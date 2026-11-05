import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AppStatus, DraftReview, DraftThread, PRDetail, PRKey, Settings } from '../shared/types.js';
import { getNet, isOnline } from './connectivity.js';
import { availableEditors, openInEditor } from './editor.js';
import { bus } from './events.js';
import { computeDiff, filePatch, gitOut, hasCommit, readBlob } from './git.js';
import { getJiraCreds, storeJiraToken, testJira } from './jira.js';
import { actOnItem, annotateBlocked, outboxCounts, processOutbox, queueComment, queueResolve, queueReview, queueViewed } from './outbox.js';
import { startPrepare } from './prepare.js';
import { localUrlFor } from './media.js';
import { presentSnapshot, summarize } from './present.js';
import { moveDraft } from './remap.js';
import { getJira, getLocal, getMeta, getOutbox, getSettings, getSnapshot, getTracked, paths, updateLocal, updateSettings } from './store.js';
import { getProgress, isSyncingPr, refreshWorktree, syncAll, syncPr, trackPrs, untrackPr } from './sync.js';
import { errMsg, exists, newId, now, parsePrUrl, prKey, tailFile } from './util.js';

const VERSION = '0.1.0';
const WEB_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

const OID = /^[0-9a-f]{7,40}$/i;

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function keyFrom(c: Context): PRKey {
  const n = Number(c.req.param('number'));
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'bad PR number');
  return prKey(c.req.param('owner')!, c.req.param('repo')!, n);
}

async function resolveKey(c: Context): Promise<PRKey> {
  const k = keyFrom(c).toLowerCase();
  const t = (await getTracked()).find((x) => x.key.toLowerCase() === k);
  if (!t) throw new HttpError(404, 'This PR is not cached. Add it from the dashboard first.');
  return t.key;
}

async function requireSnapshot(key: PRKey) {
  const s = await getSnapshot(key);
  if (!s) throw new HttpError(404, 'PR has not been downloaded yet');
  return s;
}

async function requireGit(key: PRKey) {
  const s = await requireSnapshot(key);
  if (!s.git) throw new HttpError(409, s.gitError ? `Code not available offline: ${s.gitError}` : 'Code has not been fetched yet');
  return { snap: s, git: s.git };
}

/**
 * Files that come from PRs (repo blobs, downloaded media) are untrusted: an SVG
 * opened directly could otherwise run script on this origin and drive the API.
 * `sandbox` without allow-scripts makes such documents inert.
 */
const UNTRUSTED_HEADERS = {
  'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'",
};

/** The app itself: only its own bundled code, nothing from the network. */
const APP_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; " +
  "font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

async function sendFile(c: Context, file: string, cache: 'immutable' | 'none', untrusted = false) {
  try {
    const buf = await fsp.readFile(file);
    const ext = path.extname(file).toLowerCase();
    const type = MIME[ext] ?? 'application/octet-stream';
    return c.body(buf, 200, {
      'Content-Type': type,
      'Cache-Control': cache === 'immutable' ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      ...(untrusted ? UNTRUSTED_HEADERS : ext === '.html' ? { 'Content-Security-Policy': APP_CSP } : {}),
    });
  } catch {
    return c.text('Not found', 404);
  }
}

function validDraft(d: any, commitOid: string): DraftReview {
  if (!d || typeof d !== 'object') throw new HttpError(400, 'bad draft');
  const threads: DraftThread[] = Array.isArray(d.threads) ? d.threads : [];
  for (const t of threads) {
    if (typeof t.localId !== 'string' || typeof t.path !== 'string' || typeof t.body !== 'string') throw new HttpError(400, 'bad draft thread');
    if (t.subjectType !== 'LINE' && t.subjectType !== 'FILE') throw new HttpError(400, 'bad subjectType');
  }
  const replies = Array.isArray(d.replies) ? d.replies : [];
  for (const r of replies) if (typeof r.localId !== 'string' || typeof r.threadId !== 'string' || typeof r.body !== 'string') throw new HttpError(400, 'bad reply');
  return {
    commitOid: typeof d.commitOid === 'string' && OID.test(d.commitOid) ? d.commitOid : commitOid,
    body: typeof d.body === 'string' ? d.body : '',
    threads,
    replies,
    updatedAt: now(),
  };
}

export function buildApp() {
  const app = new Hono();

  // Only answer to localhost, and require a custom header on writes. This blocks
  // other websites (CSRF, DNS rebinding) from driving the local API.
  app.use('*', async (c, next) => {
    const host = c.req.header('host') ?? '';
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) return c.text('Forbidden host', 403);
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      const origin = c.req.header('origin');
      if (origin && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) return c.text('Forbidden origin', 403);
      if (c.req.header('x-ogh') !== '1') return c.text('Missing x-ogh header', 403);
    }
    await next();
  });

  app.onError((e, c) => {
    const status = e instanceof HttpError ? e.status : 500;
    return c.json({ error: errMsg(e) }, status as any);
  });

  // ---- status & events ----

  app.get('/api/status', async (c) => {
    const net = getNet();
    const meta = await getMeta();
    const settings = await getSettings();
    const body: AppStatus = {
      online: net.online,
      lastCheckAt: net.lastCheckAt,
      lastOnlineAt: net.lastOnlineAt,
      viewer: meta.viewer ? { ...meta.viewer, avatarUrl: (await localUrlFor(meta.viewer.avatarUrl)) ?? null } : null,
      sync: { ...getProgress(), lastRunAt: getProgress().lastRunAt ?? meta.lastSyncAt, lastFullRunAt: getProgress().lastFullRunAt ?? meta.lastFullSyncAt },
      outbox: await outboxCounts(),
      jiraConfigured: !!(await getJiraCreds(settings)),
      editor: settings.editor,
      version: VERSION,
      home: paths.prs.replace(/\/prs$/, ''),
    };
    return c.json(body);
  });

  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      const queue: string[] = [];
      let wake: (() => void) | null = null;
      const off = bus.onEvent((e) => {
        queue.push(JSON.stringify(e));
        wake?.();
      });
      stream.onAbort(() => {
        off();
        wake?.();
      });
      await stream.writeSSE({ event: 'hello', data: '{}' });
      while (!stream.aborted) {
        if (!queue.length) {
          await Promise.race([new Promise<void>((r) => (wake = r)), new Promise((r) => setTimeout(r, 25_000))]);
          wake = null;
          if (!queue.length) {
            await stream.writeSSE({ event: 'ping', data: '{}' });
            continue;
          }
        }
        const batch = queue.splice(0);
        // Collapse duplicates so a burst of updates is one refetch in the UI.
        for (const data of [...new Set(batch)]) await stream.writeSSE({ event: 'bus', data });
      }
      off();
    }),
  );

  // ---- PR list ----

  app.get('/api/prs', async (c) => {
    const tracked = await getTracked();
    const outbox = await getOutbox();
    const list = await Promise.all(
      tracked.map(async (t) => {
        const [snap, local] = await Promise.all([getSnapshot(t.key), getLocal(t.key)]);
        return { ...(await summarize(t, snap, local, outbox)), syncing: isSyncingPr(t.key) };
      }),
    );
    list.sort((a, b) => (b.updatedAt ?? b.lastSyncAt ?? '').localeCompare(a.updatedAt ?? a.lastSyncAt ?? ''));
    return c.json(list);
  });

  app.post('/api/prs', async (c) => {
    const { urls } = await c.req.json<{ urls: string }>();
    const inputs = String(urls ?? '')
      .split(/[\s,]+/)
      .filter(Boolean);
    const refs: { owner: string; repo: string; number: number }[] = [];
    const invalid: string[] = [];
    for (const s of inputs) {
      const r = parsePrUrl(s);
      if (r) refs.push(r);
      else invalid.push(s);
    }
    const keys = refs.length ? await trackPrs(refs, 'manual') : [];
    if (isOnline()) for (const k of keys) void syncPr(k).catch(() => {});
    return c.json({ keys, invalid, online: isOnline() });
  });

  app.delete('/api/prs/:owner/:repo/:number', async (c) => {
    const key = await resolveKey(c);
    return c.json(await untrackPr(key, { removeWorktree: c.req.query('worktree') === '1' }));
  });

  // ---- one PR ----

  app.get('/api/prs/:owner/:repo/:number', async (c) => {
    const key = await resolveKey(c);
    const tracked = (await getTracked()).find((t) => t.key === key)!;
    const [snap, local, outbox] = await Promise.all([getSnapshot(key), getLocal(key), getOutbox()]);
    const summary = await summarize(tracked, snap, local, outbox);
    const linkedPrs = [];
    const all = await getTracked();
    for (const k of snap?.linked.prs ?? []) {
      const t = all.find((x) => x.key.toLowerCase() === k.toLowerCase());
      if (!t) continue;
      const [s, l] = await Promise.all([getSnapshot(t.key), getLocal(t.key)]);
      linkedPrs.push(await summarize(t, s, l, outbox));
    }
    // Also PRs that link to this one (e.g. the frontend PR pointing at this backend PR).
    for (const t of all) {
      if (t.key === key || linkedPrs.some((p) => p.key === t.key)) continue;
      if (!(t.links ?? []).some((k) => k.toLowerCase() === key.toLowerCase())) continue;
      const [s, l] = await Promise.all([getSnapshot(t.key), getLocal(t.key)]);
      linkedPrs.push(await summarize(t, s, l, outbox));
    }
    const jira = [];
    for (const k of snap?.linked.jira ?? []) {
      const j = await getJira(k);
      if (j) jira.push(j);
    }
    const detail: PRDetail = {
      summary: { ...summary },
      snapshot: snap ? await presentSnapshot(snap) : null,
      local,
      outbox: outbox.filter((x) => x.prKey === key),
      linkedPrs,
      jira,
    };
    return c.json({ ...detail, syncing: isSyncingPr(key) });
  });

  app.post('/api/prs/:owner/:repo/:number/sync', async (c) => {
    const key = await resolveKey(c);
    if (!isOnline()) throw new HttpError(409, "You're offline. The PR will refresh when you're back online.");
    void syncPr(key).catch(() => {});
    return c.json({ ok: true });
  });

  app.post('/api/prs/:owner/:repo/:number/seen', async (c) => {
    const key = await resolveKey(c);
    const snap = await getSnapshot(key);
    if (snap) {
      await updateLocal(key, (l) => {
        l.lastSeenUpdatedAt = snap.pr.updatedAt;
      });
      bus.emitEvent({ type: 'prs' });
    }
    return c.json({ ok: true });
  });

  app.get('/api/prs/:owner/:repo/:number/diff', async (c) => {
    const key = await resolveKey(c);
    const { git } = await requireGit(key);
    const q = c.req.query();
    let from = q.from || git.mergeBaseOid;
    let to = q.to || git.headOid;
    if (q.commit) {
      if (!OID.test(q.commit)) throw new HttpError(400, 'bad commit');
      to = q.commit;
      from = (await gitOut(git.clonePath, ['rev-parse', `${q.commit}^`], { readOnly: true }).catch(() => '')).trim() || git.mergeBaseOid;
    }
    if (!OID.test(from) || !OID.test(to)) throw new HttpError(400, 'bad range');
    for (const oid of [from, to]) {
      if (!(await hasCommit(git.clonePath, oid))) throw new HttpError(404, `Commit ${oid.slice(0, 7)} is not available offline`);
    }
    return c.json(await computeDiff(git.clonePath, from, to, { ignoreWhitespace: q.ws === '1' }));
  });

  app.get('/api/prs/:owner/:repo/:number/file-patch', async (c) => {
    const key = await resolveKey(c);
    const { git } = await requireGit(key);
    const { from, to, path: file, old, ws } = c.req.query();
    if (!OID.test(from ?? '') || !OID.test(to ?? '') || !file) throw new HttpError(400, 'bad request');
    return c.json({ patch: await filePatch(git.clonePath, from, to, file, old || null, ws === '1') });
  });

  app.get('/api/prs/:owner/:repo/:number/blob', async (c) => {
    const key = await resolveKey(c);
    const { git } = await requireGit(key);
    const { ref, path: file } = c.req.query();
    if (!OID.test(ref ?? '') || !file) throw new HttpError(400, 'bad request');
    const buf = await readBlob(git.clonePath, ref, file);
    if (!buf) return c.text('Not found', 404);
    const type = MIME[path.extname(file).toLowerCase()] ?? 'text/plain; charset=utf-8';
    return c.body(new Uint8Array(buf), 200, {
      'Content-Type': type.startsWith('text/html') || type.startsWith('text/javascript') ? 'text/plain; charset=utf-8' : type,
      'Cache-Control': 'private, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      ...UNTRUSTED_HEADERS,
    });
  });

  app.put('/api/prs/:owner/:repo/:number/viewed', async (c) => {
    const key = await resolveKey(c);
    const snap = await requireSnapshot(key);
    const { path: file, viewed } = await c.req.json<{ path: string; viewed: boolean }>();
    if (typeof file !== 'string') throw new HttpError(400, 'path required');
    const head = snap.git?.headOid ?? snap.pr.headRefOid;
    await updateLocal(key, (l) => {
      l.viewed[file] = { viewed: !!viewed, oid: head, at: now() };
    });
    await queueViewed(key, file, !!viewed, head);
    bus.emitEvent({ type: 'pr', key });
    return c.json({ ok: true });
  });

  app.put('/api/prs/:owner/:repo/:number/draft', async (c) => {
    const key = await resolveKey(c);
    const snap = await requireSnapshot(key);
    const { draft } = await c.req.json<{ draft: DraftReview | null }>();
    const head = snap.git?.headOid ?? snap.pr.headRefOid;
    await updateLocal(key, (l) => {
      l.draft = draft ? validDraft(draft, l.draft?.commitOid ?? head) : null;
    });
    bus.emitEvent({ type: 'prs' });
    return c.json({ ok: true });
  });

  app.post('/api/prs/:owner/:repo/:number/draft/move', async (c) => {
    const key = await resolveKey(c);
    const { git } = await requireGit(key);
    const result = await updateLocal(key, async (l) => {
      if (!l.draft) throw new HttpError(409, 'No pending review to move');
      if (!(await hasCommit(git.clonePath, l.draft.commitOid))) throw new HttpError(409, 'The version your review was written on is not available locally');
      const r = await moveDraft(git.clonePath, l.draft, git.headOid);
      l.draft = r.draft;
      return { moved: r.moved, toFile: r.toFile };
    });
    bus.emitEvent({ type: 'pr', key });
    return c.json(result);
  });

  app.post('/api/prs/:owner/:repo/:number/review', async (c) => {
    const key = await resolveKey(c);
    const snap = await requireSnapshot(key);
    const { event, body } = await c.req.json<{ event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES'; body: string }>();
    if (!['COMMENT', 'APPROVE', 'REQUEST_CHANGES'].includes(event)) throw new HttpError(400, 'bad event');
    if (snap.pr.author?.login === snap.viewer.login && event !== 'COMMENT') {
      throw new HttpError(400, "GitHub doesn't let you approve or request changes on your own PR.");
    }
    // Read, queue and clear the draft under one lock so a comment added at the same
    // moment can't be lost between the three steps.
    const item = await updateLocal(key, async (l) => {
      const d = l.draft;
      const hasComments = !!d && (d.threads.length > 0 || d.replies.length > 0);
      if (event !== 'APPROVE' && !hasComments && !String(body ?? '').trim()) {
        throw new HttpError(400, event === 'REQUEST_CHANGES' ? 'Add a summary saying what needs to change.' : 'Write a comment or add inline comments first.');
      }
      const queued = await queueReview({
        prKey: key,
        event,
        body: String(body ?? ''),
        commitOid: d?.commitOid ?? snap.git?.headOid ?? snap.pr.headRefOid,
        threads: d?.threads ?? [],
        replies: d?.replies ?? [],
      });
      l.draft = null;
      return queued;
    });
    bus.emitEvent({ type: 'pr', key });
    return c.json({ item, online: isOnline() });
  });

  app.post('/api/prs/:owner/:repo/:number/single', async (c) => {
    const key = await resolveKey(c);
    const snap = await requireSnapshot(key);
    const { thread, reply } = await c.req.json<{ thread?: DraftThread; reply?: any }>();
    if (!thread && !reply) throw new HttpError(400, 'nothing to send');
    if ((thread?.body ?? reply?.body ?? '').trim() === '') throw new HttpError(400, 'Comment is empty');
    const t = now();
    const item = await queueReview({
      prKey: key,
      event: 'COMMENT',
      body: '',
      commitOid: snap.git?.headOid ?? snap.pr.headRefOid,
      threads: thread ? [{ ...thread, localId: thread.localId || newId(), createdAt: t, updatedAt: t }] : [],
      replies: reply ? [{ ...reply, localId: reply.localId || newId(), createdAt: t, updatedAt: t }] : [],
      single: true,
    });
    bus.emitEvent({ type: 'pr', key });
    return c.json({ item, online: isOnline() });
  });

  app.post('/api/prs/:owner/:repo/:number/comment', async (c) => {
    const key = await resolveKey(c);
    const { body } = await c.req.json<{ body: string }>();
    if (!String(body ?? '').trim()) throw new HttpError(400, 'Comment is empty');
    const item = await queueComment(key, String(body));
    bus.emitEvent({ type: 'pr', key });
    return c.json({ item, online: isOnline() });
  });

  app.post('/api/prs/:owner/:repo/:number/resolve', async (c) => {
    const key = await resolveKey(c);
    const { threadId, resolve } = await c.req.json<{ threadId: string; resolve: boolean }>();
    if (typeof threadId !== 'string') throw new HttpError(400, 'threadId required');
    await updateLocal(key, (l) => {
      l.resolveOverrides[threadId] = !!resolve;
    });
    await queueResolve(key, threadId, !!resolve);
    bus.emitEvent({ type: 'pr', key });
    return c.json({ ok: true });
  });

  app.post('/api/prs/:owner/:repo/:number/open', async (c) => {
    const key = await resolveKey(c);
    const { editor, path: file, line } = await c.req.json<{ editor?: 'cursor' | 'code'; path?: string; line?: number }>().catch(() => ({}) as any);
    const local = await getLocal(key);
    const settings = await getSettings();
    if (!local.worktree?.path || local.worktree.error || !(await exists(local.worktree.path))) {
      throw new HttpError(409, local.worktree?.error ?? 'No checkout for this PR yet. Click "Create worktree" (works offline).');
    }
    await openInEditor(editor ?? settings.editor, local.worktree.path, file, line);
    return c.json({ ok: true, path: local.worktree.path });
  });

  app.post('/api/prs/:owner/:repo/:number/worktree', async (c) => {
    const key = await resolveKey(c);
    await requireGit(key);
    return c.json(await refreshWorktree(key));
  });

  app.post('/api/prs/:owner/:repo/:number/prepare', async (c) => {
    const key = await resolveKey(c);
    await startPrepare(key);
    return c.json({ ok: true, online: isOnline() });
  });

  app.get('/api/prs/:owner/:repo/:number/prepare-log', async (c) => {
    const key = await resolveKey(c);
    const l = await getLocal(key);
    return c.text(l.prepare?.logFile ? await tailFile(l.prepare.logFile, 24 * 1024) : '');
  });

  // ---- outbox ----

  app.get('/api/outbox', async (c) => {
    const items = await getOutbox();
    const titles: Record<string, string> = {};
    for (const k of new Set(items.map((x) => x.prKey))) titles[k] = (await getSnapshot(k))?.pr.title ?? k;
    return c.json({ items: annotateBlocked(items).filter((x) => x.type !== 'viewed' || x.status !== 'sent'), titles });
  });

  app.post('/api/outbox/send', async (c) => {
    if (!isOnline()) throw new HttpError(409, "You're offline. Queued items go out automatically when you're back online.");
    void processOutbox();
    return c.json({ ok: true });
  });

  app.post('/api/outbox/:id/:action', async (c) => {
    const action = c.req.param('action') as any;
    if (!['retry', 'confirm', 'as-comment', 'delete', 'to-draft'].includes(action)) throw new HttpError(400, 'bad action');
    await actOnItem(c.req.param('id')!, action);
    return c.json({ ok: true });
  });

  // ---- sync ----

  app.post('/api/sync', async (c) => {
    const { full } = await c.req.json<{ full?: boolean }>().catch(() => ({ full: false }));
    if (!isOnline()) throw new HttpError(409, "You're offline. Syncing will start automatically when you're back online.");
    void syncAll({ full: !!full });
    return c.json({ ok: true });
  });

  // ---- jira ----

  app.get('/api/jira/:key', async (c) => {
    const j = await getJira(c.req.param('key')!.toUpperCase());
    if (!j) throw new HttpError(404, 'Ticket not cached');
    return c.json(j);
  });

  app.post('/api/jira/login', async (c) => {
    const { email, token, baseUrl } = await c.req.json<{ email: string; token: string; baseUrl?: string }>();
    if (!email || !token) throw new HttpError(400, 'Email and API token are required');
    const settings = await updateSettings((s) => {
      s.jira.email = email.trim();
      if (baseUrl) s.jira.baseUrl = baseUrl.trim().replace(/\/+$/, '');
    });
    const base = settings.jira.baseUrl || (await getMeta()).learnedJira?.baseUrl;
    if (!base) throw new HttpError(400, 'Jira site URL is required (e.g. https://yourcompany.atlassian.net)');
    const name = await testJira({ baseUrl: base, email: email.trim(), token: token.trim() });
    await storeJiraToken(email.trim(), token.trim());
    bus.emitEvent({ type: 'status' });
    return c.json({ ok: true, name });
  });

  // ---- settings ----

  app.get('/api/settings', async (c) => {
    const settings = await getSettings();
    const meta = await getMeta();
    return c.json({ settings, editors: await availableEditors(), learnedJira: meta.learnedJira ?? null, jiraConfigured: !!(await getJiraCreds(settings)), home: paths.prs.replace(/\/prs$/, '') });
  });

  app.put('/api/settings', async (c) => {
    const patch = await c.req.json<Partial<Settings>>();
    const next = await updateSettings((s) => {
      if (Array.isArray(patch.codeRoots)) s.codeRoots = patch.codeRoots.map(String).filter(Boolean);
      if ('worktreeDir' in patch) s.worktreeDir = patch.worktreeDir ? String(patch.worktreeDir) : null;
      if (patch.editor === 'cursor' || patch.editor === 'code') s.editor = patch.editor;
      if (typeof patch.autoSyncMinutes === 'number' && patch.autoSyncMinutes >= 0) s.autoSyncMinutes = patch.autoSyncMinutes;
      if (patch.queue) {
        s.queue = {
          reviewRequested: !!patch.queue.reviewRequested,
          authored: !!patch.queue.authored,
          authoredMaxAgeDays: Math.max(0, Number(patch.queue.authoredMaxAgeDays ?? s.queue.authoredMaxAgeDays) || 0),
        };
      }
      if (patch.media) {
        s.media = {
          videos: !!patch.media.videos,
          maxVideoMB: Math.max(1, Number(patch.media.maxVideoMB) || s.media.maxVideoMB),
          maxImageMB: Math.max(1, Number(patch.media.maxImageMB) || s.media.maxImageMB),
        };
      }
      if (typeof patch.linkedPrs === 'boolean') s.linkedPrs = patch.linkedPrs;
      if (patch.jira) {
        s.jira.baseUrl = String(patch.jira.baseUrl ?? s.jira.baseUrl).replace(/\/+$/, '');
        if (Array.isArray(patch.jira.projectKeys)) s.jira.projectKeys = patch.jira.projectKeys.map((k) => String(k).toUpperCase()).filter(Boolean);
      }
      if (patch.repos && typeof patch.repos === 'object') s.repos = patch.repos;
    });
    return c.json(next);
  });

  // ---- static ----

  app.get('/assets/:file', async (c) => {
    const file = c.req.param('file')!;
    if (!/^[\w.-]+$/.test(file)) return c.text('Bad name', 400);
    return sendFile(c, path.join(paths.assets, file), 'immutable', true);
  });

  app.get('*', async (c) => {
    const p = decodeURIComponent(new URL(c.req.url).pathname);
    if (p.startsWith('/api/')) return c.json({ error: 'Not found' }, 404);
    if (p.startsWith('/static/') && !p.includes('..')) return sendFile(c, path.join(WEB_DIST, p), 'immutable');
    const direct = path.join(WEB_DIST, p);
    if (!p.includes('..') && p !== '/' && (await exists(direct)) && !(await fsp.stat(direct)).isDirectory()) return sendFile(c, direct, 'none');
    if (!(await exists(path.join(WEB_DIST, 'index.html')))) {
      return c.html('<h1>UI not built</h1><p>Run <code>npm run build</code> in the offline-github folder, then reload.</p>');
    }
    return sendFile(c, path.join(WEB_DIST, 'index.html'), 'none');
  });

  return app;
}
