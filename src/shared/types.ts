// Types shared by the local server and the web UI.

export type PRKey = string; // "owner/repo#123"

export interface Actor {
  login: string;
  avatarUrl?: string | null;
}

export interface Label {
  name: string;
  color: string;
  description?: string | null;
}

export type PRState = 'OPEN' | 'CLOSED' | 'MERGED';
export type DiffSide = 'LEFT' | 'RIGHT';
export type ReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';

export interface ReactionGroup {
  content: string;
  count: number;
  viewerHasReacted: boolean;
}

export interface ReviewComment {
  id: string;
  databaseId: number | null;
  url: string;
  body: string;
  bodyHTML: string;
  createdAt: string;
  lastEditedAt: string | null;
  author: Actor | null;
  authorAssociation?: string;
  diffHunk: string;
  path: string;
  line: number | null;
  originalLine: number | null;
  startLine: number | null;
  originalStartLine: number | null;
  outdated: boolean;
  commitOid: string | null;
  originalCommitOid: string | null;
  replyToId: string | null;
  reviewId: string | null;
  state: string;
  reactions: ReactionGroup[];
}

export interface ReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  isCollapsed: boolean;
  path: string;
  line: number | null;
  originalLine: number | null;
  startLine: number | null;
  originalStartLine: number | null;
  diffSide: DiffSide;
  startDiffSide: DiffSide | null;
  subjectType: 'LINE' | 'FILE';
  resolvedBy: string | null;
  viewerCanResolve: boolean;
  viewerCanUnresolve: boolean;
  viewerCanReply: boolean;
  comments: ReviewComment[];
}

export interface Review {
  id: string;
  databaseId: number | null;
  url: string;
  state: string;
  body: string;
  bodyHTML: string;
  submittedAt: string | null;
  createdAt: string;
  author: Actor | null;
  authorAssociation?: string;
  commitOid: string | null;
  commentCount: number;
}

export interface Commit {
  oid: string;
  abbreviatedOid: string;
  messageHeadline: string;
  messageBody: string;
  committedDate: string;
  authoredDate: string;
  url: string;
  author: { name: string | null; email: string | null; login: string | null; avatarUrl: string | null };
  checkState: string | null;
}

export interface PRFile {
  path: string;
  changeType: string;
  additions: number;
  deletions: number;
  viewerViewedState: 'VIEWED' | 'UNVIEWED' | 'DISMISSED';
}

export interface CheckItem {
  kind: 'check' | 'status';
  name: string;
  status: string | null; // QUEUED / IN_PROGRESS / COMPLETED (checks)
  conclusion: string | null; // SUCCESS / FAILURE / ... (checks)
  state: string | null; // SUCCESS / FAILURE / PENDING / ERROR (statuses)
  url: string | null;
  title: string | null;
  summary: string | null;
  appName: string | null;
  workflowName: string | null;
  isRequired: boolean;
  startedAt: string | null;
  completedAt: string | null;
}

export interface LinkedIssue {
  repo: string;
  number: number;
  title: string;
  url: string;
  state: string;
  bodyHTML: string;
  author: Actor | null;
  createdAt: string;
}

export interface ReviewRequest {
  kind: string; // User | Team | Bot | Mannequin
  login?: string;
  name?: string;
  avatarUrl?: string | null;
}

// Timeline nodes are kept close to GitHub's GraphQL shape.
export interface TimelineItem {
  __typename: string;
  id: string;
  createdAt?: string;
  [k: string]: any;
}

export interface GitInfo {
  clonePath: string;
  cloneKind: 'user' | 'managed';
  baseOid: string;
  headOid: string;
  mergeBaseOid: string;
  fetchedAt: string;
}

export interface PRSnapshot {
  schema: 1;
  key: PRKey;
  owner: string;
  repo: string;
  number: number;
  fetchedAt: string;
  viewer: Actor;
  repoInfo: { isPrivate: boolean; defaultBranch: string | null; url: string };
  pr: {
    id: string;
    number: number;
    title: string;
    url: string;
    state: PRState;
    isDraft: boolean;
    merged: boolean;
    mergedAt: string | null;
    closedAt: string | null;
    createdAt: string;
    updatedAt: string;
    body: string;
    bodyHTML: string;
    author: Actor | null;
    authorAssociation?: string;
    baseRefName: string;
    headRefName: string;
    baseRefOid: string;
    headRefOid: string;
    isCrossRepository: boolean;
    headRepository: string | null;
    headOwner: string | null;
    mergeable: string | null;
    mergeStateStatus: string | null;
    reviewDecision: string | null;
    additions: number;
    deletions: number;
    changedFiles: number;
    mergedBy: Actor | null;
    labels: Label[];
    assignees: Actor[];
    reviewRequests: ReviewRequest[];
    latestReviews: { author: Actor | null; state: string; submittedAt: string | null }[];
    milestone: { title: string; url: string } | null;
    closingIssues: LinkedIssue[];
    viewerLatestReview: { state: string; submittedAt: string | null; commitOid: string | null } | null;
  };
  commits: Commit[];
  commitsTotal: number;
  files: PRFile[];
  filesTotal: number;
  threads: ReviewThread[];
  reviews: Review[];
  timeline: TimelineItem[];
  timelineTotal: number;
  checks: { state: string | null; commitOid: string | null; items: CheckItem[] };
  git?: GitInfo;
  gitError?: string;
  linked: { prs: PRKey[]; jira: string[] };
}

// ---- Local review state ----

export interface DraftThread {
  localId: string;
  path: string;
  subjectType: 'LINE' | 'FILE';
  line?: number;
  side?: DiffSide;
  startLine?: number;
  startSide?: DiffSide;
  body: string;
  /** The code lines being commented on; used if GitHub can't anchor the comment. */
  snippet?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DraftReply {
  localId: string;
  threadId: string;
  /** databaseId of the thread's first comment (REST replies need it) */
  replyToDatabaseId?: number | null;
  /** path of the thread, for display and fallbacks */
  path?: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface DraftReview {
  commitOid: string;
  body: string;
  threads: DraftThread[];
  replies: DraftReply[];
  updatedAt: string;
}

export interface WorktreeInfo {
  path: string;
  headOid: string;
  branch: string | null;
  createdAt: string;
  /** true when we reuse a checkout that already had the PR branch */
  existing?: boolean;
  dirty?: boolean;
  note?: string;
  error?: string;
}

export interface PrepareInfo {
  status: 'running' | 'done' | 'failed';
  startedAt: string;
  finishedAt?: string;
  logFile: string;
  summary?: string;
}

export interface LocalState {
  viewed: Record<string, { viewed: boolean; oid: string; at: string; changedSinceViewed?: boolean }>;
  draft: DraftReview | null;
  lastReviewedOid: string | null;
  lastSeenUpdatedAt: string | null;
  seenHeads: string[];
  resolveOverrides: Record<string, boolean>;
  worktree?: WorktreeInfo;
  prepare?: PrepareInfo;
}

// ---- Outbox ----

export type OutboxStatus = 'queued' | 'held' | 'sending' | 'sent' | 'failed';

export interface OutboxBase {
  id: string;
  prKey: PRKey;
  createdAt: string;
  updatedAt: string;
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt?: string;
  lastError?: string;
  heldReason?: string;
  sentAt?: string;
  resultUrl?: string;
  notes?: string[];
  /** set by the API: an earlier unsent review on the same PR must go first */
  blockedBy?: string;
}

export interface OutboxReview extends OutboxBase {
  type: 'review';
  event: ReviewEvent;
  body: string;
  commitOid: string;
  threads: DraftThread[];
  replies: DraftReply[];
  /** user confirmed sending even though the PR changed after the review */
  confirmedStale?: boolean;
  /** posted as a lone comment (GitHub's "Add single comment") */
  single?: boolean;
  progress: {
    reviewId?: string;
    threads: Record<string, { id?: string; fallback?: 'file' | 'body' }>;
    replies: Record<string, string>;
    bodyAppendix: string[];
    submitted?: boolean;
  };
}

export interface OutboxComment extends OutboxBase {
  type: 'comment';
  body: string;
}

export interface OutboxResolve extends OutboxBase {
  type: 'resolve';
  threadId: string;
  resolve: boolean;
}

export interface OutboxViewed extends OutboxBase {
  type: 'viewed';
  path: string;
  viewed: boolean;
  /** PR head when you ticked it; not marked on GitHub if the file changed since */
  oid?: string;
}

export type OutboxItem = OutboxReview | OutboxComment | OutboxResolve | OutboxViewed;

// ---- Tracking ----

export type TrackSource = 'manual' | 'review-requested' | 'authored' | 'linked';

export interface TrackedPR {
  key: PRKey;
  owner: string;
  repo: string;
  number: number;
  sources: TrackSource[];
  addedAt: string;
  linkedFrom?: PRKey[];
  lastSyncAt?: string;
  lastSyncError?: string;
  lastMediaErrors?: number;
  /** PRs this one links to (copied from the snapshot for cheap reverse lookups) */
  links?: PRKey[];
  /** what we last saw on GitHub; used to skip unchanged PRs cheaply */
  probe?: { updatedAt: string; head: string; state: string; fetchedAt: string };
}

// ---- Jira ----

export interface JiraIssue {
  key: string;
  url: string;
  fetchedAt: string;
  summary: string;
  status: string | null;
  statusCategory: string | null;
  issueType: string | null;
  priority: string | null;
  assignee: string | null;
  reporter: string | null;
  created: string | null;
  updated: string | null;
  labels: string[];
  parent: { key: string; summary: string } | null;
  descriptionHTML: string;
  comments: { id: string; author: string | null; created: string; bodyHTML: string }[];
  subtasks: { key: string; summary: string; status: string | null }[];
  links: { type: string; key: string; summary: string; status: string | null }[];
  error?: string;
}

// ---- API payloads ----

export interface PRSummary {
  key: PRKey;
  owner: string;
  repo: string;
  number: number;
  sources: TrackSource[];
  linkedFrom?: PRKey[];
  lastSyncAt?: string;
  lastSyncError?: string;
  cached: boolean;
  title?: string;
  url?: string;
  state?: PRState;
  isDraft?: boolean;
  author?: Actor | null;
  updatedAt?: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  headRefName?: string;
  baseRefName?: string;
  reviewDecision?: string | null;
  labels?: Label[];
  commentCount?: number;
  unresolvedThreads?: number;
  viewedCount?: number;
  draftCount?: number;
  outbox?: { queued: number; held: number; failed: number; sending: number };
  worktree?: WorktreeInfo;
  prepare?: PrepareInfo;
  hasNewActivity?: boolean;
  viewerIsAuthor?: boolean;
  viewerLatestReview?: { state: string; submittedAt: string | null; commitOid: string | null } | null;
  newCommitsSinceReview?: boolean;
}

export interface SyncProgress {
  running: boolean;
  phase?: string;
  done?: number;
  total?: number;
  current?: string;
  startedAt?: string;
  lastRunAt?: string;
  lastFullRunAt?: string;
  lastError?: string;
  lastResult?: string;
}

export interface AppStatus {
  online: boolean;
  lastCheckAt: string | null;
  lastOnlineAt: string | null;
  viewer: Actor | null;
  sync: SyncProgress;
  outbox: { queued: number; held: number; failed: number; sending: number };
  jiraConfigured: boolean;
  editor: string | null;
  version: string;
  home: string;
}

export interface DiffFileEntry {
  path: string;
  oldPath: string | null;
  status: 'added' | 'deleted' | 'modified' | 'renamed' | 'copied' | 'typechange';
  additions: number;
  deletions: number;
  binary: boolean;
  /** omitted from the bulk patch because it's huge or generated; fetch on demand */
  deferred: boolean;
  generated: boolean;
  patch: string | null;
}

export interface DiffResponse {
  from: string;
  to: string;
  files: DiffFileEntry[];
}

export interface PRDetail {
  summary: PRSummary;
  snapshot: PRSnapshot | null;
  local: LocalState;
  outbox: OutboxItem[];
  linkedPrs: PRSummary[];
  jira: JiraIssue[];
}

export interface Settings {
  codeRoots: string[];
  worktreeDir: string | null;
  editor: 'cursor' | 'code';
  autoSyncMinutes: number;
  queue: { reviewRequested: boolean; authored: boolean; authoredMaxAgeDays: number };
  media: { videos: boolean; maxVideoMB: number; maxImageMB: number };
  linkedPrs: boolean;
  jira: { baseUrl: string; email: string | null; projectKeys: string[] };
  repos: Record<string, { clonePath?: string; prepare?: string }>;
}
