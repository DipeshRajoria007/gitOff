import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.GITOFF_HOME = path.join(os.tmpdir(), `ogh-links-${process.pid}`);

test('only explicit PR references are followed, never a bare #123', async () => {
  const { explicitPrRefs } = await import('../src/server/sync.ts');
  const body = [
    'Order: other-api #167–#169 and other-web #155/#156 deployed first.', // bare refs: GitHub links these to this repo
    'Backend: https://github.com/acme/web/pull/9415/files',
    'Also acme/other-api#168, and this PR itself https://github.com/acme/api/pull/6663',
    'Not a PR: https://github.com/acme/api/issues/12 or src/app#L10',
  ].join('\n');
  const refs = explicitPrRefs([body], 'acme/api#6663').map((r) => `${r.owner}/${r.repo}#${r.number}`);
  assert.deepEqual(refs.sort(), ['acme/other-api#168', 'acme/web#9415']);
});
