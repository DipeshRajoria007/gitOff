import {
  AlertIcon,
  CheckCircleIcon,
  CheckIcon,
  CommentIcon,
  DotFillIcon,
  FileDirectoryIcon,
  GitPullRequestIcon,
  InboxIcon,
  KebabHorizontalIcon,
  PencilIcon,
  SearchIcon,
  SyncIcon,
  TrashIcon,
  XIcon,
} from '@primer/octicons-react';
import { ActionList, ActionMenu, Button, Checkbox, Dialog, FormControl, IconButton, Spinner, Textarea, TextInput } from '@primer/react';
import type { PRSummary } from '@shared/types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Avatar, ErrorNote, Labels, PrStateIcon, relative } from '../components/common';
import { api, fetchers, prPath, prUrl } from '../lib/api';
import { plural } from '../lib/util';

type Row = PRSummary & { syncing?: boolean };

const TABS: [string, string, (p: Row) => boolean][] = [
  ['review', 'Review requests', (p) => p.sources.includes('review-requested')],
  ['created', 'Created', (p) => p.sources.includes('authored') || !!p.viewerIsAuthor],
  ['added', 'Added', (p) => p.sources.includes('manual')],
  ['linked', 'Linked', (p) => p.sources.includes('linked')],
  ['all', 'All', () => true],
];

export function Dashboard() {
  const { data: prs, isLoading, error } = useQuery({ queryKey: ['prs'], queryFn: fetchers.prs });
  const { data: status } = useQuery({ queryKey: ['status'], queryFn: fetchers.status });
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Row | null>(null);
  const all = prs ?? [];

  const repoFilter = params.get('repo');
  const closed = params.get('state') === 'closed';
  const counts = Object.fromEntries(TABS.map(([id, , fn]) => [id, all.filter(fn).length]));
  const tab = params.get('tab') ?? (counts.review ? 'review' : 'all');
  const tabFn = TABS.find(([id]) => id === tab)?.[2] ?? (() => true);
  const repos = useMemo(() => [...new Set(all.map((p) => `${p.owner}/${p.repo}`))].sort(), [all]);

  const set = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v === null) next.delete(k);
    else next.set(k, v);
    setParams(next);
  };

  const scoped = all.filter((p) => tabFn(p) && (!repoFilter || `${p.owner}/${p.repo}`.toLowerCase() === repoFilter.toLowerCase()));
  const text = q.trim().toLowerCase();
  const matching = scoped.filter((p) => !text || `${p.title ?? ''} ${p.key} ${p.author?.login ?? ''} ${p.headRefName ?? ''}`.toLowerCase().includes(text));
  const isClosed = (p: Row) => p.state === 'MERGED' || p.state === 'CLOSED';
  const openRows = matching.filter((p) => !isClosed(p));
  const closedRows = matching.filter(isClosed);
  const rows = closed ? closedRows : openRows;

  return (
    <div className="gh-page">
      <Readiness prs={all} lastSync={status?.sync.lastRunAt} online={!!status?.online} running={!!status?.sync.running} />
      <div className="row wrap" style={{ marginBottom: 16, gap: 12 }}>
        <div className="gh-subnav" role="tablist">
          {TABS.map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'selected' : ''} onClick={() => set('tab', id)}>
              {label}{' '}
              <span className="gh-counter" style={tab === id ? { background: 'rgba(255,255,255,0.2)', color: 'inherit' } : undefined}>
                {counts[id]}
              </span>
            </button>
          ))}
        </div>
        <div className="grow" style={{ minWidth: 220 }}>
          <TextInput block leadingVisual={SearchIcon} placeholder="Filter pull requests" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Button variant="primary" onClick={() => setAdding(true)}>
          Add pull requests
        </Button>
      </div>

      <div className="gh-box">
        <div className="gh-box-header">
          <button
            type="button"
            className="row link-default"
            style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', fontWeight: closed ? 400 : 600, color: closed ? 'var(--fgColor-muted)' : undefined }}
            onClick={() => set('state', null)}
          >
            <GitPullRequestIcon /> {openRows.length} Open
          </button>
          <button
            type="button"
            className="row link-default"
            style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', fontWeight: closed ? 600 : 400, color: closed ? undefined : 'var(--fgColor-muted)' }}
            onClick={() => set('state', 'closed')}
          >
            <CheckIcon /> {closedRows.length} Closed
          </button>
          <span className="grow" />
          <ActionMenu>
            <ActionMenu.Button variant="invisible" size="small">
              {repoFilter ?? 'Repository'}
            </ActionMenu.Button>
            <ActionMenu.Overlay width="medium">
              <ActionList selectionVariant="single">
                <ActionList.Item selected={!repoFilter} onSelect={() => set('repo', null)}>
                  All repositories
                </ActionList.Item>
                {repos.map((r) => (
                  <ActionList.Item key={r} selected={repoFilter?.toLowerCase() === r.toLowerCase()} onSelect={() => set('repo', r)}>
                    {r}
                  </ActionList.Item>
                ))}
              </ActionList>
            </ActionMenu.Overlay>
          </ActionMenu>
        </div>
        {isLoading && (
          <div className="gh-box-empty">
            <Spinner />
          </div>
        )}
        {error && <ErrorNote error={error} />}
        {!isLoading && rows.length === 0 && (
          <div className="gh-box-empty">
            <GitPullRequestIcon size={24} />
            <div style={{ marginTop: 8, fontSize: 16, color: 'var(--fgColor-default)' }}>No results matched your search.</div>
            {all.length === 0 && <div style={{ marginTop: 4 }}>Add pull request links, or press Sync to download every PR waiting for your review.</div>}
          </div>
        )}
        {rows.map((p) => (
          <PrRow key={p.key} p={p} onRemove={() => setRemoving(p)} />
        ))}
      </div>
      {adding && <AddDialog onClose={() => setAdding(false)} online={!!status?.online} />}
      {removing && <RemoveDialog pr={removing} onClose={() => setRemoving(null)} />}
    </div>
  );
}

function Readiness({ prs, lastSync, online, running }: { prs: Row[]; lastSync?: string; online: boolean; running: boolean }) {
  const sync = useMutation({ mutationFn: () => api('POST', '/api/sync', { full: false }) });
  if (!prs.length) return null;
  const failed = prs.filter((p) => p.lastSyncError);
  const notYet = prs.filter((p) => !p.cached && !p.lastSyncError);
  const cached = prs.filter((p) => p.cached && !p.lastSyncError).length;
  const drafts = prs.reduce((n, p) => n + (p.draftCount ?? 0), 0);
  const ready = !failed.length && !notYet.length;
  return (
    <div className={`gh-flash ${ready ? 'success' : 'warn'}`}>
      {ready ? <CheckCircleIcon /> : <AlertIcon />}
      <div className="grow">
        <b>{ready ? 'Ready to go offline.' : 'Not everything is downloaded yet.'}</b> {cached} of {plural(prs.length, 'pull request')} saved
        {drafts ? ` · ${plural(drafts, 'pending comment')}` : ''} · last sync {relative(lastSync) || 'never'}
        {notYet.length > 0 && (
          <div className="small">
            Waiting to download: {notYet.map((p) => p.key).join(', ')}
            {online ? '' : ' (needs a connection)'}
          </div>
        )}
        {failed.map((p) => (
          <div key={p.key} className="small" style={{ color: 'var(--fgColor-danger)' }}>
            {p.key}: {p.lastSyncError}
          </div>
        ))}
      </div>
      <Button size="small" leadingVisual={SyncIcon} disabled={!online || running || sync.isPending} onClick={() => sync.mutate()}>
        {running ? 'Syncing…' : 'Sync now'}
      </Button>
    </div>
  );
}

function PrRow({ p, onRemove }: { p: Row; onRemove: () => void }) {
  const base = prPath(p.owner, p.repo, p.number);
  const open = useMutation({ mutationFn: () => api('POST', `${base}/open`, {}) });
  const makeWt = useMutation({ mutationFn: () => api('POST', `${base}/worktree`) });
  const ob = p.outbox ?? { queued: 0, held: 0, failed: 0, sending: 0 };
  const hasWt = !!p.worktree?.path && !p.worktree.error;
  return (
    <div className="gh-box-row hover">
      <div style={{ paddingTop: 4 }}>
        <PrStateIcon state={p.state} isDraft={p.isDraft} />
      </div>
      <div className="grow">
        <div className="row wrap" style={{ gap: 6 }}>
          <Link className="gh-pr-row-title" to={prUrl(p.key)}>
            {p.title ?? p.key}
          </Link>
          <Labels labels={p.labels} />
        </div>
        <div className="gh-pr-row-meta">
          <span>
            {p.owner}/{p.repo}#{p.number}
            {p.author && <> by {p.author.login}</>}
            {p.updatedAt && <> · updated {relative(p.updatedAt)}</>}
          </span>
          {p.isDraft && <span>· Draft</span>}
          {p.reviewDecision === 'APPROVED' && (
            <span className="item good">
              · <CheckIcon size={12} /> Approved
            </span>
          )}
          {p.reviewDecision === 'CHANGES_REQUESTED' && (
            <span className="item bad">
              · <XIcon size={12} /> Changes requested
            </span>
          )}
          {p.reviewDecision === 'REVIEW_REQUIRED' && <span>· Review required</span>}
          {p.syncing ? (
            <span className="item info">
              · <Spinner size="small" /> downloading
            </span>
          ) : p.lastSyncError ? (
            <span className="item bad" title={p.lastSyncError}>
              · <AlertIcon size={12} /> sync failed
            </span>
          ) : !p.cached ? (
            <span className="item warn">· not downloaded yet</span>
          ) : (
            <span className="item" title={p.lastSyncAt ? new Date(p.lastSyncAt).toLocaleString() : undefined}>
              · saved {relative(p.lastSyncAt)}
            </span>
          )}
          {p.hasNewActivity && (
            <span className="item info">
              · <DotFillIcon size={12} /> new activity
            </span>
          )}
          {p.newCommitsSinceReview && !p.viewerIsAuthor && <span className="item warn">· new commits since your review</span>}
          {(p.draftCount ?? 0) > 0 && (
            <span className="item warn">
              · <PencilIcon size={12} /> {plural(p.draftCount!, 'pending comment')}
            </span>
          )}
          {ob.queued + ob.sending > 0 && (
            <span className="item info">
              · <InboxIcon size={12} /> {ob.queued + ob.sending} in outbox
            </span>
          )}
          {ob.held > 0 && <span className="item warn">· {ob.held} need your OK</span>}
          {ob.failed > 0 && <span className="item bad">· {ob.failed} failed to send</span>}
          {p.cached && (p.changedFiles ?? 0) > 0 && (
            <span className="item">
              · {p.viewedCount}/{p.changedFiles} files viewed
            </span>
          )}
          {p.prepare?.status === 'done' && <span className="item good">· ready to run</span>}
          {p.prepare?.status === 'running' && (
            <span className="item info">
              · <Spinner size="small" /> installing dependencies
            </span>
          )}
        </div>
        <ErrorNote error={open.error || makeWt.error} />
      </div>
      <div className="gh-pr-row-side">
        {(p.commentCount ?? 0) > 0 && (
          <Link to={prUrl(p.key)} className="row link-muted" style={{ gap: 4 }}>
            <CommentIcon size={16} /> {p.commentCount}
          </Link>
        )}
        {p.author && <Avatar actor={p.author} size={20} />}
        {hasWt ? <IconButton size="small" variant="invisible" icon={FileDirectoryIcon} aria-label="Open in Cursor" title={`Open ${p.worktree!.path}`} onClick={() => open.mutate()} /> : null}
        <ActionMenu>
          <ActionMenu.Anchor>
            <IconButton size="small" variant="invisible" icon={KebabHorizontalIcon} aria-label="More actions" />
          </ActionMenu.Anchor>
          <ActionMenu.Overlay>
            <ActionList>
              {hasWt ? <ActionList.Item onSelect={() => open.mutate()}>Open in Cursor</ActionList.Item> : p.cached && <ActionList.Item onSelect={() => makeWt.mutate()}>Create worktree</ActionList.Item>}
              {p.url && (
                <ActionList.LinkItem href={p.url} target="_blank">
                  Open on GitHub
                </ActionList.LinkItem>
              )}
              <ActionList.Divider />
              <ActionList.Item variant="danger" onSelect={onRemove}>
                <ActionList.LeadingVisual>
                  <TrashIcon />
                </ActionList.LeadingVisual>
                Remove from offline cache
              </ActionList.Item>
            </ActionList>
          </ActionMenu.Overlay>
        </ActionMenu>
      </div>
    </div>
  );
}

function AddDialog({ onClose, online }: { onClose: () => void; online: boolean }) {
  const [text, setText] = useState('');
  const qc = useQueryClient();
  const add = useMutation({
    mutationFn: () => api<{ keys: string[]; invalid: string[]; online: boolean }>('POST', '/api/prs', { urls: text }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['prs'] });
      if (!r.invalid.length) onClose();
    },
  });
  return (
    <Dialog
      title="Add pull requests"
      subtitle={online ? 'They download right away.' : "You're offline: they download when you reconnect."}
      onClose={onClose}
      width="large"
      footerButtons={[
        { content: 'Cancel', onClick: onClose },
        { content: 'Add', buttonType: 'primary', onClick: () => add.mutate(), disabled: !text.trim() || add.isPending },
      ]}
    >
      <Textarea
        block
        rows={5}
        autoFocus
        value={text}
        placeholder={'Paste one or more PR links, one per line\nhttps://github.com/owner/repo/pull/123'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && text.trim()) add.mutate();
        }}
      />
      {add.data?.invalid.length ? (
        <div className="small" style={{ marginTop: 8, color: 'var(--fgColor-danger)' }}>
          Not PR links: {add.data.invalid.join(', ')}
        </div>
      ) : null}
      <ErrorNote error={add.error} />
    </Dialog>
  );
}

function RemoveDialog({ pr, onClose }: { pr: Row; onClose: () => void }) {
  const qc = useQueryClient();
  const [withWorktree, setWithWorktree] = useState(true);
  const pending = (pr.outbox?.queued ?? 0) + (pr.outbox?.held ?? 0) + (pr.outbox?.failed ?? 0);
  const remove = useMutation({
    mutationFn: () => api<{ worktreeRemoved: boolean; note?: string }>('DELETE', `${prPath(pr.owner, pr.repo, pr.number)}${withWorktree ? '?worktree=1' : ''}`),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['prs'] });
      if (!r.note) onClose();
    },
  });
  const canRemoveWorktree = !!pr.worktree?.path && !pr.worktree.existing && !pr.worktree.error;
  return (
    <Dialog
      title={`Remove ${pr.key}?`}
      onClose={onClose}
      footerButtons={[
        { content: 'Cancel', onClick: onClose },
        {
          content: remove.data?.note ? 'Close' : 'Remove',
          buttonType: 'danger',
          onClick: () => (remove.data?.note ? onClose() : remove.mutate()),
          disabled: remove.isPending,
        },
      ]}
    >
      <div className="col">
        <span>This deletes the offline copy, your local viewed marks and any unsent draft for this PR.</span>
        {pr.sources.includes('review-requested') || pr.sources.includes('authored') ? (
          <span className="muted small">It's in your review queue, so the next sync will download it again.</span>
        ) : null}
        {pending > 0 && <span style={{ color: 'var(--fgColor-attention)' }}>{plural(pending, 'outbox item')} for this PR will stay in the outbox.</span>}
        {canRemoveWorktree && (
          <FormControl>
            <Checkbox checked={withWorktree} onChange={(e) => setWithWorktree(e.target.checked)} />
            <FormControl.Label>Also remove the worktree at {pr.worktree!.path} (only if it has no uncommitted changes or commits of yours)</FormControl.Label>
          </FormControl>
        )}
        {remove.data?.note && <span style={{ color: 'var(--fgColor-attention)' }}>Removed from the cache, but the worktree was kept: {remove.data.note}</span>}
        <ErrorNote error={remove.error} />
      </div>
    </Dialog>
  );
}
