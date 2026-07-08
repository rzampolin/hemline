#!/usr/bin/env python
"""Marqo-FashionSigLIP embedding sidecar (Apache 2.0 open weights).

JSON in/out on stdio; stdout carries ONLY JSON, all logging goes to stderr.
Spawned by the TS bridge (packages/matching/src/embedder.ts) — the app never
requires this to run (attribute-vector similarity is the fallback).

Modes
  warmup                       load model, embed a dummy image+text, print info
  single [--image P | --image-url U]   or stdin JSON {"imageBase64": "..."}
  text   [--query Q]                   or stdin JSON {"text": "..."}
  batch  [--batch-size N]      JSONL stdin -> JSONL stdout, one line per item:
      in : {"id": str, "imageUrl"|"imagePath"|"imageBase64"|... }
           {"id": str, "op": "text", "text": str}   (dual encoder: free text)
      out: {"id": str, "dim": int, "vector": [float,...]}
           {"id": str, "error": str}
    --batch-size 1 flushes per line (used by the web bridge as a warm server).

Image downloads are cached in ml/.cache (sha1 of url) and rate-limited to one
request per host per 0.5s with an identified User-Agent.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import os
import sys
import time
import urllib.parse
import urllib.request

MODEL_HUB_ID = "hf-hub:Marqo/marqo-fashionSigLIP"
# Must match EMBEDDING_MODEL_TAG in packages/contracts/src/matching.ts
MODEL_TAG = "marqo-fashionSigLIP"
CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".cache")
USER_AGENT = "HemlineBot/1.0 (+{})".format(os.environ.get("CRAWLER_CONTACT", "hemline"))
HOST_MIN_INTERVAL_S = 0.5
DOWNLOAD_TIMEOUT_S = 20

_last_fetch_by_host: dict[str, float] = {}


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def emit(obj: dict) -> None:
    print(json.dumps(obj, separators=(",", ":")), flush=True)


# ── model ────────────────────────────────────────────────────────────────────


class Embedder:
    def __init__(self) -> None:
        import open_clip
        import torch

        t0 = time.time()
        self.torch = torch
        self.device = "mps" if torch.backends.mps.is_available() else "cpu"
        model, _, preprocess = open_clip.create_model_and_transforms(MODEL_HUB_ID)
        self.tokenizer = open_clip.get_tokenizer(MODEL_HUB_ID)
        self.model = model.eval().to(self.device)
        self.preprocess = preprocess
        self.load_seconds = time.time() - t0
        log(f"model loaded on {self.device} in {self.load_seconds:.1f}s")

    def embed_images(self, images: list) -> list[list[float]]:
        torch = self.torch
        batch = torch.stack([self.preprocess(img) for img in images]).to(self.device)
        with torch.no_grad():
            feats = self.model.encode_image(batch, normalize=True)
        return feats.cpu().float().tolist()

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        torch = self.torch
        tokens = self.tokenizer(texts).to(self.device)
        with torch.no_grad():
            feats = self.model.encode_text(tokens, normalize=True)
        return feats.cpu().float().tolist()


# ── image loading (polite download + cache) ─────────────────────────────────


def fetch_url(url: str) -> bytes:
    os.makedirs(CACHE_DIR, exist_ok=True)
    key = hashlib.sha1(url.encode("utf-8")).hexdigest()
    cache_path = os.path.join(CACHE_DIR, key)
    if os.path.exists(cache_path):
        with open(cache_path, "rb") as f:
            return f.read()

    host = urllib.parse.urlparse(url).netloc
    waited = _last_fetch_by_host.get(host, 0) + HOST_MIN_INTERVAL_S - time.time()
    if waited > 0:
        time.sleep(waited)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=DOWNLOAD_TIMEOUT_S) as resp:
        data = resp.read()
    _last_fetch_by_host[host] = time.time()

    tmp = cache_path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, cache_path)
    return data


def load_image(item: dict):
    from PIL import Image

    if item.get("imageBase64"):
        data = base64.b64decode(item["imageBase64"])
    elif item.get("imagePath"):
        with open(item["imagePath"], "rb") as f:
            data = f.read()
    elif item.get("imageUrl"):
        data = fetch_url(item["imageUrl"])
    else:
        raise ValueError("item needs imageBase64, imagePath, or imageUrl")
    return Image.open(io.BytesIO(data)).convert("RGB")


# ── modes ────────────────────────────────────────────────────────────────────


def run_warmup() -> None:
    from PIL import Image

    embedder = Embedder()
    t0 = time.time()
    vecs = embedder.embed_images([Image.new("RGB", (224, 224), (128, 100, 90))])
    tvecs = embedder.embed_texts(["a green floral wrap midi dress"])
    emit(
        {
            "ok": True,
            "model": MODEL_TAG,
            "dim": len(vecs[0]),
            "textDim": len(tvecs[0]),
            "device": embedder.device,
            "loadSeconds": round(embedder.load_seconds, 2),
            "embedSeconds": round(time.time() - t0, 2),
        }
    )


def read_stdin_json() -> dict:
    raw = sys.stdin.read()
    return json.loads(raw) if raw.strip() else {}


def run_single(args: argparse.Namespace) -> None:
    item: dict = {}
    if args.image:
        item["imagePath"] = args.image
    elif args.image_url:
        item["imageUrl"] = args.image_url
    else:
        item = read_stdin_json()
    image = load_image(item)
    embedder = Embedder()
    vec = embedder.embed_images([image])[0]
    emit({"ok": True, "model": MODEL_TAG, "dim": len(vec), "vector": vec})


def run_text(args: argparse.Namespace) -> None:
    query = args.query if args.query else read_stdin_json().get("text", "")
    if not query.strip():
        emit({"ok": False, "error": "empty text query"})
        sys.exit(1)
    embedder = Embedder()
    vec = embedder.embed_texts([query])[0]
    emit({"ok": True, "model": MODEL_TAG, "dim": len(vec), "vector": vec})


def flush_group(embedder: Embedder, group: list[tuple[dict, object]]) -> None:
    """Embed a mixed group of loaded (item, image|text) pairs, emit per-item."""
    imgs = [(it, payload) for it, payload in group if it.get("op", "image") != "text"]
    txts = [(it, payload) for it, payload in group if it.get("op", "image") == "text"]
    for subset, embed in ((imgs, embedder.embed_images), (txts, embedder.embed_texts)):
        if not subset:
            continue
        try:
            vectors = embed([payload for _, payload in subset])
            for (item, _), vec in zip(subset, vectors):
                emit({"id": item.get("id"), "dim": len(vec), "vector": vec})
        except Exception as exc:  # noqa: BLE001 — report, keep the stream alive
            for item, _ in subset:
                emit({"id": item.get("id"), "error": f"embed failed: {exc}"})


def run_batch(args: argparse.Namespace) -> None:
    embedder = Embedder()  # load BEFORE reading so the bridge can await readiness
    emit({"ready": True, "model": MODEL_TAG, "device": embedder.device})
    group: list[tuple[dict, object]] = []
    done = 0
    t0 = time.time()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            item = json.loads(line)
        except json.JSONDecodeError as exc:
            emit({"id": None, "error": f"bad json line: {exc}"})
            continue
        try:
            payload = item.get("text", "") if item.get("op") == "text" else load_image(item)
            group.append((item, payload))
        except Exception as exc:  # noqa: BLE001 — bad image/url must not kill the run
            emit({"id": item.get("id"), "error": f"load failed: {exc}"})
        if len(group) >= args.batch_size:
            flush_group(embedder, group)
            done += len(group)
            group = []
            if done % 40 < args.batch_size:
                rate = done / max(time.time() - t0, 1e-9)
                log(f"embedded {done} items ({rate:.1f}/s)")
    if group:
        flush_group(embedder, group)


def main() -> None:
    parser = argparse.ArgumentParser(description="FashionSigLIP embedding sidecar")
    sub = parser.add_subparsers(dest="mode", required=True)
    sub.add_parser("warmup")
    p_single = sub.add_parser("single")
    p_single.add_argument("--image", help="local image path")
    p_single.add_argument("--image-url", help="remote image url")
    p_text = sub.add_parser("text")
    p_text.add_argument("--query", help="free-text query")
    p_batch = sub.add_parser("batch")
    p_batch.add_argument("--batch-size", type=int, default=8)
    args = parser.parse_args()

    if args.mode == "warmup":
        run_warmup()
    elif args.mode == "single":
        run_single(args)
    elif args.mode == "text":
        run_text(args)
    elif args.mode == "batch":
        run_batch(args)


if __name__ == "__main__":
    main()
