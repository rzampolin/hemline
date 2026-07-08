/**
 * Bridge to the Python embedding sidecar (ml/embed.py, Marqo-FashionSigLIP).
 *
 * Node-only (child_process) — deliberately NOT exported from the package
 * index, which stays pure; import via the '@hemline/matching/embedder'
 * subpath. Every entry point is null/false-safe: no venv, no python, or a
 * crashed child never throws into callers — they fall back to the
 * attribute-vector path, mirroring the keyless-AI degradation story.
 *
 * Protocol (ml/embed.py `batch` mode): JSONL on stdio.
 *   → {"id": string, "imageUrl"|"imagePath"|"imageBase64": string}
 *   → {"id": string, "op": "text", "text": string}
 *   ← {"ready": true, "model": ..., "device": ...}        (once, after load)
 *   ← {"id": string, "dim": number, "vector": number[]}
 *   ← {"id": string, "error": string}
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

export interface EmbedderPaths {
  mlDir: string;
  python: string;
  script: string;
}

/**
 * Locate ml/embed.py + its venv python: $HEMLINE_ML_DIR first, then walk up
 * from cwd (next dev runs at apps/web, npm scripts at the repo root).
 * $HEMLINE_ML_PYTHON overrides the interpreter (tests point it at a stub).
 */
export function resolveEmbedder(startDir = process.cwd()): EmbedderPaths | null {
  const candidates: string[] = [];
  if (process.env.HEMLINE_ML_DIR) candidates.push(process.env.HEMLINE_ML_DIR);
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    candidates.push(path.join(dir, 'ml'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const mlDir of candidates) {
    const script = path.join(mlDir, 'embed.py');
    const python = process.env.HEMLINE_ML_PYTHON ?? path.join(mlDir, '.venv', 'bin', 'python');
    if (fs.existsSync(script) && fs.existsSync(python)) return { mlDir, python, script };
  }
  return null;
}

/** True when the sidecar could be spawned (venv + script exist). */
export function isEmbedderAvailable(startDir?: string): boolean {
  return resolveEmbedder(startDir) != null;
}

export type EmbedRequest =
  | { op?: 'image'; imageUrl?: string; imagePath?: string; imageBase64?: string }
  | { op: 'text'; text: string };

export interface EmbedderOptions {
  paths?: EmbedderPaths;
  /** images per model forward pass (1 = flush per request, for interactive use) */
  batchSize?: number;
  /** per-request timeout; 0 disables (bulk runs). Default 90s (covers model load). */
  timeoutMs?: number;
}

interface Pending {
  resolve: (v: Float32Array) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout | null;
}

/** A long-lived embed.py child; safe to share (requests are correlated by id). */
export class EmbedderProcess {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<string, Pending>();
  private nextId = 0;
  private exited: Error | null = null;
  private readonly timeoutMs: number;

  constructor(opts: EmbedderOptions = {}) {
    const paths = opts.paths ?? resolveEmbedder();
    if (!paths) throw new Error('ml sidecar not set up — run `npm run ml:setup`');
    this.timeoutMs = opts.timeoutMs ?? 90_000;
    this.child = spawn(
      paths.python,
      [paths.script, 'batch', '--batch-size', String(opts.batchSize ?? 1)],
      { stdio: ['pipe', 'pipe', 'pipe'], cwd: paths.mlDir },
    );
    readline.createInterface({ input: this.child.stdout }).on('line', (line) => this.onLine(line));
    readline.createInterface({ input: this.child.stderr }).on('line', (line) => {
      if (process.env.HEMLINE_ML_DEBUG) console.error(`[embed.py] ${line}`);
    });
    this.child.on('error', (err) => this.onExit(new Error(`embed.py spawn failed: ${err.message}`)));
    // 'close' (not 'exit'): fires after stdio has fully drained, so tail
    // results emitted just before a clean exit still settle their promises.
    this.child.on('close', (code) => this.onExit(new Error(`embed.py exited with code ${code}`)));
  }

  get alive(): boolean {
    return this.exited == null;
  }

  /** Embed one image or text; rejects on sidecar error/timeout/exit. */
  embed(req: EmbedRequest): Promise<Float32Array> {
    if (this.exited) return Promise.reject(this.exited);
    const id = `r${this.nextId++}`;
    return new Promise<Float32Array>((resolve, reject) => {
      const timer =
        this.timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`embed request timed out after ${this.timeoutMs}ms`));
            }, this.timeoutMs)
          : null;
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, ...req }) + '\n', (err) => {
        if (err) {
          this.settle(id, undefined, new Error(`embed.py stdin write failed: ${err.message}`));
        }
      });
    });
  }

  /**
   * Close stdin — signals EOF so the sidecar embeds any partial final batch
   * and exits. Call AFTER all embed() calls have been issued (bulk mode).
   */
  endInput(): void {
    this.child.stdin.end();
  }

  /** Close stdin (flushes any partial batch) and wait for the child to finish. */
  async dispose(): Promise<void> {
    this.endInput();
    if (this.exited) return;
    await new Promise<void>((resolve) => this.child.once('close', () => resolve()));
  }

  private onLine(line: string): void {
    let msg: { id?: string; ready?: boolean; vector?: number[]; error?: string };
    try {
      msg = JSON.parse(line);
    } catch {
      return; // non-protocol noise on stdout — ignore
    }
    if (msg.ready || msg.id == null) return;
    if (msg.vector) this.settle(msg.id, Float32Array.from(msg.vector));
    else this.settle(msg.id, undefined, new Error(msg.error ?? 'embed failed'));
  }

  private settle(id: string, vector?: Float32Array, error?: Error): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    if (p.timer) clearTimeout(p.timer);
    if (vector) p.resolve(vector);
    else p.reject(error ?? new Error('embed failed'));
  }

  private onExit(err: Error): void {
    if (this.exited) return;
    this.exited = err;
    for (const [id] of this.pending) this.settle(id, undefined, err);
  }
}

// ── shared interactive embedder (web routes) ───────────────────────────────

const SHARED_KEY = Symbol.for('hemline.ml.embedder');

/**
 * Lazily-spawned shared child for interactive requests (find-similar). Kept on
 * globalThis so Next dev HMR reuses it; respawned if it died. Null when the
 * sidecar isn't set up.
 */
export function getSharedEmbedder(opts: Omit<EmbedderOptions, 'batchSize'> = {}): EmbedderProcess | null {
  if (!isEmbedderAvailable()) return null;
  const g = globalThis as unknown as Record<symbol, EmbedderProcess | undefined>;
  const cached = g[SHARED_KEY];
  if (cached?.alive) return cached;
  try {
    const proc = new EmbedderProcess({ ...opts, batchSize: 1 });
    g[SHARED_KEY] = proc;
    return proc;
  } catch {
    return null;
  }
}

/**
 * Best-effort single embed for request paths: null on ANY failure (not set
 * up, child crash, bad image, timeout) so callers just fall back.
 */
export async function embedProbe(req: EmbedRequest): Promise<Float32Array | null> {
  const embedder = getSharedEmbedder();
  if (!embedder) return null;
  try {
    return await embedder.embed(req);
  } catch (err) {
    console.warn(`[ml] embed probe failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}
