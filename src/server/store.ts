import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  JiraIssue,
  LocalState,
  OutboxItem,
  PRKey,
  PRSnapshot,
  Settings,
  TrackedPR,
} from '../shared/types.js';
import { KeyedMutex, expandHome, readJson, splitKey, writeJson } from './util.js';

export const HOME = process.env.OGH_HOME ? expandHome(process.env.OGH_HOME) : path.join(os.homedir(), '.offline-github');
export const DEFAULT_PORT = Number(process.env.OGH_PORT || 4777);

export const paths = {
  settings: path.join(HOME, 'settings.json'),
  tracked: path.join(HOME, 'tracked.json'),
  outbox: path.join(HOME, 'outbox.json'),
  repos: path.join(HOME, 'repos.json'),
  meta: path.join(HOME, 'meta.json'),
  assets: path.join(HOME, 'assets'),
  assetIndex: path.join(HOME, 'assets', 'index.json'),
  prs: path.join(HOME, 'prs'),
  jira: path.join(HOME, 'jira'),
  logs: path.join(HOME, 'logs'),
  managedClones: path.join(HOME, 'clones'),
  serverLog: path.join(HOME, 'logs', 'server.log'),
};

export const DEFAULT_SETTINGS: Settings = {
  codeRoots: ['~/code'],
  worktreeDir: null,
  editor: 'cursor',
  autoSyncMinutes: 15,
  queue: { reviewRequested: true, authored: true, authoredMaxAgeDays: 7 },
  media: { videos: true, maxVideoMB: 200, maxImageMB: 25 },
  linkedPrs: true,
  jira: { baseUrl: '', email: null, projectKeys: [] },
  repos: {},
};

const mutex = new KeyedMutex();

export function prDir(key: PRKey): string {
  const { owner, repo, number } = splitKey(key);
  return path.join(paths.prs, owner, repo, String(number));
}

// ---- settings ----

export async function getSettings(): Promise<Settings> {
  const s = await readJson<Partial<Settings>>(paths.settings, {});
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    queue: { ...DEFAULT_SETTINGS.queue, ...(s.queue ?? {}) },
    media: { ...DEFAULT_SETTINGS.media, ...(s.media ?? {}) },
    jira: { ...DEFAULT_SETTINGS.jira, ...(s.jira ?? {}) },
    repos: { ...(s.repos ?? {}) },
  };
}

export async function updateSettings(fn: (s: Settings) => void | Settings): Promise<Settings> {
  return mutex.run('settings', async () => {
    const s = await getSettings();
    const next = fn(s) ?? s;
    await writeJson(paths.settings, next);
    return next;
  });
}

// ---- tracked PRs ----

export async function getTracked(): Promise<TrackedPR[]> {
  return readJson<TrackedPR[]>(paths.tracked, []);
}

export async function updateTracked<T>(fn: (list: TrackedPR[]) => T | Promise<T>): Promise<T> {
  return mutex.run('tracked', async () => {
    const list = await getTracked();
    const result = await fn(list);
    await writeJson(paths.tracked, list);
    return result;
  });
}

// ---- snapshots ----

export async function getSnapshot(key: PRKey): Promise<PRSnapshot | null> {
  return readJson<PRSnapshot | null>(path.join(prDir(key), 'pr.json'), null);
}

export async function saveSnapshot(snap: PRSnapshot): Promise<void> {
  await mutex.run(`snap:${snap.key}`, () => writeJson(path.join(prDir(snap.key), 'pr.json'), snap));
}

export async function updateSnapshot(key: PRKey, fn: (s: PRSnapshot) => void): Promise<PRSnapshot | null> {
  return mutex.run(`snap:${key}`, async () => {
    const s = await getSnapshot(key);
    if (!s) return null;
    fn(s);
    await writeJson(path.join(prDir(key), 'pr.json'), s);
    return s;
  });
}

// ---- local review state ----

export const emptyLocal = (): LocalState => ({
  viewed: {},
  draft: null,
  lastReviewedOid: null,
  lastSeenUpdatedAt: null,
  seenHeads: [],
  resolveOverrides: {},
});

export async function getLocal(key: PRKey): Promise<LocalState> {
  const l = await readJson<Partial<LocalState>>(path.join(prDir(key), 'local.json'), {});
  return { ...emptyLocal(), ...l };
}

export async function updateLocal<T = LocalState>(key: PRKey, fn: (l: LocalState) => T | Promise<T>): Promise<T> {
  return mutex.run(`local:${key}`, async () => {
    const l = await getLocal(key);
    const r = await fn(l);
    await writeJson(path.join(prDir(key), 'local.json'), l);
    return (r === undefined ? l : r) as T;
  });
}

// ---- outbox ----

export async function getOutbox(): Promise<OutboxItem[]> {
  return readJson<OutboxItem[]>(paths.outbox, []);
}

export async function updateOutbox<T>(fn: (items: OutboxItem[]) => T | Promise<T>): Promise<T> {
  return mutex.run('outbox', async () => {
    const items = await getOutbox();
    const r = await fn(items);
    await writeJson(paths.outbox, items);
    return r;
  });
}

// ---- jira ----

export async function getJira(key: string): Promise<JiraIssue | null> {
  return readJson<JiraIssue | null>(path.join(paths.jira, `${key}.json`), null);
}

export async function saveJira(issue: JiraIssue): Promise<void> {
  await writeJson(path.join(paths.jira, `${issue.key}.json`), issue);
}

// ---- misc metadata (sync times etc.) ----

export interface Meta {
  lastSyncAt?: string;
  lastFullSyncAt?: string;
  lastQueueAt?: string;
  lastCleanupAt?: string;
  viewer?: { login: string; avatarUrl?: string | null };
  learnedJira?: { baseUrl?: string; projectKeys?: string[] };
}

export async function getMeta(): Promise<Meta> {
  return readJson<Meta>(paths.meta, {});
}

export async function updateMeta(fn: (m: Meta) => void): Promise<Meta> {
  return mutex.run('meta', async () => {
    const m = await getMeta();
    fn(m);
    await writeJson(paths.meta, m);
    return m;
  });
}

export async function removePrData(key: PRKey): Promise<void> {
  await fsp.rm(prDir(key), { recursive: true, force: true });
}
