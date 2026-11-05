import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogh-http-'));
process.env.OGH_HOME = path.join(dir, 'home');
process.env.GITHUB_TOKEN = 'test-token';
const realFetch = globalThis.fetch;
globalThis.fetch = (async (u: any) => {
  throw new Error(`no network in this test: ${u}`);
}) as any;
after(() => {
  globalThis.fetch = realFetch;
  fs.rmSync(dir, { recursive: true, force: true });
});

const KEY = 'o/r#1';
const HEAD = 'a'.repeat(40);

async function setup() {
  const store = await import('../src/server/store.ts');
  const outbox = await import('../src/server/outbox.ts');
  const { buildApp } = await import('../src/server/http.ts');
  outbox.setOnlineProbe(() => false);
  await store.updateTracked((l) => {
    if (!l.length) l.push({ key: KEY, owner: 'o', repo: 'r', number: 1, sources: ['manual'], addedAt: '' });
  });
  await store.saveSnapshot({
    schema: 1, key: KEY, owner: 'o', repo: 'r', number: 1, fetchedAt: '', viewer: { login: 'me' }, repoInfo: {} as any,
    pr: { id: 'PR_1', author: { login: 'author' }, headRefOid: HEAD } as any, commits: [], commitsTotal: 0, files: [], filesTotal: 0,
    threads: [], reviews: [], timeline: [], timelineTotal: 0, checks: { state: null, commitOid: null, items: [] }, linked: { prs: [], jira: [] },
  });
  const app = buildApp();
  const req = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(`http://localhost:4777${p}`, {
      method,
      headers: { host: 'localhost:4777', 'x-ogh': '1', 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { store, req };
}

const t = (id: string) => ({ localId: id, path: 'a.ts', subjectType: 'LINE', line: 1, side: 'RIGHT', body: id, createdAt: '', updatedAt: '' });
const draft = (threads: any[]) => ({ commitOid: HEAD, body: '', threads, replies: [], updatedAt: '' });

test('submitting a review keeps a comment that was saved while the PR was locked', async () => {
  const { store, req } = await setup();
  await store.updateLocal(KEY, (l) => void (l.draft = draft([t('T1')]) as any));
  // Something slow holds the PR's lock (like a worktree checkout during sync).
  const busy = store.updateLocal(KEY, () => new Promise((r) => setTimeout(r, 300)));
  const put = req('PUT', '/api/prs/o/r/1/draft', { draft: draft([t('T1'), t('T2')]) });
  await new Promise((r) => setTimeout(r, 20));
  const post = req('POST', '/api/prs/o/r/1/review', { event: 'COMMENT', body: 'done' });
  const [, putRes, postRes] = await Promise.all([busy, put, post]);
  assert.equal(putRes.status, 200);
  assert.equal(postRes.status, 200, await postRes.clone().text());
  const queued = (await store.getOutbox()).find((x) => x.type === 'review') as any;
  assert.deepEqual(queued.threads.map((x: any) => x.localId), ['T1', 'T2']);
  assert.equal((await store.getLocal(KEY)).draft, null);
});

test('files from a PR are served sandboxed so an SVG cannot run script', async () => {
  const { store, req } = await setup();
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const g = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  g('add', '-A');
  g('commit', '-qm', 'x');
  const oid = g('rev-parse', 'HEAD');
  const snap = (await store.getSnapshot(KEY))!;
  snap.git = { clonePath: repo, cloneKind: 'user', baseOid: oid, headOid: oid, mergeBaseOid: oid, fetchedAt: '' };
  await store.saveSnapshot(snap);
  const res = await req('GET', `/api/prs/o/r/1/blob?ref=${oid}&path=logo.svg`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy') ?? '', /sandbox/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('the API only answers localhost and needs the custom header for writes', async () => {
  const { req } = await setup();
  assert.equal((await req('GET', '/api/status', undefined, { host: 'evil.example:4777' })).status, 403);
  assert.equal((await req('POST', '/api/sync', {}, { 'x-ogh': '' })).status, 403);
  assert.equal((await req('POST', '/api/sync', {}, { origin: 'https://evil.example' })).status, 403);
});
