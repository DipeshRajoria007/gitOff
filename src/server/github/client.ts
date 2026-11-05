import { reportNetworkFailure, reportNetworkSuccess } from '../events.js';
import { exec, sleep } from '../util.js';

const API = 'https://api.github.com';

export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

export class GitHubError extends Error {
  status: number;
  types: string[];
  constructor(message: string, status: number, types: string[] = []) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.types = types;
  }
}

let cachedToken: string | null = null;

export async function getToken(forceRefresh = false): Promise<string> {
  if (!forceRefresh && cachedToken) return cachedToken;
  const env = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (env) return (cachedToken = env);
  const r = await exec('gh', ['auth', 'token'], { timeoutMs: 10_000 }).catch(() => null);
  const tok = r?.code === 0 ? r.stdout.toString().trim() : '';
  if (!tok) {
    throw new GitHubError(
      'No GitHub token. Run `gh auth login` (or set GITHUB_TOKEN) and try again.',
      401,
    );
  }
  return (cachedToken = tok);
}

export function isNetworkError(e: unknown): boolean {
  return e instanceof NetworkError;
}

const TRANSIENT_MESSAGE = /something went wrong|timed? ?out|timeout|try again|secondary rate|rate limit|abuse|temporarily|service unavailable|bad gateway/i;

/**
 * Worth retrying later (no connection, rate limits, GitHub hiccups) as opposed to
 * GitHub rejecting the request itself (validation, permissions, not found).
 */
export function isTransient(e: unknown): boolean {
  if (e instanceof NetworkError) return true;
  if (e instanceof GitHubError) {
    if (e.types.includes('RATE_LIMITED')) return true;
    if (e.status >= 500 || e.status === 429 || e.status === 408) return true;
    if (e.types.some((t) => ['SERVICE_UNAVAILABLE', 'INTERNAL', 'TIMEOUT'].includes(t))) return true;
    if (TRANSIENT_MESSAGE.test(e.message) && e.status !== 404 && e.status !== 422) return true;
  }
  return false;
}

function rateLimited(res: Response, body: string): boolean {
  return (
    res.status === 429 ||
    res.headers.get('x-ratelimit-remaining') === '0' ||
    !!res.headers.get('retry-after') ||
    /rate limit|abuse/i.test(body)
  );
}

/** OGH_OFFLINE=1 simulates having no connection (for rehearsing or testing). */
export const forcedOffline = () => process.env.OGH_OFFLINE === '1';

async function rawFetch(url: string, init: RequestInit & { timeoutMs?: number }): Promise<Response> {
  const { timeoutMs = 30_000, ...rest } = init;
  if (forcedOffline()) {
    reportNetworkFailure();
    throw new NetworkError(`Offline (OGH_OFFLINE=1): not contacting ${new URL(url).host}`);
  }
  try {
    const res = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
    reportNetworkSuccess();
    return res;
  } catch (e: any) {
    reportNetworkFailure();
    const cause = e?.cause?.code || e?.cause?.message || e?.name || '';
    throw new NetworkError(`Network error reaching ${new URL(url).host}${cause ? ` (${cause})` : ''}`);
  }
}

async function authHeaders(extra: Record<string, string> = {}): Promise<Record<string, string>> {
  return {
    Authorization: `bearer ${await getToken()}`,
    'User-Agent': 'offline-github',
    'X-GitHub-Api-Version': '2022-11-28',
    ...extra,
  };
}

export interface GraphQLResult<T> {
  data: T | null;
  errors: { type?: string; message: string; path?: (string | number)[] }[];
}

/**
 * GraphQL call. Retries transient 5xx. Returns data and errors; callers decide
 * whether partial data is acceptable (use `graphql` for the strict version).
 */
export async function graphqlRaw<T>(
  query: string,
  variables: Record<string, unknown> = {},
  opts: { timeoutMs?: number; retries?: number } = {},
): Promise<GraphQLResult<T>> {
  const retries = opts.retries ?? 2;
  for (let attempt = 0; ; attempt++) {
    const res = await rawFetch(`${API}/graphql`, {
      method: 'POST',
      headers: await authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ query, variables }),
      timeoutMs: opts.timeoutMs ?? 60_000,
    });
    if (res.status === 401) {
      cachedToken = null;
      throw new GitHubError('GitHub rejected the token (401). Run `gh auth login` again.', 401);
    }
    if ((res.status >= 500 || res.status === 429) && attempt < retries) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (res.status === 403 || res.status === 429) {
      const reset = res.headers.get('x-ratelimit-reset');
      const msg = await res.text().catch(() => '');
      const limited = rateLimited(res, msg);
      throw new GitHubError(
        `${limited ? 'GitHub rate limit' : 'GitHub refused the request'} (${res.status})${limited && reset ? `; resets at ${new Date(Number(reset) * 1000).toLocaleTimeString()}` : ''}: ${msg.slice(0, 300)}`,
        res.status,
        limited ? ['RATE_LIMITED'] : ['FORBIDDEN'],
      );
    }
    let json: any;
    try {
      json = await res.json();
    } catch {
      if (attempt < retries) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      throw new GitHubError(`GitHub returned a non-JSON response (${res.status})`, res.status);
    }
    if (!res.ok && !json?.data) {
      throw new GitHubError(json?.message || `GitHub GraphQL HTTP ${res.status}`, res.status);
    }
    return { data: json.data ?? null, errors: json.errors ?? [] };
  }
}

export async function graphql<T>(query: string, variables: Record<string, unknown> = {}, opts: { timeoutMs?: number; retries?: number } = {}): Promise<T> {
  const r = await graphqlRaw<T>(query, variables, opts);
  if (r.errors.length) {
    throw new GitHubError(
      r.errors.map((e) => e.message).join('; '),
      200,
      r.errors.map((e) => e.type || 'ERROR'),
    );
  }
  return r.data as T;
}

/** Mutations are not retried automatically (the caller handles idempotency). */
export async function mutate<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  return graphql<T>(query, variables, { retries: 0, timeoutMs: 45_000 });
}

export async function rest<T = any>(
  method: string,
  pathOrUrl: string,
  body?: unknown,
  opts: { timeoutMs?: number; accept?: string } = {},
): Promise<{ status: number; data: T; headers: Headers }> {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${API}${pathOrUrl}`;
  const res = await rawFetch(url, {
    method,
    headers: await authHeaders({
      Accept: opts.accept ?? 'application/vnd.github+json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    }),
    body: body ? JSON.stringify(body) : undefined,
    timeoutMs: opts.timeoutMs ?? 30_000,
  });
  const text = await res.text();
  let data: any = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body */
  }
  if (res.status >= 400) {
    const limited = (res.status === 403 || res.status === 429) && rateLimited(res, text);
    throw new GitHubError(data?.message || `GitHub HTTP ${res.status}`, res.status, limited ? ['RATE_LIMITED'] : []);
  }
  return { status: res.status, data, headers: res.headers };
}

/** Cheap connectivity probe: /rate_limit does not count against the quota. */
export async function ping(timeoutMs = 6000): Promise<{ ok: boolean; remaining?: number }> {
  if (forcedOffline()) return { ok: false };
  try {
    const res = await fetch(`${API}/rate_limit`, {
      headers: await authHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 200 || res.status === 401 || res.status === 403) {
      // Any real answer from api.github.com proves we're online.
      let remaining: number | undefined;
      try {
        const j: any = await res.json();
        remaining = j?.resources?.graphql?.remaining;
      } catch {
        /* ignore */
      }
      return { ok: true, remaining };
    }
    return { ok: res.status < 500 };
  } catch {
    return { ok: false };
  }
}
