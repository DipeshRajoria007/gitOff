import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { availableEditors, openInEditor } from './editor.js';
import { getToken } from './github/client.js';
import { discoverClones } from './git.js';
import { getJiraBaseUrl, getJiraCreds, storeJiraToken, testJira } from './jira.js';
import { DEFAULT_PORT, HOME, getLocal, getMeta, getOutbox, getSettings, getTracked, paths, updateSettings } from './store.js';
import { exec, parsePrUrl, prKey } from './util.js';

const HELP = `offline-github (ogh): review GitHub PRs offline

  ogh serve [--port N] [--no-open]   Start the app (http://localhost:${DEFAULT_PORT}) and the background syncer
  ogh add <pr-url> [...]             Cache PRs for offline review (also: owner/repo#123)
  ogh sync [--full]                  Send queued reviews, refresh your review queue and all cached PRs
  ogh status                         What's cached, what's waiting in the outbox
  ogh open <pr> [file[:line]]        Open the PR's worktree in Cursor (or VS Code)
  ogh prepare <pr>                   Copy .env files + install dependencies in the PR's worktree
  ogh jira login                     Save Jira email + API token (macOS Keychain) to cache tickets
  ogh doctor                         Check gh auth, git, editor, clones, Jira
  ogh service install|uninstall      Keep the app running in the background (macOS LaunchAgent)

Data lives in ${HOME}`;

// `ogh status | head` closes the pipe early; that's not an error.
process.stdout.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EPIPE') process.exit(0);
});

const args = process.argv.slice(2);
if (args[0] && parsePrUrl(args[0])) args.unshift('add'); // `ogh <url>` means `ogh add <url>`
const cmd = args[0] ?? 'help';
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const port = Number(opt('port') ?? DEFAULT_PORT);
const base = `http://127.0.0.1:${port}`;

async function api<T = any>(method: string, p: string, body?: unknown): Promise<T | null> {
  try {
    const res = await fetch(`${base}${p}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-ogh': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
    return j as T;
  } catch (e: any) {
    // Only fall back to doing the work here when the app really isn't running;
    // a slow app must not end up sending the outbox twice in parallel.
    if (e?.cause?.code === 'ECONNREFUSED') return null;
    if (e?.name === 'TimeoutError') throw new Error(`The app at ${base} is running but not answering. Try again in a moment, or restart it.`);
    throw e;
  }
}

function resolvePrArg(s: string | undefined, list: { key: string; number: number }[]): string {
  if (!s) throw new Error('Which PR? Pass a URL, owner/repo#123, or a number.');
  const r = parsePrUrl(s);
  if (r) return prKey(r.owner, r.repo, r.number);
  const n = Number(s.replace(/^#/, ''));
  const hits = list.filter((t) => t.number === n);
  if (hits.length === 1) return hits[0].key;
  if (hits.length > 1) throw new Error(`#${n} is ambiguous: ${hits.map((h) => h.key).join(', ')}`);
  throw new Error(`Not a cached PR: ${s}`);
}

function ask(q: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      const w = (rl as any)._writeToOutput;
      (rl as any)._writeToOutput = (s: string) => (s.includes(q) ? w.call(rl, s) : w.call(rl, s.replace(/[^\r\n]/g, '')));
    }
    rl.question(q, (a) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(a.trim());
    });
  });
}

const ago = (iso?: string) => {
  if (!iso) return 'never';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

async function main() {
  switch (cmd) {
    case 'serve': {
      const { startServer } = await import('./server.js');
      await startServer({ port, open: !flag('no-open') });
      return; // keep running
    }

    case 'add': {
      const urls = args.slice(1).filter((a) => !a.startsWith('--'));
      if (!urls.length) throw new Error('Usage: ogh add <pr-url> [...]');
      const viaServer = await api<{ keys: string[]; invalid: string[] }>('POST', '/api/prs', { urls: urls.join(' ') });
      if (viaServer) {
        if (viaServer.invalid.length) console.log(`Skipped (not PR links): ${viaServer.invalid.join(', ')}`);
        console.log(`Added ${viaServer.keys.join(', ')}; downloading in the background. Open ${base.replace('127.0.0.1', 'localhost')}`);
        return;
      }
      const { trackPrs, syncPr } = await import('./sync.js');
      const refs = urls.map(parsePrUrl).filter((r): r is NonNullable<typeof r> => !!r);
      const keys = await trackPrs(refs, 'manual');
      for (const k of keys) {
        process.stdout.write(`Downloading ${k} … `);
        const r = await syncPr(k);
        console.log(r.ok ? `done${r.mediaFailed ? ` (${r.mediaFailed} media files failed)` : ''}` : `failed: ${r.error}`);
      }
      return;
    }

    case 'sync': {
      const viaServer = await api('POST', '/api/sync', { full: flag('full') });
      if (viaServer) {
        console.log('Sync started in the app. Watch progress there, or run `ogh status`.');
        return;
      }
      const { syncAll } = await import('./sync.js');
      const { processOutbox } = await import('./outbox.js');
      console.log('Syncing (app not running, doing it here)…');
      const p = await syncAll({ full: flag('full') });
      await processOutbox();
      console.log(p.lastError ? `Sync stopped: ${p.lastError}` : `Done: ${p.lastResult}`);
      return;
    }

    case 'status': {
      const tracked = await getTracked();
      const outbox = await getOutbox();
      const meta = await getMeta();
      const running = await api('GET', '/api/status').catch(() => null);
      console.log(`App: ${running ? `running at ${base.replace('127.0.0.1', 'localhost')}` : 'not running (ogh serve)'}`);
      console.log(`Last sync: ${ago(meta.lastSyncAt)}   Cached PRs: ${tracked.length}`);
      for (const t of tracked) {
        const l = await getLocal(t.key);
        const flags = [
          t.sources.join('+') || 'cached',
          t.lastSyncError ? `ERROR: ${t.lastSyncError}` : `synced ${ago(t.lastSyncAt)}`,
          l.worktree?.path && !l.worktree.error ? `worktree ${l.worktree.path.replace(os.homedir(), '~')}` : null,
          l.draft && (l.draft.threads.length || l.draft.replies.length) ? `draft: ${l.draft.threads.length + l.draft.replies.length} comment(s)` : null,
        ].filter(Boolean);
        console.log(`  ${t.key.padEnd(40)} ${flags.join(' · ')}`);
      }
      const pending = outbox.filter((x) => x.status !== 'sent' && x.type !== 'viewed');
      console.log(`Outbox: ${pending.length ? pending.map((x) => `${x.type}(${x.status}) ${x.prKey}`).join(', ') : 'empty'}`);
      return;
    }

    case 'open': {
      const tracked = await getTracked();
      const key = resolvePrArg(args[1], tracked);
      const [file, line] = (args[2] ?? '').split(':');
      const settings = await getSettings();
      const l = await getLocal(key);
      if (!l.worktree?.path || l.worktree.error) throw new Error(l.worktree?.error ?? 'No worktree yet; sync the PR first.');
      await openInEditor((opt('editor') as any) ?? settings.editor, l.worktree.path, file || undefined, line ? Number(line) : undefined);
      console.log(`Opened ${l.worktree.path}`);
      return;
    }

    case 'prepare': {
      const tracked = await getTracked();
      const key = resolvePrArg(args[1], tracked);
      const [owner, rest] = key.split('/');
      const [repo, num] = rest.split('#');
      const viaServer = await api('POST', `/api/prs/${owner}/${repo}/${num}/prepare`);
      if (viaServer) {
        console.log('Preparing in the app; follow the log on the PR page.');
        return;
      }
      const { startPrepare } = await import('./prepare.js');
      await startPrepare(key);
      process.stdout.write('Preparing');
      while ((await getLocal(key)).prepare?.status === 'running') {
        process.stdout.write('.');
        await new Promise((r) => setTimeout(r, 2000));
      }
      const p = (await getLocal(key)).prepare;
      console.log(`\n${p?.status}: ${p?.summary ?? ''}\nLog: ${p?.logFile}`);
      return;
    }

    case 'jira': {
      if (args[1] !== 'login') throw new Error('Usage: ogh jira login');
      const settings = await getSettings();
      const learned = await getJiraBaseUrl(settings);
      const site = (await ask(`Jira site URL${learned ? ` [${learned}]` : ''}: `)) || learned || '';
      if (!/^https:\/\//.test(site)) throw new Error('Site must look like https://yourcompany.atlassian.net');
      const email = (await ask(`Atlassian account email${settings.jira.email ? ` [${settings.jira.email}]` : ''}: `)) || settings.jira.email || '';
      console.log('Create a token at https://id.atlassian.com/manage-profile/security/api-tokens');
      const token = await ask('API token (hidden): ', true);
      const name = await testJira({ baseUrl: site.replace(/\/+$/, ''), email, token });
      await storeJiraToken(email, token);
      await updateSettings((s) => {
        s.jira.baseUrl = site.replace(/\/+$/, '');
        s.jira.email = email;
      });
      console.log(`Jira connected as ${name}. Token saved in your macOS Keychain (service "offline-github-jira").`);
      return;
    }

    case 'doctor': {
      const ok = (b: boolean) => (b ? '✓' : '✗');
      const settings = await getSettings();
      let ghOk = false;
      try {
        await getToken();
        ghOk = true;
      } catch {}
      console.log(`${ok(ghOk)} GitHub auth via gh${ghOk ? '' : ' (run: gh auth login)'}`);
      const gitV = await exec('git', ['--version']).catch(() => null);
      console.log(`${ok(!!gitV && gitV.code === 0)} ${gitV?.stdout.toString().trim() ?? 'git not found'}`);
      console.log(`${ok(true)} node ${process.version}`);
      const editors = await availableEditors();
      console.log(`${ok(editors.length > 0)} editors: ${editors.join(', ') || 'none found (install the cursor/code shell command)'}`);
      const clones = await discoverClones(settings.codeRoots);
      console.log(`${ok(Object.keys(clones).length > 0)} ${Object.keys(clones).length} GitHub clones found under ${settings.codeRoots.join(', ')}`);
      const jira = await getJiraCreds(settings);
      console.log(`${ok(!!jira)} Jira ${jira ? `connected (${jira.baseUrl})` : 'not connected (ogh jira login)'}`);
      const df = await exec('df', ['-h', HOME.startsWith(os.homedir()) ? os.homedir() : HOME]).catch(() => null);
      const free = df?.stdout.toString().split('\n')[1]?.split(/\s+/)[3];
      console.log(`${ok(true)} free disk: ${free ?? '?'}`);
      const running = await api('GET', '/api/status').catch(() => null);
      console.log(`${ok(!!running)} app ${running ? `running at ${base.replace('127.0.0.1', 'localhost')}` : 'not running (ogh serve)'}`);
      return;
    }

    case 'service': {
      const label = 'com.offline-github.server';
      const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
      const uid = process.getuid?.() ?? 501;
      if (args[1] === 'install') {
        const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin/ogh.mjs');
        const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array><string>${esc(process.execPath)}</string><string>${esc(bin)}</string><string>serve</string><string>--no-open</string><string>--port</string><string>${port}</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${esc(process.env.PATH ?? '/usr/bin:/bin')}</string><key>HOME</key><string>${esc(os.homedir())}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${esc(path.join(paths.logs, 'service.out.log'))}</string>
  <key>StandardErrorPath</key><string>${esc(path.join(paths.logs, 'service.err.log'))}</string>
</dict></plist>
`;
        await fsp.mkdir(path.dirname(plist), { recursive: true });
        await fsp.mkdir(paths.logs, { recursive: true });
        await exec('launchctl', ['bootout', `gui/${uid}/${label}`]).catch(() => null);
        await fsp.writeFile(plist, xml);
        const r = await exec('launchctl', ['bootstrap', `gui/${uid}`, plist]);
        if (r.code !== 0) throw new Error(`launchctl: ${r.stderr.trim()}`);
        console.log(`Installed. offline-github now starts at login and stays running: ${base.replace('127.0.0.1', 'localhost')}`);
      } else if (args[1] === 'uninstall') {
        await exec('launchctl', ['bootout', `gui/${uid}/${label}`]).catch(() => null);
        await fsp.rm(plist, { force: true });
        console.log('Removed the background service.');
      } else {
        throw new Error('Usage: ogh service install|uninstall');
      }
      return;
    }

    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return;

    default:
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`ogh: ${e?.message ?? e}`);
  process.exit(1);
});
