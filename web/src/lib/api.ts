import type { AppStatus, DiffResponse, JiraIssue, OutboxItem, PRDetail, PRSummary, Settings } from '@shared/types';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { 'x-ogh': '1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) throw new ApiError((data && data.error) || `HTTP ${res.status}`, res.status);
  return data as T;
}

export const prPath = (owner: string, repo: string, number: number | string) => `/api/prs/${owner}/${repo}/${number}`;

export const fetchers = {
  status: () => api<AppStatus>('GET', '/api/status'),
  prs: () => api<(PRSummary & { syncing?: boolean })[]>('GET', '/api/prs'),
  pr: (o: string, r: string, n: string) => api<PRDetail & { syncing?: boolean }>('GET', prPath(o, r, n)),
  diff: (o: string, r: string, n: string, q: Record<string, string>) =>
    api<DiffResponse>('GET', `${prPath(o, r, n)}/diff?${new URLSearchParams(q)}`),
  outbox: () => api<{ items: OutboxItem[]; titles: Record<string, string> }>('GET', '/api/outbox'),
  settings: () =>
    api<{ settings: Settings; editors: string[]; learnedJira: { baseUrl?: string; projectKeys?: string[] } | null; jiraConfigured: boolean; home: string }>(
      'GET',
      '/api/settings',
    ),
  jira: (key: string) => api<JiraIssue>('GET', `/api/jira/${key}`),
};

export function blobUrl(o: string, r: string, n: string | number, ref: string, path: string) {
  return `${prPath(o, r, n)}/blob?${new URLSearchParams({ ref, path })}`;
}

export function splitKey(key: string) {
  const m = key.match(/^([^/]+)\/([^#]+)#(\d+)$/)!;
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

export const prUrl = (key: string, tab = '') => {
  const { owner, repo, number } = splitKey(key);
  return `/${owner}/${repo}/pull/${number}${tab ? `/${tab}` : ''}`;
};
