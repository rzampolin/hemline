/**
 * Sidecar bridge tests against a MOCKED embed.py: the stub is a Node script
 * (saved as embed.py, run via HEMLINE_ML_PYTHON=node) that speaks the exact
 * JSONL protocol, so these tests pin the IO contract without torch installed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { EmbedderProcess, isEmbedderAvailable, resolveEmbedder } from './embedder';

// CJS on purpose: the tmp dir has no package.json, so Node treats the .py file as CJS.
const STUB = `
const readline = require('node:readline');
process.stdout.write(JSON.stringify({ ready: true, model: 'stub', device: 'cpu' }) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const item = JSON.parse(line);
  if (process.argv.includes('--hang')) return; // timeout test: never answer
  if ((item.imageUrl ?? '').includes('bad')) {
    process.stdout.write(JSON.stringify({ id: item.id, error: 'load failed: 404' }) + '\\n');
  } else if (item.op === 'text') {
    process.stdout.write(JSON.stringify({ id: item.id, dim: 3, vector: [0, 0.5, -0.5] }) + '\\n');
  } else {
    process.stdout.write(JSON.stringify({ id: item.id, dim: 3, vector: [1, 0, 0.25] }) + '\\n');
  }
});
`;

let mlDir: string;
const savedEnv = { dir: process.env.HEMLINE_ML_DIR, py: process.env.HEMLINE_ML_PYTHON };
const procs: EmbedderProcess[] = [];

beforeAll(() => {
  mlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hemline-ml-stub-'));
  fs.writeFileSync(path.join(mlDir, 'embed.py'), STUB);
});

afterEach(async () => {
  process.env.HEMLINE_ML_DIR = savedEnv.dir;
  process.env.HEMLINE_ML_PYTHON = savedEnv.py;
  if (savedEnv.dir === undefined) delete process.env.HEMLINE_ML_DIR;
  if (savedEnv.py === undefined) delete process.env.HEMLINE_ML_PYTHON;
  await Promise.all(procs.splice(0).map((p) => p.dispose()));
});

afterAll(() => {
  fs.rmSync(mlDir, { recursive: true, force: true });
});

function stubPaths() {
  return { mlDir, python: process.execPath, script: path.join(mlDir, 'embed.py') };
}

function spawnStub(opts: { timeoutMs?: number } = {}) {
  const proc = new EmbedderProcess({ paths: stubPaths(), batchSize: 1, ...opts });
  procs.push(proc);
  return proc;
}

describe('degradation without python', () => {
  it('resolveEmbedder is null when neither venv nor script exist', () => {
    delete process.env.HEMLINE_ML_DIR;
    process.env.HEMLINE_ML_PYTHON = path.join(mlDir, 'no-such-python');
    expect(resolveEmbedder(os.tmpdir())).toBeNull();
    expect(isEmbedderAvailable(os.tmpdir())).toBe(false);
  });

  it('finds the sidecar via HEMLINE_ML_DIR + HEMLINE_ML_PYTHON overrides', () => {
    process.env.HEMLINE_ML_DIR = mlDir;
    process.env.HEMLINE_ML_PYTHON = process.execPath;
    const paths = resolveEmbedder(os.tmpdir());
    expect(paths?.script).toBe(path.join(mlDir, 'embed.py'));
    expect(paths?.python).toBe(process.execPath);
  });

  it('EmbedderProcess constructor throws the "run npm run ml:setup" hint when unresolvable', () => {
    delete process.env.HEMLINE_ML_DIR;
    process.env.HEMLINE_ML_PYTHON = path.join(mlDir, 'no-such-python');
    const cwd = process.cwd();
    try {
      process.chdir(os.tmpdir());
      expect(() => new EmbedderProcess()).toThrow(/ml:setup/);
    } finally {
      process.chdir(cwd);
    }
  });
});

describe('embed.py IO contract (mocked sidecar)', () => {
  it('embeds an image request into a Float32Array', async () => {
    const proc = spawnStub();
    const vec = await proc.embed({ imageUrl: 'https://img/ok.jpg' });
    expect(vec).toBeInstanceOf(Float32Array);
    expect([...vec]).toEqual([1, 0, 0.25]);
  });

  it('embeds a text request (dual encoder)', async () => {
    const proc = spawnStub();
    const vec = await proc.embed({ op: 'text', text: 'green floral wrap midi' });
    expect([...vec]).toEqual([0, 0.5, -0.5]);
  });

  it('correlates concurrent requests by id and reports per-item errors', async () => {
    const proc = spawnStub();
    const [ok1, bad, ok2] = await Promise.allSettled([
      proc.embed({ imageUrl: 'https://img/a.jpg' }),
      proc.embed({ imageUrl: 'https://img/bad.jpg' }),
      proc.embed({ op: 'text', text: 'q' }),
    ]);
    expect(ok1.status).toBe('fulfilled');
    expect(bad.status).toBe('rejected');
    expect((bad as PromiseRejectedResult).reason.message).toMatch(/load failed/);
    expect(ok2.status).toBe('fulfilled');
  });

  it('rejects pending and future requests after the child exits', async () => {
    const proc = spawnStub();
    await proc.embed({ imageUrl: 'https://img/warm.jpg' });
    await proc.dispose();
    expect(proc.alive).toBe(false);
    await expect(proc.embed({ imageUrl: 'https://img/late.jpg' })).rejects.toThrow(/exited/);
  });

  it('times out unanswered requests', async () => {
    const paths = stubPaths();
    // a stub variant that never answers
    const hangScript = path.join(mlDir, 'hang.py');
    fs.writeFileSync(hangScript, STUB.replace("process.argv.includes('--hang')", 'true'));
    const hanging = new EmbedderProcess({
      paths: { ...paths, script: hangScript },
      batchSize: 1,
      timeoutMs: 150,
    });
    procs.push(hanging);
    await expect(hanging.embed({ imageUrl: 'https://img/slow.jpg' })).rejects.toThrow(/timed out/);
  });
});
