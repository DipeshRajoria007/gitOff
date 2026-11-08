import { AlertIcon, CheckCircleIcon, CheckIcon, ClockIcon, CloudOfflineIcon, CommentIcon, FileIcon, InboxIcon, LinkExternalIcon, XCircleIcon } from '@primer/octicons-react';
import { Button, Spinner, useConfirm } from '@primer/react';
import type { OutboxItem, OutboxReview } from '@shared/types';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { ErrorNote, relative } from '../components/common';
import { api, fetchers, prUrl } from '../lib/api';
import { renderMarkdown } from '../lib/markdown';
import { plural } from '../lib/util';

function describe(x: OutboxItem): string {
  switch (x.type) {
    case 'review': {
      if (x.single) return x.replies.length ? 'Reply' : 'Single comment';
      const what = x.event === 'APPROVE' ? 'Approval' : x.event === 'REQUEST_CHANGES' ? 'Change request' : 'Review';
      const parts = [x.threads.length ? plural(x.threads.length, 'comment') : '', x.replies.length ? plural(x.replies.length, 'reply', 'replies') : ''].filter(Boolean);
      return parts.length ? `${what} with ${parts.join(' and ')}` : what;
    }
    case 'comment':
      return 'Conversation comment';
    case 'resolve':
      return x.resolve ? 'Resolve a thread' : 'Unresolve a thread';
    case 'viewed':
      return `Mark ${x.path} as ${x.viewed ? 'viewed' : 'not viewed'}`;
  }
}

const STATUS: Record<OutboxItem['status'], { label: string; cls: string }> = {
  queued: { label: 'Queued', cls: '' },
  sending: { label: 'Sending', cls: 'accent' },
  held: { label: 'Needs your OK', cls: 'attention' },
  failed: { label: 'Failed', cls: 'danger' },
  sent: { label: 'Sent', cls: 'success' },
};

function StatusIcon({ x }: { x: OutboxItem }) {
  switch (x.status) {
    case 'queued':
      return <ClockIcon className="ob-icon" />;
    case 'sending':
      return <Spinner size="small" />;
    case 'held':
      return <AlertIcon className="ob-icon attention" />;
    case 'failed':
      return <XCircleIcon className="ob-icon danger" />;
    case 'sent':
      return <CheckCircleIcon className="ob-icon success" />;
  }
}

/** The first line of a comment, without markdown noise, for the one-line previews. */
function firstLine(body: string): string {
  const line = body
    .replace(/```suggestion[\s\S]*?```/g, '(suggested change)')
    .split('\n')
    .map((l) => l.replace(/^[#>*\-\s]+/, '').trim())
    .find(Boolean);
  return (line ?? '').replace(/`/g, '');
}

function where(t: OutboxReview['threads'][number]): string {
  if (t.subjectType === 'FILE' || !t.line) return t.path;
  return t.startLine && t.startLine !== t.line ? `${t.path}:${t.startLine}-${t.line}` : `${t.path}:${t.line}`;
}

function Preview({ x }: { x: OutboxItem }) {
  if (x.type === 'comment') return <div className="ob-body markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(x.body) }} />;
  if (x.type !== 'review') return null;
  const lines = [
    ...x.threads.map((t) => ({ id: t.localId, reply: false, where: where(t), text: firstLine(t.body) })),
    ...x.replies.map((r) => ({ id: r.localId, reply: true, where: r.path ?? 'thread', text: firstLine(r.body) })),
  ];
  return (
    <>
      {x.body.trim() && <div className="ob-body markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(x.body) }} />}
      {lines.length > 0 && (
        <ul className="ob-comments">
          {lines.map((l) => (
            <li key={l.id} title={l.reply ? 'Reply in a thread on this file' : undefined}>
              {l.reply ? <CommentIcon size={12} /> : <FileIcon size={12} />}
              <span className="mono where">{l.where}</span>
              <span className="text">{l.text}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function OutboxRow({ x, title, onAct }: { x: OutboxItem; title?: string; onAct: (action: string) => void }) {
  const confirm = useConfirm();
  const s = STATUS[x.status];
  const remove = async () => {
    const wasHalfSent = x.type === 'review' && !!x.progress.reviewId;
    const ok =
      x.type === 'viewed' || x.type === 'resolve'
        ? true
        : await confirm({
            title: 'Delete from the outbox?',
            content: `It won't be sent to GitHub, and its text can't be recovered.${wasHalfSent ? ' The part already on GitHub as a pending review is discarded too.' : ''}`,
            confirmButtonContent: 'Delete',
            confirmButtonType: 'danger',
          });
    if (ok) onAct('delete');
  };
  return (
    <div className="gh-box-row ob-row">
      <div className="ob-status">
        <StatusIcon x={x} />
      </div>
      <div className="grow">
        <div className="row wrap" style={{ gap: 8 }}>
          <span className="ob-title">{describe(x)}</span>
          <span className={`ob-state ${s.cls}`}>{s.label}</span>
        </div>
        <div className="gh-pr-row-meta">
          <span>
            on{' '}
            <Link className="link-default" to={prUrl(x.prKey)}>
              {title ?? x.prKey}
            </Link>{' '}
            {x.prKey}
          </span>
          <span>· created {relative(x.createdAt)}</span>
          {x.attempts > 0 && x.status !== 'sent' && <span>· {plural(x.attempts, 'attempt')}</span>}
          {x.sentAt && <span>· sent {relative(x.sentAt)}</span>}
        </div>
        <Preview x={x} />
        {x.heldReason && (
          <div className="ob-note attention">
            <AlertIcon size={14} /> {x.heldReason}
          </div>
        )}
        {x.blockedBy && x.status === 'queued' && <div className="ob-note">Waits for your earlier review on this PR. GitHub allows one pending review per PR at a time.</div>}
        {x.lastError && x.status !== 'sent' && <div className={`ob-note ${x.status === 'failed' ? 'danger' : ''}`}>{x.lastError}</div>}
        {x.notes?.map((n) => (
          <div key={n} className="ob-note">
            {n}
          </div>
        ))}
        {x.status !== 'sent' && x.status !== 'sending' && (
          <div className="row wrap" style={{ marginTop: 12 }}>
            {x.status === 'held' && x.type === 'review' && (
              <>
                <Button size="small" variant="primary" onClick={() => onAct('confirm')}>
                  {x.event === 'APPROVE' ? 'Approve anyway' : 'Send anyway'}
                </Button>
                {x.event !== 'COMMENT' && (
                  <Button size="small" onClick={() => onAct('as-comment')}>
                    Send as comment instead
                  </Button>
                )}
              </>
            )}
            {x.status === 'failed' && (
              <Button size="small" onClick={() => onAct('retry')}>
                Retry
              </Button>
            )}
            {x.type === 'review' && !x.single && (
              <Button
                size="small"
                onClick={() => onAct('to-draft')}
                title={x.progress.reviewId ? 'Part of it is already on GitHub as a pending review; that copy is discarded (needs a connection).' : 'Turn it back into a pending review you can edit'}
              >
                Back to draft
              </Button>
            )}
            <Button size="small" variant="danger" onClick={() => void remove()}>
              Delete
            </Button>
          </div>
        )}
      </div>
      {x.resultUrl && (
        <a className="ob-link small link-muted" href={x.resultUrl} target="_blank" rel="noreferrer">
          View on GitHub <LinkExternalIcon size={12} />
        </a>
      )}
    </div>
  );
}

export function OutboxPage() {
  const { data, isLoading, error } = useQuery({ queryKey: ['outbox'], queryFn: fetchers.outbox });
  const { data: status } = useQuery({ queryKey: ['status'], queryFn: fetchers.status });
  const act = useMutation({ mutationFn: (v: { id: string; action: string }) => api('POST', `/api/outbox/${v.id}/${v.action}`) });
  const sendNow = useMutation({ mutationFn: () => api('POST', '/api/outbox/send') });
  const [showSent, setShowSent] = useState(false);
  const online = !!status?.online;

  // Queued "viewed" ticks are bookkeeping; they're summarized in the header instead of listed.
  const items = (data?.items ?? []).filter((x) => x.type !== 'viewed' || x.status !== 'queued');
  const pending = items.filter((x) => x.status !== 'sent');
  const sent = items
    .filter((x) => x.status === 'sent')
    .reverse()
    .slice(0, 50);
  const viewedQueued = (data?.items ?? []).filter((x) => x.type === 'viewed' && x.status === 'queued').length;
  const rows = showSent ? sent : pending;
  const needsYou = pending.filter((x) => x.status === 'held' || x.status === 'failed').length;

  return (
    <div className="gh-page narrow">
      <div className="gh-subhead">
        <h1 className="gh-subhead-heading">Outbox</h1>
        <Button onClick={() => sendNow.mutate()} disabled={!online || !pending.length || sendNow.isPending}>
          Send now
        </Button>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        Reviews, comments, resolved threads and "viewed" ticks you make offline wait here. They go to GitHub on their own when you're back online, oldest first.
      </p>
      {!online && pending.length > 0 && (
        <div className="gh-flash warn">
          <CloudOfflineIcon />
          <div className="grow">You're offline. {plural(pending.length, 'item')} will be sent as soon as GitHub is reachable again; you can close this tab.</div>
        </div>
      )}
      {needsYou > 0 && (
        <div className="gh-flash danger">
          <AlertIcon />
          <div className="grow">
            {plural(needsYou, 'item')} {needsYou === 1 ? 'needs' : 'need'} your attention. An approval is held when the PR got new commits after you reviewed it.
          </div>
        </div>
      )}
      <ErrorNote error={error || act.error || sendNow.error} />
      <div className="gh-box">
        <div className="gh-box-header">
          <button type="button" className={`gh-box-toggle ${showSent ? '' : 'selected'}`} onClick={() => setShowSent(false)}>
            <ClockIcon /> {pending.length} Waiting
          </button>
          <button type="button" className={`gh-box-toggle ${showSent ? 'selected' : ''}`} onClick={() => setShowSent(true)}>
            <CheckIcon /> {sent.length} Sent
          </button>
          <span className="grow" />
          {viewedQueued > 0 && <span className="muted small">+ {plural(viewedQueued, '"viewed" tick')} to sync</span>}
        </div>
        {isLoading && (
          <div className="gh-box-empty">
            <Spinner />
          </div>
        )}
        {!isLoading && rows.length === 0 && (
          <div className="gh-box-empty">
            <InboxIcon size={24} />
            <div style={{ marginTop: 8, fontSize: 16, color: 'var(--fgColor-default)' }}>{showSent ? 'Nothing sent recently.' : 'Nothing waiting to be sent.'}</div>
            {!showSent && <div style={{ marginTop: 4 }}>When you submit a review or comment without a connection, it waits here.</div>}
          </div>
        )}
        {rows.map((x) => (
          <OutboxRow key={x.id} x={x} title={data?.titles[x.prKey]} onAct={(action) => act.mutate({ id: x.id, action })} />
        ))}
      </div>
    </div>
  );
}
