import {
  ChecklistIcon,
  CommentDiscussionIcon,
  CopyIcon,
  FileDiffIcon,
  GitCommitIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  InfoIcon,
  LinkExternalIcon,
  SyncIcon,
} from '@primer/octicons-react';
import { ActionList, ActionMenu, Button, IconButton, Spinner } from '@primer/react';
import type { PRDetail } from '@shared/types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, Route, Routes, useLocation, useNavigate, useParams } from 'react-router';
import { DiffStat, ErrorNote, PrStateLabel, relative } from '../components/common';
import { ApiError, api, fetchers, prPath } from '../lib/api';
import { copy, plural } from '../lib/util';
import { ChecksTab } from './pr/Checks';
import { CommitsTab } from './pr/Commits';
import { ConversationTab } from './pr/Conversation';
import { FilesTab } from './pr/Files';

export type Detail = PRDetail & { syncing?: boolean };

export function PullRequestPage() {
  const { owner = '', repo = '', number = '' } = useParams();
  const key = `${owner}/${repo}#${number}`;
  const qc = useQueryClient();
  const { data, error, isLoading } = useQuery({
    queryKey: ['pr', key.toLowerCase()],
    queryFn: () => fetchers.pr(owner, repo, number),
    retry: false,
  });
  const { data: status } = useQuery({ queryKey: ['status'], queryFn: fetchers.status });

  const updatedAt = data?.snapshot?.pr.updatedAt;
  useEffect(() => {
    if (!updatedAt) return;
    void api('POST', `${prPath(owner, repo, number)}/seen`).then(() => qc.invalidateQueries({ queryKey: ['prs'] }));
  }, [updatedAt, owner, repo, number, qc]);

  if (isLoading) {
    return (
      <div className="gh-page">
        <Spinner />
      </div>
    );
  }
  if (error instanceof ApiError && error.status === 404) return <NotCached owner={owner} repo={repo} number={number} online={!!status?.online} />;
  if (error || !data) {
    return (
      <div className="gh-page">
        <ErrorNote error={error} />
      </div>
    );
  }
  if (!data.snapshot) {
    return (
      <div className="gh-page">
        <h1 className="gh-pr-title">
          {key} <span className="gh-pr-number">is queued for download</span>
        </h1>
        {data.summary.lastSyncError ? (
          <div className="gh-flash danger" style={{ marginTop: 16 }}>
            Download failed: {data.summary.lastSyncError}
          </div>
        ) : (
          <p className="muted">{status?.online ? 'Downloading…' : "It will download as soon as you're back online."}</p>
        )}
      </div>
    );
  }
  return <PullRequestView detail={data} online={!!status?.online} />;
}

function NotCached({ owner, repo, number, online }: { owner: string; repo: string; number: string; online: boolean }) {
  const qc = useQueryClient();
  const add = useMutation({
    mutationFn: () => api('POST', '/api/prs', { urls: `https://github.com/${owner}/${repo}/pull/${number}` }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pr'] }),
  });
  return (
    <div className="gh-page">
      <h1 className="gh-pr-title">
        {owner}/{repo}#{number} <span className="gh-pr-number">isn't saved for offline</span>
      </h1>
      <p className="muted">{online ? 'Add it to download it for offline review.' : "Add it now and it will download when you're back online."}</p>
      <div className="row">
        <Button variant="primary" onClick={() => add.mutate()} disabled={add.isPending}>
          Save for offline
        </Button>
        {online && (
          <Button as="a" href={`https://github.com/${owner}/${repo}/pull/${number}`} target="_blank" leadingVisual={LinkExternalIcon}>
            Open on GitHub
          </Button>
        )}
      </div>
      <ErrorNote error={add.error} />
    </div>
  );
}

function mergeIcon(detail: Detail) {
  const pr = detail.snapshot!.pr;
  if (pr.state === 'MERGED') return GitMergeIcon;
  if (pr.state === 'CLOSED') return GitPullRequestClosedIcon;
  if (pr.isDraft) return GitPullRequestDraftIcon;
  return GitMergeIcon;
}

function PullRequestView({ detail, online }: { detail: Detail; online: boolean }) {
  const snap = detail.snapshot!;
  const pr = snap.pr;
  const { owner, repo, number } = snap;
  const base = `/${owner}/${repo}/pull/${number}`;
  const loc = useLocation();
  const navigate = useNavigate();
  const sub = loc.pathname.slice(base.length).replace(/^\//, '');
  const tab = sub.startsWith('files') || sub.startsWith('commits/') ? 'files' : sub.startsWith('commits') ? 'commits' : sub.startsWith('checks') ? 'checks' : 'conversation';

  const refresh = useMutation({ mutationFn: () => api('POST', `${prPath(owner, repo, number)}/sync`) });
  const open = useMutation({ mutationFn: (editor?: string) => api('POST', `${prPath(owner, repo, number)}/open`, { editor }) });
  const makeWt = useMutation({ mutationFn: () => api('POST', `${prPath(owner, repo, number)}/worktree`) });
  const prepare = useMutation({ mutationFn: () => api('POST', `${prPath(owner, repo, number)}/prepare`) });
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: fetchers.settings });

  // GitHub shows a compact header once the title scrolls away.
  const titleRef = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setStuck(!e.isIntersecting), { threshold: 0 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const wt = detail.local.worktree;
  const hasWt = !!wt?.path && !wt.error;
  const editors = settings?.editors ?? [];
  const preferred = settings?.settings.editor ?? 'cursor';
  const editorName = (e: string) => (e === 'code' ? 'VS Code' : 'Cursor');
  const comments = detail.summary.commentCount ?? 0;
  const failing = snap.checks.items.filter((c) => ['FAILURE', 'ERROR', 'TIMED_OUT', 'STARTUP_FAILURE'].includes((c.conclusion ?? c.state ?? '').toUpperCase())).length;
  const MergeIco = mergeIcon(detail);
  const headLabel = pr.isCrossRepository && pr.headOwner ? `${pr.headOwner}:${pr.headRefName}` : pr.headRefName;
  const actionError = open.error || makeWt.error || prepare.error || refresh.error;

  const branchLine = (
    <>
      <span>
        <a className="gh-author" href={`https://github.com/${pr.author?.login}`} target="_blank" rel="noreferrer">
          {pr.author?.login ?? 'ghost'}
        </a>{' '}
        {pr.state === 'MERGED' ? `merged ${plural(snap.commitsTotal, 'commit')} into` : `wants to merge ${plural(snap.commitsTotal, 'commit')} into`}
      </span>
      <span className="gh-branch" title={pr.baseRefName}>
        {pr.baseRefName}
      </span>
      <span>from</span>
      <span className="gh-branch" title={headLabel}>
        {headLabel}
      </span>
    </>
  );

  return (
    <div className={`gh-page ${tab === 'files' ? 'full' : ''}`}>
      <div ref={titleRef}>
        <div className="gh-pr-titlerow">
          <h1 className="gh-pr-title">
            <bdi>{pr.title}</bdi> <span className="gh-pr-number">#{pr.number}</span>
          </h1>
          <div className="gh-pr-actions">
            <Button
              leadingVisual={MergeIco}
              onClick={() => {
                navigate(base);
                setTimeout(() => document.getElementById('merge-box')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 60);
              }}
            >
              Merge status
            </Button>
            <ActionMenu>
              <ActionMenu.Button>Code</ActionMenu.Button>
              <ActionMenu.Overlay width="large" align="end">
                <ActionList>
                  <ActionList.Group>
                    <ActionList.GroupHeading>Local checkout</ActionList.GroupHeading>
                    {hasWt ? (
                      <>
                        {[preferred, ...editors.filter((e) => e !== preferred)].filter((e) => editors.includes(e)).map((e) => (
                          <ActionList.Item key={e} onSelect={() => open.mutate(e)}>
                            Open in {editorName(e)}
                            <ActionList.Description variant="block">{wt!.path}</ActionList.Description>
                          </ActionList.Item>
                        ))}
                        <ActionList.Item onSelect={() => copy(wt!.path)}>
                          <ActionList.LeadingVisual>
                            <CopyIcon />
                          </ActionList.LeadingVisual>
                          Copy worktree path
                        </ActionList.Item>
                        <ActionList.Item onSelect={() => prepare.mutate()} disabled={detail.local.prepare?.status === 'running'}>
                          Prepare to run offline
                          <ActionList.Description variant="block">Copy your .env files and install dependencies (needs internet)</ActionList.Description>
                        </ActionList.Item>
                      </>
                    ) : snap.git ? (
                      <ActionList.Item onSelect={() => makeWt.mutate()}>
                        Create worktree
                        <ActionList.Description variant="block">Check this PR out next to your clone. Works offline.</ActionList.Description>
                      </ActionList.Item>
                    ) : (
                      <ActionList.Item disabled>Code not downloaded yet</ActionList.Item>
                    )}
                  </ActionList.Group>
                  <ActionList.Divider />
                  <ActionList.Group>
                    <ActionList.GroupHeading>GitHub CLI</ActionList.GroupHeading>
                    <ActionList.Item onSelect={() => copy(`gh pr checkout ${pr.number}`)}>
                      <ActionList.LeadingVisual>
                        <CopyIcon />
                      </ActionList.LeadingVisual>
                      <code>gh pr checkout {pr.number}</code>
                    </ActionList.Item>
                  </ActionList.Group>
                  <ActionList.Divider />
                  <ActionList.Item onSelect={() => refresh.mutate()} disabled={!online}>
                    <ActionList.LeadingVisual>
                      <SyncIcon />
                    </ActionList.LeadingVisual>
                    Refresh from GitHub
                  </ActionList.Item>
                  <ActionList.LinkItem href={pr.url} target="_blank">
                    <ActionList.LeadingVisual>
                      <LinkExternalIcon />
                    </ActionList.LeadingVisual>
                    Open on GitHub
                  </ActionList.LinkItem>
                </ActionList>
              </ActionMenu.Overlay>
            </ActionMenu>
          </div>
        </div>
        <div className="gh-pr-meta">
          <PrStateLabel state={pr.state} isDraft={pr.isDraft} />
          {branchLine}
          <IconButton size="small" variant="invisible" icon={CopyIcon} aria-label="Copy head branch name" onClick={() => copy(pr.headRefName)} />
          <span className="gh-saved muted" title={`Downloaded ${new Date(snap.fetchedAt).toLocaleString()}`}>
            · saved {relative(snap.fetchedAt)}
            {detail.syncing && (
              <>
                {' '}
                <Spinner size="small" style={{ verticalAlign: 'middle' }} /> refreshing
              </>
            )}
          </span>
        </div>
      </div>

      {stuck && tab !== 'files' && (
        <div className="gh-sticky">
          <div className="gh-sticky-inner">
            <PrStateLabel state={pr.state} isDraft={pr.isDraft} size="small" />
            <div className="grow">
              <div className="gh-sticky-title truncate">
                {pr.title} <span className="gh-pr-number">#{pr.number}</span>
              </div>
              <div className="gh-sticky-sub row" style={{ gap: 6 }}>
                {branchLine}
              </div>
            </div>
          </div>
        </div>
      )}

      {actionError && <ErrorNote error={actionError} />}
      {detail.summary.lastSyncError && (
        <div className="gh-flash warn" style={{ marginTop: 16 }}>
          <InfoIcon /> Last refresh failed, so this is the previous copy: {detail.summary.lastSyncError}
        </div>
      )}
      {snap.gitError && (
        <div className="gh-flash warn" style={{ marginTop: 16 }}>
          <InfoIcon /> The code for this PR isn't available offline: {snap.gitError}
        </div>
      )}
      {wt?.error && (
        <div className="gh-flash warn" style={{ marginTop: 16 }}>
          <InfoIcon /> Worktree problem: {wt.error}
        </div>
      )}

      <nav className="gh-tabnav" aria-label="Pull request tabs">
        <div className="gh-tabnav-tabs">
          <Link to={base} className={`gh-tab ${tab === 'conversation' ? 'selected' : ''}`}>
            <CommentDiscussionIcon /> Conversation <span className="gh-counter">{comments}</span>
          </Link>
          <Link to={`${base}/commits`} className={`gh-tab ${tab === 'commits' ? 'selected' : ''}`}>
            <GitCommitIcon /> Commits <span className="gh-counter">{snap.commitsTotal}</span>
          </Link>
          <Link to={`${base}/checks`} className={`gh-tab ${tab === 'checks' ? 'selected' : ''}`}>
            <ChecklistIcon /> Checks <span className={`gh-counter ${failing ? 'danger' : ''}`}>{snap.checks.items.length}</span>
          </Link>
          <Link to={`${base}/files`} className={`gh-tab ${tab === 'files' ? 'selected' : ''}`}>
            <FileDiffIcon /> Files changed <span className="gh-counter">{snap.filesTotal}</span>
          </Link>
        </div>
        <div className="gh-tabnav-extra">
          <DiffStat additions={pr.additions} deletions={pr.deletions} />
        </div>
      </nav>

      <Routes>
        <Route index element={<ConversationTab detail={detail} online={online} />} />
        <Route path="commits" element={<CommitsTab detail={detail} />} />
        <Route path="checks" element={<ChecksTab detail={detail} online={online} />} />
        <Route path="files" element={<FilesTab detail={detail} online={online} stuck={stuck} />} />
        <Route path="commits/:sha" element={<FilesTab detail={detail} online={online} stuck={stuck} />} />
        <Route path="*" element={<div className="muted" style={{ padding: 16 }}>Unknown tab</div>} />
      </Routes>
    </div>
  );
}
