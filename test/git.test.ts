import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogh-git-'));
process.env.OGH_HOME = path.join(dir, 'home');
const repo = path.join(dir, 'repo');
fs.mkdirSync(repo);
const g = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
const write = (p: string, s: string | Buffer) => {
  fs.mkdirSync(path.dirname(path.join(repo, p)), { recursive: true });
  fs.writeFileSync(path.join(repo, p), s);
};

g('init', '-q', '-b', 'main');
write('src/keep.ts', Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
write('src/old name.ts', 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\nexport const d = 4;\n');
write('gone.txt', 'bye\n');
write('img.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 0, 0, 0]));
write('.gitattributes', 'dist/** linguist-generated\n');
g('add', '-A');
g('commit', '-qm', 'base');
const base = g('rev-parse', 'HEAD');

const keep = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
keep[19] = 'line 20 changed';
write('src/keep.ts', keep.join('\n') + '\n');
g('mv', 'src/old name.ts', 'src/new name.ts');
write('src/new name.ts', 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\nexport const d = 5;\n');
g('rm', '-q', 'gone.txt');
write('img.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 9, 9, 9, 0, 0, 0]));
write('package-lock.json', '{\n  "lockfileVersion": 3\n}\n');
write('dist/bundle.js', 'console.log(1)\n');
write('docs/ünïcode file.md', '# hi\n');
write('weird "q".txt', 'quoted\n');
g('add', '-A');
g('commit', '-qm', 'change');
const head = g('rev-parse', 'HEAD');

after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('computeDiff maps every file to the right patch and metadata', async () => {
  const { computeDiff } = await import('../src/server/git.ts');
  const d = await computeDiff(repo, base, head);
  const by = Object.fromEntries(d.files.map((f) => [f.path, f]));
  assert.deepEqual(Object.keys(by).sort(), ['dist/bundle.js', 'docs/ünïcode file.md', 'gone.txt', 'img.png', 'package-lock.json', 'src/keep.ts', 'src/new name.ts', 'weird "q".txt'].sort());

  assert.equal(by['src/keep.ts'].status, 'modified');
  assert.equal(by['src/keep.ts'].additions, 1);
  assert.match(by['src/keep.ts'].patch!, /\+line 20 changed/);

  const ren = by['src/new name.ts'];
  assert.equal(ren.status, 'renamed');
  assert.equal(ren.oldPath, 'src/old name.ts');
  assert.match(ren.patch!, /\+export const d = 5;/);

  assert.equal(by['gone.txt'].status, 'deleted');
  assert.match(by['gone.txt'].patch!, /-bye/);

  assert.equal(by['img.png'].binary, true);
  assert.equal(by['img.png'].patch, null);

  assert.equal(by['package-lock.json'].generated, true);
  assert.equal(by['package-lock.json'].deferred, true);
  assert.equal(by['package-lock.json'].patch, null);

  assert.equal(by['dist/bundle.js'].generated, true, '.gitattributes linguist-generated is honoured');

  assert.equal(by['docs/ünïcode file.md'].status, 'added');
  assert.match(by['docs/ünïcode file.md'].patch!, /\+# hi/);
  assert.match(by['weird "q".txt'].patch!, /\+quoted/, 'C-quoted paths are unquoted');
});

test('filePatch loads a deferred file on demand, and readBlob reads either side', async () => {
  const { filePatch, readBlob } = await import('../src/server/git.ts');
  const p = await filePatch(repo, base, head, 'package-lock.json', null);
  assert.match(p, /lockfileVersion/);
  const oldSide = await readBlob(repo, base, 'src/old name.ts');
  assert.match(oldSide!.toString(), /d = 4/);
  assert.equal(await readBlob(repo, base, 'nope.txt'), null);
});

test('remote URLs of all shapes resolve to owner/repo', async () => {
  const { remoteToNameWithOwner } = await import('../src/server/git.ts');
  assert.equal(remoteToNameWithOwner('git@github.com:Acme/Web-App.git'), 'acme/web-app');
  assert.equal(remoteToNameWithOwner('https://github.com/acme/marketing-site.git'), 'acme/marketing-site');
  assert.equal(remoteToNameWithOwner('https://x-access-token:abc@github.com/o/r'), 'o/r');
  assert.equal(remoteToNameWithOwner('ssh://git@github.com/o/r.git'), 'o/r');
  assert.equal(remoteToNameWithOwner('git@gitlab.com:o/r.git'), null);
});

test('worktrees: created detached at the PR head, moved when clean, left alone when dirty', async () => {
  const { ensureWorktree } = await import('../src/server/git.ts');
  const settings = { codeRoots: [dir], worktreeDir: path.join(dir, 'wt'), editor: 'cursor', autoSyncMinutes: 0, queue: { reviewRequested: false, authored: false }, media: { videos: false, maxVideoMB: 1, maxImageMB: 1 }, linkedPrs: false, jira: { baseUrl: '', email: null, projectKeys: [] }, repos: {} } as any;
  const args = { clone: { path: repo, kind: 'user' as const }, settings, repo: 'repo', number: 7, headRefName: 'feature', viewerIsAuthor: false, isCrossRepository: false };
  // A real sync pins every PR head it fetched under refs/ogh/pr/<n>/.
  g('update-ref', `refs/ogh/pr/7/seen/${base}`, base);
  g('update-ref', `refs/ogh/pr/7/seen/${head}`, head);
  const w1 = await ensureWorktree({ ...args, headOid: base });
  assert.equal(w1.error, undefined);
  assert.equal(w1.headOid, base);
  assert.ok(fs.existsSync(path.join(w1.path, 'gone.txt')));
  const w2 = await ensureWorktree({ ...args, headOid: head, previous: w1 });
  assert.equal(w2.headOid, head, 'clean worktree follows the new head');
  fs.appendFileSync(path.join(w2.path, 'src/keep.ts'), 'local edit\n');
  const w3 = await ensureWorktree({ ...args, headOid: base, previous: w2 });
  assert.equal(w3.dirty, true);
  assert.equal(w3.headOid, head, 'dirty worktree is not moved');
});

test('a worktree holding your own commit is neither moved nor removed', async () => {
  const { ensureWorktree, removeWorktree } = await import('../src/server/git.ts');
  const settings = { codeRoots: [dir], worktreeDir: path.join(dir, 'wt2'), editor: 'cursor', autoSyncMinutes: 0, queue: {}, media: {}, linkedPrs: false, jira: {}, repos: {} } as any;
  const args = { clone: { path: repo, kind: 'user' as const }, settings, repo: 'repo', number: 8, headRefName: 'feature', viewerIsAuthor: false, isCrossRepository: false };
  g('update-ref', `refs/ogh/pr/8/seen/${base}`, base);
  g('update-ref', `refs/ogh/pr/8/seen/${head}`, head);
  const w1 = await ensureWorktree({ ...args, headOid: base });
  fs.writeFileSync(path.join(w1.path, 'fix.txt'), 'my fix\n');
  execFileSync('git', ['add', '-A'], { cwd: w1.path });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'local fix'], { cwd: w1.path });
  const mine = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: w1.path, encoding: 'utf8' }).trim();
  const w2 = await ensureWorktree({ ...args, headOid: head, previous: w1 });
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: w2.path, encoding: 'utf8' }).trim(), mine);
  assert.match(w2.note ?? '', /commits that are not on the PR/);
  await assert.rejects(removeWorktree(repo, w2.path, 8), /commits that are not on the PR/);
  assert.ok(fs.existsSync(path.join(w2.path, 'fix.txt')));
});
