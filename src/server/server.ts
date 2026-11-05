import fsp from 'node:fs/promises';
import { serve } from '@hono/node-server';
import { checkNow, isOnline, startConnectivity } from './connectivity.js';
import { buildApp } from './http.js';
import { onAfterSend, processOutbox, resetBackoff, setOnlineProbe } from './outbox.js';
import { fixStalePrepare } from './prepare.js';
import { getMeta, getOutbox, getSettings, getTracked, paths } from './store.js';
import { syncAll, syncPr } from './sync.js';
import { appendLine, exec } from './util.js';

export function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  appendLine(paths.serverLog, line);
}

async function maybeAutoSync(force = false) {
  if (!isOnline()) return;
  const s = await getSettings();
  if (!s.autoSyncMinutes && !force) return;
  const meta = await getMeta();
  const last = meta.lastSyncAt ? Date.parse(meta.lastSyncAt) : 0;
  if (force || Date.now() - last > s.autoSyncMinutes * 60_000) {
    void syncAll().then((p) => log(`sync: ${p.lastError ?? p.lastResult ?? 'done'}`));
  }
}

async function tick() {
  if (!isOnline()) return;
  const now = Date.now();
  const due = (await getOutbox()).some((x) => x.status === 'queued' && (!x.nextAttemptAt || Date.parse(x.nextAttemptAt) <= now));
  if (due) await processOutbox();
  await maybeAutoSync();
}

export async function startServer(opts: { port: number; open: boolean }) {
  await fsp.mkdir(paths.logs, { recursive: true });
  for (const t of await getTracked()) await fixStalePrepare(t.key);

  const app = buildApp();
  await new Promise<void>((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port: opts.port, hostname: '127.0.0.1' }, () => resolve());
    server.on('error', (e: any) => {
      if (e?.code === 'EADDRINUSE') reject(new Error(`Port ${opts.port} is busy. Is offline-github already running? Open http://localhost:${opts.port}`));
      else reject(e);
    });
  });
  const url = `http://localhost:${opts.port}`;
  log(`offline-github running at ${url} (data in ${paths.prs.replace(/\/prs$/, '')})`);

  setOnlineProbe(isOnline);
  onAfterSend((keys) => {
    for (const k of keys) void syncPr(k, { followLinks: false }).catch(() => {});
  });
  startConnectivity({
    onOnline: () => {
      log('online: sending outbox and refreshing PRs');
      void (async () => {
        await resetBackoff();
        await processOutbox();
        await maybeAutoSync(true);
      })();
    },
  });
  setInterval(() => void tick().catch((e) => log(`tick error: ${e?.message ?? e}`)), 60_000).unref?.();
  void checkNow();

  if (opts.open) await exec('open', [url]).catch(() => {});
  return url;
}
