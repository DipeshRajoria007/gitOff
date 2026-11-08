import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { forcedOffline } from './github/client.js';
import { paths } from './store.js';
import { KeyedMutex, now, pool, readJson, sha1, writeJson } from './util.js';

export interface AssetRecord {
  file: string;
  type: string;
  size: number;
  at: string;
}
type AssetIndex = Record<string, AssetRecord>;

const mutex = new KeyedMutex();
let indexCache: AssetIndex | null = null;

async function loadIndex(): Promise<AssetIndex> {
  if (!indexCache) indexCache = await readJson<AssetIndex>(paths.assetIndex, {});
  return indexCache;
}

async function saveIndex(): Promise<void> {
  if (indexCache) await writeJson(paths.assetIndex, indexCache);
}

export function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

/** Stable key for a media URL: signed query params (jwt, tokens) change on every fetch. */
export function assetKey(rawUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(decodeEntities(rawUrl));
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  for (const p of ['jwt', 'token', 'X-Amz-Algorithm', 'X-Amz-Credential', 'X-Amz-Date', 'X-Amz-Expires', 'X-Amz-Signature', 'X-Amz-SignedHeaders']) {
    u.searchParams.delete(p);
  }
  return sha1(u.toString());
}

const VIDEO_EXT = /\.(mp4|mov|webm|m4v|mkv)(\?|$)/i;

export interface MediaRef {
  url: string;
  kind: 'image' | 'video';
  /** extra request headers (e.g. Jira basic auth) */
  headers?: Record<string, string>;
}

/** Find images and videos referenced by GitHub-rendered HTML. */
export function extractMedia(html: string): MediaRef[] {
  const out: MediaRef[] = [];
  if (!html) return out;
  const tagRe = /<(img|video|source)\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html))) {
    const tag = m[0];
    const name = m[1].toLowerCase();
    for (const attr of ['src', 'poster']) {
      const a = tag.match(new RegExp(`\\s${attr}="([^"]+)"`, 'i'));
      if (!a) continue;
      const url = decodeEntities(a[1]);
      if (!/^https?:\/\//.test(url)) continue;
      const kind = name === 'img' || attr === 'poster' ? 'image' : 'video';
      out.push({ url, kind: kind === 'image' && VIDEO_EXT.test(url) ? 'video' : kind });
    }
  }
  // Bare links to uploaded videos (GitHub sometimes renders these as links).
  const linkRe = /<a\b[^>]*\shref="(https:\/\/(?:private-user-images\.githubusercontent\.com|github\.com\/user-attachments\/assets)[^"]+)"/gi;
  while ((m = linkRe.exec(html))) {
    const url = decodeEntities(m[1]);
    if (VIDEO_EXT.test(url)) out.push({ url, kind: 'video' });
  }
  return out;
}

const EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/avif': '.avif',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
};

export interface DownloadResult {
  downloaded: number;
  skipped: number;
  failed: { url: string; reason: string; status?: number }[];
}

async function downloadOne(ref: MediaRef, maxBytes: number): Promise<{ ok: true } | { ok: false; reason: string; status?: number }> {
  const key = assetKey(ref.url);
  if (!key) return { ok: false, reason: 'bad url' };
  const index = await loadIndex();
  if (index[key]) return { ok: true };
  return mutex.run(key, async () => {
    if ((await loadIndex())[key]) return { ok: true } as const;
    let res: Response;
    if (forcedOffline()) return { ok: false, reason: 'offline' } as const;
    try {
      res = await fetch(ref.url, {
        headers: { 'User-Agent': 'gitoff', ...(ref.headers ?? {}) },
        redirect: 'follow',
        signal: AbortSignal.timeout(ref.kind === 'video' ? 20 * 60_000 : 60_000),
      });
    } catch (e: any) {
      return { ok: false, reason: `network: ${e?.cause?.code || e?.name || 'error'}` } as const;
    }
    if (!res.ok || !res.body) {
      return { ok: false, reason: `HTTP ${res.status}`, status: res.status } as const;
    }
    const len = Number(res.headers.get('content-length') || 0);
    if (len && len > maxBytes) {
      await res.body.cancel().catch(() => {});
      return { ok: false, reason: `too large (${Math.round(len / 1e6)} MB)` } as const;
    }
    const type = (res.headers.get('content-type') || '').split(';')[0].trim();
    const ext = EXT[type] || path.extname(new URL(ref.url).pathname).slice(0, 6) || '';
    const file = `${key}${ext}`;
    const dest = path.join(paths.assets, file);
    const tmp = `${dest}.part`;
    await fsp.mkdir(paths.assets, { recursive: true });
    let size = 0;
    try {
      const body = Readable.fromWeb(res.body as any);
      body.on('data', (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) body.destroy(new Error('too large'));
      });
      await pipeline(body, fs.createWriteStream(tmp));
      await fsp.rename(tmp, dest);
    } catch (e: any) {
      await fsp.rm(tmp, { force: true });
      return { ok: false, reason: e?.message === 'too large' ? 'too large' : `download failed: ${e?.message || e}` } as const;
    }
    const idx = await loadIndex();
    idx[key] = { file, type: type || 'application/octet-stream', size, at: now() };
    await saveIndex();
    return { ok: true } as const;
  });
}

export async function downloadMedia(
  refs: MediaRef[],
  opts: { videos: boolean; maxVideoMB: number; maxImageMB: number },
  refetch?: () => Promise<MediaRef[]>,
): Promise<DownloadResult> {
  const unique = new Map<string, MediaRef>();
  for (const r of refs) {
    if (r.kind === 'video' && !opts.videos) continue;
    const k = assetKey(r.url);
    if (k && !unique.has(k)) unique.set(k, r);
  }
  const index = await loadIndex();
  const todo = [...unique.entries()].filter(([k]) => !index[k]);
  // Images first: they are small and signed URLs expire after ~5 minutes.
  todo.sort((a, b) => (a[1].kind === b[1].kind ? 0 : a[1].kind === 'image' ? -1 : 1));
  const result: DownloadResult = { downloaded: 0, skipped: unique.size - todo.length, failed: [] };
  const limit = (r: MediaRef) => (r.kind === 'video' ? opts.maxVideoMB : opts.maxImageMB) * 1024 * 1024;

  const expired: [string, MediaRef][] = [];
  await pool(todo, 4, async ([k, ref]) => {
    const r = await downloadOne(ref, limit(ref));
    if (r.ok) result.downloaded++;
    else if ((r.status === 401 || r.status === 403 || r.status === 404) && /[?&]jwt=/.test(ref.url) && refetch) expired.push([k, ref]);
    else result.failed.push({ url: ref.url, reason: r.reason, status: r.status });
  });

  if (expired.length && refetch) {
    // Signed URLs ran out while we were busy: ask GitHub for fresh ones and retry once.
    const fresh = new Map<string, MediaRef>();
    for (const r of await refetch().catch(() => [] as MediaRef[])) {
      const k = assetKey(r.url);
      if (k) fresh.set(k, r);
    }
    await pool(expired, 3, async ([k, ref]) => {
      const again = fresh.get(k);
      const r = again ? await downloadOne(again, limit(again)) : ({ ok: false, reason: 'signed URL expired' } as const);
      if (r.ok) result.downloaded++;
      else result.failed.push({ url: ref.url, reason: r.reason });
    });
  }
  return result;
}

/** Rewrite media URLs in HTML to locally cached copies. Unknown URLs are left untouched. */
export async function localizeHtml(html: string): Promise<string> {
  if (!html) return html;
  const index = await loadIndex();
  return html.replace(/(\s(?:src|href|poster|data-canonical-src)=")(https?:\/\/[^"]+)"/gi, (whole, pre: string, url: string) => {
    const k = assetKey(url);
    const rec = k ? index[k] : undefined;
    return rec ? `${pre}/assets/${rec.file}"` : whole;
  });
}

export async function localUrlFor(url: string | null | undefined): Promise<string | null | undefined> {
  if (!url) return url;
  const k = assetKey(url);
  const rec = k ? (await loadIndex())[k] : undefined;
  return rec ? `/assets/${rec.file}` : url;
}

export async function assetType(file: string): Promise<string | null> {
  const index = await loadIndex();
  for (const rec of Object.values(index)) if (rec.file === file) return rec.type;
  return null;
}

/** Delete downloaded media that no cached PR or ticket refers to any more. */
export async function pruneAssets(keepKeys: Set<string>, keepFiles: Set<string>): Promise<number> {
  return mutex.run('__index__', async () => {
    const index = await loadIndex();
    let removed = 0;
    for (const [k, rec] of Object.entries(index)) {
      if (keepKeys.has(k) || keepFiles.has(rec.file)) continue;
      await fsp.rm(path.join(paths.assets, rec.file), { force: true });
      delete index[k];
      removed++;
    }
    // Stray files (interrupted downloads etc.).
    const known = new Set(Object.values(index).map((r) => r.file));
    for (const f of await fsp.readdir(paths.assets).catch(() => [] as string[])) {
      if (f === 'index.json' || known.has(f) || keepFiles.has(f)) continue;
      await fsp.rm(path.join(paths.assets, f), { force: true });
      removed++;
    }
    await saveIndex();
    return removed;
  });
}
