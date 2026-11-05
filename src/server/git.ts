import fsp from 'node:fs/promises';
import path from 'node:path';
import type { DiffFileEntry, DiffResponse, Settings, WorktreeInfo } from '../shared/types.js';
import { HOME, paths } from './store.js';
import { exec, exists, expandHome, now, readJson, writeJson, type ExecOptions } from './util.js';

export class GitError extends Error {
  constructor(
    message: string,
    public stderr = '',
  ) {
    super(message);
    this.name = 'GitError';
  }
}

const BASE_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
  GIT_ASKPASS: '',
  SSH_ASKPASS: '',
};

/** Config that keeps output machine-readable and stops repo hooks/prompts from running. */
const SAFE_CONFIG = [
  '-c', 'core.quotePath=false',
  '-c', 'color.ui=false',
  '-c', 'diff.noprefix=false',
  '-c', 'diff.mnemonicPrefix=false',
  '-c', 'diff.external=',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'advice.detachedHead=false',
];

export async function git(cwd: string, args: string[], opts: ExecOptions & { readOnly?: boolean } = {}) {
  return exec('git', [...SAFE_CONFIG, ...args], {
    ...opts,
    cwd,
    env: { ...BASE_ENV, ...(opts.readOnly ? { GIT_OPTIONAL_LOCKS: '0' } : {}), ...opts.env },
  });
}

export async function gitOut(cwd: string, args: string[], opts: ExecOptions & { readOnly?: boolean } = {}): Promise<string> {
  const r = await git(cwd, args, opts);
  if (r.code !== 0) {
    throw new GitError(`git ${args.filter((a) => !a.startsWith('-c')).slice(0, 3).join(' ')} failed: ${r.stderr.trim().split('\n').slice(-3).join(' ')}`, r.stderr);
  }
  return r.stdout.toString();
}

// ---------------------------------------------------------------------------
// Finding a local clone for owner/repo

export function remoteToNameWithOwner(url: string): string | null {
  const m =
    url.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?\/?$/i) ||
    url.match(/^(?:ssh:\/\/)?git@github\.com(?::\d+)?\/([^/]+)\/(.+?)(?:\.git)?\/?$/i) ||
    url.match(/^https?:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

interface RepoCache {
  [nameWithOwnerLower: string]: { path: string; kind: 'user' | 'managed' };
}

async function isFullCloneDir(dir: string): Promise<boolean> {
  try {
    const st = await fsp.stat(path.join(dir, '.git'));
    return st.isDirectory(); // worktrees have a .git *file*
  } catch {
    return false;
  }
}

export async function discoverClones(roots: string[]): Promise<Record<string, string[]>> {
  const found: Record<string, string[]> = {};
  for (const rootRaw of roots) {
    const root = expandHome(rootRaw);
    let entries: string[] = [];
    try {
      entries = await fsp.readdir(root);
    } catch {
      continue;
    }
    await Promise.all(
      entries.map(async (name) => {
        const dir = path.join(root, name);
        if (!(await isFullCloneDir(dir))) return;
        const r = await git(dir, ['config', '--get-regexp', '^remote\\..*\\.url$'], { readOnly: true, timeoutMs: 5000 }).catch(() => null);
        if (!r || r.code !== 0) return;
        const urls = r.stdout
          .toString()
          .split('\n')
          .map((l) => l.split(' ')[1])
          .filter(Boolean);
        for (const u of urls) {
          const nwo = remoteToNameWithOwner(u);
          if (nwo) (found[nwo] ??= []).includes(dir) || found[nwo].push(dir);
        }
      }),
    );
  }
  return found;
}

export async function resolveClone(owner: string, repo: string, settings: Settings): Promise<{ path: string; kind: 'user' | 'managed' }> {
  const nwo = `${owner}/${repo}`.toLowerCase();
  const override = Object.entries(settings.repos).find(([k]) => k.toLowerCase() === nwo)?.[1]?.clonePath;
  if (override) {
    const p = expandHome(override);
    if (await exists(path.join(p, '.git'))) return { path: p, kind: 'user' };
  }
  const cache = await readJson<RepoCache>(paths.repos, {});
  const cached = cache[nwo];
  if (cached && (await exists(cached.kind === 'managed' ? cached.path : path.join(cached.path, '.git')))) return cached;

  const clones = await discoverClones(settings.codeRoots);
  const candidates = clones[nwo] ?? [];
  if (candidates.length) {
    const exact = candidates.find((c) => path.basename(c).toLowerCase() === repo.toLowerCase());
    const pick = { path: exact ?? candidates.sort((a, b) => a.length - b.length)[0], kind: 'user' as const };
    cache[nwo] = pick;
    await writeJson(paths.repos, cache);
    return pick;
  }

  // No clone on disk: keep a bare clone of our own.
  const managed = path.join(paths.managedClones, owner, `${repo}.git`);
  if (!(await exists(managed))) {
    await fsp.mkdir(path.dirname(managed), { recursive: true });
    const r = await exec('git', [...SAFE_CONFIG, ...credentialArgs(), 'clone', '--bare', '--no-tags', `https://github.com/${owner}/${repo}.git`, managed], {
      env: BASE_ENV,
      timeoutMs: 30 * 60_000,
    });
    if (r.code !== 0) {
      await fsp.rm(managed, { recursive: true, force: true });
      throw new GitError(`Could not clone ${owner}/${repo}: ${r.stderr.trim().split('\n').slice(-2).join(' ')}`, r.stderr);
    }
  }
  const pick = { path: managed, kind: 'managed' as const };
  cache[nwo] = pick;
  await writeJson(paths.repos, cache);
  return pick;
}

function credentialArgs(): string[] {
  // Use the gh CLI's stored token over HTTPS so fetches never prompt (works even when
  // the clone's own remote uses SSH with a passphrase-protected key).
  return ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential'];
}

// ---------------------------------------------------------------------------
// Fetching PR refs

export const prRef = (n: number, which: 'head' | 'base') => `refs/ogh/pr/${n}/${which}`;

export async function fetchPrRefs(opts: {
  clonePath: string;
  owner: string;
  repo: string;
  number: number;
  baseRefName: string;
  baseRefOid: string;
  headRefOid: string;
}): Promise<{ baseOid: string; headOid: string; mergeBaseOid: string }> {
  const { clonePath, owner, repo, number } = opts;
  const url = `https://github.com/${owner}/${repo}.git`;
  const headRef = prRef(number, 'head');
  const baseRef = prRef(number, 'base');

  if (process.env.OGH_OFFLINE === '1') throw new GitError('Offline (OGH_OFFLINE=1): not fetching');
  const run = (refspecs: string[]) =>
    git(clonePath, [...credentialArgs(), 'fetch', '--no-tags', '--no-write-fetch-head', '--quiet', url, ...refspecs], {
      timeoutMs: 20 * 60_000,
    });

  let r = await run([`+refs/pull/${number}/head:${headRef}`, `+refs/heads/${opts.baseRefName}:${baseRef}`]);
  if (r.code !== 0) {
    // Base branch may be gone; GitHub also serves reachable commits by SHA.
    r = await run([`+refs/pull/${number}/head:${headRef}`, `+${opts.baseRefOid}:${baseRef}`]);
  }
  if (r.code !== 0) {
    throw new GitError(`git fetch failed: ${r.stderr.trim().split('\n').slice(-3).join(' ')}`, r.stderr);
  }
  const headOid = (await gitOut(clonePath, ['rev-parse', `${headRef}^{commit}`], { readOnly: true })).trim();
  const baseOid = (await gitOut(clonePath, ['rev-parse', `${baseRef}^{commit}`], { readOnly: true })).trim();
  // Pin every head we have seen so "changes since last review" works after force-pushes.
  await gitOut(clonePath, ['update-ref', `refs/ogh/pr/${number}/seen/${headOid}`, headOid]);
  const mergeBaseOid = (await gitOut(clonePath, ['merge-base', baseOid, headOid], { readOnly: true }).catch(() => baseOid)).trim();

  if (await isPartialClone(clonePath)) {
    // Promisor clones fetch blobs lazily; pull what the review needs while we're online.
    await git(clonePath, ['log', '-p', '--format=', `${mergeBaseOid}..${headOid}`], { readOnly: true, maxBytes: 1024 ** 3, timeoutMs: 20 * 60_000 });
    await git(clonePath, ['diff', '--stat', mergeBaseOid, headOid], { readOnly: true, timeoutMs: 20 * 60_000 });
  }
  return { baseOid, headOid, mergeBaseOid };
}

async function isPartialClone(clonePath: string): Promise<boolean> {
  const r = await git(clonePath, ['config', '--get', 'extensions.partialClone'], { readOnly: true });
  return r.code === 0 && r.stdout.toString().trim() !== '';
}

export async function hasCommit(clonePath: string, oid: string): Promise<boolean> {
  const r = await git(clonePath, ['cat-file', '-e', `${oid}^{commit}`], { readOnly: true });
  return r.code === 0;
}

export async function deletePrRefs(clonePath: string, number: number): Promise<void> {
  const out = await gitOut(clonePath, ['for-each-ref', '--format=%(refname)', `refs/ogh/pr/${number}/`], { readOnly: true }).catch(() => '');
  const refs = out.split('\n').filter(Boolean);
  if (!refs.length) return;
  await git(clonePath, ['update-ref', '--stdin'], { input: refs.map((r) => `delete ${r}\n`).join('') });
}

// ---------------------------------------------------------------------------
// Diffs

const GENERATED_PATTERNS = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)npm-shrinkwrap\.json$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)bun\.lockb?$/,
  /(^|\/)Cargo\.lock$/,
  /(^|\/)poetry\.lock$/,
  /(^|\/)uv\.lock$/,
  /(^|\/)Pipfile\.lock$/,
  /(^|\/)Gemfile\.lock$/,
  /(^|\/)composer\.lock$/,
  /(^|\/)go\.sum$/,
  /\.min\.(js|css)$/,
  /\.map$/,
  /\.snap$/,
];

const MAX_INLINE_LINES = 2500;

interface RawEntry {
  status: string;
  path: string;
  oldPath: string | null;
}

function parseRawZ(out: string): RawEntry[] {
  const parts = out.split('\0');
  const entries: RawEntry[] = [];
  let i = 0;
  while (i < parts.length) {
    const meta = parts[i];
    if (!meta || !meta.startsWith(':')) {
      i++;
      continue;
    }
    const status = meta.trim().split(' ').pop() || 'M';
    const code = status[0];
    if (code === 'R' || code === 'C') {
      entries.push({ status: code, oldPath: parts[i + 1], path: parts[i + 2] });
      i += 3;
    } else {
      entries.push({ status: code, oldPath: null, path: parts[i + 1] });
      i += 2;
    }
  }
  return entries;
}

function parseNumstatZ(out: string): Map<string, { add: number; del: number; binary: boolean }> {
  // "<add>\t<del>\t<path>\0" or for renames "<add>\t<del>\t\0<old>\0<new>\0"
  const map = new Map<string, { add: number; del: number; binary: boolean }>();
  const parts = out.split('\0');
  let i = 0;
  while (i < parts.length) {
    const p = parts[i];
    if (!p) {
      i++;
      continue;
    }
    const m = p.match(/^(-|\d+)\t(-|\d+)\t(.*)$/s);
    if (!m) {
      i++;
      continue;
    }
    const binary = m[1] === '-';
    const stat = { add: binary ? 0 : Number(m[1]), del: binary ? 0 : Number(m[2]), binary };
    if (m[3] === '') {
      map.set(parts[i + 2], stat);
      i += 3;
    } else {
      map.set(m[3], stat);
      i += 1;
    }
  }
  return map;
}

/** Undo git's C-style quoting ("a\\tb", octal UTF-8 bytes) and the trailing tab it adds to paths with spaces. */
function cleanPath(raw: string): string {
  let p = raw.replace(/\t$/, '');
  if (p.startsWith('"') && p.endsWith('"')) {
    const bytes: number[] = [];
    const body = p.slice(1, -1);
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      if (ch !== '\\') {
        bytes.push(...Buffer.from(ch, 'utf8'));
        continue;
      }
      const next = body[++i];
      if (/[0-7]/.test(next)) {
        bytes.push(parseInt(body.slice(i, i + 3), 8));
        i += 2;
      } else {
        const map: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 };
        bytes.push(map[next] ?? next.charCodeAt(0));
      }
    }
    p = Buffer.from(bytes).toString('utf8');
  }
  return p;
}

/** Map each `diff --git` chunk to its (new) path. */
function splitPatch(patch: string): Map<string, string> {
  const chunks = new Map<string, string>();
  if (!patch) return chunks;
  const starts: number[] = [];
  const re = /^diff --git /gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(patch))) starts.push(m.index);
  for (let k = 0; k < starts.length; k++) {
    const chunk = patch.slice(starts[k], k + 1 < starts.length ? starts[k + 1] : patch.length);
    const lines = chunk.split('\n', 12);
    let p: string | null = null;
    for (const line of lines) {
      if (line.startsWith('rename to ')) p = cleanPath(line.slice(10));
      else if (line.startsWith('copy to ')) p = cleanPath(line.slice(8));
      else if (line.startsWith('+++ b/')) p = cleanPath(line.slice(6));
      else if (line.startsWith('+++ "b/')) p = cleanPath('"' + line.slice(7));
      else if (line.startsWith('--- a/') && !p) p = cleanPath(line.slice(6)); // deleted file: "+++ /dev/null" follows
      else if (line.startsWith('--- "a/') && !p) p = cleanPath('"' + line.slice(7));
      if (line.startsWith('@@')) break;
    }
    if (!p) {
      // "diff --git a/X b/X": the two halves are equal when there's no rename.
      const header = lines[0].slice('diff --git '.length);
      const half = (header.length - 1) / 2;
      if (Number.isInteger(half)) p = header.slice(half + 1).replace(/^b\//, '');
    }
    if (p) chunks.set(p, chunk);
  }
  return chunks;
}

async function generatedByAttributes(clonePath: string, rev: string, files: string[]): Promise<Set<string>> {
  if (!files.length) return new Set();
  const r = await git(clonePath, ['check-attr', `--source=${rev}`, '-z', '--stdin', 'linguist-generated'], {
    input: files.join('\0') + '\0',
    readOnly: true,
  }).catch(() => null);
  const set = new Set<string>();
  if (!r || r.code !== 0) return set;
  const parts = r.stdout.toString().split('\0');
  for (let i = 0; i + 2 < parts.length; i += 3) {
    if (parts[i + 2] === 'set' || parts[i + 2] === 'true') set.add(parts[i]);
  }
  return set;
}

export async function computeDiff(clonePath: string, from: string, to: string, opts: { ignoreWhitespace?: boolean } = {}): Promise<DiffResponse> {
  const ws = opts.ignoreWhitespace ? ['-w'] : [];
  const [rawOut, numOut] = await Promise.all([
    gitOut(clonePath, ['diff', '--raw', '-z', '-M', '--no-abbrev', from, to], { readOnly: true }),
    gitOut(clonePath, ['diff', '--numstat', '-z', '-M', ...ws, from, to], { readOnly: true }),
  ]);
  const raw = parseRawZ(rawOut);
  const stats = parseNumstatZ(numOut);
  const generatedAttr = await generatedByAttributes(clonePath, to, raw.map((e) => e.path));

  const entries = raw.map((e) => {
    const st = stats.get(e.path) ?? { add: 0, del: 0, binary: false };
    const generated = generatedAttr.has(e.path) || GENERATED_PATTERNS.some((re) => re.test(e.path));
    const deferred = !st.binary && (generated || st.add + st.del > MAX_INLINE_LINES);
    return { e, st, generated, deferred };
  });

  const exclude = entries.filter((x) => x.deferred || x.st.binary).map((x) => `:(exclude,top,literal)${x.e.path}`);
  const patch = entries.some((x) => !x.deferred && !x.st.binary)
    ? await gitOut(clonePath, ['diff', '-M', '-U3', '--no-ext-diff', '--no-textconv', ...ws, from, to, '--', ':/', ...exclude], {
        readOnly: true,
      })
    : '';
  const chunks = splitPatch(patch);

  const statusOf = (c: string): DiffFileEntry['status'] =>
    c === 'A' ? 'added' : c === 'D' ? 'deleted' : c === 'R' ? 'renamed' : c === 'C' ? 'copied' : c === 'T' ? 'typechange' : 'modified';

  const files: DiffFileEntry[] = entries.map(({ e, st, generated, deferred }) => ({
    path: e.path,
    oldPath: e.oldPath,
    status: statusOf(e.status),
    additions: st.add,
    deletions: st.del,
    binary: st.binary,
    deferred,
    generated,
    patch: deferred || st.binary ? null : (chunks.get(e.path) ?? null),
  }));
  return { from, to, files };
}

export async function filePatch(clonePath: string, from: string, to: string, file: string, oldPath: string | null, ignoreWhitespace = false): Promise<string> {
  const specs = [`:(top,literal)${file}`];
  if (oldPath && oldPath !== file) specs.push(`:(top,literal)${oldPath}`);
  return gitOut(clonePath, ['diff', '-M', '-U3', '--no-ext-diff', '--no-textconv', ...(ignoreWhitespace ? ['-w'] : []), from, to, '--', ...specs], {
    readOnly: true,
  });
}

export async function readBlob(clonePath: string, rev: string, file: string, maxBytes = 25 * 1024 * 1024): Promise<Buffer | null> {
  const r = await git(clonePath, ['cat-file', 'blob', `${rev}:${file}`], { readOnly: true, maxBytes });
  return r.code === 0 ? r.stdout : null;
}

export async function changedPaths(clonePath: string, a: string, b: string): Promise<Set<string>> {
  const out = await gitOut(clonePath, ['diff', '--name-only', '-z', a, b], { readOnly: true });
  return new Set(out.split('\0').filter(Boolean));
}

export async function isAncestor(clonePath: string, a: string, b: string): Promise<boolean> {
  const r = await git(clonePath, ['merge-base', '--is-ancestor', a, b], { readOnly: true });
  return r.code === 0;
}

// ---------------------------------------------------------------------------
// Worktrees

interface WorktreeEntry {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
}

export async function listWorktrees(clonePath: string): Promise<WorktreeEntry[]> {
  const out = await gitOut(clonePath, ['worktree', 'list', '--porcelain', '-z'], { readOnly: true }).catch(() => '');
  const list: WorktreeEntry[] = [];
  let cur: WorktreeEntry | null = null;
  for (const field of out.split('\0')) {
    if (!field) {
      if (cur) list.push(cur);
      cur = null;
      continue;
    }
    if (field.startsWith('worktree ')) cur = { path: field.slice(9), head: null, branch: null, detached: false, bare: false };
    else if (!cur) continue;
    else if (field.startsWith('HEAD ')) cur.head = field.slice(5);
    else if (field.startsWith('branch ')) cur.branch = field.slice(7);
    else if (field === 'detached') cur.detached = true;
    else if (field === 'bare') cur.bare = true;
  }
  if (cur) list.push(cur);
  return list;
}

async function realpath(p: string): Promise<string> {
  try {
    return await fsp.realpath(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Does the worktree's HEAD contain commits that aren't on the PR (any head we've
 * fetched for it)? Then it holds work of yours and must not be moved or removed.
 */
export async function hasLocalCommits(worktreePath: string, number: number): Promise<boolean> {
  const r = await git(worktreePath, ['rev-list', '-n', '1', 'HEAD', '--not', `--glob=refs/ogh/pr/${number}/*`], { readOnly: true });
  return r.code !== 0 || r.stdout.toString().trim() !== '';
}

export async function isDirty(worktreePath: string): Promise<boolean> {
  const r = await git(worktreePath, ['status', '--porcelain', '--untracked-files=no'], { readOnly: true });
  return r.code !== 0 || r.stdout.toString().trim() !== '';
}

export function defaultWorktreePath(settings: Settings, clone: { path: string; kind: 'user' | 'managed' }, repo: string, number: number): string {
  if (settings.worktreeDir) return path.join(expandHome(settings.worktreeDir), `${repo}-review-${number}`);
  if (clone.kind === 'user') return path.join(path.dirname(clone.path), `${path.basename(clone.path)}-review-${number}`);
  const root = expandHome(settings.codeRoots[0] ?? path.join(HOME, 'worktrees'));
  return path.join(root, `${repo}-review-${number}`);
}

export async function ensureWorktree(args: {
  clone: { path: string; kind: 'user' | 'managed' };
  settings: Settings;
  repo: string;
  number: number;
  headOid: string;
  headRefName: string;
  viewerIsAuthor: boolean;
  isCrossRepository: boolean;
  previous?: WorktreeInfo;
}): Promise<WorktreeInfo> {
  const { clone, headOid } = args;
  const worktrees = await listWorktrees(clone.path);
  const ownBranch = args.viewerIsAuthor && !args.isCrossRepository ? args.headRefName : null;

  // Your own PR already checked out somewhere (main clone or another worktree): use that.
  if (ownBranch) {
    const w = worktrees.find((x) => x.branch === `refs/heads/${ownBranch}`);
    if (w) {
      return {
        path: w.path,
        headOid: w.head ?? headOid,
        branch: ownBranch,
        createdAt: args.previous?.createdAt ?? now(),
        existing: true,
        note: w.head && w.head !== headOid ? 'This checkout is at a different commit than the PR head (pull or push to sync).' : undefined,
      };
    }
  }

  const target = args.previous && !args.previous.existing && !args.previous.error ? args.previous.path : defaultWorktreePath(args.settings, clone, args.repo, args.number);
  const targetReal = await realpath(target);
  let entry: WorktreeEntry | undefined;
  for (const w of worktrees) {
    if ((await realpath(w.path)) === targetReal) entry = w;
  }

  if (!entry) {
    if (await exists(target)) {
      return { path: target, headOid, branch: null, createdAt: now(), error: `${target} exists but is not a worktree of ${clone.path}; leaving it alone.` };
    }
    await git(clone.path, ['worktree', 'prune'], {});
    let branch: string | null = null;
    let addArgs: string[];
    if (ownBranch) {
      const local = await git(clone.path, ['rev-parse', '--verify', '--quiet', `refs/heads/${ownBranch}^{commit}`], { readOnly: true });
      const localOid = local.code === 0 ? local.stdout.toString().trim() : null;
      if (!localOid) {
        addArgs = ['worktree', 'add', '-b', ownBranch, target, headOid];
        branch = ownBranch;
      } else if (localOid === headOid || (await isAncestor(clone.path, localOid, headOid))) {
        addArgs = ['worktree', 'add', target, ownBranch];
        branch = ownBranch;
      } else {
        addArgs = ['worktree', 'add', '--detach', target, headOid];
      }
    } else {
      addArgs = ['worktree', 'add', '--detach', target, headOid];
    }
    const r = await git(clone.path, addArgs, { timeoutMs: 15 * 60_000 });
    if (r.code !== 0) {
      return { path: target, headOid, branch: null, createdAt: now(), error: `git worktree add failed: ${r.stderr.trim().split('\n').slice(-2).join(' ')}` };
    }
    if (branch) {
      await git(clone.path, ['config', `branch.${branch}.remote`, 'origin']);
      await git(clone.path, ['config', `branch.${branch}.merge`, `refs/heads/${branch}`]);
      const cur = (await gitOut(target, ['rev-parse', 'HEAD'], { readOnly: true })).trim();
      if (cur !== headOid) await git(target, ['merge', '--ff-only', '--quiet', headOid]);
    }
    const head = (await gitOut(target, ['rev-parse', 'HEAD'], { readOnly: true }).catch(() => headOid)).trim();
    return {
      path: target,
      headOid: head,
      branch,
      createdAt: now(),
      note: ownBranch && !branch ? `Local branch ${ownBranch} has commits that aren't on the PR; checked out the PR head detached instead.` : undefined,
    };
  }

  // Worktree exists: bring it to the new head if that's safe.
  const info: WorktreeInfo = {
    path: entry.path,
    headOid: entry.head ?? headOid,
    branch: entry.branch?.replace('refs/heads/', '') ?? null,
    createdAt: args.previous?.createdAt ?? now(),
  };
  if (entry.head === headOid) return info;
  if (await isDirty(entry.path)) {
    return { ...info, dirty: true, note: 'Worktree has uncommitted changes, so it was not moved to the latest PR head.' };
  }
  if (entry.detached) {
    if (await hasLocalCommits(entry.path, args.number)) {
      return { ...info, note: 'Worktree has commits that are not on the PR, so it was not moved to the latest PR head.' };
    }
    const r = await git(entry.path, ['checkout', '--detach', '--quiet', headOid], { timeoutMs: 10 * 60_000 });
    if (r.code !== 0) return { ...info, note: `Could not update worktree: ${r.stderr.trim().split('\n').pop()}` };
    return { ...info, headOid };
  }
  if (ownBranch && entry.branch === `refs/heads/${ownBranch}`) {
    const r = await git(entry.path, ['merge', '--ff-only', '--quiet', headOid], { timeoutMs: 10 * 60_000 });
    if (r.code !== 0) return { ...info, note: 'Branch has diverged from the PR head; not updated.' };
    return { ...info, headOid };
  }
  return { ...info, note: `Worktree is on branch ${info.branch}; left as is.` };
}

export async function removeWorktree(clonePath: string, worktreePath: string, number: number): Promise<void> {
  if (await isDirty(worktreePath)) throw new GitError('Worktree has uncommitted changes; not removing it.');
  if (await hasLocalCommits(worktreePath, number)) throw new GitError('Worktree has commits that are not on the PR; not removing it.');
  const r = await git(clonePath, ['worktree', 'remove', worktreePath], {});
  if (r.code !== 0) throw new GitError(`git worktree remove failed: ${r.stderr.trim()}`);
}
