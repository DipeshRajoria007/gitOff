import { CheckIcon, CodeIcon, CopyIcon, DotFillIcon, GitCommitIcon, XIcon } from '@primer/octicons-react';
import { IconButton } from '@primer/react';
import type { Commit } from '@shared/types';
import { useState } from 'react';
import { Link } from 'react-router';
import { Avatar, Time } from '../../components/common';
import { prUrl } from '../../lib/api';
import { copy } from '../../lib/util';
import type { Detail } from '../PullRequest';

export function CheckStateIcon({ state }: { state: string | null }) {
  const s = (state ?? '').toUpperCase();
  if (s === 'SUCCESS') return <CheckIcon fill="var(--fgColor-success)" />;
  if (s === 'FAILURE' || s === 'ERROR') return <XIcon fill="var(--fgColor-danger)" />;
  if (s === 'PENDING' || s === 'EXPECTED') return <DotFillIcon fill="var(--fgColor-attention)" />;
  return null;
}

function CommitRow({ c, snapKey }: { c: Commit; snapKey: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="gh-box-row hover" style={{ alignItems: 'center', padding: '8px 16px' }}>
      <div className="grow">
        <div>
          <Link className="gh-commit-title" to={prUrl(snapKey, `commits/${c.oid}`)}>
            {c.messageHeadline}
          </Link>
          {c.messageBody.trim() && (
            <button type="button" className="gh-ellipsis" aria-label="Show commit message" onClick={() => setOpen((v) => !v)}>
              …
            </button>
          )}
        </div>
        {open && <pre className="gh-commit-body">{c.messageBody}</pre>}
        <div className="gh-commit-meta">
          <Avatar actor={c.author.login ? { login: c.author.login, avatarUrl: c.author.avatarUrl } : null} size={20} />
          <b>{c.author.login ?? c.author.name}</b> committed <Time iso={c.committedDate} />
          <CheckStateIcon state={c.checkState} />
        </div>
      </div>
      <div className="row" style={{ gap: 4 }}>
        <Link className="gh-sha" to={prUrl(snapKey, `commits/${c.oid}`)}>
          {c.abbreviatedOid}
        </Link>
        <IconButton size="small" variant="invisible" icon={CopyIcon} aria-label="Copy full SHA" onClick={() => copy(c.oid)} />
        <IconButton
          size="small"
          variant="invisible"
          icon={CodeIcon}
          aria-label="Browse the changes in this commit"
          onClick={() => (window.location.href = prUrl(snapKey, `commits/${c.oid}`))}
        />
      </div>
    </div>
  );
}

export function CommitsTab({ detail }: { detail: Detail }) {
  const snap = detail.snapshot!;
  const byDay = new Map<string, Commit[]>();
  for (const c of snap.commits) {
    const day = new Date(c.committedDate).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    byDay.set(day, [...(byDay.get(day) ?? []), c]);
  }
  return (
    <div style={{ marginTop: 24 }}>
      {snap.commits.length < snap.commitsTotal && (
        <p className="muted small">
          Showing {snap.commits.length} of {snap.commitsTotal} commits.
        </p>
      )}
      {[...byDay.entries()].map(([day, commits]) => (
        <div key={day} className="gh-commits-day">
          <div className="gh-commits-dayhead">
            <GitCommitIcon /> Commits on {day}
          </div>
          <div className="gh-box">
            {commits.map((c) => (
              <CommitRow key={c.oid} c={c} snapKey={snap.key} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
