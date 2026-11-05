import {
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
} from '@primer/octicons-react';
import { StateLabel } from '@primer/react';
import type { Actor, Label, PRState } from '@shared/types';
import { useMemo, type CSSProperties, type MouseEvent } from 'react';
import { useNavigate } from 'react-router';
import { sanitize } from '../lib/markdown';

export function PrStateIcon({ state, isDraft, size = 16 }: { state?: PRState; isDraft?: boolean; size?: number }) {
  if (state === 'MERGED') return <GitMergeIcon size={size} fill="var(--fgColor-done)" />;
  if (state === 'CLOSED') return <GitPullRequestClosedIcon size={size} fill="var(--fgColor-danger)" />;
  if (isDraft) return <GitPullRequestDraftIcon size={size} fill="var(--fgColor-muted)" />;
  return <GitPullRequestIcon size={size} fill="var(--fgColor-success)" />;
}

export function PrStateLabel({ state, isDraft, size }: { state: PRState; isDraft: boolean; size?: 'small' | 'normal' }) {
  const s = size === 'small' ? { size: 'small' as const } : {};
  if (state === 'MERGED') return <StateLabel status="pullMerged" {...s}>Merged</StateLabel>;
  if (state === 'CLOSED') return <StateLabel status="pullClosed" {...s}>Closed</StateLabel>;
  if (isDraft) return <StateLabel status="draft" {...s}>Draft</StateLabel>;
  return <StateLabel status="pullOpened" {...s}>Open</StateLabel>;
}

export function Avatar({ actor, size = 20, className }: { actor?: Actor | null; size?: number; className?: string }) {
  if (!actor?.avatarUrl) {
    return <span className={className} style={{ width: size, height: size, display: 'inline-block', borderRadius: '50%', background: 'var(--bgColor-neutral-muted)', flex: `0 0 ${size}px` }} />;
  }
  return (
    <img
      className={className}
      src={actor.avatarUrl}
      alt={actor.login}
      title={actor.login}
      width={size}
      height={size}
      style={{ borderRadius: '50%', background: 'var(--bgColor-muted)', flex: `0 0 ${size}px`, verticalAlign: 'middle' }}
      onError={(e) => ((e.target as HTMLImageElement).style.visibility = 'hidden')}
    />
  );
}

function rgb(hex: string): [number, number, number] {
  const h = (hex || '888888').replace('#', '').padEnd(6, '8');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** GitHub-style label colors: solid in light mode, tinted with readable text in dark mode. */
function labelStyle(hex: string): CSSProperties {
  const [r, g, b] = rgb(hex);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  // Lighten the label color for text on dark backgrounds.
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    const rr = r / 255;
    const gg = g / 255;
    const bb = b / 255;
    h = max === rr ? (gg - bb) / d + (gg < bb ? 6 : 0) : max === gg ? (bb - rr) / d + 2 : (rr - gg) / d + 4;
    h *= 60;
  }
  const darkL = Math.min(0.88, Math.max(0.68, l + 0.25));
  return {
    ['--lr' as any]: r,
    ['--lg' as any]: g,
    ['--lb' as any]: b,
    ['--l-fg' as any]: lum > 0.6 ? '#1f2328' : '#ffffff',
    ['--l-fg-dark' as any]: `hsl(${Math.round(h)} ${Math.round(Math.min(1, s + 0.1) * 100)}% ${Math.round(darkL * 100)}%)`,
  };
}

export function Labels({ labels }: { labels?: Label[] }) {
  if (!labels?.length) return null;
  return (
    <>
      {labels.map((l) => (
        <span key={l.name} className="gh-label" style={labelStyle(l.color)} title={l.description ?? undefined}>
          {l.name}
        </span>
      ))}
    </>
  );
}

const GH_PR = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(\/files|\/commits|\/changes)?\/?(#.*)?$/;
const JIRA = /^https:\/\/[a-z0-9-]+\.atlassian\.net\/browse\/([A-Z][A-Z0-9_]+-\d+)/;

/**
 * GitHub-rendered HTML. Links to other PRs and Jira tickets open the local cached
 * copy (which also works offline); everything else opens normally.
 */
export function Html({ html, className = '', empty = 'No description provided.' }: { html: string; className?: string; empty?: string }) {
  const navigate = useNavigate();
  const clean = useMemo(() => sanitize(html), [html]);
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest('a');
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const href = a.getAttribute('href') ?? '';
    const pr = href.match(GH_PR);
    if (pr) {
      e.preventDefault();
      navigate(`/${pr[1]}/${pr[2]}/pull/${pr[3]}${pr[4] === '/files' || pr[4] === '/changes' ? '/files' : ''}`);
      return;
    }
    const jira = href.match(JIRA);
    if (jira) {
      e.preventDefault();
      navigate(`/jira/${jira[1]}`);
    }
  };
  if (!clean.trim()) {
    return (
      <div className={`markdown-body ${className}`}>
        <p className="muted">
          <em>{empty}</em>
        </p>
      </div>
    );
  }
  return <div className={`markdown-body ${className}`} onClick={onClick} dangerouslySetInnerHTML={{ __html: clean }} />;
}

export function DiffStat({ additions, deletions, blocks = true }: { additions?: number; deletions?: number; blocks?: boolean }) {
  const a = additions ?? 0;
  const d = deletions ?? 0;
  const total = a + d;
  const n = 5;
  const aBlocks = total ? Math.round((a / total) * n) : 0;
  const dBlocks = total ? Math.min(n - aBlocks, Math.round((d / total) * n)) : 0;
  return (
    <span className="gh-diffstat">
      <span className="stat-add">+{a.toLocaleString()}</span>
      <span className="stat-del">−{d.toLocaleString()}</span>
      {blocks && (
        <span className="blocks" aria-hidden>
          {Array.from({ length: n }, (_, i) => (
            <i key={i} className={i < aBlocks ? 'a' : i < aBlocks + dBlocks ? 'd' : ''} />
          ))}
        </span>
      )}
    </span>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <div className="gh-flash danger" style={{ margin: '8px 0' }}>
      {(error as Error).message ?? String(error)}
    </div>
  );
}

/** "commented 2 weeks ago" style relative time with the exact time on hover. */
export function Time({ iso }: { iso?: string | null }) {
  if (!iso) return null;
  return (
    <span className="gh-time" title={new Date(iso).toLocaleString()}>
      {relative(iso)}
    </span>
  );
}

export function relative(iso?: string | null): string {
  if (!iso) return '';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 45) return 'now';
  if (s < 90) return '1 minute ago';
  if (s < 3600) return `${Math.round(s / 60)} minutes ago`;
  if (s < 5400) return '1 hour ago';
  if (s < 86400) return `${Math.round(s / 3600)} hours ago`;
  if (s < 172800) return 'yesterday';
  if (s < 604800) return `${Math.round(s / 86400)} days ago`;
  if (s < 1209600) return 'last week';
  if (s < 2592000) return `${Math.round(s / 604800)} weeks ago`;
  if (s < 5184000) return 'last month';
  const d = new Date(iso);
  return `on ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) })}`;
}

export const ROLE: Record<string, string> = { OWNER: 'Owner', MEMBER: 'Member', COLLABORATOR: 'Collaborator', CONTRIBUTOR: 'Contributor', FIRST_TIME_CONTRIBUTOR: 'First-time contributor' };
