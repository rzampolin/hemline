# syntax=docker/dockerfile:1
# Hemline production image — web (Next standalone) + ingest scheduler in ONE
# container, supervised by docker/start.mjs (SQLite volume = single machine;
# docs/decisions-deploy.md). No Python/ML inside: the FashionSigLIP sidecar is
# deliberately excluded for v1 — probe embedding degrades to the attribute
# path, stored vectors on the volume still power blended ranking.
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
 && printf 'import "./impl/ingest-scheduler.impl.mjs";\n' > dist/ingest-scheduler.mjs \
 && printf 'import "./impl/ingest-run.impl.mjs";\n'       > dist/ingest-run.mjs \
 && printf 'import "./impl/seed.impl.mjs";\n'             > dist/seed.mjs

# ── runtime: standalone server + bundles + supervisor ───────────────────────
FROM ${NODE_IMAGE} AS runner
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DATABASE_PATH=/data/hemline.db
WORKDIR /app

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
