import { LinkExternalIcon } from '@primer/octicons-react';
import { Button, Spinner, StateLabel } from '@primer/react';
import type { JiraIssue } from '@shared/types';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { ErrorNote, Html, relative, Time } from '../components/common';
import { ApiError, fetchers } from '../lib/api';

/** Jira has no avatars offline; use initials in the same 40px circle as GitHub's timeline. */
function Initials({ name }: { name: string | null }) {
  const letters =
    (name ?? '?')
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w[0])
      .join('')
      .slice(0, 2)
      .toUpperCase() || '?';
  return (
    <span className="gh-tl-avatar gh-initials" aria-hidden="true">
      {letters}
    </span>
  );
}

function JiraState({ j }: { j: JiraIssue }) {
  if (!j.status) return null;
  const status = j.statusCategory === 'done' ? 'issueClosed' : j.statusCategory === 'indeterminate' ? 'issueOpened' : 'issueDraft';
  return <StateLabel status={status}>{j.status}</StateLabel>;
}

function SidebarItem({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <div className="gh-sidebar-item">
      <div className="gh-sidebar-heading">{heading}</div>
      {children}
    </div>
  );
}

export function JiraPage() {
  const { key = '' } = useParams();
  const { data: j, error, isLoading } = useQuery({ queryKey: ['jira', key], queryFn: () => fetchers.jira(key), retry: false });
  if (isLoading) {
    return (
      <div className="gh-page">
        <Spinner />
      </div>
    );
  }
  if (error instanceof ApiError && error.status === 404) {
    return (
      <div className="gh-page narrow">
        <div className="gh-box">
          <div className="gh-box-empty">
            <div style={{ fontSize: 20, color: 'var(--fgColor-default)' }}>{key} isn't cached</div>
            <div style={{ marginTop: 8 }}>
              Jira tickets mentioned in cached pull requests download during sync once Jira is connected. <Link to="/settings#jira">Connect Jira</Link>
            </div>
          </div>
        </div>
      </div>
    );
  }
  if (error || !j) {
    return (
      <div className="gh-page">
        <ErrorNote error={error} />
      </div>
    );
  }
  const related = [...j.subtasks.map((s) => ({ type: 'Subtask', ...s })), ...j.links];
  return (
    <div className="gh-page">
      <div className="gh-jira-head">
        {j.parent && (
          <div className="small muted" style={{ marginBottom: 4 }}>
            <Link to={`/jira/${j.parent.key}`}>{j.parent.key}</Link> {j.parent.summary}
          </div>
        )}
        <div className="gh-pr-titlerow">
          <h1 className="gh-pr-title">
            {j.summary} <span className="gh-pr-number">{j.key}</span>
          </h1>
          <div className="gh-pr-actions">
            <Button as="a" href={j.url} target="_blank" rel="noreferrer" leadingVisual={LinkExternalIcon}>
              Open in Jira
            </Button>
          </div>
        </div>
        <div className="gh-pr-meta">
          <JiraState j={j} />
          <span>
            <b>{j.reporter ?? 'Someone'}</b> opened this {j.issueType ? j.issueType.toLowerCase() : 'ticket'} <Time iso={j.created} />
            {j.comments.length > 0 && ` · ${j.comments.length} ${j.comments.length === 1 ? 'comment' : 'comments'}`} · cached {relative(j.fetchedAt)}
          </span>
        </div>
      </div>

      <div className="gh-discussion">
        <div className="gh-discussion-main">
          <div className="gh-timeline">
            <div className="gh-tl-comment">
              <Initials name={j.reporter} />
              <div className="gh-comment caret">
                <div className="gh-comment-header">
                  <span className="gh-comment-author">{j.reporter ?? 'Someone'}</span>
                  <span>opened</span>
                  <Time iso={j.created} />
                </div>
                <div className="gh-comment-body">
                  <Html html={j.descriptionHTML} />
                </div>
              </div>
            </div>
            {j.comments.map((c) => (
              <div className="gh-tl-comment" key={c.id}>
                <Initials name={c.author} />
                <div className="gh-comment caret">
                  <div className="gh-comment-header">
                    <span className="gh-comment-author">{c.author ?? 'Someone'}</span>
                    <span>commented</span>
                    <Time iso={c.created} />
                  </div>
                  <div className="gh-comment-body">
                    <Html html={c.bodyHTML} empty="" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <aside className="gh-sidebar">
          <SidebarItem heading="Assignee">
            <div className="gh-sidebar-row">{j.assignee ? <span className="name">{j.assignee}</span> : <span className="gh-sidebar-muted">No one assigned</span>}</div>
          </SidebarItem>
          <SidebarItem heading="Reporter">
            <div className="gh-sidebar-row">{j.reporter ? <span className="name">{j.reporter}</span> : <span className="gh-sidebar-muted">Unknown</span>}</div>
          </SidebarItem>
          <SidebarItem heading="Details">
            <div className="gh-sidebar-row">
              <span className="gh-sidebar-muted">Status</span> {j.status ?? '—'}
            </div>
            <div className="gh-sidebar-row">
              <span className="gh-sidebar-muted">Type</span> {j.issueType ?? '—'}
            </div>
            <div className="gh-sidebar-row">
              <span className="gh-sidebar-muted">Priority</span> {j.priority ?? '—'}
            </div>
            <div className="gh-sidebar-row">
              <span className="gh-sidebar-muted">Updated</span> <Time iso={j.updated} />
            </div>
          </SidebarItem>
          <SidebarItem heading="Labels">
            {j.labels.length ? (
              <div className="row wrap" style={{ gap: 4 }}>
                {j.labels.map((l) => (
                  <span key={l} className="gh-role">
                    {l}
                  </span>
                ))}
              </div>
            ) : (
              <div className="gh-sidebar-muted">None yet</div>
            )}
          </SidebarItem>
          {related.length > 0 && (
            <SidebarItem heading="Related tickets">
              {related.map((l) => (
                <div className="gh-sidebar-related" key={`${l.type}-${l.key}`}>
                  <div className="gh-sidebar-muted">{l.type}</div>
                  <div>
                    <Link to={`/jira/${l.key}`}>{l.key}</Link> {l.summary}
                    {l.status && <span className="gh-sidebar-muted"> · {l.status}</span>}
                  </div>
                </div>
              ))}
            </SidebarItem>
          )}
        </aside>
      </div>
    </div>
  );
}
