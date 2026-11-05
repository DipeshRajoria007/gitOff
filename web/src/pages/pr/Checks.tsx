import { CheckCircleFillIcon, CircleIcon, DotFillIcon, GitCommitIcon, LinkExternalIcon, SkipIcon, StopIcon, XCircleFillIcon } from '@primer/octicons-react';
import { Label } from '@primer/react';
import type { CheckItem } from '@shared/types';
import { useMemo, useState } from 'react';
import { relative } from '../../components/common';
import type { Detail } from '../PullRequest';

function outcome(c: CheckItem): string {
  if (c.kind === 'status') return (c.state ?? 'PENDING').toUpperCase();
  if (c.status && c.status !== 'COMPLETED') return 'PENDING';
  return (c.conclusion ?? 'NEUTRAL').toUpperCase();
}

export function CheckIcon({ o, size = 16 }: { o: string; size?: number }) {
  if (o === 'SUCCESS') return <CheckCircleFillIcon size={size} fill="var(--fgColor-success)" />;
  if (o === 'FAILURE' || o === 'ERROR' || o === 'TIMED_OUT' || o === 'STARTUP_FAILURE') return <XCircleFillIcon size={size} fill="var(--fgColor-danger)" />;
  if (o === 'PENDING' || o === 'EXPECTED') return <DotFillIcon size={size} fill="var(--fgColor-attention)" />;
  if (o === 'CANCELLED' || o === 'ACTION_REQUIRED') return <StopIcon size={size} fill="var(--fgColor-muted)" />;
  if (o === 'SKIPPED' || o === 'NEUTRAL' || o === 'STALE') return <SkipIcon size={size} fill="var(--fgColor-muted)" />;
  return <CircleIcon size={size} />;
}

const ORDER = ['FAILURE', 'ERROR', 'TIMED_OUT', 'STARTUP_FAILURE', 'ACTION_REQUIRED', 'PENDING', 'EXPECTED', 'CANCELLED', 'SUCCESS', 'NEUTRAL', 'SKIPPED', 'STALE'];

function duration(c: CheckItem): string {
  if (!c.startedAt || !c.completedAt) return '';
  const s = Math.round((Date.parse(c.completedAt) - Date.parse(c.startedAt)) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function ChecksTab({ detail, online }: { detail: Detail; online: boolean }) {
  const snap = detail.snapshot!;
  const items = useMemo(() => [...snap.checks.items].sort((a, b) => ORDER.indexOf(outcome(a)) - ORDER.indexOf(outcome(b))), [snap.checks.items]);
  const groups = useMemo(() => {
    const m = new Map<string, CheckItem[]>();
    for (const c of items) {
      const g = c.workflowName ?? c.appName ?? (c.kind === 'status' ? 'Commit statuses' : 'Checks');
      m.set(g, [...(m.get(g) ?? []), c]);
    }
    return [...m.entries()];
  }, [items]);
  const [selected, setSelected] = useState(0);
  const sel = items[selected];
  const head = snap.commits.find((c) => c.oid === (snap.checks.commitOid ?? snap.pr.headRefOid)) ?? snap.commits[snap.commits.length - 1];

  return (
    <div style={{ marginTop: 8 }}>
      <div className="gh-checks-head">
        <CheckIcon o={(snap.checks.state ?? 'NEUTRAL').toUpperCase()} size={20} />
        <b>{head?.messageHeadline ?? 'Latest commit'}</b>
        <span className="gh-sha">{head?.abbreviatedOid}</span>
        <span className="muted small" style={{ marginLeft: 'auto' }}>
          as of {relative(snap.fetchedAt)}
        </span>
      </div>
      <div className="gh-checks">
        <nav className="gh-checks-list" aria-label="Checks">
          {groups.map(([g, cs]) => (
            <div key={g}>
              <div className="gh-checks-group">{g}</div>
              {cs.map((c) => {
                const i = items.indexOf(c);
                return (
                  <button key={`${c.name}-${i}`} type="button" className={`gh-checks-item ${i === selected ? 'selected' : ''}`} onClick={() => setSelected(i)}>
                    <CheckIcon o={outcome(c)} />
                    <span className="grow truncate">{c.name}</span>
                    {c.isRequired && <Label size="small">Required</Label>}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
        <section className="gh-checks-detail">
          {!sel ? (
            <div className="gh-checks-empty">
              <GitCommitIcon size={24} />
              There are no checks for this commit
            </div>
          ) : (
            <div className="col" style={{ gap: 12 }}>
              <div className="row">
                <CheckIcon o={outcome(sel)} size={24} />
                <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>{sel.name}</h2>
              </div>
              <div className="muted small">
                {outcome(sel).toLowerCase().replace('_', ' ')}
                {duration(sel) ? ` in ${duration(sel)}` : ''}
                {sel.completedAt ? ` · ${relative(sel.completedAt)}` : sel.startedAt ? ` · started ${relative(sel.startedAt)}` : ''}
                {sel.workflowName ? ` · ${sel.workflowName}` : ''}
              </div>
              {sel.title && <div style={{ fontWeight: 600 }}>{sel.title}</div>}
              {sel.summary && <pre className="log-view" style={{ maxHeight: 420 }}>{sel.summary}</pre>}
              {!sel.title && !sel.summary && <div className="muted">No summary was reported for this check. Logs aren't saved offline.</div>}
              {sel.url && (
                <a href={sel.url} target="_blank" rel="noreferrer" className="row small" title={online ? undefined : 'Needs a connection'}>
                  <LinkExternalIcon /> View details on GitHub
                </a>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
