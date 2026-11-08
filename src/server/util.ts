import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const now = () => new Date().toISOString();

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const newId = () => randomBytes(8).toString('hex');

export const sha1 = (s: string | Buffer) => createHash('sha1').update(s).digest('hex');

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    return JSON.parse(raw) as T;
  } catch (e: any) {
    if (e?.code === 'ENOENT') return fallback;
    if (e instanceof SyntaxError) {
      // Keep the broken file around for inspection instead of silently losing data.
      await fsp.rename(file, `${file}.corrupt-${Date.now()}`).catch(() => {});
      return fallback;
    }
    throw e;
  }
}

/** Write JSON atomically (temp file + rename) so a crash never leaves half a file. */
export async function writeJson(file: string, data: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
  await fsp.rename(tmp, file);
}

/** Serialises async work per key. */
export class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>();
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const result = prev.then(() => fn());
    const tail = result.then(
      () => {},
      () => {},
    );
    this.tails.set(key, tail);
    try {
      return await result;
    } finally {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  isBusy(key: string): boolean {
    return this.tails.has(key);
  }
}

export interface ExecResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  input?: string | Buffer;
  timeoutMs?: number;
  maxBytes?: number;
}

/** Run a process without a shell. Never throws for non-zero exit; check `code`. */
export function exec(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    let outLen = 0;
    let err = '';
    let killedForSize = false;
    const max = opts.maxBytes ?? 512 * 1024 * 1024;
    child.stdout.on('data', (d: Buffer) => {
      outLen += d.length;
      if (outLen > max) {
        killedForSize = true;
        child.kill('SIGKILL');
        return;
      }
      out.push(d);
    });
    child.stderr.on('data', (d: Buffer) => {
      if (err.length < 64 * 1024) err += d.toString();
    });
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        err += `\n[timed out after ${opts.timeoutMs}ms]`;
        child.kill('SIGKILL');
      }, opts.timeoutMs);
    }
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (killedForSize) err += `\n[output exceeded ${max} bytes]`;
      resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: err });
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/** Open a URL in the default browser. Best effort: does nothing if there is no browser to open. */
export async function openUrl(url: string): Promise<void> {
  // On Windows, `start` reads its first quoted argument as the window title, hence the empty ''.
  const [cmd, args]: [string, string[]] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  await exec(cmd, args, { timeoutMs: 10_000 }).catch(() => {});
}

export async function which(bin: string): Promise<string | null> {
  const r = await exec('/usr/bin/which', [bin]).catch(() => null);
  if (!r || r.code !== 0) return null;
  const p = r.stdout.toString().trim();
  return p || null;
}

export function parsePrUrl(input: string): { owner: string; repo: string; number: number } | null {
  const s = input.trim();
  let m = s.match(/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/i);
  if (m) return { owner: m[1], repo: m[2].replace(/\.git$/, ''), number: Number(m[3]) };
  // owner/repo#123 shorthand
  m = s.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/);
  if (m) return { owner: m[1], repo: m[2], number: Number(m[3]) };
  return null;
}

export const prKey = (owner: string, repo: string, number: number) => `${owner}/${repo}#${number}`;

export function splitKey(key: string): { owner: string; repo: string; number: number } {
  const m = key.match(/^([^/]+)\/([^#]+)#(\d+)$/);
  if (!m) throw new Error(`bad PR key: ${key}`);
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

export async function tailFile(file: string, maxBytes = 16 * 1024): Promise<string> {
  try {
    const fh = await fsp.open(file, 'r');
    try {
      const { size } = await fh.stat();
      const start = Math.max(0, size - maxBytes);
      const buf = Buffer.alloc(size - start);
      await fh.read(buf, 0, buf.length, start);
      return buf.toString('utf8');
    } finally {
      await fh.close();
    }
  } catch {
    return '';
  }
}

export function appendLine(file: string, line: string) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line.endsWith('\n') ? line : line + '\n');
  } catch {
    /* logging must never crash the app */
  }
}

/** Run async tasks with limited concurrency. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
