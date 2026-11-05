import { CheckIcon, ClockIcon, InboxIcon, StopIcon, XIcon } from '@primer/octicons-react';
import { Button, Label, Spinner } from '@primer/react';
import type { OutboxItem } from '@shared/types';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { ErrorNote } from '../components/common';
import { api, fetchers, prUrl } from '../lib/api';
import { renderMarkdown } from '../lib/markdown';
import { plural, timeAgo } from '../lib/util';

function describe(x: OutboxItem): string {
  switch (x.type) {
    case 'review':
      if (x.single) return x.replies.length ? 'Reply' : 'Single comment';
      return `Review: ${x.event === 'APPROVE' ? 'approve' : x.event === 'REQUEST_CHANGES' ? 'request changes' : 'comment'}${
        x.threads.length || x.replies.length ? ` with ${plural(x.threads.length, 'comment')}${x.replies.length ? `, ${plural(x.replies.length, 'reply', 'replies')}` : ''}` : ''
      }`;
    case 'comment':
      return 'Conversation comment';
    case 'resolve':
      return x.resolve ? 'Resolve a thread' : 'Unresolve a thread';
    case 'viewed':
      return `Mark ${x.path} as ${x.viewed ? 'viewed' : 'not viewed'}`;
  }
}

function StatusBadge({ x }: { x: OutboxItem }) {
  switch (x.status) {
    case 'queued':
      return (
        <Label variant="accent">
          <ClockIcon size={12} /> queued
        </Label>
      );
    case 'sending':
      return <Label variant="accent">sending…</Label>;
    case 'held':
      return (
        <Label variant="attention">
          <StopIcon size={12} /> needs your OK
        </Label>
      );
    case 'failed':
      return (
        <Label variant="danger">
          <XIcon size={12} /> failed
        </Label>
      );
    case 'sent':
      return (
        <Label variant="success">
          <CheckIcon size={12} /> sent
        </Label>
      );
  }
}

export function OutboxPage() {
  const { data, isLoading, error } = useQuery({ queryKey: ['outbox'], queryFn: fetchers.outbox });
  const { data: status } = useQuery({ queryKey: ['status'], queryFn: fetchers.status });
  const act = useMutation({ mutationFn: (v: { id: string; action: string }) => api('POST', `/api/outbox/${v.id}/${v.action}`) });
  const sendNow = useMutation({ mutationFn: () => api('POST', '/api/outbox/send') });
  const items = (data?.items ?? []).filter((x) => x.type !== 'viewed' || x.status !== 'queued');
  const pending = items.filter((x) => x.status !== 'sent');
  const sent = items.filter((x) => x.status === 'sent').reverse().slice(0, 30);
  const viewedQueued = (data?.items ?? []).filter((x) => x.type === 'viewed' && x.status === 'queued').length;

  const Item = ({ x }: { x: OutboxItem }) => (
    <div className="outbox-item">
      <div className="row wrap">
        <StatusBadge x={x} />
        <b>{describe(x)}</b>
        <span className="muted small">
          on <Link to={prUrl(x.prKey)}>{data?.titles[x.prKey] ?? x.prKey}</Link> <span className="muted">({x.prKey})</span> · created {timeAgo(x.createdAt)}
          {x.attempts > 0 && x.status !== 'sent' ? ` · ${plural(x.attempts, 'attempt')}` : ''}
          {x.sentAt ? ` · sent ${timeAgo(x.sentAt)}` : ''}
        </span>
        <span style={{ flex: 1 }} />
        {x.resultUrl && (
          <a href={x.resultUrl} target="_blank" rel="noreferrer" className="small">
            View on GitHub
          </a>
        )}
      </div>
      {x.type === 'review' && x.body.trim() && <div className="markdown-body small" style={{ marginTop: 8 }} dangerouslySetInnerHTML={{ __html: renderMarkdown(x.body) }} />}
      {x.type === 'review' && x.single && (
        <div className="markdown-body small" style={{ marginTop: 8 }} dangerouslySetInnerHTML={{ __html: renderMarkdown((x.threads[0] ?? x.replies[0])?.body ?? '') }} />
      )}
      {x.type === 'comment' && <div className="markdown-body small" style={{ marginTop: 8 }} dangerouslySetInnerHTML={{ __html: renderMarkdown(x.body) }} />}
      {x.heldReason && <div style={{ marginTop: 8, color: 'var(--fgColor-attention)' }}>{x.heldReason}</div>}
      {x.blockedBy && x.status === 'queued' && (
        <div className="small muted" style={{ marginTop: 8 }}>
          Waits for your earlier review on this PR (GitHub allows one pending review per PR at a time).
        </div>
      )}
      {x.lastError && x.status !== 'sent' && <div className="small" style={{ marginTop: 8, color: x.status === 'failed' ? 'var(--fgColor-danger)' : 'var(--fgColor-muted)' }}>{x.lastError}</div>}
      {x.notes?.map((n) => (
        <div key={n} className="small muted" style={{ marginTop: 4 }}>
          {n}
        </div>
      ))}
      {x.status !== 'sent' && x.status !== 'sending' && (
        <div className="row wrap" style={{ marginTop: 8 }}>
          {x.status === 'held' && x.type === 'review' && (
            <>
              <Button size="small" variant="primary" onClick={() => act.mutate({ id: x.id, action: 'confirm' })}>
                {x.event === 'APPROVE' ? 'Approve anyway' : 'Send anyway'}
              </Button>
              {x.event !== 'COMMENT' && (
                <Button size="small" onClick={() => act.mutate({ id: x.id, action: 'as-comment' })}>
                  Send as comment instead
                </Button>
              )}
            </>
          )}
          {x.status === 'failed' && (
            <Button size="small" onClick={() => act.mutate({ id: x.id, action: 'retry' })}>
              Retry
            </Button>
          )}
          {x.type === 'review' && !x.single && (
            <Button
              size="small"
              onClick={() => act.mutate({ id: x.id, action: 'to-draft' })}
              title={x.progress.reviewId ? 'Part of it is already on GitHub as a pending review; that copy is discarded (needs a connection).' : undefined}
            >
              Back to draft
            </Button>
          )}
          <Button size="small" variant="danger" onClick={() => act.mutate({ id: x.id, action: 'delete' })}>
            Delete
          </Button>
        </div>
      )}
    </div>
  );

  return (
    <div className="container">
      <div className="row" style={{ marginBottom: 16 }}>
        <h2 className="grow" style={{ margin: 0, fontWeight: 400 }}>
          <InboxIcon size={24} /> Outbox
        </h2>
        <Button onClick={() => sendNow.mutate()} disabled={!status?.online || !pending.length || sendNow.isPending}>
          {status?.online ? 'Send now' : 'Offline: sends when you reconnect'}
        </Button>
      </div>
      <p className="muted">
        Everything you submit while offline waits here and goes to GitHub automatically once you're back online. Approvals are held for your OK if the PR got new
        commits after you reviewed it.
      </p>
      <ErrorNote error={error || act.error || sendNow.error} />
      {isLoading && <Spinner />}
      <div className="section-title">
        Waiting <span className="chip">{pending.length}</span>
        {viewedQueued > 0 && <span className="muted small" style={{ fontWeight: 400 }}>(+{plural(viewedQueued, '"viewed" mark')} to sync)</span>}
      </div>
      <div className="box">{pending.length ? pending.map((x) => <Item key={x.id} x={x} />) : <div className="box-empty">Nothing waiting to be sent.</div>}</div>
      {sent.length > 0 && (
        <>
          <div className="section-title">Recently sent</div>
          <div className="box">
            {sent.map((x) => (
              <Item key={x.id} x={x} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
