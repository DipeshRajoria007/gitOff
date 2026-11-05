import type {
  DraftReply,
  DraftThread,
  OutboxComment,
  OutboxItem,
  OutboxResolve,
  OutboxReview,
  OutboxViewed,
  PRKey,
  ReviewEvent,
} from '../shared/types.js';
import { bus } from './events.js';
import { GitHubError, graphql, graphqlRaw, isNetworkError, isTransient, mutate, rest } from './github/client.js';
import { fetchPrRefs, hasCommit } from './git.js';
import { moveDraft } from './remap.js';
import { getOutbox, getSnapshot, updateLocal, updateOutbox } from './store.js';
import { errMsg, newId, now, sleep, splitKey } from './util.js';

// ---------------------------------------------------------------------------
// Queueing

function base(prKey: PRKey) {
  const t = now();
  return { id: newId(), prKey, createdAt: t, updatedAt: t, status: 'queued' as const, attempts: 0 };
}

export async function queueReview(args: {
  prKey: PRKey;
  event: ReviewEvent;
  body: string;
  commitOid: string;
  threads: DraftThread[];
  replies: DraftReply[];
  single?: boolean;
}): Promise<OutboxReview> {
  const item: OutboxReview = {
    ...base(args.prKey),
    type: 'review',
    event: args.event,
    body: args.body,
    commitOid: args.commitOid,
    threads: args.threads,
    replies: args.replies,
    single: args.single,
    progress: { threads: {}, replies: {}, bodyAppendix: [] },
  };
  await updateOutbox((items) => void items.push(item));
  changed();
  return item;
}

export async function queueComment(prKey: PRKey, body: string): Promise<OutboxComment> {
  const item: OutboxComment = { ...base(prKey), type: 'comment', body };
  await updateOutbox((items) => void items.push(item));
  changed();
  return item;
}

export async function queueResolve(prKey: PRKey, threadId: string, resolve: boolean): Promise<void> {
  await updateOutbox((items) => {
    // A newer resolve/unresolve for the same thread replaces an unsent one.
    for (let i = items.length - 1; i >= 0; i--) {
      const x = items[i];
      if (x.type === 'resolve' && x.threadId === threadId && x.status !== 'sent' && x.status !== 'sending') items.splice(i, 1);
    }
    const item: OutboxResolve = { ...base(prKey), type: 'resolve', threadId, resolve };
    items.push(item);
  });
  changed();
}

export async function queueViewed(prKey: PRKey, path: string, viewed: boolean, oid?: string): Promise<void> {
  await updateOutbox((items) => {
    for (let i = items.length - 1; i >= 0; i--) {
      const x = items[i];
      if (x.type === 'viewed' && x.prKey === prKey && x.path === path && x.status !== 'sent' && x.status !== 'sending') items.splice(i, 1);
    }
    const item: OutboxViewed = { ...base(prKey), type: 'viewed', path, viewed, oid };
    items.push(item);
  });
  changed();
}

const isPending = (x: OutboxItem) => x.status !== 'sent';

/** The file changed after you ticked "viewed": don't tell GitHub you viewed the new version. */
export async function dropPendingViewed(prKey: PRKey, path: string): Promise<void> {
  await updateOutbox((items) => {
    for (let i = items.length - 1; i >= 0; i--) {
      const x = items[i];
      if (x.type === 'viewed' && x.prKey === prKey && x.path === path && x.viewed && x.status !== 'sent' && x.status !== 'sending') items.splice(i, 1);
    }
  });
}

/** Annotate queued reviews that wait for an earlier unsent review on the same PR. */
export function annotateBlocked(items: OutboxItem[]): OutboxItem[] {
  const first = new Map<string, string>();
  return items.map((x) => {
    if (x.type !== 'review' || x.single || x.status === 'sent') return x;
    const earlier = first.get(x.prKey);
    if (!earlier) {
      first.set(x.prKey, x.id);
      return x;
    }
    return { ...x, blockedBy: earlier };
  });
}

export async function pendingViewedPaths(prKey: PRKey): Promise<Set<string>> {
  const items = await getOutbox();
  return new Set(items.filter((x): x is OutboxViewed => x.type === 'viewed' && x.prKey === prKey && isPending(x)).map((x) => x.path));
}

export async function pendingResolveThreads(prKey: PRKey): Promise<Set<string>> {
  const items = await getOutbox();
  return new Set(items.filter((x): x is OutboxResolve => x.type === 'resolve' && x.prKey === prKey && isPending(x)).map((x) => x.threadId));
}

export async function outboxCounts() {
  const items = await getOutbox();
  const c = { queued: 0, held: 0, failed: 0, sending: 0 };
  for (const x of items) {
    if (x.type === 'viewed' && x.status === 'queued') continue; // too noisy to count
    if (x.status === 'queued') c.queued++;
    else if (x.status === 'held') c.held++;
    else if (x.status === 'failed') c.failed++;
    else if (x.status === 'sending') c.sending++;
  }
  return c;
}

function changed() {
  bus.emitEvent({ type: 'outbox' });
  bus.emitEvent({ type: 'status' });
  kick();
}

// ---------------------------------------------------------------------------
// User actions on items

export async function actOnItem(id: string, action: 'retry' | 'confirm' | 'as-comment' | 'delete' | 'to-draft'): Promise<void> {
  // A review that is half-sent has a pending (invisible) review on GitHub. Throwing the
  // item away must discard that too, or the next review would publish its comments.
  const current = (await getOutbox()).find((x) => x.id === id);
  if (
    current?.type === 'review' &&
    (action === 'delete' || action === 'to-draft') &&
    current.status !== 'sent' &&
    current.status !== 'sending' &&
    current.progress.reviewId &&
    !current.progress.submitted
  ) {
    if (!isOnline()) throw new Error('Part of this review is already on GitHub as a pending review. Connect to the internet to discard it.');
    await discardPendingReview(current.progress.reviewId);
    await updateOutbox((items) => {
      const x = items.find((y) => y.id === id);
      if (x?.type === 'review') x.progress = { threads: {}, replies: {}, bodyAppendix: [] };
    });
  }

  let restore: OutboxReview | null = null;
  await updateOutbox((items) => {
    const i = items.findIndex((x) => x.id === id);
    if (i < 0) throw new Error('Outbox item not found');
    const item = items[i];
    if (item.status === 'sending') throw new Error('That item is being sent right now.');
    if (item.status === 'sent' && action !== 'delete') throw new Error('Already sent.');
    switch (action) {
      case 'retry':
        Object.assign(item, { status: 'queued', lastError: undefined, heldReason: undefined, nextAttemptAt: undefined, updatedAt: now() });
        break;
      case 'confirm':
        if (item.type !== 'review') throw new Error('Only reviews can be confirmed');
        Object.assign(item, { status: 'queued', confirmedStale: true, heldReason: undefined, lastError: undefined, nextAttemptAt: undefined, updatedAt: now() });
        break;
      case 'as-comment':
        if (item.type !== 'review') throw new Error('Only reviews can be converted');
        Object.assign(item, { status: 'queued', event: 'COMMENT', heldReason: undefined, lastError: undefined, nextAttemptAt: undefined, updatedAt: now() });
        break;
      case 'delete':
        if (item.type === 'review' && item.status !== 'sent' && item.progress.reviewId && !item.progress.submitted) {
          throw new Error('This review is still attached to a pending review on GitHub; try again.');
        }
        items.splice(i, 1);
        break;
      case 'to-draft':
        if (item.type !== 'review') throw new Error('Only reviews can go back to draft');
        if (item.progress.reviewId) throw new Error('This review is still attached to a pending review on GitHub; try again.');
        restore = item;
        items.splice(i, 1);
        break;
    }
  });
  if (restore) {
    const r: OutboxReview = restore;
    await updateLocal(r.prKey, (l) => {
      const d = l.draft ?? { commitOid: r.commitOid, body: '', threads: [], replies: [], updatedAt: now() };
      d.threads = [...r.threads, ...d.threads.filter((t) => !r.threads.some((x) => x.localId === t.localId))];
      d.replies = [...r.replies, ...d.replies.filter((t) => !r.replies.some((x) => x.localId === t.localId))];
      d.body = d.body || r.body;
      d.commitOid = r.commitOid;
      d.updatedAt = now();
      l.draft = d;
    });
    bus.emitEvent({ type: 'pr', key: r.prKey });
  }
  changed();
}

const M_DELETE_REVIEW = `mutation($id: ID!) { deletePullRequestReview(input: {pullRequestReviewId: $id}) { pullRequestReview { id } } }`;

async function discardPendingReview(reviewId: string): Promise<void> {
  const node = await reviewNode(reviewId);
  if (!node) return; // already gone
  if (node.state !== 'PENDING') throw new Error('That review has already been submitted on GitHub.');
  await mutate(M_DELETE_REVIEW, { id: reviewId });
}

// ---------------------------------------------------------------------------
// Sending

let afterSend: (keys: PRKey[]) => void = () => {};
export function onAfterSend(fn: (keys: PRKey[]) => void) {
  afterSend = fn;
}

let processing: Promise<void> | null = null;
let kickTimer: NodeJS.Timeout | null = null;
let isOnline: () => boolean = () => true;
export function setOnlineProbe(fn: () => boolean) {
  isOnline = fn;
}

/** Ask the sender to run soon (debounced). */
export function kick() {
  if (kickTimer) return;
  kickTimer = setTimeout(() => {
    kickTimer = null;
    if (isOnline()) void processOutbox();
  }, 500);
}

/** Needs the user's decision before it can go out. */
class HoldError extends Error {}
/** GitHub accepted something that doesn't match what was asked; needs a human look. */
class FailError extends Error {}

/**
 * Every body we post carries an invisible marker, so after a lost response the
 * next attempt can see what already reached GitHub instead of posting it twice.
 */
const MARK = (id: string) => `<!-- ogh:${id} -->`;
const withMark = (body: string, id: string) => `${body.trimEnd()}\n\n${MARK(id)}`;
const markersIn = (bodies: string[]) => {
  const out = new Set<string>();
  for (const b of bodies) for (const m of (b ?? '').matchAll(/<!-- ogh:([\w-]+) -->/g)) out.add(m[1]);
  return out;
};

/** Persist progress of the item being sent (nobody else edits an item while it's "sending"). */
async function save(item: OutboxItem) {
  item.updatedAt = now();
  await updateOutbox((items) => {
    const i = items.findIndex((x) => x.id === item.id);
    if (i >= 0) items[i] = item;
  });
  bus.emitEvent({ type: 'outbox' });
}

const PRIORITY: Record<OutboxItem['type'], number> = { comment: 0, review: 0, resolve: 1, viewed: 2 };

/** Atomically pick the next item that may go out and mark it "sending". */
async function pickNext(): Promise<OutboxItem | null> {
  return updateOutbox((items) => {
    const t = Date.now();
    const reviewTaken = new Set<string>();
    const candidates: { x: OutboxItem; i: number }[] = [];
    items.forEach((x, i) => {
      if (x.status === 'sent') return;
      if (x.type === 'review' && !x.single) {
        // One pending review per PR on GitHub: reviews for a PR go strictly in order.
        if (reviewTaken.has(x.prKey)) return;
        reviewTaken.add(x.prKey);
      }
      if (x.status === 'queued' && (!x.nextAttemptAt || Date.parse(x.nextAttemptAt) <= t)) candidates.push({ x, i });
    });
    const pick = candidates.sort((a, b) => PRIORITY[a.x.type] - PRIORITY[b.x.type] || a.i - b.i)[0]?.x;
    if (!pick) return null;
    pick.status = 'sending';
    pick.attempts++;
    pick.updatedAt = now();
    return structuredClone(pick);
  });
}

export function processOutbox(): Promise<void> {
  if (processing) return processing;
  processing = (async () => {
    const touched = new Set<PRKey>();
    const cache: RunCache = { heads: new Map(), compares: new Map() };
    try {
      // Anything left "sending" by a crash goes back in the queue (sends are idempotent).
      await updateOutbox((items) => {
        for (const x of items) if (x.status === 'sending') x.status = 'queued';
      });
      while (true) {
        const next = await pickNext();
        if (!next) break;
        bus.emitEvent({ type: 'outbox' });
        bus.emitEvent({ type: 'status' });
        try {
          await sendItem(next, cache);
          next.status = 'sent';
          next.sentAt = now();
          next.lastError = undefined;
          next.heldReason = undefined;
          next.nextAttemptAt = undefined;
          touched.add(next.prKey);
          await save(next);
        } catch (e) {
          if (e instanceof HoldError) {
            next.status = 'held';
            next.heldReason = e.message;
            await save(next);
          } else if (isTransient(e)) {
            next.status = 'queued';
            next.lastError = errMsg(e);
            const rate = e instanceof GitHubError && e.types.includes('RATE_LIMITED');
            const delay = rate ? 10 * 60_000 : Math.min(5 * 60_000, 15_000 * 2 ** Math.min(next.attempts, 5));
            next.nextAttemptAt = new Date(Date.now() + delay).toISOString();
            await save(next);
            break; // offline, rate limited or GitHub having a moment: try again later
          } else {
            next.status = 'failed';
            next.lastError = errMsg(e);
            await save(next);
          }
        }
        await sleep(200); // stay well under GitHub's secondary rate limits
      }
      await pruneSent();
    } finally {
      processing = null;
      bus.emitEvent({ type: 'status' });
      if (touched.size) afterSend([...touched]);
    }
  })();
  return processing;
}

async function pruneSent() {
  await updateOutbox((items) => {
    const nowMs = Date.now();
    for (let i = items.length - 1; i >= 0; i--) {
      const x = items[i];
      if (x.status !== 'sent') continue;
      const age = nowMs - Date.parse(x.sentAt ?? x.updatedAt);
      const keep = x.type === 'viewed' || x.type === 'resolve' ? 2 * 86400_000 : 14 * 86400_000;
      if (age > keep) items.splice(i, 1);
    }
  });
}

export async function resetBackoff() {
  await updateOutbox((items) => {
    for (const x of items) if (x.status === 'queued') x.nextAttemptAt = undefined;
  });
}

interface RunCache {
  heads: Map<PRKey, string>;
  compares: Map<string, Set<string> | null>;
}

async function sendItem(item: OutboxItem, cache: RunCache): Promise<void> {
  switch (item.type) {
    case 'review':
      return item.single ? sendSingle(item) : sendReview(item);
    case 'comment':
      return sendComment(item);
    case 'resolve':
      return sendResolve(item);
    case 'viewed':
      return sendViewed(item, cache);
  }
}

const Q_STATE = `
query($owner: String!, $repo: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      id headRefOid state merged
      reviews(states: PENDING, first: 5) { nodes { id author { login } } }
    }
  }
}`;

async function prState(prKey: PRKey) {
  const { owner, repo, number } = splitKey(prKey);
  const r = await graphql<any>(Q_STATE, { owner, repo, number });
  const pr = r?.repository?.pullRequest;
  if (!pr) throw new GitHubError(`${prKey} not found`, 404);
  const viewer: string = r.viewer.login;
  const pending: { id: string } | null = (pr.reviews?.nodes ?? []).find((x: any) => x?.author?.login === viewer) ?? null;
  return { pr, viewer, pending };
}

const Q_REVIEW = `query($id: ID!) { node(id: $id) { ... on PullRequestReview { state url comments(first: 100) { nodes { body } } } } }`;

/** A review by id; null only when GitHub definitely says it doesn't exist. Other failures throw. */
async function reviewNode(id: string): Promise<{ state: string; url: string; bodies: string[] } | null> {
  const r = await graphqlRaw<any>(Q_REVIEW, { id });
  if (r.errors.length) {
    if (r.errors.every((e) => e.type === 'NOT_FOUND')) return null;
    throw new GitHubError(r.errors.map((e) => e.message).join('; '), 200, r.errors.map((e) => e.type || 'ERROR'));
  }
  const n = r.data?.node;
  if (!n || !n.state) return null;
  return { state: n.state, url: n.url, bodies: (n.comments?.nodes ?? []).map((c: any) => c?.body ?? '') };
}

const EXPECTED_STATE: Record<ReviewEvent, string> = { APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED', COMMENT: 'COMMENTED' };

function holdChecks(item: OutboxReview, pr: any) {
  if (item.confirmedStale) return;
  if (item.event === 'APPROVE' && pr.headRefOid !== item.commitOid) {
    throw new HoldError('New commits were pushed after you reviewed. Approve anyway, send it as a comment, or re-review.');
  }
  if (item.event !== 'COMMENT' && pr.state !== 'OPEN') {
    throw new HoldError(`The PR is ${pr.merged ? 'already merged' : 'closed'}.`);
  }
}

function lineLabel(t: DraftThread): string {
  if (t.subjectType === 'FILE' || !t.line) return `\`${t.path}\``;
  const range = t.startLine && t.startLine !== t.line ? `L${t.startLine}-L${t.line}` : `L${t.line}`;
  return `\`${t.path}\` ${range}${t.side === 'LEFT' ? ' (old)' : ''}`;
}

function quoted(t: DraftThread): string {
  if (!t.snippet) return '';
  const fence = t.snippet.includes('```') ? '~~~' : '```';
  return `${fence}\n${t.snippet}\n${fence}\n`;
}

/** GitHub only accepts ```suggestion blocks on line comments; fall back to plain code. */
const unsuggest = (body: string) => body.replace(/```suggestion\b/g, '```');

const M_ADD_REVIEW = `mutation($pr: ID!, $commit: GitObjectID) { addPullRequestReview(input: {pullRequestId: $pr, commitOID: $commit}) { pullRequestReview { id } } }`;
const M_ADD_THREAD = `mutation($review: ID!, $path: String!, $body: String!, $line: Int, $side: DiffSide, $startLine: Int, $startSide: DiffSide, $subjectType: PullRequestReviewThreadSubjectType) {
  addPullRequestReviewThread(input: {pullRequestReviewId: $review, path: $path, body: $body, line: $line, side: $side, startLine: $startLine, startSide: $startSide, subjectType: $subjectType}) { thread { id } }
}`;
const M_ADD_REPLY = `mutation($review: ID!, $thread: ID!, $body: String!) { addPullRequestReviewThreadReply(input: {pullRequestReviewId: $review, pullRequestReviewThreadId: $thread, body: $body}) { comment { id } } }`;
const M_SUBMIT = `mutation($review: ID!, $event: PullRequestReviewEvent!, $body: String) { submitPullRequestReview(input: {pullRequestReviewId: $review, event: $event, body: $body}) { pullRequestReview { id url state } } }`;

function threadVars(reviewId: string, t: DraftThread) {
  const body = withMark(t.body, t.localId);
  if (t.subjectType === 'FILE' || !t.line) {
    return { review: reviewId, path: t.path, body: withMark(unsuggest(t.body), t.localId), subjectType: 'FILE' };
  }
  const multi = t.startLine && (t.startLine !== t.line || (t.startSide && t.startSide !== t.side));
  return {
    review: reviewId,
    path: t.path,
    body,
    line: t.line,
    side: t.side ?? 'RIGHT',
    ...(multi ? { startLine: t.startLine, startSide: t.startSide ?? t.side ?? 'RIGHT' } : {}),
    subjectType: 'LINE',
  };
}

/**
 * The commit you reviewed is gone (force-push) and you chose to send anyway:
 * move line comments onto the latest commit, or make them file comments.
 */
async function reanchor(item: OutboxReview, latestHead: string): Promise<void> {
  const snap = await getSnapshot(item.prKey);
  const { owner, repo, number } = splitKey(item.prKey);
  const draft = { commitOid: item.commitOid, body: item.body, threads: item.threads, replies: item.replies, updatedAt: now() };
  let moved: typeof draft | null = null;
  if (snap?.git && (await hasCommit(snap.git.clonePath, item.commitOid))) {
    try {
      if (!(await hasCommit(snap.git.clonePath, latestHead))) {
        await fetchPrRefs({ clonePath: snap.git.clonePath, owner, repo, number, baseRefName: snap.pr.baseRefName, baseRefOid: snap.pr.baseRefOid, headRefOid: latestHead });
      }
      if (await hasCommit(snap.git.clonePath, latestHead)) moved = (await moveDraft(snap.git.clonePath, draft, latestHead)).draft;
    } catch (e) {
      if (isTransient(e)) throw e;
    }
  }
  item.threads = moved
    ? moved.threads
    : item.threads.map((t) =>
        t.subjectType === 'LINE' && t.line
          ? { ...t, subjectType: 'FILE' as const, line: undefined, startLine: undefined, body: `> ${lineLabel(t)} of an earlier version\n\n${quoted(t)}\n${unsuggest(t.body)}`.trim() }
          : t,
      );
  item.commitOid = latestHead;
}

async function sendReview(item: OutboxReview): Promise<void> {
  const p = item.progress;
  const notes = new Set(item.notes ?? []);
  const { pr, pending } = await prState(item.prKey);

  // 1. Did an earlier attempt already get this review submitted (response lost)?
  let reviewId = p.reviewId;
  let existingBodies: string[] = [];
  if (reviewId) {
    const node = await reviewNode(reviewId);
    if (node && node.state !== 'PENDING') {
      p.submitted = true;
      item.resultUrl = node.url;
      if (node.state !== EXPECTED_STATE[item.event]) {
        throw new FailError(`GitHub has this review as "${node.state.toLowerCase().replace('_', ' ')}", not "${EXPECTED_STATE[item.event].toLowerCase().replace('_', ' ')}". Check it on GitHub: ${node.url}`);
      }
      return;
    }
    if (!node) {
      // The pending review was deleted on github.com: start over.
      reviewId = undefined;
      p.reviewId = undefined;
      p.threads = {};
      p.replies = {};
      p.bodyAppendix = [];
    } else {
      existingBodies = node.bodies;
    }
  }

  // 2. Approvals wait for your OK if the PR moved on.
  holdChecks(item, pr);

  // 3. Find or create the pending review.
  if (!reviewId && pending) {
    const owner = (await getOutbox()).find((x) => x.id !== item.id && x.type === 'review' && x.status !== 'sent' && (x as OutboxReview).progress?.reviewId === pending.id);
    if (owner) throw new HoldError('Another unsent review on this PR is using the pending review on GitHub; send or delete that one first.');
    reviewId = pending.id;
    notes.add('Added to the pending review you had started on github.com.');
    existingBodies = (await reviewNode(pending.id))?.bodies ?? [];
  }
  if (!reviewId) {
    try {
      const r = await mutate<any>(M_ADD_REVIEW, { pr: pr.id, commit: item.commitOid });
      reviewId = r.addPullRequestReview.pullRequestReview.id as string;
    } catch (e) {
      if (isTransient(e)) throw e;
      if (!item.confirmedStale) {
        throw new HoldError(
          `GitHub would not attach the review to the commit you reviewed (${item.commitOid.slice(0, 7)}); it was probably force-pushed away. Send anyway to put it on the latest commit (comments are moved to their new lines, or become file comments).`,
        );
      }
      await reanchor(item, pr.headRefOid);
      const r = await mutate<any>(M_ADD_REVIEW, { pr: pr.id, commit: pr.headRefOid });
      reviewId = r.addPullRequestReview.pullRequestReview.id as string;
      notes.add('Moved onto the latest commit because the reviewed commit was gone.');
    }
  }
  p.reviewId = reviewId;
  item.notes = [...notes];
  await save(item);

  const present = markersIn(existingBodies);

  for (const t of item.threads) {
    const done = p.threads[t.localId];
    if (done?.id || done?.fallback) continue;
    if (present.has(t.localId)) {
      p.threads[t.localId] = { id: 'existing' };
      continue;
    }
    try {
      const r = await mutate<any>(M_ADD_THREAD, threadVars(reviewId, t));
      p.threads[t.localId] = { id: r.addPullRequestReviewThread.thread?.id ?? 'ok' };
    } catch (e) {
      if (isTransient(e)) throw e;
      // GitHub can't place it on that line (outside the diff, or the file changed).
      const fileBody = withMark(`> ${lineLabel(t)}\n\n${quoted(t)}\n${unsuggest(t.body)}`.trim(), t.localId);
      try {
        const r = await mutate<any>(M_ADD_THREAD, { review: reviewId, path: t.path, body: fileBody, subjectType: 'FILE' });
        p.threads[t.localId] = { id: r.addPullRequestReviewThread.thread?.id ?? 'ok', fallback: 'file' };
        notes.add(`A comment on ${lineLabel(t)} couldn't be placed on that line, so it was posted as a file comment.`);
      } catch (e2) {
        if (isTransient(e2)) throw e2;
        p.bodyAppendix.push(`**${lineLabel(t)}**\n\n${quoted(t)}\n${unsuggest(t.body)}`.trim());
        p.threads[t.localId] = { fallback: 'body' };
        notes.add(`A comment on ${lineLabel(t)} was added to the review summary (the file is no longer in the PR?).`);
      }
    }
    item.notes = [...notes];
    await save(item);
    await sleep(150);
  }

  for (const r of item.replies) {
    if (p.replies[r.localId]) continue;
    if (present.has(r.localId)) {
      p.replies[r.localId] = 'existing';
      continue;
    }
    try {
      const res = await mutate<any>(M_ADD_REPLY, { review: reviewId, thread: r.threadId, body: withMark(r.body, r.localId) });
      p.replies[r.localId] = res.addPullRequestReviewThreadReply.comment?.id ?? 'ok';
    } catch (e) {
      if (isTransient(e)) throw e;
      p.bodyAppendix.push(`**Reply on ${r.path ? `\`${r.path}\`` : 'a thread'}:**\n\n${r.body}`);
      p.replies[r.localId] = 'body';
      notes.add('A reply could not be added to its thread (deleted?), so it was added to the review summary.');
    }
    item.notes = [...notes];
    await save(item);
    await sleep(150);
  }

  const body = [item.body.trim(), ...p.bodyAppendix].filter(Boolean).join('\n\n---\n\n');
  const res = await mutate<any>(M_SUBMIT, { review: reviewId, event: item.event, body: body || null });
  p.submitted = true;
  item.resultUrl = res.submitPullRequestReview.pullRequestReview?.url;
  await updateLocal(item.prKey, (l) => {
    l.lastReviewedOid = item.commitOid;
  });
}

/** Comments by the viewer posted since the item was created that carry its marker. */
async function findMarked(item: OutboxItem, viewer: string | undefined): Promise<string | null> {
  if (!viewer) return null;
  const { owner, repo, number } = splitKey(item.prKey);
  const since = encodeURIComponent(new Date(Date.parse(item.createdAt) - 60_000).toISOString());
  const [a, b] = await Promise.all([
    rest<any[]>('GET', `/repos/${owner}/${repo}/pulls/${number}/comments?since=${since}&per_page=100`),
    rest<any[]>('GET', `/repos/${owner}/${repo}/issues/${number}/comments?since=${since}&per_page=100`),
  ]);
  const hit = [...(a.data ?? []), ...(b.data ?? [])].find((c: any) => c?.user?.login === viewer && typeof c.body === 'string' && c.body.includes(MARK(item.id)));
  return hit ? (hit.html_url ?? 'posted') : null;
}

const validation = (e: unknown) => !isTransient(e);

/** "Add single comment": posted on its own via REST so it never touches a pending review. */
async function sendSingle(item: OutboxReview): Promise<void> {
  const { owner, repo, number } = splitKey(item.prKey);
  const t = item.threads[0];
  const reply = item.replies[0];
  const snap = await getSnapshot(item.prKey);
  if (item.attempts > 1) {
    const hit = await findMarked(item, snap?.viewer.login);
    if (hit) {
      item.resultUrl = hit;
      return;
    }
  }
  const mark = (body: string) => withMark(body, item.id);

  if (reply) {
    if (reply.replyToDatabaseId) {
      try {
        const r = await rest('POST', `/repos/${owner}/${repo}/pulls/${number}/comments/${reply.replyToDatabaseId}/replies`, { body: mark(reply.body) });
        item.resultUrl = r.data?.html_url;
        return;
      } catch (e) {
        if (!validation(e)) throw e;
      }
    }
    // Thread gone: post as a conversation comment instead.
    const r = await rest('POST', `/repos/${owner}/${repo}/issues/${number}/comments`, {
      body: mark(`**Reply on ${reply.path ? `\`${reply.path}\`` : 'a review thread'}:**\n\n${reply.body}`),
    });
    item.resultUrl = r.data?.html_url;
    item.notes = ['The thread could not be replied to, so this was posted as a conversation comment.'];
    return;
  }
  if (!t) return;
  const lineComment =
    t.subjectType === 'LINE' && t.line
      ? {
          body: mark(t.body),
          commit_id: item.commitOid,
          path: t.path,
          line: t.line,
          side: t.side ?? 'RIGHT',
          ...(t.startLine && t.startLine !== t.line ? { start_line: t.startLine, start_side: t.startSide ?? t.side ?? 'RIGHT' } : {}),
        }
      : null;
  if (lineComment) {
    try {
      const r = await rest('POST', `/repos/${owner}/${repo}/pulls/${number}/comments`, lineComment);
      item.resultUrl = r.data?.html_url;
      return;
    } catch (e) {
      if (!validation(e)) throw e;
    }
  }
  try {
    const r = await rest('POST', `/repos/${owner}/${repo}/pulls/${number}/comments`, {
      body: mark(lineComment ? `> ${lineLabel(t)}\n\n${quoted(t)}\n${unsuggest(t.body)}`.trim() : unsuggest(t.body)),
      commit_id: item.commitOid,
      path: t.path,
      subject_type: 'file',
    });
    item.resultUrl = r.data?.html_url;
    if (lineComment) item.notes = [`Couldn't be placed on ${lineLabel(t)}, so it was posted as a file comment.`];
  } catch (e) {
    if (!validation(e)) throw e;
    const r = await rest('POST', `/repos/${owner}/${repo}/issues/${number}/comments`, {
      body: mark(`**${lineLabel(t)}**\n\n${quoted(t)}\n${unsuggest(t.body)}`.trim()),
    });
    item.resultUrl = r.data?.html_url;
    item.notes = ['The file is no longer part of the PR, so this was posted as a conversation comment.'];
  }
}

async function sendComment(item: OutboxComment): Promise<void> {
  const { owner, repo, number } = splitKey(item.prKey);
  if (item.attempts > 1) {
    const hit = await findMarked(item, (await getSnapshot(item.prKey))?.viewer.login);
    if (hit) {
      item.resultUrl = hit;
      return;
    }
  }
  const r = await rest('POST', `/repos/${owner}/${repo}/issues/${number}/comments`, { body: withMark(item.body, item.id) });
  item.resultUrl = r.data?.html_url;
}

const M_RESOLVE = `mutation($thread: ID!) { resolveReviewThread(input: {threadId: $thread}) { thread { id isResolved } } }`;
const M_UNRESOLVE = `mutation($thread: ID!) { unresolveReviewThread(input: {threadId: $thread}) { thread { id isResolved } } }`;

async function sendResolve(item: OutboxResolve): Promise<void> {
  await mutate(item.resolve ? M_RESOLVE : M_UNRESOLVE, { thread: item.threadId });
}

const M_VIEWED = `mutation($pr: ID!, $path: String!) { markFileAsViewed(input: {pullRequestId: $pr, path: $path}) { clientMutationId } }`;
const M_UNVIEWED = `mutation($pr: ID!, $path: String!) { unmarkFileAsViewed(input: {pullRequestId: $pr, path: $path}) { clientMutationId } }`;
const Q_HEAD = `query($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) { headRefOid } } }`;

/** Files changed between two commits on GitHub; null if GitHub can't compare them. */
async function changedOnGitHub(prKey: PRKey, from: string, to: string, cache: RunCache): Promise<Set<string> | null> {
  const k = `${prKey}|${from}|${to}`;
  if (cache.compares.has(k)) return cache.compares.get(k)!;
  const { owner, repo } = splitKey(prKey);
  let result: Set<string> | null = null;
  try {
    const r = await rest<any>('GET', `/repos/${owner}/${repo}/compare/${from}...${to}?per_page=100`);
    const files: any[] = r.data?.files ?? [];
    result = files.length >= 300 ? null : new Set(files.flatMap((f) => [f.filename, f.previous_filename].filter(Boolean)));
  } catch (e) {
    if (isTransient(e)) throw e;
  }
  cache.compares.set(k, result);
  return result;
}

async function sendViewed(item: OutboxViewed, cache: RunCache): Promise<void> {
  const snap = await getSnapshot(item.prKey);
  if (!snap) throw new GitHubError('PR is no longer cached', 404);
  if (item.viewed && item.oid) {
    let head = cache.heads.get(item.prKey);
    if (!head) {
      const { owner, repo, number } = splitKey(item.prKey);
      head = (await graphql<any>(Q_HEAD, { owner, repo, number }))?.repository?.pullRequest?.headRefOid as string;
      cache.heads.set(item.prKey, head);
    }
    if (head && head !== item.oid) {
      const changed = await changedOnGitHub(item.prKey, item.oid, head, cache);
      if (!changed || changed.has(item.path)) {
        item.notes = ['The file changed after you viewed it, so it was not marked as viewed on GitHub.'];
        return;
      }
    }
  }
  try {
    await mutate(item.viewed ? M_VIEWED : M_UNVIEWED, { pr: snap.pr.id, path: item.path });
  } catch (e) {
    if (isTransient(e)) throw e;
    if (/part of (the )?pull request/i.test(errMsg(e))) {
      item.notes = ['File is no longer part of the PR; nothing to mark.'];
      return;
    }
    throw e;
  }
}

export { FailError, isNetworkError };
