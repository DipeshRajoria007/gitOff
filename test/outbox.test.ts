// Outbox sending against a fake GitHub API (no network, nothing posted anywhere).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ogh-test-'));
process.env.GITOFF_HOME = home;
process.env.GITHUB_TOKEN = 'test-token';
delete process.env.GITOFF_OFFLINE;
delete process.env.OGH_OFFLINE;

/** How a call fails: the connection drops before/after GitHub did the work, or GitHub answers with an error. */
type FailMode = 'net-before' | 'net-after' | 'http502-after' | 'rate-limit' | 'gql-timeout';

interface Pending {
  id: string;
  comments: { body: string; path: string }[];
}

interface FakeState {
  head: string;
  prState: string;
  pending: Pending | null;
  submitted: { id: string; event: string; body: string | null }[];
  threads: any[];
  replies: any[];
  restComments: any[];
  issueComments: { body: string; user: { login: string }; html_url: string }[];
  viewedMarks: string[];
  deletedReviews: string[];
  compareFiles: string[];
  calls: string[];
  fail: { kind: string; mode: FailMode; times?: number } | null;
  rejectLine: number | null;
  reviewCounter: number;
}

let S: FakeState;
let lastSubmitted: Pending | null = null;

function reset() {
  S = {
    head: 'a'.repeat(40),
    prState: 'OPEN',
    pending: null,
    submitted: [],
    threads: [],
    replies: [],
    restComments: [],
    issueComments: [],
    viewedMarks: [],
    deletedReviews: [],
    compareFiles: [],
    calls: [],
    fail: null,
    rejectLine: null,
    reviewCounter: 0,
  };
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const netError = () => new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } } as any);

function kindOf(q: string): string {
  if (q.includes('addPullRequestReviewThreadReply')) return 'reply';
  if (q.includes('addPullRequestReviewThread')) return 'thread';
  if (q.includes('addPullRequestReview(')) return 'createReview';
  if (q.includes('submitPullRequestReview')) return 'submit';
  if (q.includes('deletePullRequestReview')) return 'deleteReview';
  if (q.includes('reviews(states: PENDING')) return 'state';
  if (q.includes('... on PullRequestReview { state url')) return 'reviewNode';
  if (q.includes('resolveReviewThread')) return 'resolve';
  if (q.includes('markFileAsViewed')) return 'viewed';
  if (q.includes('pullRequest(number: $number) { headRefOid }')) return 'head';
  return 'other';
}

function graphqlHandler(kind: string, vars: any): { data?: any; errors?: any[] } {
  switch (kind) {
    case 'state':
      return {
        data: {
          viewer: { login: 'me' },
          repository: {
            pullRequest: {
              id: 'PR_1',
              headRefOid: S.head,
              state: S.prState,
              merged: S.prState === 'MERGED',
              reviews: { nodes: S.pending ? [{ id: S.pending.id, author: { login: 'me' } }] : [] },
            },
          },
        },
      };
    case 'head':
      return { data: { repository: { pullRequest: { headRefOid: S.head } } } };
    case 'createReview': {
      if (S.pending) return { errors: [{ message: 'User can only have one pending review per pull request' }] };
      if (vars.commit && vars.commit.startsWith('dead')) return { errors: [{ type: 'UNPROCESSABLE', message: 'commit_id is not part of the pull request' }] };
      S.pending = { id: `R_${++S.reviewCounter}`, comments: [] };
      return { data: { addPullRequestReview: { pullRequestReview: { id: S.pending.id } } } };
    }
    case 'thread': {
      if (!S.pending || S.pending.id !== vars.review) return { errors: [{ message: 'review not pending' }] };
      if (vars.subjectType === 'LINE' && vars.line === S.rejectLine) return { errors: [{ type: 'UNPROCESSABLE', message: 'Line could not be resolved' }] };
      S.threads.push(vars);
      S.pending.comments.push({ body: vars.body, path: vars.path });
      return { data: { addPullRequestReviewThread: { thread: { id: `T_${S.threads.length}` } } } };
    }
    case 'reply':
      if (!S.pending || S.pending.id !== vars.review) return { errors: [{ message: 'review not pending' }] };
      S.replies.push(vars);
      S.pending.comments.push({ body: vars.body, path: 'x' });
      return { data: { addPullRequestReviewThreadReply: { comment: { id: `C_${S.replies.length}` } } } };
    case 'submit': {
      if (!S.pending || S.pending.id !== vars.review) return { errors: [{ message: 'Could not resolve to a node' }] };
      S.submitted.push({ id: S.pending.id, event: vars.event, body: vars.body });
      lastSubmitted = S.pending;
      S.pending = null;
      return { data: { submitPullRequestReview: { pullRequestReview: { id: vars.review, url: `https://github.com/o/r/pull/1#review-${vars.review}`, state: vars.event } } } };
    }
    case 'reviewNode': {
      const done = S.submitted.find((x) => x.id === vars.id);
      const STATE: Record<string, string> = { APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED', COMMENT: 'COMMENTED' };
      if (done) return { data: { node: { state: STATE[done.event], url: `https://github.com/o/r/pull/1#review-${vars.id}`, comments: { nodes: [] } } } };
      if (S.pending && S.pending.id === vars.id) return { data: { node: { state: 'PENDING', url: '', comments: { nodes: S.pending.comments.map((c) => ({ body: c.body })) } } } };
      return { data: { node: null } };
    }
    case 'deleteReview':
      S.deletedReviews.push(vars.id);
      if (S.pending?.id === vars.id) S.pending = null;
      return { data: { deletePullRequestReview: { pullRequestReview: { id: vars.id } } } };
    case 'viewed':
      S.viewedMarks.push(vars.path);
      return { data: { markFileAsViewed: { clientMutationId: null } } };
    case 'resolve':
      return { data: { ok: true } };
    default:
      return { errors: [{ message: `unexpected query` }] };
  }
}

/** Apply a configured failure to a call of `kind`; returns a Response/throws, or null to proceed normally. */
function maybeFail(kind: string, doWork: () => void): Response | null {
  const f = S.fail;
  if (!f || f.kind !== kind) {
    doWork();
    return null;
  }
  if (f.times === undefined || --f.times <= 0) S.fail = null;
  switch (f.mode) {
    case 'net-before':
      throw netError();
    case 'net-after':
      doWork();
      throw netError();
    case 'http502-after':
      doWork();
      return json({ message: 'Bad Gateway' }, 502);
    case 'rate-limit':
      return new Response(JSON.stringify({ message: 'You have exceeded a secondary rate limit' }), { status: 403, headers: { 'content-type': 'application/json', 'retry-after': '60' } });
    case 'gql-timeout':
      return json({ data: null, errors: [{ message: 'Something went wrong while executing your query. This may be the result of a timeout.' }] });
  }
}

const realFetch = globalThis.fetch;

before(() => {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url === 'https://api.github.com/graphql') {
      const { query, variables } = JSON.parse(init.body);
      const kind = kindOf(query);
      S.calls.push(kind);
      let result: any;
      const failed = maybeFail(kind, () => {
        result = graphqlHandler(kind, variables);
      });
      return failed ?? json(result);
    }
    const issues = url.match(/\/repos\/o\/r\/issues\/1\/comments/);
    if (issues && method === 'GET') return json(S.issueComments);
    if (issues && method === 'POST') {
      S.calls.push('issueComment');
      const body = JSON.parse(init.body).body;
      const c = { body, user: { login: 'me' }, html_url: `https://github.com/o/r/pull/1#issuecomment-${S.issueComments.length + 1}` };
      const failed = maybeFail('issueComment', () => void S.issueComments.push(c));
      return failed ?? json(c, 201);
    }
    if (url.includes('/pulls/1/comments') && method === 'GET') return json(S.restComments);
    if (url.includes('/pulls/1/comments') && method === 'POST') {
      S.calls.push('restComment');
      const body = JSON.parse(init.body);
      if (body.line && body.line === S.rejectLine) return json({ message: 'Validation Failed: line could not be resolved' }, 422);
      const c = { ...body, user: { login: 'me' }, html_url: `https://github.com/o/r/pull/1#discussion_r${S.restComments.length + 1}` };
      const failed = maybeFail('restComment', () => void S.restComments.push(c));
      return failed ?? json(c, 201);
    }
    if (url.includes('/compare/')) {
      S.calls.push('compare');
      return json({ files: S.compareFiles.map((filename) => ({ filename })) });
    }
    throw new Error(`unexpected fetch ${method} ${url}`);
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
  fs.rmSync(home, { recursive: true, force: true });
});

const KEY = 'o/r#1';

async function setup() {
  const store = await import('../src/server/store.ts');
  const outbox = await import('../src/server/outbox.ts');
  await store.saveSnapshot({
    schema: 1,
    key: KEY,
    owner: 'o',
    repo: 'r',
    number: 1,
    fetchedAt: new Date().toISOString(),
    viewer: { login: 'me' },
    repoInfo: { isPrivate: true, defaultBranch: 'main', url: '' },
    pr: { id: 'PR_1', author: { login: 'author' } } as any,
    commits: [],
    commitsTotal: 0,
    files: [],
    filesTotal: 0,
    threads: [],
    reviews: [],
    timeline: [],
    timelineTotal: 0,
    checks: { state: null, commitOid: null, items: [] },
    linked: { prs: [], jira: [] },
  });
  await store.updateOutbox((items) => void items.splice(0));
  // Tests drive sending explicitly; don't let the debounced auto-send run in the background.
  outbox.setOnlineProbe(() => false);
  return { store, outbox };
}

/** Run the sender until nothing is due, clearing backoff between rounds (like coming back online). */
async function drain(outbox: any, rounds = 4) {
  for (let i = 0; i < rounds; i++) {
    await outbox.resetBackoff();
    await outbox.processOutbox();
  }
}

const thread = (over: any = {}) => ({
  localId: Math.random().toString(36).slice(2),
  path: 'src/a.ts',
  subjectType: 'LINE' as const,
  line: 10,
  side: 'RIGHT' as const,
  body: 'please rename',
  snippet: 'const x = 1;',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...over,
});
const reply = (over: any = {}) => ({ localId: Math.random().toString(36).slice(2), threadId: 'PRRT_x', body: 'agree', createdAt: '', updatedAt: '', ...over });

beforeEach(() => reset());

test('review: pending review on the reviewed commit, threads and replies carry markers, then submit', async () => {
  const { store, outbox } = await setup();
  await outbox.queueReview({ prKey: KEY, event: 'COMMENT', body: 'summary', commitOid: S.head, threads: [thread(), thread({ line: 20, startLine: 18, startSide: 'RIGHT', body: 'multi' })], replies: [reply()] });
  await outbox.processOutbox();
  const [item] = await store.getOutbox();
  assert.equal(item.status, 'sent', item.lastError);
  assert.deepEqual(S.calls, ['state', 'createReview', 'thread', 'thread', 'reply', 'submit']);
  assert.equal(S.threads[1].startLine, 18);
  assert.match(S.threads[0].body, /<!-- ogh:\w+ -->$/);
  assert.equal(S.submitted[0].body, 'summary');
});

test('a line GitHub rejects becomes a file comment quoting the code (no suggestion block)', async () => {
  const { store, outbox } = await setup();
  S.rejectLine = 99;
  await outbox.queueReview({ prKey: KEY, event: 'COMMENT', body: '', commitOid: S.head, threads: [thread({ line: 99, body: '```suggestion\nfoo\n```' })], replies: [] });
  await outbox.processOutbox();
  const [item] = await store.getOutbox();
  assert.equal(item.status, 'sent', item.lastError);
  assert.equal(S.threads.length, 1);
  assert.equal(S.threads[0].subjectType, 'FILE');
  assert.match(S.threads[0].body, /L99/);
  assert.match(S.threads[0].body, /const x = 1;/);
  assert.doesNotMatch(S.threads[0].body, /```suggestion/);
});

test('approval waits for your OK when new commits landed, then sends', async () => {
  const { store, outbox } = await setup();
  await outbox.queueReview({ prKey: KEY, event: 'APPROVE', body: '', commitOid: 'b'.repeat(40), threads: [], replies: [] });
  await outbox.processOutbox();
  let [item] = await store.getOutbox();
  assert.equal(item.status, 'held');
  assert.equal(S.submitted.length, 0);
  await outbox.actOnItem(item.id, 'confirm');
  await outbox.processOutbox();
  [item] = await store.getOutbox();
  assert.equal(item.status, 'sent', item.lastError);
  assert.equal(S.submitted[0].event, 'APPROVE');
});

test('connection drops before submit: retry reuses the pending review, nothing doubled', async () => {
  const { store, outbox } = await setup();
  await outbox.queueReview({ prKey: KEY, event: 'COMMENT', body: 'sum', commitOid: S.head, threads: [thread(), thread({ line: 30 })], replies: [] });
  S.fail = { kind: 'submit', mode: 'net-before' };
  await outbox.processOutbox();
  assert.equal((await store.getOutbox())[0].status, 'queued');
  await drain(outbox);
  const [item] = await store.getOutbox();
  assert.equal(item.status, 'sent', item.lastError);
  assert.equal(S.threads.length, 2);
  assert.equal(S.submitted.length, 1);
  assert.equal(S.calls.filter((c) => c === 'createReview').length, 1);
});

test('submit went through but the response was lost: detected, not submitted twice', async () => {
  const { store, outbox } = await setup();
  await outbox.queueReview({ prKey: KEY, event: 'APPROVE', body: '', commitOid: S.head, threads: [thread()], replies: [] });
  S.fail = { kind: 'submit', mode: 'net-after' };
  await drain(outbox);
  const [item] = await store.getOutbox();
  assert.equal(item.status, 'sent', item.lastError);
  assert.equal(S.submitted.length, 1);
});

test('[review B] a failing review lookup after a lost submit never re-posts the review', async () => {
  const { store, outbox } = await setup();
  await outbox.queueReview({ prKey: KEY, event: 'APPROVE', body: '', commitOid: S.head, threads: [thread()], replies: [] });
  S.fail = { kind: 'submit', mode: 'net-after' };
  await outbox.processOutbox();
  // A 502 that outlasts the client's own retries.
  S.fail = { kind: 'reviewNode', mode: 'http502-after', times: 3 };
  await outbox.resetBackoff();
  await outbox.processOutbox();
  assert.equal((await store.getOutbox())[0].status, 'queued', 'a 502 on the lookup is retried, not treated as "deleted"');
  await drain(outbox);
  const [item] = await store.getOutbox();
  assert.equal(item.status, 'sent', item.lastError);
  assert.equal(S.submitted.length, 1);
  assert.equal(S.threads.length, 1);
});

test('[review A] lost response on a reply: the reply is posted once', async () => {
  const { store, outbox } = await setup();
  await outbox.queueReview({ prKey: KEY, event: 'COMMENT', body: 'x', commitOid: S.head, threads: [], replies: [reply()] });
  S.fail = { kind: 'reply', mode: 'net-after' };
  await drain(outbox);
  const [item] = await store.getOutbox();
  assert.equal(item.status, 'sent', item.lastError);
  assert.equal(S.replies.length, 1);
});

test('[review C] a rate limit on a line comment is retried, not demoted to a file comment', async () => {
  const { store, outbox } = await setup();
  await outbox.queueReview({ prKey: KEY, event: 'COMMENT', body: 'x', commitOid: S.head, threads: [thread()], replies: [] });
  S.fail = { kind: 'thread', mode: 'rate-limit' };
  await outbox.processOutbox();
  let [item] = await store.getOutbox();
  assert.equal(item.status, 'queued');
  assert.equal(S.threads.length, 0);
  await drain(outbox);
  [item] = await store.getOutbox();
  assert.equal(item.status, 'sent', item.lastError);
  assert.equal(S.threads.length, 1);
  assert.equal(S.threads[0].subjectType, 'LINE');
});

test('[review C2] a 502 on a line comment that actually landed does not add a file comment', async () => {
  const { store, outbox } = await setup();
  await outbox.queueReview({ prKey: KEY, event: 'COMMENT', body: 'x', commitOid: S.head, threads: [thread()], replies: [] });
  S.fail = { kind: 'thread', mode: 'http502-after' };
  await drain(outbox);
  const [item] = await store.getOutbox();
  assert.equal(item.status, 'sent', item.lastError);
  assert.equal(S.threads.length, 1);
  assert.equal(S.threads[0].subjectType, 'LINE');
});

test('[review C] a GraphQL timeout is retried, not treated as a rejected line', async () => {
  const { store, outbox } = await setup();
  await outbox.queueReview({ prKey: KEY, event: 'COMMENT', body: 'x', commitOid: S.head, threads: [thread()], replies: [] });
  S.fail = { kind: 'thread', mode: 'gql-timeout' };
  await drain(outbox);
  assert.equal(S.threads.length, 1);
  assert.equal(S.threads[0].subjectType, 'LINE');
});

test('[review D] lost response on a fallback file comment: posted once', async () => {
  const { store, outbox } = await setup();
  S.rejectLine = 50;
  await outbox.queueReview({ prKey: KEY, event: 'COMMENT', body: 'x', commitOid: S.head, threads: [thread({ line: 50 })], replies: [] });
  // the LINE attempt is rejected (validation), the FILE fallback lands but its response is lost
  S.fail = { kind: 'thread', mode: 'net-after' };
  await drain(outbox);
  const [item] = await store.getOutbox();
  assert.equal(item.status, 'sent', item.lastError);
  assert.equal(S.threads.length, 1);
  assert.equal(S.threads[0].subjectType, 'FILE');
});

test('[review E] a later review on the same PR waits for a held one; the approval really goes out', async () => {
  const { store, outbox } = await setup();
  // A: an approval whose pending review gets created, then the connection drops before submit.
  await outbox.queueReview({ prKey: KEY, event: 'APPROVE', body: 'lgtm', commitOid: S.head, threads: [thread()], replies: [] });
  S.fail = { kind: 'submit', mode: 'net-before' };
  await outbox.processOutbox();
  S.head = 'c'.repeat(40); // new commits arrive
  await outbox.queueReview({ prKey: KEY, event: 'COMMENT', body: 'second', commitOid: S.head, threads: [thread({ line: 3 })], replies: [] });
  await drain(outbox);
  let [a, b] = await store.getOutbox();
  assert.equal(a.status, 'held', 'A waits for your OK');
  assert.equal(b.status, 'queued', 'B must not run while A is unsent');
  assert.equal(S.submitted.length, 0);
  await outbox.actOnItem(a.id, 'confirm');
  await drain(outbox);
  [a, b] = await store.getOutbox();
  assert.equal(a.status, 'sent', a.lastError);
  assert.equal(b.status, 'sent', b.lastError);
  assert.deepEqual(
    S.submitted.map((x) => x.event),
    ['APPROVE', 'COMMENT'],
  );
});

test('a review GitHub recorded with a different state is reported, not marked sent', async () => {
  const { store, outbox } = await setup();
  await outbox.queueReview({ prKey: KEY, event: 'APPROVE', body: '', commitOid: S.head, threads: [], replies: [] });
  S.fail = { kind: 'submit', mode: 'net-before' };
  await outbox.processOutbox();
  // Meanwhile that pending review got submitted as a plain comment (e.g. on github.com).
  S.submitted.push({ id: S.pending!.id, event: 'COMMENT', body: null });
  S.pending = null;
  await drain(outbox);
  const [item] = await store.getOutbox();
  assert.equal(item.status, 'failed');
  assert.match(item.lastError!, /commented/);
});

test('deleting a half-sent review also discards its pending review on GitHub', async () => {
  const { store, outbox } = await setup();
  await outbox.queueReview({ prKey: KEY, event: 'COMMENT', body: 'x', commitOid: S.head, threads: [thread()], replies: [] });
  S.fail = { kind: 'submit', mode: 'net-before' };
  await outbox.processOutbox();
  const [item] = await store.getOutbox();
  assert.ok(item.type === 'review' && item.progress.reviewId);
  outbox.setOnlineProbe(() => true);
  await outbox.actOnItem(item.id, 'delete');
  outbox.setOnlineProbe(() => false);
  assert.equal((await store.getOutbox()).length, 0);
  assert.equal(S.deletedReviews.length, 1);
  assert.equal(S.pending, null);
});

test('force-pushed commit: held, then moved onto the latest commit when confirmed', async () => {
  const { store, outbox } = await setup();
  await outbox.queueReview({ prKey: KEY, event: 'COMMENT', body: 'x', commitOid: 'dead'.padEnd(40, '0'), threads: [thread()], replies: [] });
  await outbox.processOutbox();
  let [item] = await store.getOutbox();
  assert.equal(item.status, 'held');
  assert.match(item.heldReason!, /force-pushed/);
  await outbox.actOnItem(item.id, 'confirm');
  await outbox.processOutbox();
  [item] = await store.getOutbox();
  assert.equal(item.status, 'sent', item.lastError);
  assert.equal(S.submitted.length, 1);
  // No local clone in this test, so the line comment can't be remapped and becomes a file comment.
  assert.equal(S.threads[0].subjectType, 'FILE');
  assert.match(S.threads[0].body, /earlier version/);
});

test('conversation comment: a lost response does not post it twice', async () => {
  const { store, outbox } = await setup();
  await outbox.queueComment(KEY, 'hello from the plane');
  S.fail = { kind: 'issueComment', mode: 'net-after' };
  await drain(outbox);
  const [item] = await store.getOutbox();
  assert.equal(item.status, 'sent', item.lastError);
  assert.equal(S.issueComments.length, 1);
});

test('single comment goes through REST and never touches a pending review from github.com', async () => {
  const { store, outbox } = await setup();
  S.pending = { id: 'R_web', comments: [{ body: 'web draft', path: 'x' }] };
  await outbox.queueReview({ prKey: KEY, event: 'COMMENT', body: '', commitOid: S.head, threads: [thread()], replies: [], single: true });
  S.fail = { kind: 'restComment', mode: 'net-after' };
  await drain(outbox);
  const [item] = await store.getOutbox();
  assert.equal(item.status, 'sent', item.lastError);
  assert.equal(S.restComments.length, 1, 'not posted twice after a lost response');
  assert.equal(S.calls.filter((c) => c === 'submit').length, 0);
  assert.equal(S.pending?.id, 'R_web');
});

test('a review joins a pending review you started on github.com', async () => {
  const { store, outbox } = await setup();
  S.pending = { id: 'R_web', comments: [] };
  await outbox.queueReview({ prKey: KEY, event: 'COMMENT', body: 'b', commitOid: S.head, threads: [thread()], replies: [] });
  await outbox.processOutbox();
  const [item] = await store.getOutbox();
  assert.equal(item.status, 'sent', item.lastError);
  assert.equal(S.submitted[0].id, 'R_web');
});

test('"viewed" is not sent for a file that changed after you looked at it', async () => {
  const { store, outbox } = await setup();
  const old = 'b'.repeat(40);
  S.compareFiles = ['changed.ts'];
  await outbox.queueViewed(KEY, 'changed.ts', true, old);
  await outbox.queueViewed(KEY, 'same.ts', true, old);
  await outbox.queueViewed(KEY, 'current.ts', true, S.head);
  await outbox.processOutbox();
  const items = await store.getOutbox();
  assert.ok(items.every((x) => x.status === 'sent'));
  assert.deepEqual(S.viewedMarks.sort(), ['current.ts', 'same.ts']);
  assert.ok(items.find((x) => x.type === 'viewed' && x.path === 'changed.ts')!.notes?.[0]?.includes('changed'));
});

test('resolve and viewed marks are coalesced', async () => {
  const { store, outbox } = await setup();
  await outbox.queueViewed(KEY, 'a.ts', true, S.head);
  await outbox.queueViewed(KEY, 'a.ts', false, S.head);
  await outbox.queueViewed(KEY, 'a.ts', true, S.head);
  await outbox.queueResolve(KEY, 'T1', true);
  await outbox.queueResolve(KEY, 'T1', false);
  assert.equal((await store.getOutbox()).length, 2);
  await outbox.processOutbox();
  assert.ok((await store.getOutbox()).every((x) => x.status === 'sent'));
  assert.equal(S.viewedMarks.length, 1);
});
