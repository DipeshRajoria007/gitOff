import type { DraftReview, DraftThread } from '../shared/types.js';
import { git } from './git.js';

interface Hunk {
  oldStart: number;
  oldLen: number;
  newStart: number;
  newLen: number;
}

/** Parse the hunk headers of a zero-context diff (`git diff -U0`). */
export function parseHunks(patch: string): Hunk[] {
  const out: Hunk[] = [];
  for (const m of patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    out.push({
      oldStart: Number(m[1]),
      oldLen: m[2] === undefined ? 1 : Number(m[2]),
      newStart: Number(m[3]),
      newLen: m[4] === undefined ? 1 : Number(m[4]),
    });
  }
  return out;
}

/**
 * Where does `line` of the old version end up in the new version? Returns null
 * when the line itself was changed or removed.
 */
export function mapLine(hunks: Hunk[], line: number): number | null {
  let offset = 0;
  for (const h of hunks) {
    if (h.oldLen === 0) {
      // Pure insertion after old line `oldStart`.
      if (line <= h.oldStart) return line + offset;
      offset += h.newLen;
      continue;
    }
    if (line < h.oldStart) return line + offset;
    if (line < h.oldStart + h.oldLen) return null;
    offset += h.newLen - h.oldLen;
  }
  return line + offset;
}

/**
 * Move a pending review written against `draft.commitOid` onto `toOid`.
 * New-side (RIGHT) line comments follow their lines; comments on lines that
 * changed become file comments that quote the original code. Old-side (LEFT)
 * lines belong to the base version, which doesn't move.
 */
export async function moveDraft(clonePath: string, draft: DraftReview, toOid: string): Promise<{ draft: DraftReview; moved: number; toFile: number }> {
  const fromOid = draft.commitOid;
  if (fromOid === toOid) return { draft, moved: 0, toFile: 0 };
  const cache = new Map<string, Hunk[] | null>();
  const hunksFor = async (path: string): Promise<Hunk[] | null> => {
    if (cache.has(path)) return cache.get(path)!;
    // `--no-renames` keeps this about one path; a renamed or deleted file has no mapping.
    const exists = await git(clonePath, ['cat-file', '-e', `${toOid}:${path}`], { readOnly: true });
    let result: Hunk[] | null = null;
    if (exists.code === 0) {
      const r = await git(clonePath, ['diff', '-U0', '--no-renames', '--no-ext-diff', '--no-textconv', fromOid, toOid, '--', `:(top,literal)${path}`], { readOnly: true });
      if (r.code === 0) result = parseHunks(r.stdout.toString());
    }
    cache.set(path, result);
    return result;
  };

  let moved = 0;
  let toFile = 0;
  const threads: DraftThread[] = [];
  for (const t of draft.threads) {
    if (t.subjectType !== 'LINE' || !t.line || t.side === 'LEFT') {
      threads.push(t);
      continue;
    }
    const hunks = await hunksFor(t.path);
    const end = hunks ? mapLine(hunks, t.line) : null;
    const start = hunks && t.startLine && t.startSide !== 'LEFT' ? mapLine(hunks, t.startLine) : t.startLine;
    if (end != null && (t.startLine == null || start != null)) {
      if (end !== t.line || start !== t.startLine) moved++;
      threads.push({ ...t, line: end, ...(t.startLine != null ? { startLine: start ?? undefined } : {}) });
    } else {
      toFile++;
      const range = t.startLine && t.startLine !== t.line ? `L${t.startLine}-L${t.line}` : `L${t.line}`;
      const fence = t.snippet?.includes('```') ? '~~~' : '```';
      const quote = t.snippet ? `${fence}\n${t.snippet}\n${fence}\n` : '';
      threads.push({
        localId: t.localId,
        path: t.path,
        subjectType: 'FILE',
        body: `> On ${range} of an earlier version (that code has since changed):\n\n${quote}\n${t.body.replace(/```suggestion\b/g, '```')}`,
        snippet: t.snippet,
        createdAt: t.createdAt,
        updatedAt: new Date().toISOString(),
      });
    }
  }
  return { draft: { ...draft, threads, commitOid: toOid, updatedAt: new Date().toISOString() }, moved, toFile };
}
