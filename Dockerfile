# syntax=docker/dockerfile:1
# Hemline production image — web (Next standalone) + ingest scheduler in ONE
# container, supervised by docker/start.mjs (SQLite volume = single machine;
# docs/decisions-deploy.md), PLUS the FashionSigLIP ML sidecar (option (a),
# 2026-07-08): the `ml` stage bakes a CPU-only torch venv AND the ~860MB
# model weights into the image at BUILD time, so boot never downloads
# anything (HF_HUB_OFFLINE=1) and probe embedding / embed-on-ingest run in
# prod. Costs ~2GB of image; needs the 4GB VM in fly.toml.
#
#   docker build -t hemline .
#   docker run --rm -p 3000:3000 -v hemline-data:/data \
#     -e SESSION_SECRET=$(openssl rand -hex 32) hemline

ARG NODE_IMAGE=node:22-slim

# ── deps: install the full workspace tree once (cached by lockfile) ─────────
FROM ${NODE_IMAGE} AS deps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY apps/ingest/package.json apps/ingest/
COPY packages/ai/package.json packages/ai/
COPY packages/connectors/package.json packages/connectors/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/matching/package.json packages/matching/
COPY packages/ui/package.json packages/ui/
RUN npm ci
# fail the build early if the better-sqlite3 native binding didn't resolve
RUN node -e "require('better-sqlite3'); console.log('better-sqlite3 native binding OK')"

# ── build: Next standalone + esbuild bundles for scheduler/ingest/seed ──────
FROM deps AS build
COPY . .
# Canonical public origin (ops, 2026-07-13 — custom-domain prep, docs/DOMAIN.md).
# NEXT_PUBLIC_* vars are inlined into client bundles at BUILD time, so a domain
# change means updating fly.toml [build.args] and redeploying. Server code
# (metadataBase) reads the runtime env, which the runner stage also sets.
ARG NEXT_PUBLIC_APP_URL=https://hemline.fly.dev
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# Bundle the non-Next entrypoints so the runtime image needs no tsx/devDeps.
# Native modules stay external (resolved from the standalone node_modules).
# The dist/*.mjs one-line launchers exist so each bundle's import.meta.url
# differs from process.argv[1] — the repo's `isMain` guards (seed.ts,
# schedule.ts) must stay false inside a bundle (docker/entry-scheduler.ts).
RUN ESB="node_modules/.bin/esbuild --bundle --platform=node --format=esm --target=node22 \
      --external:better-sqlite3 --external:sharp --log-level=warning \
      --banner:js=\"import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);\"" \
 && eval "$ESB docker/entry-scheduler.ts   --outfile=dist/impl/ingest-scheduler.impl.mjs" \
 && eval "$ESB apps/ingest/src/run.ts      --outfile=dist/impl/ingest-run.impl.mjs" \
 && eval "$ESB scripts/prod-seed.ts        --outfile=dist/impl/seed.impl.mjs" \
 && eval "$ESB scripts/fix-brands.ts       --outfile=dist/impl/fix-brands.impl.mjs" \
 && eval "$ESB apps/ingest/src/upgrade.ts  --outfile=dist/impl/extract-upgrade.impl.mjs" \
 && eval "$ESB apps/ingest/src/estimate-lengths.ts --outfile=dist/impl/extract-lengths.impl.mjs" \
 && eval "$ESB apps/ingest/src/verify.ts           --outfile=dist/impl/verify-listings.impl.mjs" \
 && eval "$ESB scripts/purge-kids.ts       --outfile=dist/impl/purge-kids.impl.mjs" \
 && eval "$ESB docker/restore-drill.ts     --outfile=dist/impl/restore-drill.impl.mjs" \
 && printf 'import "./impl/ingest-scheduler.impl.mjs";\n' > dist/ingest-scheduler.mjs \
 && printf 'import "./impl/ingest-run.impl.mjs";\n'       > dist/ingest-run.mjs \
 && printf 'import "./impl/seed.impl.mjs";\n'             > dist/seed.mjs \
 && printf 'import "./impl/fix-brands.impl.mjs";\n'       > dist/fix-brands.mjs \
 && printf 'import "./impl/extract-upgrade.impl.mjs";\n'  > dist/extract-upgrade.mjs \
 && printf 'import "./impl/extract-lengths.impl.mjs";\n'  > dist/extract-lengths.mjs \
 && printf 'import "./impl/verify-listings.impl.mjs";\n'  > dist/verify-listings.mjs \
 && printf 'import "./impl/purge-kids.impl.mjs";\n'       > dist/purge-kids.mjs \
 && printf 'import "./impl/restore-drill.impl.mjs";\n'    > dist/restore-drill.mjs

# ── ml: FashionSigLIP venv + weights, baked at BUILD time ───────────────────
# Same Debian base as the runtime so the venv's /usr/bin/python3.11 symlinks
# resolve identically after COPY. torch comes from the CPU-only wheel index
# (no CUDA/nvidia bloat — the default PyPI x86_64 wheel drags ~3GB of CUDA
# libs); manylinux_2_28 +cpu wheels exist for BOTH linux/amd64 (Fly remote
# builders) and linux/arm64 (local Apple Silicon verify), and bookworm's
# glibc 2.36 satisfies them. torchvision (open_clip dep) must come from the
# SAME index — a PyPI torchvision against a +cpu torch aborts with
# "operator torchvision::nms does not exist". The warmup run downloads the checkpoint +
# tokenizer into HF_HOME *inside the layer* and smoke-tests one image + one
# text embed, so a broken model fails the BUILD, not the boot.
FROM ${NODE_IMAGE} AS ml
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app/ml
COPY ml/requirements.txt ./
RUN python3 -m venv .venv \
 && .venv/bin/pip install --no-cache-dir --upgrade pip \
 && .venv/bin/pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch torchvision \
 && .venv/bin/pip install --no-cache-dir -r requirements.txt
COPY ml/embed.py ./
ENV HF_HOME=/app/ml/.hf
RUN .venv/bin/python embed.py warmup \
 && rm -rf .cache /root/.cache
# build gate: prove the runtime's fully-OFFLINE load works against the baked
# cache (this is exactly how boot runs it — a transformers/hub offline
# regression must fail HERE, not on the first machine restart)
RUN HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 .venv/bin/python embed.py warmup

# ── litestream: fetch + verify the backup binary in its own stage ───────────
# Official release tarball, arch-matched via BuildKit's TARGETARCH so the same
# Dockerfile builds on Fly's amd64 builders and local Apple Silicon. Separate
# stage so the runner gets ONLY the extracted binary (no dead tarball layer);
# `litestream version` gates a bad download/extract at BUILD time.
FROM ${NODE_IMAGE} AS litestream
ARG TARGETARCH
ARG LITESTREAM_VERSION=0.5.14
# Release assets name amd64 as "x86_64" (arm64 stays "arm64") — TARGETARCH
# says "amd64", which 404'd on Fly's builders (2026-07-09). node:slim has no
# curl/wget; node's fetch follows the GitHub → S3 redirect fine.
RUN ARCH=$([ "$TARGETARCH" = "amd64" ] && echo x86_64 || echo "$TARGETARCH") \
 && node -e "const fs=require('node:fs');fetch('https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-${LITESTREAM_VERSION}-linux-'+process.argv[1]+'.tar.gz').then(r=>{if(!r.ok)throw new Error('download '+r.status);return r.arrayBuffer()}).then(b=>fs.writeFileSync('/tmp/litestream.tar.gz',Buffer.from(b)))" "$ARCH" \
 && tar -xzf /tmp/litestream.tar.gz -C /usr/local/bin litestream \
 && litestream version

# ── runtime: standalone server + bundles + supervisor + ml sidecar ──────────
FROM ${NODE_IMAGE} AS runner
ARG NEXT_PUBLIC_APP_URL=https://hemline.fly.dev
ENV NODE_ENV=production \
    NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DATABASE_PATH=/data/hemline.db \
    # ml sidecar: explicit dir (fly ssh console cwd isn't /app), baked HF
    # cache, never touch the network for weights, eager-load at web boot
    HEMLINE_ML_DIR=/app/ml \
    HF_HOME=/app/ml/.hf \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    HEMLINE_ML_EAGER=1
WORKDIR /app

# system python for the venv (python3-venv not needed — venv already built)
# + ca-certificates: node:slim ships NONE (Node bundles its own CA store, so
# the web app never noticed) but embed.py downloads listing images via
# python urllib → system OpenSSL → every https fetch dies with
# CERTIFICATE_VERIFY_FAILED without it. Placed BEFORE the app layers: this
# changes ~never, app code changes often.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# litestream: continuous SQLite backup to S3-compatible storage (Tigris in
# prod). The supervisor only spawns it when the S3 secrets are present
# (start.mjs), so the ~36MB binary is inert in secretless local runs.
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
COPY docker/litestream.yml /etc/litestream.yml

# ~2GB layer (torch venv + weights) — kept early so app-only rebuilds reuse it.
# node-owned: embed.py writes its image-download cache to /app/ml/.cache.
COPY --from=ml --chown=node:node /app/ml /app/ml

# standalone output mirrors the monorepo: apps/web/server.js + traced node_modules
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/dist ./dist
COPY --chown=node:node docker/start.mjs ./docker/start.mjs
RUN mkdir -p /data && chown node:node /data

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# start.mjs begins as root ONLY to chown the volume mount (Fly mounts are
# root-owned), then drops to the unprivileged `node` user before spawning
# the web server and the scheduler. Both app processes run non-root.
CMD ["node", "docker/start.mjs"]
