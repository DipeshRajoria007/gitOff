import type { JiraIssue, Settings } from '../shared/types.js';
import { downloadMedia, localizeHtml, type MediaRef } from './media.js';
import { getMeta, saveJira, updateMeta } from './store.js';
import { exec, now } from './util.js';

export const KEYCHAIN_SERVICE = 'gitoff-jira';
/** Keychain service used before the rename; tokens saved there keep working. */
const LEGACY_KEYCHAIN_SERVICE = 'offline-github-jira';

export interface JiraCreds {
  baseUrl: string;
  email: string;
  token: string;
}

export async function getJiraBaseUrl(settings: Settings): Promise<string | null> {
  if (settings.jira.baseUrl) return settings.jira.baseUrl.replace(/\/+$/, '');
  const meta = await getMeta();
  return meta.learnedJira?.baseUrl ?? null;
}

async function keychainToken(email: string): Promise<string | null> {
  if (process.platform !== 'darwin') return null;
  for (const service of [KEYCHAIN_SERVICE, LEGACY_KEYCHAIN_SERVICE]) {
    const r = await exec('security', ['find-generic-password', '-s', service, '-a', email, '-w'], { timeoutMs: 5000 }).catch(() => null);
    const token = r?.code === 0 ? r.stdout.toString().trim() : '';
    if (token) return token;
  }
  return null;
}

export async function storeJiraToken(email: string, token: string): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('Saving the token needs the macOS Keychain. On other systems, start gitOff with the JIRA_API_TOKEN environment variable set instead.');
  const r = await exec('security', ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', email, '-w', token], { timeoutMs: 10_000 });
  if (r.code !== 0) throw new Error(`Could not save the token to Keychain: ${r.stderr.trim()}`);
}

export async function getJiraCreds(settings: Settings): Promise<JiraCreds | null> {
  const baseUrl = await getJiraBaseUrl(settings);
  const email = settings.jira.email || process.env.JIRA_EMAIL || null;
  if (!baseUrl || !email) return null;
  const token = process.env.JIRA_API_TOKEN || (await keychainToken(email));
  if (!token) return null;
  return { baseUrl, email, token };
}

const LINK_RE = /https:\/\/([a-z0-9-]+)\.atlassian\.net\/browse\/([A-Z][A-Z0-9_]+-\d+)/gi;
const KEY_RE = /\b([A-Za-z][A-Za-z0-9_]{1,9})-(\d{1,7})\b/g;

/**
 * Find Jira issue keys. Links to *.atlassian.net/browse/KEY-1 always count; bare
 * keys (in titles, branch names, commits) only count for known project keys so
 * things like "UTF-8" or "ISO-8601" are ignored.
 */
export function extractJiraKeys(htmlAndText: string[], plain: string[], knownProjects: string[]) {
  const keys = new Set<string>();
  const sites = new Set<string>();
  const projects = new Set(knownProjects.map((k) => k.toUpperCase()));
  for (const s of htmlAndText) {
    for (const m of s.matchAll(LINK_RE)) {
      sites.add(`https://${m[1].toLowerCase()}.atlassian.net`);
      const key = m[2].toUpperCase();
      keys.add(key);
      projects.add(key.split('-')[0]);
    }
  }
  for (const s of [...plain, ...htmlAndText]) {
    for (const m of s.matchAll(KEY_RE)) {
      const proj = m[1].toUpperCase();
      if (projects.has(proj)) keys.add(`${proj}-${Number(m[2])}`);
    }
  }
  return { keys: [...keys], sites: [...sites], projects: [...projects] };
}

export async function learnJira(sites: string[], projects: string[]): Promise<void> {
  if (!sites.length && !projects.length) return;
  await updateMeta((m) => {
    m.learnedJira ??= {};
    if (!m.learnedJira.baseUrl && sites[0]) m.learnedJira.baseUrl = sites[0];
    const set = new Set([...(m.learnedJira.projectKeys ?? []), ...projects]);
    m.learnedJira.projectKeys = [...set].slice(0, 50);
  });
}

function absolutize(html: string, baseUrl: string): string {
  return html.replace(/(\s(?:src|href)=")(\/[^"]*)"/g, (_w, pre: string, p: string) => `${pre}${baseUrl}${p}"`);
}

export async function fetchJiraIssue(creds: JiraCreds, key: string, media: Settings['media']): Promise<JiraIssue> {
  const auth = 'Basic ' + Buffer.from(`${creds.email}:${creds.token}`).toString('base64');
  const fields = 'summary,status,issuetype,priority,assignee,reporter,created,updated,labels,parent,subtasks,issuelinks,comment,description';
  const url = `${creds.baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}?expand=renderedFields&fields=${fields}`;
  const res = await fetch(url, {
    headers: { Authorization: auth, Accept: 'application/json', 'User-Agent': 'gitoff' },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 404) throw new Error(`${key} not found in Jira (or no access)`);
  if (res.status === 401 || res.status === 403) throw new Error(`Jira rejected the credentials (${res.status}); run \`gitoff jira login\` again`);
  if (!res.ok) throw new Error(`Jira HTTP ${res.status}`);
  const j: any = await res.json();
  const f = j.fields ?? {};
  const rf = j.renderedFields ?? {};
  const rawComments: any[] = f.comment?.comments ?? [];
  const renderedComments: any[] = rf.comment?.comments ?? [];

  let descriptionHTML = absolutize(rf.description ?? '', creds.baseUrl);
  let comments = rawComments.map((c, i) => ({
    id: String(c.id),
    author: c.author?.displayName ?? null,
    created: c.created,
    bodyHTML: absolutize(renderedComments[i]?.body ?? '', creds.baseUrl),
  }));

  // Jira attachments need auth to download; fetch them now so they show offline.
  const refs: MediaRef[] = [];
  const collect = (html: string) => {
    for (const m of html.matchAll(/<img\b[^>]*\ssrc="([^"]+)"/gi)) {
      const src = m[1].replace(/&amp;/g, '&');
      if (src.startsWith(creds.baseUrl)) refs.push({ url: src, kind: 'image', headers: { Authorization: auth } });
    }
  };
  collect(descriptionHTML);
  comments.forEach((c) => collect(c.bodyHTML));
  if (refs.length) await downloadMedia(refs, media);
  descriptionHTML = await localizeHtml(descriptionHTML);
  comments = await Promise.all(comments.map(async (c) => ({ ...c, bodyHTML: await localizeHtml(c.bodyHTML) })));

  const issue: JiraIssue = {
    key: j.key ?? key,
    url: `${creds.baseUrl}/browse/${j.key ?? key}`,
    fetchedAt: now(),
    summary: f.summary ?? '',
    status: f.status?.name ?? null,
    statusCategory: f.status?.statusCategory?.key ?? null,
    issueType: f.issuetype?.name ?? null,
    priority: f.priority?.name ?? null,
    assignee: f.assignee?.displayName ?? null,
    reporter: f.reporter?.displayName ?? null,
    created: f.created ?? null,
    updated: f.updated ?? null,
    labels: f.labels ?? [],
    parent: f.parent ? { key: f.parent.key, summary: f.parent.fields?.summary ?? '' } : null,
    descriptionHTML,
    comments,
    subtasks: (f.subtasks ?? []).map((s: any) => ({ key: s.key, summary: s.fields?.summary ?? '', status: s.fields?.status?.name ?? null })),
    links: (f.issuelinks ?? [])
      .map((l: any) => {
        const other = l.outwardIssue ?? l.inwardIssue;
        if (!other) return null;
        return {
          type: l.outwardIssue ? l.type?.outward : l.type?.inward,
          key: other.key,
          summary: other.fields?.summary ?? '',
          status: other.fields?.status?.name ?? null,
        };
      })
      .filter(Boolean),
  };
  await saveJira(issue);
  return issue;
}

export async function testJira(creds: JiraCreds): Promise<string> {
  const res = await fetch(`${creds.baseUrl}/rest/api/3/myself`, {
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${creds.email}:${creds.token}`).toString('base64'),
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Jira answered HTTP ${res.status}`);
  const j: any = await res.json();
  return j.displayName ?? creds.email;
}
