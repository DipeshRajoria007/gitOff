import { LinkExternalIcon } from '@primer/octicons-react';
import { Button, Label, Spinner } from '@primer/react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ErrorNote, Html } from '../components/common';
import { ApiError, fetchers } from '../lib/api';
import { timeAgo } from '../lib/util';

export function JiraPage() {
  const { key = '' } = useParams();
  const { data: j, error, isLoading } = useQuery({ queryKey: ['jira', key], queryFn: () => fetchers.jira(key), retry: false });
  if (isLoading) {
    return (
      <div className="container">
        <Spinner />
      </div>
    );
  }
  if (error instanceof ApiError && error.status === 404) {
    return (
      <div className="container">
        <h2 style={{ fontWeight: 400 }}>
          {key} <span className="muted">isn't cached</span>
        </h2>
        <p className="muted">
          Jira tickets linked from cached PRs are downloaded during sync once Jira is connected. <Link to="/settings">Connect Jira</Link>.
        </p>
      </div>
    );
  }
  if (error || !j) {
    return (
      <div className="container">
        <ErrorNote error={error} />
      </div>
    );
  }
  return (
    <div className="container" style={{ maxWidth: 1000 }}>
      <div className="muted small">
        {j.parent && (
          <>
            <Link to={`/jira/${j.parent.key}`}>{j.parent.key}</Link> {j.parent.summary} /{' '}
          </>
        )}
        {j.key}
      </div>
      <h1 style={{ fontWeight: 400, margin: '4px 0 8px' }}>{j.summary}</h1>
      <div className="row wrap" style={{ marginBottom: 16 }}>
        {j.status && <Label variant={j.statusCategory === 'done' ? 'done' : j.statusCategory === 'indeterminate' ? 'accent' : 'secondary'}>{j.status}</Label>}
        {j.issueType && <Label>{j.issueType}</Label>}
        {j.priority && <Label>{j.priority}</Label>}
        <span className="muted small">
          Assignee: {j.assignee ?? 'unassigned'} · Reporter: {j.reporter ?? '—'} · updated {timeAgo(j.updated)} · cached {timeAgo(j.fetchedAt)}
        </span>
        <span style={{ flex: 1 }} />
        <Button as="a" href={j.url} target="_blank" size="small" leadingVisual={LinkExternalIcon}>
          Open in Jira
        </Button>
      </div>
      <div className="box">
        <div className="box-header">Description</div>
        <div style={{ padding: 16 }}>
          <Html html={j.descriptionHTML} />
        </div>
      </div>
      {(j.subtasks.length > 0 || j.links.length > 0) && (
        <div className="box" style={{ marginTop: 16 }}>
          <div className="box-header">Related</div>
          {[...j.subtasks.map((s) => ({ type: 'subtask', ...s })), ...j.links].map((l) => (
            <div className="box-row" key={`${l.type}-${l.key}`}>
              <span className="muted small" style={{ width: 120 }}>
                {l.type}
              </span>
              <Link to={`/jira/${l.key}`}>{l.key}</Link>
              <span className="grow">{l.summary}</span>
              {l.status && <Label>{l.status}</Label>}
            </div>
          ))}
        </div>
      )}
      <div className="section-title">Comments ({j.comments.length})</div>
      {j.comments.map((c) => (
        <div className="comment-box" key={c.id} style={{ marginBottom: 12 }}>
          <div className="comment-head">
            <span className="who">{c.author ?? 'Someone'}</span> commented {timeAgo(c.created)}
          </div>
          <div className="comment-body">
            <Html html={c.bodyHTML} />
          </div>
        </div>
      ))}
    </div>
  );
}
