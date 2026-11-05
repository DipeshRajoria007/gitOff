import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { mapLine, moveDraft, parseHunks } from '../src/server/remap.ts';

test('mapLine follows insertions and deletions and refuses changed lines', () => {
  // old 1..10; insert 2 lines after old 3; change old 6; delete old 9
  const hunks = parseHunks(['@@ -3,0 +4,2 @@', '+a', '+b', '@@ -6 +8 @@', '-x', '+y', '@@ -9 +10,0 @@', '-z'].join('\n'));
  assert.equal(mapLine(hunks, 1), 1);
  assert.equal(mapLine(hunks, 3), 3);
  assert.equal(mapLine(hunks, 4), 6);
  assert.equal(mapLine(hunks, 5), 7);
  assert.equal(mapLine(hunks, 6), null, 'changed line');
  assert.equal(mapLine(hunks, 7), 9);
  assert.equal(mapLine(hunks, 9), null, 'deleted line');
  assert.equal(mapLine(hunks, 10), 11);
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogh-remap-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const g = (...a: string[]) =>
  execFileSync('git', a, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

test('moveDraft moves comments to the new head and turns changed lines into file comments', async () => {
  g('init', '-q', '-b', 'main');
  const lines = Array.from({ length: 20 }, (_, i) => `l${i + 1}`);
  fs.writeFileSync(path.join(dir, 'f.ts'), lines.join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'gone.ts'), 'x\n');
  g('add', '-A');
  g('commit', '-qm', 'v1');
  const v1 = g('rev-parse', 'HEAD');
  const next = ['new0', ...lines];
  next[10] = 'l10 changed'; // old line 10 is now index 10 (line 11)
  fs.writeFileSync(path.join(dir, 'f.ts'), next.join('\n') + '\n');
  fs.rmSync(path.join(dir, 'gone.ts'));
  g('add', '-A');
  g('commit', '-qm', 'v2');
  const v2 = g('rev-parse', 'HEAD');
  const t = (o: any) => ({ localId: Math.random().toString(36), path: 'f.ts', subjectType: 'LINE', side: 'RIGHT', body: 'b', createdAt: '', updatedAt: '', ...o });
  const { draft, moved, toFile } = await moveDraft(
    dir,
    {
      commitOid: v1,
      body: '',
      replies: [],
      updatedAt: '',
      threads: [t({ line: 5 }), t({ line: 10, snippet: 'l10', body: '```suggestion\nl10!\n```' }), t({ line: 3, side: 'LEFT' }), t({ path: 'gone.ts', line: 1, snippet: 'x' }), t({ startLine: 2, line: 4 })],
    },
    v2,
  );
  assert.equal(draft.commitOid, v2);
  assert.equal(draft.threads[0].line, 6);
  assert.equal(draft.threads[1].subjectType, 'FILE');
  assert.match(draft.threads[1].body, /earlier version/);
  assert.doesNotMatch(draft.threads[1].body, /```suggestion/);
  assert.equal(draft.threads[2].line, 3, 'LEFT side stays');
  assert.equal(draft.threads[3].subjectType, 'FILE', 'deleted file becomes a file comment');
  assert.equal(draft.threads[4].startLine, 3);
  assert.equal(draft.threads[4].line, 5);
  assert.equal(moved, 2);
  assert.equal(toFile, 2);
});
