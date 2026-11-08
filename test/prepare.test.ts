import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogh-prep-'));
process.env.GITOFF_HOME = path.join(dir, 'home');
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const clone = path.join(dir, 'app');
fs.mkdirSync(clone);
const g = (cwd: string, ...a: string[]) =>
  execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

const pkg = { name: 'app', version: '1.0.0', private: true };
const lock = { name: 'app', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'app', version: '1.0.0' } } };
fs.writeFileSync(path.join(clone, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
fs.writeFileSync(path.join(clone, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
fs.writeFileSync(path.join(clone, '.gitignore'), 'node_modules/\n.env*\n!.env.example\n');
fs.writeFileSync(path.join(clone, '.env.example'), 'A=example\n');
g(clone, 'init', '-q', '-b', 'main');
g(clone, 'add', '-A');
g(clone, 'commit', '-qm', 'init');
const head = g(clone, 'rev-parse', 'HEAD');
// Untracked local state in the main checkout that a fresh worktree lacks.
fs.writeFileSync(path.join(clone, '.env'), 'SECRET=fake\n');
fs.mkdirSync(path.join(clone, 'web'));
fs.writeFileSync(path.join(clone, 'web', '.env.local'), 'NESTED=1\n');
fs.mkdirSync(path.join(clone, 'node_modules', 'left-pad'), { recursive: true });
fs.writeFileSync(path.join(clone, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');

async function setupPr(n: number) {
  const store = await import('../src/server/store.ts');
  const key = `o/app#${n}`;
  const wt = path.join(dir, `app-review-${n}`);
  g(clone, 'worktree', 'add', '-q', '--detach', wt, head);
  await store.saveSnapshot({
    schema: 1, key, owner: 'o', repo: 'app', number: n, fetchedAt: '', viewer: { login: 'me' },
    repoInfo: { isPrivate: true, defaultBranch: 'main', url: '' }, pr: {} as any, commits: [], commitsTotal: 0, files: [], filesTotal: 0,
    threads: [], reviews: [], timeline: [], timelineTotal: 0, checks: { state: null, commitOid: null, items: [] }, linked: { prs: [], jira: [] },
    git: { clonePath: clone, cloneKind: 'user', baseOid: head, headOid: head, mergeBaseOid: head, fetchedAt: '' },
  });
  await store.updateLocal(key, (l) => {
    l.worktree = { path: wt, headOid: head, branch: null, createdAt: '' };
  });
  return { key, wt, store };
}

async function waitDone(store: any, key: string) {
  for (let i = 0; i < 300; i++) {
    const l = await store.getLocal(key);
    if (l.prepare && l.prepare.status !== 'running') return l.prepare;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('prepare did not finish');
}

test('prepare copies ignored .env files and reuses node_modules when the lockfile matches', async () => {
  const { key, wt, store } = await setupPr(1);
  const { startPrepare } = await import('../src/server/prepare.ts');
  await startPrepare(key);
  const p = await waitDone(store, key);
  assert.equal(p.status, 'done', p.summary);
  assert.equal(fs.readFileSync(path.join(wt, '.env'), 'utf8'), 'SECRET=fake\n');
  assert.equal(fs.readFileSync(path.join(wt, 'web', '.env.local'), 'utf8'), 'NESTED=1\n');
  assert.equal(fs.readFileSync(path.join(wt, '.env.example'), 'utf8'), 'A=example\n', 'tracked files are left alone');
  assert.ok(fs.existsSync(path.join(wt, 'node_modules', 'left-pad', 'index.js')));
  assert.match(p.summary!, /reused node_modules/);
  assert.equal(g(wt, 'status', '--porcelain', '--untracked-files=no'), '', 'worktree stays clean');
});

test('prepare runs the package manager when the lockfile differs', async () => {
  const { key, wt, store } = await setupPr(2);
  const changed = { ...lock, version: '1.0.1', packages: { '': { name: 'app', version: '1.0.1' } } };
  fs.writeFileSync(path.join(wt, 'package-lock.json'), JSON.stringify(changed, null, 2) + '\n');
  fs.writeFileSync(path.join(wt, 'package.json'), JSON.stringify({ ...pkg, version: '1.0.1' }, null, 2) + '\n');
  const { startPrepare } = await import('../src/server/prepare.ts');
  await startPrepare(key);
  const p = await waitDone(store, key);
  assert.equal(p.status, 'done', `${p.summary}\n${fs.readFileSync(p.logFile, 'utf8')}`);
  assert.match(p.summary!, /npm ci done/);
  assert.match(fs.readFileSync(p.logFile, 'utf8'), /\$ npm ci/);
});
