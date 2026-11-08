import type { LocalState, OutboxItem, PRSnapshot, PRSummary, TrackedPR } from '../shared/types.js';
import { localUrlFor, localizeHtml } from './media.js';

async function localizeAvatars(obj: any): Promise<void> {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    for (const x of obj) await localizeAvatars(x);
    return;
  }
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (k === 'avatarUrl' && typeof v === 'string') obj[k] = await localUrlFor(v);
    else if (v && typeof v === 'object') await localizeAvatars(v);
  }
}

/** Copy of the snapshot with media pointing at the local cache. */
export async function presentSnapshot(snap: PRSnapshot): Promise<PRSnapshot> {
  const s: PRSnapshot = structuredClone(snap);
  s.pr.bodyHTML = await localizeHtml(s.pr.bodyHTML);
  for (const i of s.pr.closingIssues) i.bodyHTML = await localizeHtml(i.bodyHTML);
  for (const t of s.timeline) if (typeof t.bodyHTML === 'string') t.bodyHTML = await localizeHtml(t.bodyHTML);
  for (const th of s.threads) for (const c of th.comments) c.bodyHTML = await localizeHtml(c.bodyHTML);
  for (const r of s.reviews) r.bodyHTML = await localizeHtml(r.bodyHTML);
  await localizeAvatars(s);
  return s;
}

export function effectiveViewed(snap: PRSnapshot, local: LocalState, path: string): boolean {
  const l = local.viewed[path];
  if (l) return l.viewed;
  return snap.files.find((f) => f.path === path)?.viewerViewedState === 'VIEWED';
}

export async function summarize(t: TrackedPR, snap: PRSnapshot | null, local: LocalState, outbox: OutboxItem[]): Promise<PRSummary> {
  const mine = outbox.filter((x) => x.prKey === t.key && x.type !== 'viewed');
  const counts = { queued: 0, held: 0, failed: 0, sending: 0 };
  for (const x of mine) if (x.status in counts) counts[x.status as keyof typeof counts]++;
  const base: PRSummary = {
    key: t.key,
    owner: t.owner,
    repo: t.repo,
    number: t.number,
    sources: t.sources,
    linkedFrom: t.linkedFrom,
    lastSyncAt: t.lastSyncAt,
    lastSyncError: t.lastSyncError,
    cached: !!snap,
    outbox: counts,
    worktree: local.worktree,
    prepare: local.prepare,
  };
  if (!snap) return base;
  const pr = snap.pr;
  const resolvedNow = (id: string, isResolved: boolean) => local.resolveOverrides[id] ?? isResolved;
  const comments =
    snap.timeline.filter((x) => x.__typename === 'IssueComment').length + snap.threads.reduce((n, th) => n + th.comments.length, 0);
  return {
    ...base,
    title: pr.title,
    url: pr.url,
    state: pr.state,
    isDraft: pr.isDraft,
    author: pr.author ? { login: pr.author.login, avatarUrl: await localUrlFor(pr.author.avatarUrl) } : null,
    updatedAt: pr.updatedAt,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changedFiles,
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName,
    isPrivate: snap.repoInfo.isPrivate,
    reviewDecision: pr.reviewDecision,
    labels: pr.labels,
    commentCount: comments,
    unresolvedThreads: snap.threads.filter((th) => !resolvedNow(th.id, th.isResolved)).length,
    viewedCount: snap.files.filter((f) => effectiveViewed(snap, local, f.path)).length,
    draftCount: (local.draft?.threads.length ?? 0) + (local.draft?.replies.length ?? 0),
    hasNewActivity: !!local.lastSeenUpdatedAt && pr.updatedAt > local.lastSeenUpdatedAt,
    viewerIsAuthor: pr.author?.login === snap.viewer.login,
    viewerLatestReview: pr.viewerLatestReview,
    newCommitsSinceReview: !!local.lastReviewedOid && local.lastReviewedOid !== pr.headRefOid,
  };
}
