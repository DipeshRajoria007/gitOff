import type {
  Actor,
  CheckItem,
  Commit,
  PRFile,
  PRSnapshot,
  Review,
  ReviewComment,
  ReviewThread,
  TimelineItem,
} from '../../shared/types.js';
import { now, prKey } from '../util.js';
import { GitHubError, graphql, graphqlRaw } from './client.js';
import {
  PAGE_COMMITS,
  PAGE_FILES,
  PAGE_REVIEWS,
  PAGE_THREAD_COMMENTS,
  PAGE_THREADS,
  PAGE_TIMELINE,
  PR_CONVERSATION,
  PR_CORE,
} from './queries.js';

const MAX_PAGES = 40;

async function paginate<T>(
  query: string,
  id: string,
  field: string,
  first: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: (T | null)[] } | null | undefined,
): Promise<T[]> {
  // GitHub can return partial data (a connection or some nodes null); keep what's there.
  if (!first) return [];
  const out = (first.nodes ?? []).filter((n): n is T => n != null);
  let pageInfo = first.pageInfo;
  let pages = 0;
  while (pageInfo?.hasNextPage && pages++ < MAX_PAGES) {
    const r = await graphql<any>(query, { id, after: pageInfo.endCursor });
    const conn = r?.node?.[field];
    if (!conn) break;
    out.push(...(conn.nodes ?? []).filter((n: T | null) => n != null));
    pageInfo = conn.pageInfo;
  }
  return out;
}

/** Non-null nodes of a (possibly null) connection. */
const nodes = (conn: any): any[] => (conn?.nodes ?? []).filter((n: any) => n != null);

const actor = (a: any): Actor | null => (a ? { login: a.login, avatarUrl: a.avatarUrl ?? null } : null);

function mapComment(c: any): ReviewComment {
  return {
    id: c.id,
    databaseId: c.databaseId ?? null,
    url: c.url,
    body: c.body ?? '',
    bodyHTML: c.bodyHTML ?? '',
    createdAt: c.createdAt,
    lastEditedAt: c.lastEditedAt ?? null,
    author: actor(c.author),
    authorAssociation: c.authorAssociation,
    diffHunk: c.diffHunk ?? '',
    path: c.path,
    line: c.line ?? null,
    originalLine: c.originalLine ?? null,
    startLine: c.startLine ?? null,
    originalStartLine: c.originalStartLine ?? null,
    outdated: !!c.outdated,
    commitOid: c.commit?.oid ?? null,
    originalCommitOid: c.originalCommit?.oid ?? null,
    replyToId: c.replyTo?.id ?? null,
    reviewId: c.pullRequestReview?.id ?? null,
    state: c.state ?? 'SUBMITTED',
    reactions: (c.reactionGroups ?? []).filter(Boolean)
      .filter((g: any) => g.reactors?.totalCount > 0)
      .map((g: any) => ({ content: g.content, count: g.reactors.totalCount, viewerHasReacted: !!g.viewerHasReacted })),
  };
}

async function mapThread(t: any): Promise<ReviewThread> {
  let comments = nodes(t.comments);
  if (t.comments?.pageInfo?.hasNextPage) {
    comments = await paginate(PAGE_THREAD_COMMENTS, t.id, 'comments', t.comments);
  }
  return {
    id: t.id,
    isResolved: !!t.isResolved,
    isOutdated: !!t.isOutdated,
    isCollapsed: !!t.isCollapsed,
    path: t.path,
    line: t.line ?? null,
    originalLine: t.originalLine ?? null,
    startLine: t.startLine ?? null,
    originalStartLine: t.originalStartLine ?? null,
    diffSide: t.diffSide ?? 'RIGHT',
    startDiffSide: t.startDiffSide ?? null,
    subjectType: t.subjectType ?? 'LINE',
    resolvedBy: t.resolvedBy?.login ?? null,
    viewerCanResolve: !!t.viewerCanResolve,
    viewerCanUnresolve: !!t.viewerCanUnresolve,
    viewerCanReply: t.viewerCanReply !== false,
    // Pending comments of the viewer (from a review started on github.com) are skipped
    // here; they belong to the viewer's own unsubmitted review.
    comments: comments.map(mapComment).filter((c: ReviewComment) => c.state !== 'PENDING'),
  };
}

function mapReview(r: any): Review {
  return {
    id: r.id,
    databaseId: r.databaseId ?? null,
    url: r.url,
    state: r.state,
    body: r.body ?? '',
    bodyHTML: r.bodyHTML ?? '',
    submittedAt: r.submittedAt ?? null,
    createdAt: r.createdAt,
    author: actor(r.author),
    authorAssociation: r.authorAssociation,
    commitOid: r.commit?.oid ?? null,
    commentCount: r.comments?.totalCount ?? 0,
  };
}

function mapCommit(n: any): Commit {
  const c = n.commit;
  return {
    oid: c.oid,
    abbreviatedOid: c.abbreviatedOid,
    messageHeadline: c.messageHeadline,
    messageBody: c.messageBody ?? '',
    committedDate: c.committedDate,
    authoredDate: c.authoredDate,
    url: c.url,
    author: {
      name: c.author?.name ?? null,
      email: c.author?.email ?? null,
      login: c.author?.user?.login ?? null,
      avatarUrl: c.author?.user?.avatarUrl ?? null,
    },
    checkState: c.statusCheckRollup?.state ?? null,
  };
}

function mapChecks(lastCommit: any): PRSnapshot['checks'] {
  const commit = lastCommit?.nodes?.[0]?.commit;
  const rollup = commit?.statusCheckRollup;
  const items: CheckItem[] = nodes(rollup?.contexts).map((n: any): CheckItem => {
    if (n.__typename === 'CheckRun') {
      return {
        kind: 'check',
        name: n.name,
        status: n.status ?? null,
        conclusion: n.conclusion ?? null,
        state: null,
        url: n.detailsUrl ?? null,
        title: n.title ?? null,
        summary: n.summary ?? null,
        appName: n.checkSuite?.app?.name ?? null,
        workflowName: n.checkSuite?.workflowRun?.workflow?.name ?? null,
        isRequired: !!n.isRequired,
        startedAt: n.startedAt ?? null,
        completedAt: n.completedAt ?? null,
      };
    }
    return {
      kind: 'status',
      name: n.context,
      status: null,
      conclusion: null,
      state: n.state ?? null,
      url: n.targetUrl ?? null,
      title: n.description ?? null,
      summary: null,
      appName: null,
      workflowName: null,
      isRequired: !!n.isRequired,
      startedAt: n.createdAt ?? null,
      completedAt: null,
    };
  });
  return { state: rollup?.state ?? null, commitOid: commit?.oid ?? null, items };
}

export class PRNotFoundError extends Error {}

/** Download everything GitHub knows about a PR (no git data, no media). */
export async function fetchPrSnapshot(owner: string, repo: string, number: number): Promise<Omit<PRSnapshot, 'linked'>> {
  const vars = { owner, repo, number };
  const [coreRes, convRes] = await Promise.all([
    graphqlRaw<any>(PR_CORE, vars),
    graphqlRaw<any>(PR_CONVERSATION, vars),
  ]);
  const repository = coreRes.data?.repository;
  const pr = repository?.pullRequest;
  if (!pr) {
    const msg = coreRes.errors.map((e) => e.message).join('; ');
    if (coreRes.errors.some((e) => e.type === 'NOT_FOUND') || !repository) {
      throw new PRNotFoundError(msg || `PR ${owner}/${repo}#${number} not found (or no access)`);
    }
    throw new GitHubError(msg || 'Pull request missing from response', 200);
  }
  const conv = convRes.data?.repository?.pullRequest;
  if (!conv) {
    throw new GitHubError(convRes.errors.map((e) => e.message).join('; ') || 'conversation query failed', 200);
  }

  const [files, commits, threadNodes, reviewNodes, timelineNodes] = await Promise.all([
    paginate<any>(PAGE_FILES, pr.id, 'files', pr.files),
    paginate<any>(PAGE_COMMITS, pr.id, 'commits', pr.commits),
    paginate<any>(PAGE_THREADS, pr.id, 'reviewThreads', conv.reviewThreads),
    paginate<any>(PAGE_REVIEWS, pr.id, 'reviews', conv.reviews),
    paginate<any>(PAGE_TIMELINE, pr.id, 'timelineItems', conv.timelineItems),
  ]);

  const threads: ReviewThread[] = [];
  for (const t of threadNodes) {
    const mapped = await mapThread(t);
    if (mapped.comments.length) threads.push(mapped);
  }

  const timeline: TimelineItem[] = timelineNodes
    .filter((n: any) => n && n.__typename)
    // The viewer's own pending review (started on github.com) is not public yet.
    .filter((n: any) => !(n.__typename === 'PullRequestReview' && n.state === 'PENDING'))
    .map((n: any) => ({ ...n, id: n.id ?? `${n.__typename}-${n.createdAt}` }));

  return {
    schema: 1,
    key: prKey(owner, repo, number),
    owner,
    repo,
    number,
    fetchedAt: now(),
    viewer: actor(coreRes.data?.viewer) ?? { login: 'unknown' },
    repoInfo: {
      isPrivate: !!repository.isPrivate,
      defaultBranch: repository.defaultBranchRef?.name ?? null,
      url: repository.url,
    },
    pr: {
      id: pr.id,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      state: pr.state,
      isDraft: !!pr.isDraft,
      merged: !!pr.merged,
      mergedAt: pr.mergedAt ?? null,
      closedAt: pr.closedAt ?? null,
      createdAt: pr.createdAt,
      updatedAt: pr.updatedAt,
      body: pr.body ?? '',
      bodyHTML: pr.bodyHTML ?? '',
      author: actor(pr.author),
      authorAssociation: pr.authorAssociation,
      baseRefName: pr.baseRefName,
      headRefName: pr.headRefName,
      baseRefOid: pr.baseRefOid,
      headRefOid: pr.headRefOid,
      isCrossRepository: !!pr.isCrossRepository,
      headRepository: pr.headRepository?.nameWithOwner ?? null,
      headOwner: pr.headRepositoryOwner?.login ?? null,
      mergeable: pr.mergeable ?? null,
      mergeStateStatus: pr.mergeStateStatus ?? null,
      reviewDecision: pr.reviewDecision ?? null,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changedFiles,
      mergedBy: actor(pr.mergedBy),
      labels: nodes(pr.labels).map((l: any) => ({ name: l.name, color: l.color, description: l.description })),
      assignees: nodes(pr.assignees).map(actor).filter(Boolean) as Actor[],
      reviewRequests: nodes(pr.reviewRequests)
        .map((n: any) => n.requestedReviewer)
        .filter(Boolean)
        .map((r: any) => ({ kind: r.__typename, login: r.login, name: r.name, avatarUrl: r.avatarUrl ?? null })),
      latestReviews: nodes(pr.latestOpinionatedReviews).map((r: any) => ({
        author: actor(r.author),
        state: r.state,
        submittedAt: r.submittedAt ?? null,
      })),
      milestone: pr.milestone ? { title: pr.milestone.title, url: pr.milestone.url } : null,
      closingIssues: nodes(pr.closingIssuesReferences).map((i: any) => ({
        repo: i.repository?.nameWithOwner ?? '',
        number: i.number,
        title: i.title,
        url: i.url,
        state: i.state,
        bodyHTML: i.bodyHTML ?? '',
        author: actor(i.author),
        createdAt: i.createdAt,
      })),
      viewerLatestReview: pr.viewerLatestReview
        ? {
            state: pr.viewerLatestReview.state,
            submittedAt: pr.viewerLatestReview.submittedAt ?? null,
            commitOid: pr.viewerLatestReview.commit?.oid ?? null,
          }
        : null,
    },
    commits: commits.map(mapCommit),
    commitsTotal: pr.commits?.totalCount ?? commits.length,
    files: files.map(
      (f: any): PRFile => ({
        path: f.path,
        changeType: f.changeType,
        additions: f.additions,
        deletions: f.deletions,
        viewerViewedState: f.viewerViewedState ?? 'UNVIEWED',
      }),
    ),
    filesTotal: pr.files?.totalCount ?? files.length,
    threads,
    reviews: reviewNodes.filter((r: any) => r.state !== 'PENDING').map(mapReview),
    timeline,
    timelineTotal: conv.timelineItems?.totalCount ?? timeline.length,
    checks: mapChecks(pr.lastCommit),
  };
}
