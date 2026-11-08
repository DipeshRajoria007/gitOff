import type { PRKey, PRSnapshot, SyncProgress, TrackSource, TrackedPR, WorktreeInfo } from '../shared/types.js';
import { bus } from './events.js';
import { GitHubError, graphql, graphqlRaw, isNetworkError } from './github/client.js';
import { PRNotFoundError, fetchPrSnapshot } from './github/fetchPr.js';
import { SEARCH_PRS, buildProbeQuery } from './github/queries.js';
import { changedPaths, deletePrRefs, ensureWorktree, fetchPrRefs, hasCommit, removeWorktree, resolveClone } from './git.js';
import { extractJiraKeys, fetchJiraIssue, getJiraCreds, learnJira } from './jira.js';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { assetKey, downloadMedia, extractMedia, pruneAssets, type MediaRef } from './media.js';
import { dropPendingViewed, pendingResolveThreads, pendingViewedPaths, processOutbox } from './outbox.js';
import {
  getJira,
  getLocal,
  getMeta,
  getOutbox,
  paths,
  getSettings,
  getSnapshot,
  getTracked,
  removePrData,
  saveSnapshot,
  updateLocal,
  updateMeta,
  updateTracked,
} from './store.js';
import { KeyedMutex, errMsg, now, pool, prKey, splitKey } from './util.js';

const prMutex = new KeyedMutex();

let progress: SyncProgress = { running: false };
export const getProgress = () => progress;

function setProgress(p: Partial<SyncProgress>) {
  progress = { ...progress, ...p };
  bus.emitEvent({ type: 'sync' });
}

// ---------------------------------------------------------------------------
// Tracking

const sameKey = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export async function trackPrs(
  refs: { owner: string; repo: string; number: number }[],
  source: TrackSource,
  linkedFrom?: PRKey,
): Promise<PRKey[]> {
  const keys = await updateTracked((list) => {
    const out: PRKey[] = [];
    for (const r of refs) {
      const key = prKey(r.owner, r.repo, r.number);
      const existing = list.find((t) => sameKey(t.key, key));
      if (existing) {
        if (!existing.sources.includes(source)) existing.sources.push(source);
        if (linkedFrom && !(existing.linkedFrom ?? []).includes(linkedFrom)) existing.linkedFrom = [...(existing.linkedFrom ?? []), linkedFrom];
        out.push(existing.key);
      } else {
        list.push({ key, owner: r.owner, repo: r.repo, number: r.number, sources: [source], addedAt: now(), linkedFrom: linkedFrom ? [linkedFrom] : undefined });
        out.push(key);
      }
    }
    return out;
  });
  bus.emitEvent({ type: 'prs' });
  return keys;
}

export async function untrackPr(key: PRKey, opts: { removeWorktree?: boolean } = {}): Promise<{ worktreeRemoved: boolean; note?: string }> {
  // Wait for a sync of this PR to finish, so it can't write the PR back afterwards.
  return prMutex.run(key, () => untrackUnlocked(key, opts));
}

async function untrackUnlocked(key: PRKey, opts: { removeWorktree?: boolean }): Promise<{ worktreeRemoved: boolean; note?: string }> {
  const snap = await getSnapshot(key);
  const local = await getLocal(key);
  let worktreeRemoved = false;
  let note: string | undefined;
  if (opts.removeWorktree && snap?.git && local.worktree && !local.worktree.existing && !local.worktree.error) {
    try {
      await removeWorktree(snap.git.clonePath, local.worktree.path, snap.number);
      worktreeRemoved = true;
    } catch (e) {
      note = errMsg(e);
    }
  }
  if (snap?.git) await deletePrRefs(snap.git.clonePath, snap.number).catch(() => {});
  await updateTracked((list) => {
    const i = list.findIndex((t) => sameKey(t.key, key));
    if (i >= 0) list.splice(i, 1);
  });
  await removePrData(key);
  bus.emitEvent({ type: 'prs' });
  return { worktreeRemoved, note };
}

// ---------------------------------------------------------------------------
// One PR

function allHtml(snap: Pick<PRSnapshot, 'pr' | 'timeline' | 'threads' | 'reviews'>): string[] {
  const out = [snap.pr.bodyHTML];
  for (const t of snap.timeline) if (t.bodyHTML) out.push(t.bodyHTML);
  for (const th of snap.threads) for (const c of th.comments) out.push(c.bodyHTML);
  for (const r of snap.reviews) out.push(r.bodyHTML);
  for (const i of snap.pr.closingIssues) out.push(i.bodyHTML);
  return out;
}

function collectAvatars(obj: unknown, out: Set<string>) {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    for (const x of obj) collectAvatars(x, out);
    return;
  }
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (k === 'avatarUrl' && typeof v === 'string') out.add(v);
    else if (v && typeof v === 'object') collectAvatars(v, out);
  }
}

function collectMedia(snap: Pick<PRSnapshot, 'pr' | 'timeline' | 'threads' | 'reviews' | 'commits'>): MediaRef[] {
  const refs: MediaRef[] = [];
  for (const html of allHtml(snap)) refs.push(...extractMedia(html));
  const avatars = new Set<string>();
  collectAvatars(snap, avatars);
  for (const a of avatars) refs.push({ url: a, kind: 'image' });
  return refs;
}

// Only explicit references count: a full PR URL or "owner/repo#123" in the markdown the
// author wrote. A bare "#123" is ambiguous: "other-repo #167" gets auto-linked by GitHub to
// *this* repo's #167, which is usually some unrelated old PR.
const PR_URL_RE = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g;
const PR_XREF_RE = /(?<![\w/.-])([\w.-]+)\/([\w.-]+)#(\d+)\b/g;

export function explicitPrRefs(texts: string[], self: string): { owner: string; repo: string; number: number }[] {
  const prs = new Map<string, { owner: string; repo: string; number: number }>();
  for (const t of texts) {
    for (const re of [PR_URL_RE, PR_XREF_RE]) {
      for (const m of (t ?? '').matchAll(re)) {
        const ref = { owner: m[1], repo: m[2], number: Number(m[3]) };
        const key = prKey(ref.owner, ref.repo, ref.number);
        if (!sameKey(key, self)) prs.set(key.toLowerCase(), ref);
      }
    }
  }
  return [...prs.values()];
}

async function findLinks(snap: PRSnapshot): Promise<PRSnapshot['linked']> {
  const settings = await getSettings();
  const texts = [snap.pr.body, ...snap.timeline.filter((t) => t.__typename === 'IssueComment' && t.author?.login === snap.pr.author?.login).map((t) => t.body as string)];
  const prs = explicitPrRefs(texts, snap.key);
  const meta = await getMeta();
  const known = [...settings.jira.projectKeys, ...(meta.learnedJira?.projectKeys ?? [])];
  const plain = [snap.pr.title, snap.pr.headRefName, snap.pr.body, ...snap.commits.map((c) => c.messageHeadline)];
  const jira = extractJiraKeys([snap.pr.bodyHTML], plain, known);
  await learnJira(jira.sites, jira.projects.filter((p) => !known.includes(p)));
  return {
    prs: prs.slice(0, 10).map((r) => prKey(r.owner, r.repo, r.number)),
    jira: jira.keys.slice(0, 10),
  };
}

/** Of these PRs, the ones still open (linked PRs are only worth caching while open). */
async function openOnly(keys: PRKey[]): Promise<PRKey[]> {
  if (!keys.length) return [];
  const r = await graphqlRaw<any>(buildProbeQuery(keys.map(splitKey)));
  return keys.filter((_, i) => r.data?.[`p${i}`]?.pullRequest?.state === 'OPEN');
}

export interface SyncPrResult {
  key: PRKey;
  ok: boolean;
  error?: string;
  mediaFailed?: number;
}

export function isSyncingPr(key: PRKey): boolean {
  return prMutex.isBusy(key);
}

export async function syncPr(key: PRKey, opts: { followLinks?: boolean } = {}): Promise<SyncPrResult> {
  return prMutex.run(key, async () => {
    const { owner, repo, number } = splitKey(key);
    if (!(await getTracked()).some((t) => sameKey(t.key, key))) return { key, ok: false, error: 'not tracked' };
    const settings = await getSettings();
    const prev = await getSnapshot(key);
    bus.emitEvent({ type: 'pr', key });
    try {
      const fetched = await fetchPrSnapshot(owner, repo, number);
      const snap: PRSnapshot = { ...fetched, key, git: prev?.git, linked: prev?.linked ?? { prs: [], jira: [] } };
      if (snap.viewer.login !== 'unknown') {
        await updateMeta((m) => {
          m.viewer = snap.viewer;
        });
      }

      // Media first: private image URLs are signed and expire after ~5 minutes.
      const media = await downloadMedia(collectMedia(snap), settings.media, async () => collectMedia(await fetchPrSnapshot(owner, repo, number)));

      snap.linked = await findLinks(snap);

      try {
        const clone = await resolveClone(owner, repo, settings);
        const g = await fetchPrRefs({
          clonePath: clone.path,
          owner,
          repo,
          number,
          baseRefName: snap.pr.baseRefName,
          baseRefOid: snap.pr.baseRefOid,
          headRefOid: snap.pr.headRefOid,
        });
        snap.git = { clonePath: clone.path, cloneKind: clone.kind, ...g, fetchedAt: now() };
        delete snap.gitError;
      } catch (e) {
        if (isNetworkError(e)) throw e;
        snap.gitError = errMsg(e);
      }
      await saveSnapshot(snap);
      const tracked = (await getTracked()).find((x) => sameKey(x.key, key));
      // PRs you review (or add by hand) get a worktree automatically. Your own PRs and
      // linked PRs get one only when you ask; ones that left your queue only keep one
      // that already exists.
      const ownPr = snap.pr.author?.login === snap.viewer.login;
      const autoWorktree = !ownPr && !!tracked && tracked.sources.some((s) => s === 'review-requested' || s === 'manual');
      await reconcileLocal(snap, settings, autoWorktree);

      await updateTracked((list) => {
        const t = list.find((x) => sameKey(x.key, key));
        if (!t) return;
        t.lastSyncAt = now();
        t.lastSyncError = undefined;
        t.lastMediaErrors = media.failed.length || undefined;
        t.probe = { updatedAt: snap.pr.updatedAt, head: snap.pr.headRefOid, state: snap.pr.state, fetchedAt: snap.fetchedAt };
        t.links = snap.linked.prs;
      });

      if (opts.followLinks !== false && settings.linkedPrs && snap.linked.prs.length) {
        const open = await openOnly(snap.linked.prs);
        const added = open.length ? await trackPrs(open.map(splitKey), 'linked', key) : [];
        for (const k of added) {
          if (!(await getSnapshot(k))) {
            // Linked PRs are fetched in the background; don't block this PR on them.
            void syncPr(k, { followLinks: false }).catch(() => {});
          }
        }
      }
      bus.emitEvent({ type: 'pr', key });
      return { key, ok: true, mediaFailed: media.failed.length };
    } catch (e) {
      const msg = e instanceof PRNotFoundError ? `Not found or no access: ${errMsg(e)}` : errMsg(e);
      await updateTracked((list) => {
        const t = list.find((x) => sameKey(x.key, key));
        if (t) t.lastSyncError = msg;
      });
      bus.emitEvent({ type: 'pr', key });
      if (isNetworkError(e)) throw e;
      return { key, ok: false, error: msg };
    }
  });
}

/** Bring local review state in line with a fresh snapshot. Slow git work stays outside the per-PR lock. */
async function reconcileLocal(snap: PRSnapshot, settings: Awaited<ReturnType<typeof getSettings>>, autoWorktree: boolean) {
  const pendingViewed = await pendingViewedPaths(snap.key);
  const pendingResolve = await pendingResolveThreads(snap.key);
  const git = snap.git;

  // Which files changed since each commit you marked files "viewed" at?
  const before = await getLocal(snap.key);
  const changedSince = new Map<string, Set<string>>();
  if (git) {
    for (const v of Object.values(before.viewed)) {
      if (!v.viewed || v.oid === git.headOid || changedSince.has(v.oid)) continue;
      if (await hasCommit(git.clonePath, v.oid)) changedSince.set(v.oid, await changedPaths(git.clonePath, v.oid, git.headOid).catch(() => new Set<string>()));
    }
  }

  const unviewed: string[] = [];
  await updateLocal(snap.key, (l) => {
    if (git && !l.seenHeads.includes(git.headOid)) l.seenHeads.push(git.headOid);
    // GitHub is the source of truth for "viewed" once our change has been sent.
    for (const [p, v] of Object.entries(l.viewed)) {
      if (!pendingViewed.has(p)) {
        delete l.viewed[p];
        continue;
      }
      if (git && v.viewed && v.oid !== git.headOid && changedSince.get(v.oid)?.has(p)) {
        v.viewed = false;
        v.changedSinceViewed = true;
        unviewed.push(p);
      }
    }
    for (const id of Object.keys(l.resolveOverrides)) if (!pendingResolve.has(id)) delete l.resolveOverrides[id];
    // An empty draft follows the latest head.
    if (l.draft && !l.draft.threads.length && !l.draft.replies.length && !l.draft.body.trim()) l.draft = null;
    const gh = snap.pr.viewerLatestReview?.commitOid;
    if (gh && gh !== l.lastReviewedOid && snap.pr.viewerLatestReview?.state !== 'PENDING') l.lastReviewedOid = gh;
  });
  // Don't tell GitHub you viewed a file that changed after you looked at it.
  for (const p of unviewed) await dropPendingViewed(snap.key, p);

  if (git && (autoWorktree || (before.worktree && !before.worktree.error))) await refreshWorktreeUnlocked(snap, settings);
}

async function refreshWorktreeUnlocked(snap: PRSnapshot, settings: Awaited<ReturnType<typeof getSettings>>) {
  const git = snap.git!;
  const previous = (await getLocal(snap.key)).worktree;
  let info: WorktreeInfo;
  try {
    info = await ensureWorktree({
      clone: { path: git.clonePath, kind: git.cloneKind },
      settings,
      repo: snap.repo,
      number: snap.number,
      headOid: git.headOid,
      headRefName: snap.pr.headRefName,
      viewerIsAuthor: snap.pr.author?.login === snap.viewer.login,
      isCrossRepository: snap.pr.isCrossRepository,
      previous: previous?.error ? undefined : previous,
    });
  } catch (e) {
    info = { ...(previous ?? { path: '', headOid: git.headOid, branch: null, createdAt: now() }), error: errMsg(e) };
  }
  await updateLocal(snap.key, (l) => {
    l.worktree = info;
  });
  return info;
}

/** Create or update a PR's worktree now (works offline once the code is fetched). */
export async function refreshWorktree(key: PRKey): Promise<WorktreeInfo> {
  return prMutex.run(key, async () => {
    const snap = await getSnapshot(key);
    if (!snap?.git) throw new Error('The code for this PR has not been fetched yet.');
    const info = await refreshWorktreeUnlocked(snap, await getSettings());
    bus.emitEvent({ type: 'pr', key });
    return info;
  });
}

// ---------------------------------------------------------------------------
// Everything

async function refreshQueue(): Promise<void> {
  const settings = await getSettings();
  const queries: [TrackSource, string][] = [];
  if (settings.queue.reviewRequested) queries.push(['review-requested', 'is:pr is:open review-requested:@me archived:false']);
  if (settings.queue.authored) {
    // Only recently active PRs of yours: people often have dozens of stale open PRs.
    const days = settings.queue.authoredMaxAgeDays;
    const since = days > 0 ? ` updated:>=${new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10)}` : '';
    queries.push(['authored', `is:pr is:open author:@me archived:false${since}`]);
  }
  for (const [source, q] of queries) {
    const r = await graphql<any>(SEARCH_PRS, { q });
    const refs = (r?.search?.nodes ?? [])
      .filter((n: any) => n?.repository?.nameWithOwner)
      .map((n: any) => {
        const [owner, repo] = n.repository.nameWithOwner.split('/');
        return { owner, repo, number: n.number as number };
      });
    const keys = new Set((await trackPrs(refs, source)).map((k) => k.toLowerCase()));
    await updateTracked((list) => {
      for (const t of list) {
        if (t.sources.includes(source) && !keys.has(t.key.toLowerCase())) t.sources = t.sources.filter((s) => s !== source);
      }
    });
  }
  await updateMeta((m) => {
    m.lastQueueAt = now();
  });
}

const STALE_MS = 6 * 60 * 60 * 1000;
const DAY = 86400_000;

/**
 * Forget PRs you're done with: closed, or no longer in your queue, quiet for a week,
 * and with nothing unsent. Their worktrees go too, unless they hold changes or
 * commits of yours.
 */
async function cleanup(): Promise<number> {
  const tracked = await getTracked();
  const outbox = await getOutbox();
  const keys = new Set(tracked.map((t) => t.key.toLowerCase()));
  let removed = 0;
  for (const t of tracked) {
    if (outbox.some((x) => x.prKey === t.key && x.status !== 'sent')) continue;
    const d = (await getLocal(t.key)).draft;
    if (d && (d.threads.length || d.replies.length || d.body.trim())) continue;
    const quietFor = Date.now() - Date.parse(t.probe?.updatedAt ?? t.addedAt);
    const closed = t.probe?.state === 'MERGED' || t.probe?.state === 'CLOSED';
    const linkedOnly = t.sources.length > 0 && t.sources.every((s) => s === 'linked');
    const orphan = t.sources.length === 0 || (linkedOnly && !(t.linkedFrom ?? []).some((k) => keys.has(k.toLowerCase())));
    if ((closed || orphan) && quietFor > 7 * DAY) {
      await untrackPr(t.key, { removeWorktree: true });
      removed++;
    }
  }
  if (removed) {
    // Media and tickets nothing refers to any more.
    const keepKeys = new Set<string>();
    const keepFiles = new Set<string>();
    const jiraKeep = new Set<string>();
    for (const t of await getTracked()) {
      const s = await getSnapshot(t.key);
      if (!s) continue;
      for (const r of collectMedia(s)) {
        const k = assetKey(r.url);
        if (k) keepKeys.add(k);
      }
      for (const j of s.linked.jira) jiraKeep.add(j);
    }
    for (const f of await fsp.readdir(paths.jira).catch(() => [] as string[])) {
      const key = f.replace(/\.json$/, '');
      if (!jiraKeep.has(key)) {
        await fsp.rm(path.join(paths.jira, f), { force: true });
        continue;
      }
      const raw = await fsp.readFile(path.join(paths.jira, f), 'utf8').catch(() => '');
      for (const m of raw.matchAll(/\/assets\/([\w.-]+)/g)) keepFiles.add(m[1]);
    }
    await pruneAssets(keepKeys, keepFiles);
  }
  return removed;
}

async function probeChanged(tracked: TrackedPR[]): Promise<TrackedPR[]> {
  const out: TrackedPR[] = [];
  const candidates: TrackedPR[] = [];
  for (const t of tracked) {
    if (!t.probe || t.lastSyncError || (t.probe.state === 'OPEN' && Date.now() - Date.parse(t.probe.fetchedAt) > STALE_MS)) out.push(t);
    else candidates.push(t);
  }
  for (let i = 0; i < candidates.length; i += 25) {
    const chunk = candidates.slice(i, i + 25);
    const r = await graphqlRaw<any>(buildProbeQuery(chunk.map((c) => splitKey(c.key))));
    chunk.forEach((c, j) => {
      const p = r.data?.[`p${j}`]?.pullRequest;
      if (!p || p.updatedAt !== c.probe!.updatedAt || p.headRefOid !== c.probe!.head || p.state !== c.probe!.state) out.push(c);
    });
  }
  return out;
}

async function syncJira(force: boolean): Promise<string | null> {
  const settings = await getSettings();
  const creds = await getJiraCreds(settings);
  const tracked = await getTracked();
  const keys = new Set<string>();
  for (const t of tracked) {
    const s = await getSnapshot(t.key);
    for (const k of s?.linked.jira ?? []) keys.add(k);
  }
  if (!keys.size) return null;
  if (!creds) return `${keys.size} Jira ticket(s) referenced; run \`gitoff jira login\` to cache them`;
  let failed = 0;
  await pool([...keys], 3, async (k) => {
    const cached = await getJira(k);
    if (cached && !cached.error && !force && Date.now() - Date.parse(cached.fetchedAt) < 60 * 60 * 1000) return;
    try {
      await fetchJiraIssue(creds, k, settings.media);
    } catch (e) {
      if (isNetworkError(e)) throw e;
      failed++;
    }
  });
  return failed ? `${failed} Jira ticket(s) could not be fetched` : null;
}

let currentRun: Promise<SyncProgress> | null = null;

export function syncAll(opts: { full?: boolean } = {}): Promise<SyncProgress> {
  if (currentRun) return currentRun;
  currentRun = (async () => {
    setProgress({ running: true, phase: 'Sending outbox', startedAt: now(), done: 0, total: 0, current: undefined, lastError: undefined });
    const notes: string[] = [];
    try {
      await processOutbox();
      setProgress({ phase: 'Checking your review queue' });
      await refreshQueue();
      setProgress({ phase: 'Checking for updates' });
      const tracked = await getTracked();
      const todo = opts.full ? tracked : await probeChanged(tracked);
      setProgress({ phase: 'Downloading PRs', total: todo.length, done: 0 });
      let done = 0;
      let failed = 0;
      await pool(todo, 3, async (t) => {
        setProgress({ current: t.key });
        const r = await syncPr(t.key);
        if (!r.ok) failed++;
        setProgress({ done: ++done });
      });
      // Linked PRs discovered during this run that haven't been fetched yet.
      const fresh = (await getTracked()).filter((t) => !t.probe && !todo.some((x) => sameKey(x.key, t.key)));
      if (fresh.length) {
        setProgress({ phase: 'Downloading linked PRs', total: todo.length + fresh.length });
        await pool(fresh, 3, async (t) => {
          setProgress({ current: t.key });
          const r = await syncPr(t.key, { followLinks: false });
          if (!r.ok) failed++;
          setProgress({ done: ++done });
        });
      }
      setProgress({ phase: 'Jira tickets', current: undefined });
      const jiraNote = await syncJira(!!opts.full);
      if (jiraNote) notes.push(jiraNote);
      const meta = await getMeta();
      if (!meta.lastCleanupAt || Date.now() - Date.parse(meta.lastCleanupAt) > 6 * 3600_000) {
        setProgress({ phase: 'Cleaning up' });
        const removed = await cleanup();
        if (removed) notes.push(`removed ${removed} finished PR(s)`);
        await updateMeta((m) => {
          m.lastCleanupAt = now();
        });
      }
      await updateMeta((m) => {
        m.lastSyncAt = now();
        if (opts.full) m.lastFullSyncAt = now();
      });
      notes.unshift(`${done - failed} PR(s) updated${failed ? `, ${failed} failed` : ''}`);
      setProgress({ running: false, phase: undefined, current: undefined, lastRunAt: now(), ...(opts.full ? { lastFullRunAt: now() } : {}), lastResult: notes.join(' · ') });
    } catch (e) {
      const offline = isNetworkError(e);
      setProgress({
        running: false,
        phase: undefined,
        current: undefined,
        lastRunAt: now(),
        lastError: offline ? 'Went offline during sync; it will continue when the connection is back.' : errMsg(e),
      });
    } finally {
      currentRun = null;
    }
    return progress;
  })();
  return currentRun;
}

export { GitHubError };
