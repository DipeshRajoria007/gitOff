import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { PRKey } from '../shared/types.js';
import { bus } from './events.js';
import { git } from './git.js';
import { getLocal, getSettings, getSnapshot, paths, updateLocal } from './store.js';
import { appendLine, errMsg, exists, now, splitKey } from './util.js';

const running = new Set<PRKey>();

function runLogged(cmd: string, args: string[], cwd: string, logFile: string, env: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const fd = fs.openSync(logFile, 'a');
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', fd, fd], env: { ...process.env, CI: '1', ...env } });
    child.once('error', (e) => {
      fs.closeSync(fd);
      reject(e);
    });
    child.once('close', (code) => {
      fs.closeSync(fd);
      resolve(code ?? -1);
    });
  });
}

async function findEnvFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, depth: number) {
    let entries: fs.Dirent[] = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === '.venv' || e.name === 'venv') continue;
      const p = path.join(dir, e.name);
      if (e.isFile() && /^\.env(\.|$)/.test(e.name)) out.push(path.relative(root, p));
      else if (e.isDirectory() && depth < 3 && !e.name.startsWith('.')) await walk(p, depth + 1);
    }
  }
  await walk(root, 0);
  return out;
}

const LOCKS: [string, string, string[]][] = [
  ['bun.lock', 'bun', ['install', '--frozen-lockfile']],
  ['bun.lockb', 'bun', ['install', '--frozen-lockfile']],
  ['pnpm-lock.yaml', 'pnpm', ['install', '--frozen-lockfile']],
  ['yarn.lock', 'yarn', ['install', '--frozen-lockfile']],
  ['package-lock.json', 'npm', ['ci', '--prefer-offline', '--no-audit', '--no-fund']],
];

/**
 * Make a PR's worktree runnable offline: copy your git-ignored .env files from the
 * main checkout and install dependencies while there's still a connection.
 */
export async function startPrepare(key: PRKey): Promise<void> {
  if (running.has(key)) throw new Error('Already preparing this PR.');
  running.add(key); // claim it before any await so a double-click can't start two installs
  let started = false;
  try {
    await startPrepareClaimed(key);
    started = true;
  } finally {
    if (!started) running.delete(key);
  }
}

async function startPrepareClaimed(key: PRKey): Promise<void> {
  const snap = await getSnapshot(key);
  const local = await getLocal(key);
  if (!snap?.git || !local.worktree || local.worktree.error || !local.worktree.path) {
    throw new Error('This PR has no worktree yet. Sync it first.');
  }
  const { owner, repo, number } = splitKey(key);
  const logFile = path.join(paths.logs, `prepare-${owner}-${repo}-${number}.log`);
  await fsp.mkdir(paths.logs, { recursive: true });
  await fsp.writeFile(logFile, `# Preparing ${key} in ${local.worktree.path}\n# ${now()}\n`);
  await updateLocal(key, (l) => {
    l.prepare = { status: 'running', startedAt: now(), logFile };
  });
  bus.emitEvent({ type: 'prepare', key });

  const wt = local.worktree.path;
  const clone = snap.git.clonePath;
  const fromUserClone = snap.git.cloneKind === 'user' && path.resolve(clone) !== path.resolve(wt);
  const log = (s: string) => appendLine(logFile, s);

  void (async () => {
    const summary: string[] = [];
    try {
      if (fromUserClone) {
        let copied = 0;
        for (const rel of await findEnvFiles(clone)) {
          const dst = path.join(wt, rel);
          if (await exists(dst)) continue;
          const ignored = await git(clone, ['check-ignore', '-q', rel], { readOnly: true });
          if (ignored.code !== 0) continue; // tracked files are already in the worktree
          await fsp.mkdir(path.dirname(dst), { recursive: true });
          await fsp.copyFile(path.join(clone, rel), dst);
          log(`copied ${rel}`);
          copied++;
        }
        summary.push(copied ? `copied ${copied} env file(s)` : 'no env files to copy');
      }

      const settings = await getSettings();
      const nwo = `${owner}/${repo}`.toLowerCase();
      const custom = Object.entries(settings.repos).find(([k]) => k.toLowerCase() === nwo)?.[1]?.prepare;
      if (custom) {
        log(`$ ${custom}`);
        const code = await runLogged('/bin/sh', ['-lc', custom], wt, logFile);
        if (code !== 0) throw new Error(`"${custom}" exited with ${code}`);
        summary.push(`ran ${custom}`);
      } else {
        const lock = LOCKS.find(([f]) => fs.existsSync(path.join(wt, f)));
        if (lock) {
          const [lockFile, pm, args] = lock;
          const dstNM = path.join(wt, 'node_modules');
          const srcNM = path.join(clone, 'node_modules');
          let installed = false;
          if (fromUserClone && !(await exists(dstNM)) && (await exists(srcNM))) {
            const same = await Promise.all([fsp.readFile(path.join(clone, lockFile)).catch(() => null), fsp.readFile(path.join(wt, lockFile))]).then(
              ([a, b]) => !!a && a.equals(b),
            );
            if (same || pm !== 'npm') {
              // Copy-on-write: APFS clones on macOS, reflinks on Linux (btrfs, XFS). Where the
              // filesystem can't do it, cp fails and we install instead of making a full copy.
              const cow = process.platform === 'darwin' ? ['-cR'] : ['-R', '--reflink=always'];
              log('cloning node_modules from your main checkout (copy-on-write, uses no extra disk)…');
              const code = await runLogged('cp', [...cow, srcNM, dstNM], wt, logFile);
              if (code === 0 && same) {
                installed = true;
                summary.push('reused node_modules (lockfile unchanged)');
              } else if (code !== 0) {
                await fsp.rm(dstNM, { recursive: true, force: true });
              }
            }
          }
          if (!installed) {
            log(`$ ${pm} ${args.join(' ')}`);
            const code = await runLogged(pm, args, wt, logFile);
            if (code !== 0) throw new Error(`${pm} ${args[0]} exited with ${code}`);
            summary.push(`${pm} ${args[0]} done`);
          }
        }
        if (fs.existsSync(path.join(wt, 'uv.lock'))) {
          log('$ uv sync --frozen');
          const code = await runLogged('uv', ['sync', '--frozen'], wt, logFile);
          if (code !== 0) throw new Error(`uv sync exited with ${code}`);
          summary.push('uv sync done');
        } else if (fs.existsSync(path.join(wt, 'requirements.txt')) && fromUserClone) {
          for (const v of ['.venv', 'venv']) {
            if ((await exists(path.join(clone, v))) && !(await exists(path.join(wt, v)))) {
              await fsp.symlink(path.join(clone, v), path.join(wt, v));
              log(`linked ${v} from your main checkout`);
              summary.push(`linked ${v}`);
              break;
            }
          }
        }
        if (!lock && !summary.some((s) => s.includes('uv') || s.includes('venv'))) {
          summary.push('no dependency manager detected (set a custom prepare command in settings)');
        }
      }
      log(`\n# done: ${summary.join(', ')}`);
      await updateLocal(key, (l) => {
        l.prepare = { status: 'done', startedAt: l.prepare?.startedAt ?? now(), finishedAt: now(), logFile, summary: summary.join(', ') };
      });
    } catch (e) {
      log(`\n# failed: ${errMsg(e)}`);
      await updateLocal(key, (l) => {
        l.prepare = { status: 'failed', startedAt: l.prepare?.startedAt ?? now(), finishedAt: now(), logFile, summary: errMsg(e) };
      });
    } finally {
      running.delete(key);
      bus.emitEvent({ type: 'prepare', key });
      bus.emitEvent({ type: 'pr', key });
    }
  })();
}

/** After a restart, a "running" prepare can't still be running. */
export async function fixStalePrepare(key: PRKey): Promise<void> {
  if (running.has(key)) return;
  const l = await getLocal(key);
  if (l.prepare?.status === 'running') {
    await updateLocal(key, (x) => {
      if (x.prepare) x.prepare = { ...x.prepare, status: 'failed', summary: 'Interrupted (server restarted)' };
    });
  }
}
