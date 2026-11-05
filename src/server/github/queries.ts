// GraphQL documents used to snapshot a pull request.

const ACTOR = `login avatarUrl(size: 80)`;

const REACTIONS = `reactionGroups { content reactors { totalCount } viewerHasReacted }`;

export const REVIEW_COMMENT_FIELDS = `
  id databaseId url body bodyHTML createdAt lastEditedAt state
  author { ${ACTOR} }
  authorAssociation
  diffHunk path line originalLine startLine originalStartLine outdated
  commit { oid } originalCommit { oid }
  replyTo { id }
  pullRequestReview { id }
  ${REACTIONS}
`;

export const THREAD_FIELDS = `
  id isResolved isOutdated isCollapsed path line originalLine startLine originalStartLine
  diffSide startDiffSide subjectType
  viewerCanResolve viewerCanUnresolve viewerCanReply
  resolvedBy { login }
  comments(first: 60) {
    totalCount
    pageInfo { hasNextPage endCursor }
    nodes { ${REVIEW_COMMENT_FIELDS} }
  }
`;

export const TIMELINE_TYPES = [
  'ISSUE_COMMENT',
  'PULL_REQUEST_REVIEW',
  'PULL_REQUEST_COMMIT',
  'HEAD_REF_FORCE_PUSHED_EVENT',
  'BASE_REF_FORCE_PUSHED_EVENT',
  'LABELED_EVENT',
  'UNLABELED_EVENT',
  'REVIEW_REQUESTED_EVENT',
  'REVIEW_REQUEST_REMOVED_EVENT',
  'REVIEW_DISMISSED_EVENT',
  'MERGED_EVENT',
  'CLOSED_EVENT',
  'REOPENED_EVENT',
  'READY_FOR_REVIEW_EVENT',
  'CONVERT_TO_DRAFT_EVENT',
  'ASSIGNED_EVENT',
  'UNASSIGNED_EVENT',
  'RENAMED_TITLE_EVENT',
  'CROSS_REFERENCED_EVENT',
  'HEAD_REF_DELETED_EVENT',
  'HEAD_REF_RESTORED_EVENT',
  'BASE_REF_CHANGED_EVENT',
];

export const TIMELINE_FIELDS = `
  __typename
  ... on IssueComment { id databaseId url body bodyHTML createdAt lastEditedAt author { ${ACTOR} } authorAssociation ${REACTIONS} }
  ... on PullRequestReview { id databaseId url state body bodyHTML submittedAt createdAt author { ${ACTOR} } authorAssociation commit { oid } comments { totalCount } }
  ... on PullRequestCommit { id commit { oid abbreviatedOid messageHeadline committedDate author { name user { ${ACTOR} } } } }
  ... on HeadRefForcePushedEvent { id createdAt actor { ${ACTOR} } beforeCommit { oid abbreviatedOid } afterCommit { oid abbreviatedOid } }
  ... on BaseRefForcePushedEvent { id createdAt actor { ${ACTOR} } beforeCommit { abbreviatedOid } afterCommit { abbreviatedOid } }
  ... on LabeledEvent { id createdAt actor { ${ACTOR} } label { name color } }
  ... on UnlabeledEvent { id createdAt actor { ${ACTOR} } label { name color } }
  ... on ReviewRequestedEvent { id createdAt actor { ${ACTOR} } requestedReviewer { __typename ... on User { login } ... on Team { name } ... on Bot { login } } }
  ... on ReviewRequestRemovedEvent { id createdAt actor { ${ACTOR} } requestedReviewer { __typename ... on User { login } ... on Team { name } ... on Bot { login } } }
  ... on ReviewDismissedEvent { id createdAt actor { ${ACTOR} } dismissalMessage review { author { login } } }
  ... on MergedEvent { id createdAt actor { ${ACTOR} } commit { abbreviatedOid } mergeRefName }
  ... on ClosedEvent { id createdAt actor { ${ACTOR} } }
  ... on ReopenedEvent { id createdAt actor { ${ACTOR} } }
  ... on ReadyForReviewEvent { id createdAt actor { ${ACTOR} } }
  ... on ConvertToDraftEvent { id createdAt actor { ${ACTOR} } }
  ... on AssignedEvent { id createdAt actor { ${ACTOR} } assignee { __typename ... on User { login } ... on Bot { login } } }
  ... on UnassignedEvent { id createdAt actor { ${ACTOR} } assignee { __typename ... on User { login } ... on Bot { login } } }
  ... on RenamedTitleEvent { id createdAt actor { ${ACTOR} } previousTitle currentTitle }
  ... on CrossReferencedEvent { id createdAt actor { ${ACTOR} } isCrossRepository source { __typename ... on PullRequest { number title url state repository { nameWithOwner } } ... on Issue { number title url state repository { nameWithOwner } } } }
  ... on HeadRefDeletedEvent { id createdAt actor { ${ACTOR} } headRefName }
  ... on HeadRefRestoredEvent { id createdAt actor { ${ACTOR} } }
  ... on BaseRefChangedEvent { id createdAt actor { ${ACTOR} } previousRefName currentRefName }
`;

const COMMIT_FIELDS = `
  commit {
    oid abbreviatedOid messageHeadline messageBody committedDate authoredDate url
    author { name email user { ${ACTOR} } }
    statusCheckRollup { state }
  }
`;

const CHECK_CONTEXTS = `
  contexts(first: 100) {
    nodes {
      __typename
      ... on CheckRun {
        name status conclusion detailsUrl title summary startedAt completedAt
        isRequired(pullRequestNumber: $number)
        checkSuite { app { name } workflowRun { workflow { name } } }
      }
      ... on StatusContext {
        context state description targetUrl createdAt
        isRequired(pullRequestNumber: $number)
      }
    }
  }
`;

/** Core PR data: metadata, first pages of files and commits, checks. */
export const PR_CORE = `
query PRCore($owner: String!, $repo: String!, $number: Int!) {
  viewer { ${ACTOR} }
  repository(owner: $owner, name: $repo) {
    nameWithOwner isPrivate url
    defaultBranchRef { name }
    pullRequest(number: $number) {
      id number title url state isDraft merged mergedAt closedAt createdAt updatedAt
      body bodyHTML
      author { ${ACTOR} }
      authorAssociation
      baseRefName headRefName baseRefOid headRefOid
      isCrossRepository
      headRepository { nameWithOwner }
      headRepositoryOwner { login }
      mergeable mergeStateStatus reviewDecision
      additions deletions changedFiles
      mergedBy { ${ACTOR} }
      labels(first: 40) { nodes { name color description } }
      assignees(first: 20) { nodes { ${ACTOR} } }
      reviewRequests(first: 30) {
        nodes { requestedReviewer { __typename ... on User { ${ACTOR} } ... on Team { name slug } ... on Bot { ${ACTOR} } ... on Mannequin { ${ACTOR} } } }
      }
      latestOpinionatedReviews(first: 30) { nodes { author { ${ACTOR} } state submittedAt } }
      milestone { title url }
      closingIssuesReferences(first: 10) {
        nodes { number title url state bodyHTML createdAt repository { nameWithOwner } author { ${ACTOR} } }
      }
      viewerLatestReview { state submittedAt commit { oid } }
      files(first: 100) { totalCount pageInfo { hasNextPage endCursor } nodes { path changeType additions deletions viewerViewedState } }
      commits(first: 100) { totalCount pageInfo { hasNextPage endCursor } nodes { ${COMMIT_FIELDS} } }
      lastCommit: commits(last: 1) {
        nodes { commit { oid statusCheckRollup { state ${CHECK_CONTEXTS} } } }
      }
    }
  }
}`;

/** Conversation data: review threads, reviews, timeline. */
export const PR_CONVERSATION = `
query PRConversation($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 50) { totalCount pageInfo { hasNextPage endCursor } nodes { ${THREAD_FIELDS} } }
      reviews(first: 50) {
        totalCount pageInfo { hasNextPage endCursor }
        nodes { id databaseId url state body bodyHTML submittedAt createdAt author { ${ACTOR} } authorAssociation commit { oid } comments { totalCount } }
      }
      timelineItems(first: 100, itemTypes: [${TIMELINE_TYPES.join(', ')}]) {
        totalCount pageInfo { hasNextPage endCursor }
        nodes { ${TIMELINE_FIELDS} }
      }
    }
  }
}`;

// Pagination queries (run against the PR node id).
export const PAGE_FILES = `
query($id: ID!, $after: String) { node(id: $id) { ... on PullRequest {
  files(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { path changeType additions deletions viewerViewedState } }
} } }`;

export const PAGE_COMMITS = `
query($id: ID!, $after: String) { node(id: $id) { ... on PullRequest {
  commits(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { ${COMMIT_FIELDS} } }
} } }`;

export const PAGE_THREADS = `
query($id: ID!, $after: String) { node(id: $id) { ... on PullRequest {
  reviewThreads(first: 50, after: $after) { pageInfo { hasNextPage endCursor } nodes { ${THREAD_FIELDS} } }
} } }`;

export const PAGE_THREAD_COMMENTS = `
query($id: ID!, $after: String) { node(id: $id) { ... on PullRequestReviewThread {
  comments(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { ${REVIEW_COMMENT_FIELDS} } }
} } }`;

export const PAGE_REVIEWS = `
query($id: ID!, $after: String) { node(id: $id) { ... on PullRequest {
  reviews(first: 50, after: $after) { pageInfo { hasNextPage endCursor }
    nodes { id databaseId url state body bodyHTML submittedAt createdAt author { ${ACTOR} } authorAssociation commit { oid } comments { totalCount } } }
} } }`;

export const PAGE_TIMELINE = `
query($id: ID!, $after: String) { node(id: $id) { ... on PullRequest {
  timelineItems(first: 100, after: $after, itemTypes: [${TIMELINE_TYPES.join(', ')}]) { pageInfo { hasNextPage endCursor } nodes { ${TIMELINE_FIELDS} } }
} } }`;

/** Search used to build the review queue. */
export const SEARCH_PRS = `
query($q: String!) {
  search(query: $q, type: ISSUE, first: 50) {
    nodes { ... on PullRequest { number updatedAt repository { nameWithOwner } } }
  }
}`;

/** Lightweight change probe for many PRs (built with aliases). */
export function buildProbeQuery(prs: { owner: string; repo: string; number: number }[]): string {
  const parts = prs.map(
    (p, i) =>
      `p${i}: repository(owner: ${JSON.stringify(p.owner)}, name: ${JSON.stringify(p.repo)}) { pullRequest(number: ${p.number}) { updatedAt headRefOid state } }`,
  );
  return `query { ${parts.join('\n')} }`;
}
