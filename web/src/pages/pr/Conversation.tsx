import {
  AlertIcon,
  CheckCircleIcon,
  CheckIcon,
  CommentDiscussionIcon,
  CommentIcon,
  CrossReferenceIcon,
  DotFillIcon,
  EyeIcon,
  FileDiffIcon,
  GearIcon,
  GitBranchIcon,
  GitCommitIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  IssueOpenedIcon,
  KebabHorizontalIcon,
  PencilIcon,
  PersonIcon,
  RepoPushIcon,
  SkipIcon,
  TagIcon,
  XIcon,
} from '@primer/octicons-react';
import { Button, Label, Spinner } from '@primer/react';
import type { Actor, OutboxItem, PRSnapshot, ReviewThread, TimelineItem } from '@shared/types';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Avatar, ErrorNote, Html, Labels, PrStateIcon, PrStateLabel, ROLE, Time } from '../../components/common';
import { MarkdownEditor } from '../../components/MarkdownEditor';
import { api, prPath, prUrl } from '../../lib/api';
import { renderMarkdown } from '../../lib/markdown';
import { plural, shortSha } from '../../lib/util';
import type { Detail } from '../PullRequest';
import { REACTION, ThreadView } from './Thread';
import { queuedFromOutbox, useDraft } from './useDraft';

/* ---------------------------------------------------------------- pieces */

function TimelineComment({
  author,
  at,
  edited,
  bodyHTML,
  role,
  own,
  reactions,
  verb = 'commented',
}: {
  author: Actor | null | undefined;
  at: string;
  edited?: boolean;
  bodyHTML: string;
  role?: string | null;
  own?: boolean;
  reactions?: { content: string; count: number; viewerHasReacted: boolean }[];
  verb?: string;
}) {
  return (
    <div className="gh-tl-comment">
      <Avatar actor={author} size={40} className="gh-tl-avatar" />
      <div className={`gh-comment caret ${own ? 'own' : ''}`}>
        <div className="gh-comment-header">
          <span className="gh-comment-author">{author?.login ?? 'ghost'}</span>
          <span>{verb}</span>
          <Time iso={at} />
          {edited && <span>• edited</span>}
          <span className="gh-comment-tools">
            {role && <span className="gh-role">{role}</span>}
            <KebabHorizontalIcon />
          </span>
        </div>
        <div className="gh-comment-body">
          <Html html={bodyHTML} />
        </div>
        {!!reactions?.length && (
          <div className="gh-reactions">
            {reactions.map((r) => (
              <span key={r.content} className={`gh-reaction ${r.viewerHasReacted ? 'mine' : ''}`}>
                {REACTION[r.content] ?? r.content} {r.count}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Item({ icon, tone, avatar, children }: { icon: ReactNode; tone?: string; avatar?: Actor | null; children: ReactNode }) {
  return (
    <div className="gh-tl-item">
      {avatar !== undefined && <Avatar actor={avatar} size={40} className="gh-tl-avatar" />}
      <span className={`gh-tl-badge ${tone ?? ''}`}>{icon}</span>
      <div className="gh-tl-body">{children}</div>
    </div>
  );
}

const Who = ({ a }: { a: any }) => (
  <>
    {a?.avatarUrl && <img className="mini" src={a.avatarUrl} alt="" />}
    <span className="who">{a?.login ?? 'ghost'}</span>
  </>
);

function roleFor(login: string | undefined, assoc: string | undefined, prAuthor: string | undefined) {
  if (login && login === prAuthor) return 'Author';
  return assoc ? (ROLE[assoc] ?? null) : null;
}

/* ---------------------------------------------------------------- tab */

export function ConversationTab({ detail, online }: { detail: Detail; online: boolean }) {
  const snap = detail.snapshot!;
  const viewer = snap.viewer;
  const prAuthor = snap.pr.author?.login;
  const draft = useDraft(detail);
  const queued = useMemo(() => queuedFromOutbox(detail.outbox), [detail.outbox]);
  const base = prPath(snap.owner, snap.repo, snap.number);

  const resolve = useMutation({ mutationFn: (v: { threadId: string; resolve: boolean }) => api('POST', `${base}/resolve`, v) });
  const single = useMutation({ mutationFn: (reply: any) => api('POST', `${base}/single`, { reply }) });

  const threadsByReview = useMemo(() => {
    const m = new Map<string, ReviewThread[]>();
    for (const t of snap.threads) {
      const rid = t.comments[0]?.reviewId ?? 'none';
      m.set(rid, [...(m.get(rid) ?? []), t]);
    }
    return m;
  }, [snap.threads]);

  const shownReviews = new Set(snap.timeline.filter((t) => t.__typename === 'PullRequestReview').map((t) => t.id));
  const orphanThreads = snap.threads.filter((t) => !shownReviews.has(t.comments[0]?.reviewId ?? ''));
  const hasDraft = !!draft.draft && (draft.draft.threads.length > 0 || draft.draft.replies.length > 0);

  const renderThread = (t: ReviewThread) => (
    <ThreadView
      key={t.id}
      thread={t}
      resolved={detail.local.resolveOverrides[t.id] ?? t.isResolved}
      showContext
      prAuthor={prAuthor}
      viewer={viewer}
      draftReplies={draft.draft?.replies.filter((r) => r.threadId === t.id) ?? []}
      queuedReplies={queued.replies.get(t.id) ?? []}
      online={online}
      hasDraft={hasDraft}
      onReply={{
        addToReview: (body) => draft.addReply({ threadId: t.id, body, path: t.path, replyToDatabaseId: t.comments[0]?.databaseId ?? null }),
        single: (body) => single.mutate({ threadId: t.id, body, path: t.path, replyToDatabaseId: t.comments[0]?.databaseId ?? null }),
      }}
      onResolve={(r) => resolve.mutate({ threadId: t.id, resolve: r })}
      onEditDraftReply={draft.updateReply}
      onDeleteDraftReply={draft.removeReply}
    />
  );

  // Runs of commits are shown together, like GitHub does.
  const blocks: (TimelineItem | { __typename: 'Commits'; id: string; items: TimelineItem[] })[] = [];
  for (const it of snap.timeline) {
    const last = blocks[blocks.length - 1];
    if (it.__typename === 'PullRequestCommit') {
      if (last && last.__typename === 'Commits') (last as any).items.push(it);
      else blocks.push({ __typename: 'Commits', id: `c-${it.id}`, items: [it] });
    } else blocks.push(it);
  }

  return (
    <div className="gh-discussion">
      <div className="gh-discussion-main">
        <div className="gh-timeline">
          <TimelineComment
            author={snap.pr.author}
            at={snap.pr.createdAt}
            bodyHTML={snap.pr.bodyHTML}
            own={prAuthor === viewer.login}
          />
          {blocks.map((b) => (
            <TimelineBlock key={b.id} item={b as any} snap={snap} threads={threadsByReview} renderThread={renderThread} />
          ))}
          {orphanThreads.length > 0 && <div className="gh-tl-indent">{orphanThreads.map(renderThread)}</div>}
          <PendingItems items={detail.outbox} viewer={viewer} />
          {hasDraft && (
            <Item icon={<PencilIcon />} tone="attention">
              You have a pending review with {plural((draft.draft?.threads.length ?? 0) + (draft.draft?.replies.length ?? 0), 'comment')}.{' '}
              <Link to={prUrl(snap.key, 'files')}>Finish your review</Link>
            </Item>
          )}
        </div>
        <div className="gh-tl-break" />
        <ErrorNote error={resolve.error || single.error} />
        {draft.error && <ErrorNote error={new Error(draft.error)} />}
        <MergeBox snap={snap} online={online} />
        <NewComment base={base} online={online} viewer={viewer} />
      </div>
      <Sidebar detail={detail} />
    </div>
  );
}

function TimelineBlock({
  item,
  snap,
  threads,
  renderThread,
}: {
  item: TimelineItem & { items?: TimelineItem[] };
  snap: PRSnapshot;
  threads: Map<string, ReviewThread[]>;
  renderThread: (t: ReviewThread) => ReactNode;
}) {
  const a = item.actor;
  const prAuthor = snap.pr.author?.login;
  switch (item.__typename) {
    case 'Commits': {
      const commits = item.items!;
      const authors = new Set(commits.map((c) => c.commit?.author?.user?.login ?? c.commit?.author?.name));
      const who = commits[0].commit?.author?.user ?? { login: commits[0].commit?.author?.name };
      return (
        <>
          <Item icon={<RepoPushIcon />}>
            <Who a={who} /> {authors.size > 1 ? 'and others ' : ''}added {plural(commits.length, 'commit')} <Time iso={commits[0].commit?.committedDate} />
          </Item>
          {commits.map((c) => (
            <CommitRow key={c.id} c={c} snapKey={snap.key} />
          ))}
        </>
      );
    }
    case 'IssueComment':
      return (
        <TimelineComment
          author={item.author}
          at={item.createdAt!}
          edited={!!item.lastEditedAt}
          bodyHTML={item.bodyHTML}
          role={roleFor(item.author?.login, item.authorAssociation, prAuthor)}
          own={item.author?.login === snap.viewer.login}
          reactions={(item.reactionGroups ?? []).filter((g: any) => g.reactors?.totalCount > 0).map((g: any) => ({ content: g.content, count: g.reactors.totalCount, viewerHasReacted: g.viewerHasReacted }))}
        />
      );
    case 'PullRequestReview': {
      const ts = threads.get(item.id) ?? [];
      const verb =
        item.state === 'APPROVED' ? 'approved these changes' : item.state === 'CHANGES_REQUESTED' ? 'requested changes' : item.state === 'DISMISSED' ? 'reviewed (dismissed)' : item.body?.trim() || ts.length ? 'commented' : 'reviewed';
      const icon = item.state === 'APPROVED' ? <CheckIcon /> : item.state === 'CHANGES_REQUESTED' ? <FileDiffIcon /> : item.state === 'DISMISSED' ? <XIcon /> : <EyeIcon />;
      const tone = item.state === 'APPROVED' ? 'success' : item.state === 'CHANGES_REQUESTED' ? 'danger' : undefined;
      return (
        <>
          <Item icon={icon} tone={tone} avatar={item.author}>
            <div className="gh-tl-head">
              <span className="who">{item.author?.login ?? 'ghost'}</span> {verb} <Time iso={item.submittedAt ?? item.createdAt} />
              {item.commit?.oid && (
                <Link className="end link-muted" to={`${prUrl(snap.key, 'files')}?to=${item.commit.oid}`}>
                  View reviewed changes
                </Link>
              )}
            </div>
          </Item>
          {(item.body?.trim() || ts.length > 0) && (
            <div className="gh-tl-indent">
              {item.body?.trim() && (
                <div className={`gh-comment ${item.author?.login === snap.viewer.login ? 'own' : ''}`}>
                  <div className="gh-comment-header">
                    <span className="gh-comment-author">{item.author?.login}</span> left a comment
                    <span className="gh-comment-tools">
                      {roleFor(item.author?.login, item.authorAssociation, prAuthor) && <span className="gh-role">{roleFor(item.author?.login, item.authorAssociation, prAuthor)}</span>}
                      <KebabHorizontalIcon />
                    </span>
                  </div>
                  <div className="gh-comment-body">
                    <Html html={item.bodyHTML} />
                  </div>
                </div>
              )}
              {ts.map(renderThread)}
            </div>
          )}
        </>
      );
    }
    case 'HeadRefForcePushedEvent':
      return (
        <Item icon={<RepoPushIcon />}>
          <Who a={a} /> force-pushed the <span className="gh-branch">{snap.pr.headRefName}</span> branch from <code>{item.beforeCommit?.abbreviatedOid}</code> to <code>{item.afterCommit?.abbreviatedOid}</code> <Time iso={item.createdAt} />
        </Item>
      );
    case 'BaseRefForcePushedEvent':
      return (
        <Item icon={<RepoPushIcon />}>
          <Who a={a} /> force-pushed the base branch <Time iso={item.createdAt} />
        </Item>
      );
    case 'LabeledEvent':
    case 'UnlabeledEvent':
      return (
        <Item icon={<TagIcon />}>
          <Who a={a} /> {item.__typename === 'LabeledEvent' ? 'added' : 'removed'} the <Labels labels={item.label ? [item.label] : []} /> label <Time iso={item.createdAt} />
        </Item>
      );
    case 'ReviewRequestedEvent':
    case 'ReviewRequestRemovedEvent':
      return (
        <Item icon={<EyeIcon />}>
          <Who a={a} /> {item.__typename === 'ReviewRequestedEvent' ? 'requested a review from' : 'removed the request for review from'}{' '}
          <span className="who">{item.requestedReviewer?.login ?? item.requestedReviewer?.name ?? 'someone'}</span> <Time iso={item.createdAt} />
        </Item>
      );
    case 'ReviewDismissedEvent':
      return (
        <Item icon={<XIcon />}>
          <Who a={a} /> dismissed <span className="who">{item.review?.author?.login}</span>’s stale review <Time iso={item.createdAt} />
          {item.dismissalMessage ? <div className="markdown-body small" style={{ marginTop: 4 }}>{item.dismissalMessage}</div> : null}
        </Item>
      );
    case 'MergedEvent':
      return (
        <Item icon={<GitMergeIcon />} tone="done">
          <Who a={a} /> merged commit <code>{item.commit?.abbreviatedOid}</code> into <span className="gh-branch">{item.mergeRefName}</span> <Time iso={item.createdAt} />
        </Item>
      );
    case 'ClosedEvent':
      return (
        <Item icon={<GitPullRequestClosedIcon />} tone="danger">
          <Who a={a} /> closed this <Time iso={item.createdAt} />
        </Item>
      );
    case 'ReopenedEvent':
      return (
        <Item icon={<DotFillIcon />} tone="success">
          <Who a={a} /> reopened this <Time iso={item.createdAt} />
        </Item>
      );
    case 'ReadyForReviewEvent':
      return (
        <Item icon={<EyeIcon />}>
          <Who a={a} /> marked this pull request as ready for review <Time iso={item.createdAt} />
        </Item>
      );
    case 'ConvertToDraftEvent':
      return (
        <Item icon={<GitPullRequestDraftIcon />}>
          <Who a={a} /> marked this pull request as draft <Time iso={item.createdAt} />
        </Item>
      );
    case 'AssignedEvent':
    case 'UnassignedEvent':
      return (
        <Item icon={<PersonIcon />}>
          <Who a={a} /> {item.__typename === 'AssignedEvent' ? (item.assignee?.login === a?.login ? 'self-assigned this' : 'assigned') : 'unassigned'}{' '}
          {item.assignee?.login !== a?.login && <span className="who">{item.assignee?.login}</span>} <Time iso={item.createdAt} />
        </Item>
      );
    case 'RenamedTitleEvent':
      return (
        <Item icon={<PencilIcon />}>
          <Who a={a} /> changed the title <del>{item.previousTitle}</del> <b className="link-default">{item.currentTitle}</b> <Time iso={item.createdAt} />
        </Item>
      );
    case 'CrossReferencedEvent': {
      const s = item.source;
      if (!s) return null;
      const isPr = s.__typename === 'PullRequest';
      return (
        <Item icon={<CrossReferenceIcon />}>
          <Who a={a} /> mentioned this pull request <Time iso={item.createdAt} />
          <div className="gh-tl-ref">
            <div className="grow">
              {isPr ? (
                <Link className="title" to={`/${s.repository.nameWithOwner}/pull/${s.number}`}>
                  {s.title}
                </Link>
              ) : (
                <a className="title" href={s.url} target="_blank" rel="noreferrer">
                  {s.title}
                </a>
              )}{' '}
              <span className="muted">
                {s.repository?.nameWithOwner !== `${snap.owner}/${snap.repo}` ? s.repository?.nameWithOwner : ''}#{s.number}
              </span>
            </div>
            {isPr && <PrStateLabel state={s.state} isDraft={false} size="small" />}
          </div>
        </Item>
      );
    }
    case 'HeadRefDeletedEvent':
      return (
        <Item icon={<GitBranchIcon />}>
          <Who a={a} /> deleted the <span className="gh-branch">{item.headRefName}</span> branch <Time iso={item.createdAt} />
        </Item>
      );
    case 'HeadRefRestoredEvent':
      return (
        <Item icon={<GitBranchIcon />}>
          <Who a={a} /> restored the head branch <Time iso={item.createdAt} />
        </Item>
      );
    case 'BaseRefChangedEvent':
      return (
        <Item icon={<GitBranchIcon />}>
          <Who a={a} /> changed the base branch from <span className="gh-branch">{item.previousRefName}</span> to <span className="gh-branch">{item.currentRefName}</span> <Time iso={item.createdAt} />
        </Item>
      );
    default:
      return null;
  }
}

function CommitRow({ c, snapKey }: { c: TimelineItem; snapKey: string }) {
  const user = c.commit?.author?.user;
  return (
    <div className="gh-tl-item condensed">
      <span className="gh-tl-badge">
        <GitCommitIcon size={16} />
      </span>
      <div className="gh-tl-body">
        <div className="gh-commit-line">
          <span className="avatars">{user?.avatarUrl ? <img src={user.avatarUrl} alt={user.login} title={user.login} /> : null}</span>
          <code className="grow truncate">
            <Link to={prUrl(snapKey, `commits/${c.commit.oid}`)} title={c.commit.messageHeadline}>
              {c.commit.messageHeadline}
            </Link>
          </code>
          <Link className="sha mono" to={prUrl(snapKey, `commits/${c.commit.oid}`)}>
            {c.commit.abbreviatedOid}
          </Link>
        </div>
      </div>
    </div>
  );
}

function statusLabel(x: OutboxItem) {
  if (x.status === 'held') return <Label variant="attention">Needs your OK in the outbox</Label>;
  if (x.status === 'failed') return <Label variant="danger">Failed to send</Label>;
  if (x.status === 'sending') return <Label variant="accent">Sending…</Label>;
  return <Label variant="accent">Queued, sends when online</Label>;
}

function PendingItems({ items, viewer }: { items: OutboxItem[]; viewer: Actor }) {
  const pending = items.filter((x) => x.status !== 'sent' && (x.type === 'comment' || (x.type === 'review' && !x.single)));
  if (!pending.length) return null;
  return (
    <>
      {pending.map((x) => (
        <div className="gh-tl-comment" key={x.id}>
          <Avatar actor={viewer} size={40} className="gh-tl-avatar" />
          <div className="gh-comment caret pending">
            <div className="gh-comment-header">
              <span className="gh-comment-author">{viewer.login}</span>
              {x.type === 'review' ? (
                <span>
                  {x.event === 'APPROVE' ? 'approves' : x.event === 'REQUEST_CHANGES' ? 'requests changes' : 'reviews'} · {plural(x.threads.length, 'inline comment')}
                  {x.replies.length ? `, ${plural(x.replies.length, 'reply', 'replies')}` : ''}
                </span>
              ) : (
                <span>commented</span>
              )}
              <span className="gh-comment-tools">
                {statusLabel(x)}
                {x.type === 'review' && (
                  <Link to="/outbox" className="small">
                    Outbox
                  </Link>
                )}
              </span>
            </div>
            {(x.type === 'comment' ? x.body : x.type === 'review' ? x.body : '').trim() && (
              <div className="gh-comment-body markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(x.type === 'comment' ? x.body : x.type === 'review' ? x.body : '') }} />
            )}
            {(x.heldReason || x.lastError) && (
              <div className="gh-comment-body small" style={{ color: x.status === 'failed' ? 'var(--fgColor-danger)' : 'var(--fgColor-attention)', paddingTop: 0 }}>
                {x.heldReason ?? x.lastError}
              </div>
            )}
          </div>
        </div>
      ))}
    </>
  );
}

/* ---------------------------------------------------------------- merge box */

function MergeBox({ snap, online }: { snap: PRSnapshot; online: boolean }) {
  const pr = snap.pr;
  const approvals = pr.latestReviews.filter((r) => r.state === 'APPROVED').length;
  const changes = pr.latestReviews.filter((r) => r.state === 'CHANGES_REQUESTED').length;
  const checks = snap.checks.items;
  const outcome = (c: (typeof checks)[number]) => (c.kind === 'status' ? (c.state ?? 'PENDING') : c.status && c.status !== 'COMPLETED' ? 'PENDING' : (c.conclusion ?? 'NEUTRAL')).toUpperCase();
  const failing = checks.filter((c) => ['FAILURE', 'ERROR', 'TIMED_OUT', 'STARTUP_FAILURE', 'ACTION_REQUIRED'].includes(outcome(c))).length;
  const pendingChecks = checks.filter((c) => ['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS'].includes(outcome(c))).length;
  const passing = checks.filter((c) => outcome(c) === 'SUCCESS').length;

  if (pr.state === 'MERGED' || pr.state === 'CLOSED') {
    const merged = pr.state === 'MERGED';
    return (
      <div className="gh-mergebox-wrap" id="merge-box">
        <span className={`gh-mergebox-icon ${merged ? 'done' : 'danger'}`}>{merged ? <GitMergeIcon size={24} /> : <GitPullRequestClosedIcon size={24} />}</span>
        <div className="gh-mergebox">
          <div className="gh-mb-section">
            <div>
              <div className="gh-mb-title">{merged ? 'Pull request successfully merged and closed' : 'Closed with unmerged commits'}</div>
              <div className="gh-mb-sub">
                {merged ? <>Merged {pr.mergedBy ? <>by {pr.mergedBy.login} </> : null}<Time iso={pr.mergedAt} /></> : <>Closed <Time iso={pr.closedAt} /></>}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const clean = pr.mergeable === 'MERGEABLE';
  const conflict = pr.mergeable === 'CONFLICTING';
  return (
    <div className="gh-mergebox-wrap" id="merge-box">
      <span className={`gh-mergebox-icon ${clean && !pr.isDraft && !failing && pr.reviewDecision !== 'CHANGES_REQUESTED' ? 'success' : ''}`}>
        {pr.isDraft ? <GitPullRequestDraftIcon size={24} /> : <GitMergeIcon size={24} />}
      </span>
      <div className="gh-mergebox">
        <div className="gh-mb-section">
          <span className={`gh-mb-icon square ${pr.reviewDecision === 'APPROVED' || approvals ? 'success' : changes ? 'danger' : ''}`}>
            <CommentDiscussionIcon />
          </span>
          <div>
            <div className="gh-mb-title">
              {pr.reviewDecision === 'CHANGES_REQUESTED' || changes ? 'Changes requested' : pr.reviewDecision === 'APPROVED' ? 'Changes approved' : approvals ? 'Changes reviewed' : 'Review required'}
            </div>
            <div className="gh-mb-sub">
              {approvals || changes
                ? [approvals ? `${plural(approvals, 'approving review')}` : '', changes ? `${plural(changes, 'review')} requesting changes` : ''].filter(Boolean).join(', ') + ' by reviewers with write access.'
                : 'At least 1 approving review is required by reviewers with write access.'}
            </div>
          </div>
        </div>
        {checks.length > 0 && (
          <div className="gh-mb-section">
            <span className={`gh-mb-icon ${failing ? 'danger' : pendingChecks ? 'attention' : 'success'}`}>{failing ? <XIcon /> : pendingChecks ? <DotFillIcon /> : <CheckIcon />}</span>
            <div>
              <div className="gh-mb-title">{failing ? 'Some checks were not successful' : pendingChecks ? "Some checks haven't completed yet" : 'All checks have passed'}</div>
              <div className="gh-mb-sub">{[failing && `${failing} failing`, pendingChecks && `${pendingChecks} pending`, passing && `${passing} successful`].filter(Boolean).join(', ')} checks</div>
            </div>
          </div>
        )}
        <div className="gh-mb-section">
          <span className={`gh-mb-icon ${clean ? 'success' : conflict ? 'danger' : ''}`}>{clean ? <CheckIcon /> : conflict ? <AlertIcon /> : <DotFillIcon />}</span>
          <div>
            <div className="gh-mb-title">{clean ? 'No conflicts with base branch' : conflict ? 'This branch has conflicts that must be resolved' : 'Checking for the ability to merge automatically…'}</div>
            <div className="gh-mb-sub">{clean ? 'Merging can be performed automatically.' : conflict ? 'Resolve conflicts then push again.' : `As of ${new Date(snap.fetchedAt).toLocaleString()}.`}</div>
          </div>
        </div>
        {pr.isDraft && (
          <div className="gh-mb-section">
            <span className="gh-mb-icon">
              <GitPullRequestDraftIcon />
            </span>
            <div className="grow">
              <div className="gh-mb-title">This pull request is still a work in progress</div>
              <div className="gh-mb-sub">Draft pull requests cannot be merged.</div>
            </div>
            <Button size="small" disabled>
              Ready for review
            </Button>
          </div>
        )}
        <div className="gh-mb-footer">
          <Button variant="primary" disabled>
            Merge pull request
          </Button>
          <span>
            {online ? (
              <>
                Merging isn't done from the offline app. <a href={pr.url} target="_blank" rel="noreferrer">Open on GitHub</a>
              </>
            ) : (
              "Merging isn't available offline."
            )}
          </span>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- composer */

function NewComment({ base, online, viewer }: { base: string; online: boolean; viewer: Actor }) {
  const [text, setText] = useState('');
  const send = useMutation({
    mutationFn: () => api('POST', `${base}/comment`, { body: text }),
    onSuccess: () => setText(''),
  });
  return (
    <div className="gh-composer-wrap">
      <Avatar actor={viewer} size={40} className="gh-tl-avatar" />
      <h3 className="gh-composer-title">Add a comment</h3>
      <MarkdownEditor
        value={text}
        onChange={setText}
        onSubmit={() => text.trim() && send.mutate()}
        hint={online ? undefined : "You're offline: your comment goes to the outbox and is posted when you reconnect."}
        actions={
          <Button variant="primary" disabled={!text.trim() || send.isPending} onClick={() => send.mutate()}>
            Comment
          </Button>
        }
      />
      <ErrorNote error={send.error} />
    </div>
  );
}

/* ---------------------------------------------------------------- sidebar */

function SidebarItem({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="gh-sidebar-item">
      <div className="gh-sidebar-heading">
        <span>{title}</span>
        <GearIcon size={16} />
      </div>
      {children}
    </div>
  );
}

function Sidebar({ detail }: { detail: Detail }) {
  const snap = detail.snapshot!;
  const pr = snap.pr;
  const reviewed = new Set(pr.latestReviews.map((r) => r.author?.login));
  const reviewIcon = (s: string) =>
    s === 'APPROVED' ? (
      <CheckIcon fill="var(--fgColor-success)" />
    ) : s === 'CHANGES_REQUESTED' ? (
      <FileDiffIcon fill="var(--fgColor-danger)" />
    ) : (
      <CommentIcon fill="var(--fgColor-muted)" />
    );
  const jiraCached = new Set(detail.jira.map((j) => j.key));
  const participants = useMemo(() => {
    const m = new Map<string, Actor>();
    const add = (a?: Actor | null) => a?.login && !m.has(a.login) && m.set(a.login, a);
    add(pr.author);
    for (const t of snap.timeline) if (t.__typename === 'IssueComment' || t.__typename === 'PullRequestReview') add(t.author);
    for (const th of snap.threads) for (const c of th.comments) add(c.author);
    return [...m.values()];
  }, [snap, pr.author]);

  return (
    <aside className="gh-sidebar">
      <SidebarItem title="Reviewers">
        {pr.latestReviews.map((r) => (
          <div className="gh-sidebar-row" key={r.author?.login}>
            <Avatar actor={r.author} size={20} />
            <span className="name grow">{r.author?.login}</span>
            {reviewIcon(r.state)}
          </div>
        ))}
        {pr.reviewRequests
          .filter((r) => !reviewed.has(r.login))
          .map((r) => (
            <div className="gh-sidebar-row" key={r.login ?? r.name}>
              {r.avatarUrl ? <Avatar actor={{ login: r.login ?? '', avatarUrl: r.avatarUrl }} size={20} /> : <PersonIcon />}
              <span className="name grow">{r.login ?? r.name}</span>
              <span title="Awaiting requested review">
                <DotFillIcon fill="var(--fgColor-attention)" />
              </span>
            </div>
          ))}
        {!pr.latestReviews.length && !pr.reviewRequests.length && <span className="gh-sidebar-muted">No reviews</span>}
      </SidebarItem>
      <SidebarItem title="Assignees">
        {pr.assignees.length ? (
          pr.assignees.map((a) => (
            <div className="gh-sidebar-row" key={a.login}>
              <Avatar actor={a} size={20} /> <span className="name">{a.login}</span>
            </div>
          ))
        ) : (
          <span className="gh-sidebar-muted">No one assigned</span>
        )}
      </SidebarItem>
      <SidebarItem title="Labels">
        <div className="row wrap" style={{ gap: 4 }}>
          {pr.labels.length ? <Labels labels={pr.labels} /> : <span className="gh-sidebar-muted">None yet</span>}
        </div>
      </SidebarItem>
      <SidebarItem title="Milestone">{pr.milestone ? <span className="name">{pr.milestone.title}</span> : <span className="gh-sidebar-muted">No milestone</span>}</SidebarItem>
      <SidebarItem title="Development">
        {pr.closingIssues.length === 0 && detail.linkedPrs.length === 0 && <span className="gh-sidebar-muted">Successfully merging this pull request may close these issues.</span>}
        {pr.closingIssues.map((i) => (
          <details key={i.url} style={{ marginBottom: 4 }}>
            <summary className="gh-sidebar-row" style={{ cursor: 'pointer' }}>
              <IssueOpenedIcon fill={i.state === 'OPEN' ? 'var(--fgColor-success)' : 'var(--fgColor-done)'} />
              <span className="name">
                {i.title} <span className="muted">#{i.number}</span>
              </span>
            </summary>
            <div style={{ padding: 8, border: '1px solid var(--borderColor-muted)', borderRadius: 6, marginTop: 4 }}>
              <Html html={i.bodyHTML} />
            </div>
          </details>
        ))}
        {detail.linkedPrs.map((p) => (
          <div className="gh-sidebar-row" key={p.key}>
            <PrStateIcon state={p.state} isDraft={p.isDraft} />
            <Link to={prUrl(p.key)} className="link-default grow truncate" title={p.key}>
              {p.title ?? p.key}
            </Link>
            <span className="muted nowrap">
              {p.repo}#{p.number}
            </span>
          </div>
        ))}
      </SidebarItem>
      {snap.linked.jira.length > 0 && (
        <SidebarItem title="Jira">
          {detail.jira.map((j) => (
            <div className="gh-sidebar-row" key={j.key}>
              <Link to={`/jira/${j.key}`}>{j.key}</Link>
              <span className="grow truncate" title={j.summary}>
                {j.summary}
              </span>
              {j.status && <Label>{j.status}</Label>}
            </div>
          ))}
          {snap.linked.jira
            .filter((k) => !jiraCached.has(k))
            .map((k) => (
              <div className="gh-sidebar-row" key={k}>
                <span>{k}</span>
                <span className="gh-sidebar-muted">
                  not saved (<Link to="/settings">connect Jira</Link>)
                </span>
              </div>
            ))}
        </SidebarItem>
      )}
      <LocalCheckout detail={detail} />
      <div className="gh-sidebar-item">
        <div className="gh-sidebar-heading">
          <span>{plural(participants.length, 'participant')}</span>
        </div>
        <div className="gh-participants">
          {participants.map((p) => (
            <Avatar key={p.login} actor={p} size={26} />
          ))}
        </div>
      </div>
    </aside>
  );
}

function LocalCheckout({ detail }: { detail: Detail }) {
  const snap = detail.snapshot!;
  const wt = detail.local.worktree;
  const prep = detail.local.prepare;
  const [showLog, setShowLog] = useState(false);
  const base = prPath(snap.owner, snap.repo, snap.number);
  const log = useQuery({
    queryKey: ['prepare-log', snap.key.toLowerCase()],
    queryFn: () => fetch(`${base}/prepare-log`).then((r) => r.text()),
    enabled: showLog,
    refetchInterval: prep?.status === 'running' && showLog ? 2000 : false,
  });
  const prepare = useMutation({ mutationFn: () => api('POST', `${base}/prepare`) });
  const makeWt = useMutation({ mutationFn: () => api('POST', `${base}/worktree`) });
  return (
    <div className="gh-sidebar-item">
      <div className="gh-sidebar-heading">
        <span>Local checkout</span>
      </div>
      {!snap.git && <span className="gh-sidebar-muted">Code not downloaded{snap.gitError ? `: ${snap.gitError}` : ''}</span>}
      {snap.git && (
        <div className="col" style={{ gap: 6 }}>
          {wt?.path && !wt.error ? (
            <>
              <code className="small" style={{ wordBreak: 'break-all' }}>
                {wt.path}
              </code>
              <span className="gh-sidebar-muted">
                {wt.branch ? `on branch ${wt.branch}` : `detached at ${shortSha(wt.headOid)}`}
                {wt.existing ? ' (your existing checkout)' : ''}
              </span>
              {wt.dirty && <span style={{ color: 'var(--fgColor-attention)' }}>Has uncommitted changes</span>}
              {wt.note && <span style={{ color: 'var(--fgColor-attention)' }}>{wt.note}</span>}
              <div className="row wrap">
                <Button size="small" onClick={() => prepare.mutate()} disabled={prep?.status === 'running' || prepare.isPending}>
                  {prep?.status === 'running' ? (
                    <>
                      <Spinner size="small" /> Preparing…
                    </>
                  ) : prep?.status === 'done' ? (
                    'Prepare again'
                  ) : (
                    'Prepare to run'
                  )}
                </Button>
                {prep && (
                  <Button size="small" variant="invisible" onClick={() => setShowLog((v) => !v)}>
                    {showLog ? 'Hide log' : 'Log'}
                  </Button>
                )}
              </div>
            </>
          ) : (
            <>
              <span className="gh-sidebar-muted">{wt?.error ?? 'No worktree yet.'}</span>
              <Button size="small" onClick={() => makeWt.mutate()} disabled={makeWt.isPending}>
                {makeWt.isPending ? 'Creating…' : 'Create worktree'}
              </Button>
            </>
          )}
          {prep && (
            <span className={prep.status === 'failed' ? '' : 'gh-sidebar-muted'} style={prep.status === 'failed' ? { color: 'var(--fgColor-danger)' } : undefined}>
              {prep.status === 'done' ? <CheckCircleIcon fill="var(--fgColor-success)" /> : prep.status === 'failed' ? <SkipIcon /> : null} {prep.summary ?? prep.status}
            </span>
          )}
          {showLog && <pre className="log-view">{log.data ?? '…'}</pre>}
          <ErrorNote error={prepare.error || makeWt.error} />
        </div>
      )}
    </div>
  );
}
