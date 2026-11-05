import {
  CommentIcon,
  FileAddedIcon,
  FileDiffIcon,
  FileMovedIcon,
  FileRemovedIcon,
  FilterIcon,
  GearIcon,
  GitCommitIcon,
  SidebarCollapseIcon,
  SidebarExpandIcon,
  TriangleDownIcon,
} from '@primer/octicons-react';
import { ActionList, ActionMenu, Button, CounterLabel, Dialog, FormControl, IconButton, Radio, RadioGroup, Spinner, TextInput, TreeView } from '@primer/react';
import type { DiffFileEntry, DraftThread, ReviewEvent, ReviewThread } from '@shared/types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { ErrorNote, PrStateLabel } from '../../components/common';
import { MarkdownEditor } from '../../components/MarkdownEditor';
import { api, fetchers, prPath, prUrl } from '../../lib/api';
import { plural, shortSha, usePersistentState } from '../../lib/util';
import type { Detail } from '../PullRequest';
import { FileCard } from './FileCard';
import { queuedFromOutbox, useDraft } from './useDraft';

interface TreeNode {
  name: string;
  path: string;
  children?: TreeNode[];
  file?: DiffFileEntry;
}

function buildTree(files: DiffFileEntry[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', children: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    let node = root;
    parts.forEach((part, i) => {
      const p = parts.slice(0, i + 1).join('/');
      if (i === parts.length - 1) {
        node.children!.push({ name: part, path: p, file: f });
      } else {
        let next = node.children!.find((c) => c.children && c.name === part);
        if (!next) {
          next = { name: part, path: p, children: [] };
          node.children!.push(next);
        }
        node = next;
      }
    });
  }
  return root.children ?? [];
}

function FileIconFor({ f }: { f: DiffFileEntry }) {
  if (f.status === 'added') return <FileAddedIcon fill="var(--fgColor-success)" />;
  if (f.status === 'deleted') return <FileRemovedIcon fill="var(--fgColor-danger)" />;
  if (f.status === 'renamed') return <FileMovedIcon fill="var(--fgColor-attention)" />;
  return <FileDiffIcon fill="var(--fgColor-muted)" />;
}

function ProgressRing({ value }: { value: number }) {
  const r = 6;
  const c = 2 * Math.PI * r;
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <circle cx="8" cy="8" r={r} fill="none" stroke="var(--borderColor-default)" strokeWidth="2" />
      <circle cx="8" cy="8" r={r} fill="none" stroke="var(--fgColor-done)" strokeWidth="2" strokeDasharray={`${c * value} ${c}`} transform="rotate(-90 8 8)" strokeLinecap="round" />
    </svg>
  );
}

export function FilesTab({ detail, online, stuck }: { detail: Detail; online: boolean; stuck?: boolean }) {
  const snap = detail.snapshot!;
  const git = snap.git;
  const { sha } = useParams();
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const base = prPath(snap.owner, snap.repo, snap.number);
  const head = git?.headOid ?? snap.pr.headRefOid;

  const since = params.get('since');
  const at = params.get('to');
  const isFull = !sha && !since && !at;
  const query: Record<string, string> = sha ? { commit: sha } : since ? { from: since, to: head } : at ? { to: at } : {};
  const [ws, setWs] = usePersistentState('ogh.ignoreWhitespace', false);
  const [mode, setMode] = usePersistentState<'split' | 'unified'>('ogh.diffStyle', 'split');
  const [showTree, setShowTree] = usePersistentState('ogh.showTree', true);
  const [hideViewed, setHideViewed] = usePersistentState('ogh.hideViewed', false);
  const [filter, setFilter] = useState('');
  const [reviewOpen, setReviewOpen] = useState(false);
  const [current, setCurrent] = useState<string | null>(null);

  const diffQ = useQuery({
    queryKey: ['diff', snap.key.toLowerCase(), JSON.stringify(query), ws, head],
    queryFn: () => fetchers.diff(snap.owner, snap.repo, String(snap.number), { ...query, ...(ws ? { ws: '1' } : {}) }),
    enabled: !!git,
    staleTime: Infinity,
  });
  const diff = diffQ.data;
  const draft = useDraft(detail);
  // A pending review written against an older head can't take comments on the new
  // version (GitHub anchors a whole review to one commit); move it forward first.
  const staleDraft = !!draft.draft && draft.draft.commitOid !== head && (draft.draft.threads.length > 0 || draft.draft.replies.length > 0);
  const canComment = !!diff && diff.to === head && !staleDraft;
  const allowLeft = isFull;
  const moveDraft = useMutation({
    mutationFn: () => api<{ moved: number; toFile: number }>('POST', `${base}/draft/move`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pr', snap.key.toLowerCase()] }),
  });

  const queued = useMemo(() => queuedFromOutbox(detail.outbox), [detail.outbox]);
  const hasDraft = !!draft.draft && (draft.draft.threads.length > 0 || draft.draft.replies.length > 0);
  const pendingCount = (draft.draft?.threads.length ?? 0) + (draft.draft?.replies.length ?? 0);

  // Per-file slices kept referentially stable so file cards don't re-render needlessly.
  const threadsByPath = useMemo(() => {
    const m = new Map<string, ReviewThread[]>();
    if (isFull) for (const t of snap.threads) m.set(t.path, [...(m.get(t.path) ?? []), t]);
    return m;
  }, [snap.threads, isFull]);
  const draftByPath = useMemo(() => {
    const m = new Map<string, DraftThread[]>();
    for (const t of draft.draft?.threads ?? []) m.set(t.path, [...(m.get(t.path) ?? []), t]);
    return m;
  }, [draft.draft]);
  const queuedByPath = useMemo(() => {
    const m = new Map<string, (DraftThread & { status: string })[]>();
    for (const t of queued.threads) m.set(t.path, [...(m.get(t.path) ?? []), t]);
    return m;
  }, [queued]);
  const EMPTY: never[] = useMemo(() => [], []);

  const ghFile = useMemo(() => new Map(snap.files.map((f) => [f.path, f])), [snap.files]);
  const viewedOf = useCallback(
    (path: string) => detail.local.viewed[path]?.viewed ?? ghFile.get(path)?.viewerViewedState === 'VIEWED',
    [detail.local.viewed, ghFile],
  );
  const changedSince = (path: string) => !!detail.local.viewed[path]?.changedSinceViewed || (!detail.local.viewed[path] && ghFile.get(path)?.viewerViewedState === 'DISMISSED');

  const setViewed = useMutation({
    mutationFn: (v: { path: string; viewed: boolean }) => api('PUT', `${base}/viewed`, v),
    onMutate: (v) => {
      qc.setQueryData(['pr', snap.key.toLowerCase()], (old: Detail | undefined) =>
        old ? { ...old, local: { ...old.local, viewed: { ...old.local.viewed, [v.path]: { viewed: v.viewed, oid: head, at: new Date().toISOString() } } } } : old,
      );
    },
  });
  const resolve = useMutation({ mutationFn: (v: { threadId: string; resolve: boolean }) => api('POST', `${base}/resolve`, v) });
  const single = useMutation({ mutationFn: (body: { thread?: unknown; reply?: unknown }) => api('POST', `${base}/single`, body) });
  const open = useMutation({ mutationFn: (v: { path?: string; line?: number }) => api('POST', `${base}/open`, v) });

  const refs = useRef(new Map<string, HTMLDivElement>());
  const registerRef = useCallback((path: string, el: HTMLDivElement | null) => {
    if (el) refs.current.set(path, el);
    else refs.current.delete(path);
  }, []);

  const files = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (diff?.files ?? []).filter((x) => (!f || x.path.toLowerCase().includes(f)) && (!hideViewed || !viewedOf(x.path)));
  }, [diff, filter, hideViewed, viewedOf]);
  const tree = useMemo(() => buildTree(files), [files]);
  const viewedCount = (diff?.files ?? []).filter((f) => viewedOf(f.path)).length;
  const totalFiles = diff?.files.length ?? 0;
  const unresolved = snap.threads.filter((t) => !(detail.local.resolveOverrides[t.id] ?? t.isResolved));

  const scrollTo = (path: string) => {
    refs.current.get(path)?.scrollIntoView({ block: 'start' });
    setCurrent(path);
  };

  // Track which file is at the top of the viewport (for j/k/v and the tree highlight).
  useEffect(() => {
    const onScroll = () => {
      let best: string | null = null;
      for (const f of files) {
        const el = refs.current.get(f.path);
        if (!el) continue;
        if (el.getBoundingClientRect().bottom > 120) {
          best = f.path;
          break;
        }
      }
      setCurrent(best);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener('scroll', onScroll);
  }, [files]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, [contenteditable="true"], select') || e.metaKey || e.ctrlKey || e.altKey) return;
      const idx = files.findIndex((f) => f.path === current);
      if (e.key === 'j' || e.key === 'k') {
        const next = files[Math.max(0, Math.min(files.length - 1, idx + (e.key === 'j' ? 1 : -1)))];
        if (next) scrollTo(next.path);
      } else if (e.key === 'v' && current) {
        setViewed.mutate({ path: current, viewed: !viewedOf(current) });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, current, viewedOf]);

  if (!git) {
    return (
      <div style={{ marginTop: 16 }}>
        <div className="gh-flash warn">The code for this PR isn't downloaded. {snap.gitError ?? (online ? 'Refresh the PR to fetch it.' : 'Connect to the internet and sync to fetch it.')}</div>
        <div className="gh-box">
          {snap.files.map((f) => (
            <div className="gh-box-row" key={f.path}>
              <span className="gh-file-path grow">
                <span>{f.path}</span>
              </span>
              <span className="stat-add">+{f.additions}</span> <span className="stat-del">−{f.deletions}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const lastReviewed = detail.local.lastReviewedOid;
  const rangeLabel = sha ? `Commit ${shortSha(sha)}` : since ? 'Changes since your last review' : at ? `Up to ${shortSha(at)}` : 'All commits';

  const replyActions = (t: ReviewThread) => ({
    addToReview: (body: string) => draft.addReply({ threadId: t.id, body, path: t.path, replyToDatabaseId: t.comments[0]?.databaseId ?? null }),
    single: (body: string) => single.mutate({ reply: { threadId: t.id, body, path: t.path, replyToDatabaseId: t.comments[0]?.databaseId ?? null } }),
  });

  return (
    <div>
      <div className="gh-files-toolbar">
        <IconButton icon={showTree ? SidebarExpandIcon : SidebarCollapseIcon} aria-label={showTree ? 'Collapse file tree' : 'Expand file tree'} onClick={() => setShowTree(!showTree)} />
        {stuck && (
          <span className="compact">
            <PrStateLabel state={snap.pr.state} isDraft={snap.pr.isDraft} size="small" />
            <span className="truncate" style={{ maxWidth: 520 }}>
              <b>{snap.pr.title}</b> <span className="muted">#{snap.pr.number}</span>
            </span>
          </span>
        )}
        <ActionMenu>
          <ActionMenu.Button leadingVisual={GitCommitIcon} size="small">
            {rangeLabel}
          </ActionMenu.Button>
          <ActionMenu.Overlay width="large">
            <ActionList selectionVariant="single">
              <ActionList.LinkItem as={Link} to={prUrl(snap.key, 'files')} active={isFull}>
                All commits
                <ActionList.Description variant="block">Show all changes ({plural(snap.commitsTotal, 'commit')})</ActionList.Description>
              </ActionList.LinkItem>
              {lastReviewed && lastReviewed !== head && (
                <ActionList.LinkItem as={Link} to={`${prUrl(snap.key, 'files')}?since=${lastReviewed}`} active={!!since}>
                  Changes since your last review
                  <ActionList.Description variant="block">
                    {shortSha(lastReviewed)} to {shortSha(head)}
                  </ActionList.Description>
                </ActionList.LinkItem>
              )}
              <ActionList.Divider />
              {snap.commits.map((c) => (
                <ActionList.LinkItem key={c.oid} as={Link} to={prUrl(snap.key, `commits/${c.oid}`)} active={sha === c.oid}>
                  <span className="truncate">{c.messageHeadline}</span>
                  <ActionList.Description variant="block">
                    {c.abbreviatedOid} · {c.author.login ?? c.author.name}
                  </ActionList.Description>
                </ActionList.LinkItem>
              ))}
            </ActionList>
          </ActionMenu.Overlay>
        </ActionMenu>
        <span className="grow" />
        <span className="gh-viewed-progress" title="v toggles the current file, j/k move between files">
          <ProgressRing value={totalFiles ? viewedCount / totalFiles : 0} />
          <b>{viewedCount}</b> / {totalFiles} viewed
        </span>
        <Button
          variant="primary"
          size="small"
          onClick={() => setReviewOpen(true)}
          trailingVisual={pendingCount ? () => <CounterLabel>{pendingCount}</CounterLabel> : undefined}
          trailingAction={TriangleDownIcon}
        >
          Submit review
        </Button>
        <ActionMenu>
          <ActionMenu.Anchor>
            <IconButton icon={GearIcon} aria-label="Diff view settings" size="small" />
          </ActionMenu.Anchor>
          <ActionMenu.Overlay width="medium">
            <ActionList>
              <ActionList.Group selectionVariant="single">
                <ActionList.GroupHeading>Layout</ActionList.GroupHeading>
                <ActionList.Item selected={mode === 'split'} onSelect={() => setMode('split')}>
                  Split
                </ActionList.Item>
                <ActionList.Item selected={mode === 'unified'} onSelect={() => setMode('unified')}>
                  Unified
                </ActionList.Item>
              </ActionList.Group>
              <ActionList.Divider />
              <ActionList.Group selectionVariant="multiple">
                <ActionList.Item selected={ws} onSelect={() => setWs(!ws)}>
                  Hide whitespace
                </ActionList.Item>
                <ActionList.Item selected={hideViewed} onSelect={() => setHideViewed(!hideViewed)}>
                  Hide viewed files
                </ActionList.Item>
              </ActionList.Group>
            </ActionList>
          </ActionMenu.Overlay>
        </ActionMenu>
        <Button size="small" leadingVisual={CommentIcon} onClick={() => unresolved[0] && scrollTo(unresolved[0].path)} title="Jump to the first unresolved conversation">
          {unresolved.length}
        </Button>
      </div>

      {staleDraft && (
        <div className="gh-flash warn" style={{ margin: '12px 0', alignItems: 'flex-start' }}>
          <div className="grow">
            <b>Your pending review was written on an older version of this PR.</b> New commits arrived after you started it ({shortSha(draft.draft!.commitOid)} → {shortSha(head)}). Submit it as it is, or move it to the latest version: comments follow their lines, and comments on code that changed become file comments that quote the old code.
          </div>
          <Button size="small" onClick={() => setReviewOpen(true)}>
            Submit as is
          </Button>
          <Button size="small" variant="primary" onClick={() => moveDraft.mutate()} disabled={moveDraft.isPending}>
            Move to latest version
          </Button>
        </div>
      )}
      {moveDraft.data && !staleDraft && (
        <div className="gh-flash success" style={{ margin: '12px 0' }}>
          Your pending review now targets the latest version. {moveDraft.data.moved} comment(s) moved to their new line numbers
          {moveDraft.data.toFile ? `, ${moveDraft.data.toFile} became file comments because that code changed` : ''}.
        </div>
      )}
      {!canComment && !staleDraft && diff && (
        <div className="small muted" style={{ padding: '8px 0' }}>
          You're viewing an older range. Switch to <Link to={prUrl(snap.key, 'files')}>All commits</Link> to comment.
        </div>
      )}
      {since && <div className="small muted" style={{ padding: '8px 0' }}>Showing what changed since you last reviewed. Comments here go on the latest version (new-side lines only).</div>}
      <ErrorNote error={diffQ.error || setViewed.error || resolve.error || single.error || open.error || moveDraft.error} />
      {draft.error && <ErrorNote error={new Error(draft.error)} />}

      <div className={`gh-files ${showTree ? '' : 'no-tree'}`}>
        {showTree && (
          <aside className="gh-files-tree" aria-label="Changed files">
            <div className="filter">
              <TextInput block size="small" leadingVisual={FilterIcon} placeholder="Filter files..." value={filter} onChange={(e) => setFilter(e.target.value)} />
              <IconButton
                size="small"
                icon={FilterIcon}
                aria-label={hideViewed ? 'Show viewed files' : 'Hide viewed files'}
                variant={hideViewed ? 'primary' : 'default'}
                onClick={() => setHideViewed(!hideViewed)}
              />
            </div>
            <TreeView aria-label="Changed files">
              {tree.map((n) => (
                <TreeNodeView key={n.path} node={n} current={current} onSelect={scrollTo} viewedOf={viewedOf} threadsByPath={threadsByPath} />
              ))}
            </TreeView>
          </aside>
        )}
        <div className="gh-files-main">
          {diffQ.isLoading && <Spinner />}
          {diff && diff.files.length === 0 && <div className="gh-box gh-box-empty">No changes in this range.</div>}
          {files.map((f) => (
            <FileCard
              key={`${f.path}|${diff!.from}|${diff!.to}|${ws}`}
              owner={snap.owner}
              repo={snap.repo}
              number={snap.number}
              file={f}
              from={diff!.from}
              to={diff!.to}
              ignoreWhitespace={ws}
              mode={mode}
              viewed={viewedOf(f.path)}
              changedSinceViewed={changedSince(f.path)}
              onToggleViewed={(v) => setViewed.mutate({ path: f.path, viewed: v })}
              threads={threadsByPath.get(f.path) ?? EMPTY}
              resolveOverrides={detail.local.resolveOverrides}
              draftThreads={draftByPath.get(f.path) ?? EMPTY}
              draftReplies={draft.draft?.replies ?? EMPTY}
              queuedThreads={queuedByPath.get(f.path) ?? EMPTY}
              queuedReplies={queued.replies}
              canComment={canComment}
              allowLeft={allowLeft}
              hasDraft={hasDraft}
              online={online}
              prAuthor={snap.pr.author?.login}
              viewer={snap.viewer}
              onAddDraftThread={draft.addThread}
              onSingleThread={(t) => single.mutate({ thread: t })}
              onUpdateDraftThread={draft.updateThread}
              onRemoveDraftThread={draft.removeThread}
              replyActions={replyActions}
              onEditDraftReply={draft.updateReply}
              onDeleteDraftReply={draft.removeReply}
              onResolve={(threadId, r) => resolve.mutate({ threadId, resolve: r })}
              onOpenInEditor={(path, line) => open.mutate({ path, line })}
              registerRef={registerRef}
            />
          ))}
          <div className="small muted kbd-help" style={{ padding: '16px 0 48px' }}>
            Shortcuts: <kbd>j</kbd>/<kbd>k</kbd> next/previous file · <kbd>v</kbd> toggle viewed · <kbd>⌘</kbd>+<kbd>Enter</kbd> submit a comment
          </div>
        </div>
      </div>
      {reviewOpen && (
        <ReviewDialog
          detail={detail}
          draftBody={draft.draft?.body ?? ''}
          onBody={draft.setBody}
          counts={{ threads: draft.draft?.threads.length ?? 0, replies: draft.draft?.replies.length ?? 0 }}
          online={online}
          onDiscard={draft.discard}
          onClose={() => setReviewOpen(false)}
          onSubmitted={() => setParams({})}
        />
      )}
    </div>
  );
}

function TreeNodeView({
  node,
  current,
  onSelect,
  viewedOf,
  threadsByPath,
}: {
  node: TreeNode;
  current: string | null;
  onSelect: (p: string) => void;
  viewedOf: (p: string) => boolean;
  threadsByPath: Map<string, ReviewThread[]>;
}) {
  if (node.children) {
    return (
      <TreeView.Item id={`dir:${node.path}`} defaultExpanded>
        <TreeView.LeadingVisual>
          <TreeView.DirectoryIcon />
        </TreeView.LeadingVisual>
        {node.name}
        <TreeView.SubTree>
          {node.children.map((c) => (
            <TreeNodeView key={c.path} node={c} current={current} onSelect={onSelect} viewedOf={viewedOf} threadsByPath={threadsByPath} />
          ))}
        </TreeView.SubTree>
      </TreeView.Item>
    );
  }
  const f = node.file!;
  const n = threadsByPath.get(f.path)?.reduce((a, t) => a + t.comments.length, 0) ?? 0;
  const viewed = viewedOf(f.path);
  return (
    <TreeView.Item id={f.path} current={current === f.path} onSelect={() => onSelect(f.path)}>
      <TreeView.LeadingVisual>
        <FileIconFor f={f} />
      </TreeView.LeadingVisual>
      <span style={{ color: viewed ? 'var(--fgColor-muted)' : undefined }}>{node.name}</span>
      {n > 0 && (
        <TreeView.TrailingVisual>
          <span className="gh-tree-comment">
            <CommentIcon size={14} /> {n}
          </span>
        </TreeView.TrailingVisual>
      )}
    </TreeView.Item>
  );
}

function ReviewDialog({
  detail,
  draftBody,
  onBody,
  counts,
  online,
  onDiscard,
  onClose,
  onSubmitted,
}: {
  detail: Detail;
  draftBody: string;
  onBody: (b: string) => void;
  counts: { threads: number; replies: number };
  online: boolean;
  onDiscard: () => void;
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const snap = detail.snapshot!;
  const own = snap.pr.author?.login === snap.viewer.login;
  const [body, setBody] = useState(draftBody);
  const [event, setEvent] = useState<ReviewEvent>('COMMENT');
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const qc = useQueryClient();
  const submit = useMutation({
    mutationFn: () => api('POST', `${prPath(snap.owner, snap.repo, snap.number)}/review`, { event, body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pr', snap.key.toLowerCase()] });
      onSubmitted();
      onClose();
    },
  });
  const close = () => {
    if (body !== draftBody) onBody(body);
    onClose();
  };
  const total = counts.threads + counts.replies;
  return (
    <Dialog title="Finish your review" onClose={close} width="large">
      <div className="col">
        <MarkdownEditor value={body} onChange={setBody} placeholder="Leave a comment" minHeight={120} autoFocus onSubmit={() => submit.mutate()} />
        <RadioGroup name="event" onChange={(v) => v && setEvent(v as ReviewEvent)}>
          <RadioGroup.Label visuallyHidden>Review type</RadioGroup.Label>
          <FormControl>
            <Radio value="COMMENT" checked={event === 'COMMENT'} />
            <FormControl.Label>Comment</FormControl.Label>
            <FormControl.Caption>Submit general feedback without explicit approval.</FormControl.Caption>
          </FormControl>
          <FormControl disabled={own}>
            <Radio value="APPROVE" checked={event === 'APPROVE'} />
            <FormControl.Label>Approve</FormControl.Label>
            <FormControl.Caption>Give your approval to merge this pull request.{!own && ' If new commits land before it is sent, it waits for your OK.'}</FormControl.Caption>
          </FormControl>
          <FormControl disabled={own}>
            <Radio value="REQUEST_CHANGES" checked={event === 'REQUEST_CHANGES'} />
            <FormControl.Label>Request changes</FormControl.Label>
            <FormControl.Caption>Submit feedback that must be addressed before merging.</FormControl.Caption>
          </FormControl>
        </RadioGroup>
        <div className="small muted">
          {total ? `${plural(counts.threads, 'inline comment')}${counts.replies ? ` and ${plural(counts.replies, 'reply', 'replies')}` : ''} will be included.` : 'No inline comments.'}{' '}
          {online ? 'It will be sent right away.' : "You're offline: it goes to the outbox and is sent automatically when you reconnect."}
        </div>
        <ErrorNote error={submit.error} />
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          {total > 0 &&
            (confirmDiscard ? (
              <>
                <span className="small" style={{ color: 'var(--fgColor-danger)' }}>
                  Delete all pending comments?
                </span>
                <Button size="small" variant="danger" onClick={() => (onDiscard(), onClose())}>
                  Yes, discard
                </Button>
                <Button size="small" onClick={() => setConfirmDiscard(false)}>
                  Keep
                </Button>
              </>
            ) : (
              <Button size="small" variant="invisible" onClick={() => setConfirmDiscard(true)}>
                Abandon review
              </Button>
            ))}
          <span style={{ flex: 1 }} />
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={() => submit.mutate()} disabled={submit.isPending}>
            Submit review
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
