import {
  CloudOfflineIcon,
  CodeIcon,
  GearIcon,
  GitPullRequestIcon,
  GraphIcon,
  InboxIcon,
  IssueOpenedIcon,
  LockIcon,
  PlayIcon,
  ShieldIcon,
  SyncIcon,
  TableIcon,
  ThreeBarsIcon,
} from '@primer/octicons-react';
import { ActionList, ActionMenu, Spinner } from '@primer/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useLocation, useNavigate } from 'react-router';
import { api, fetchers } from '../lib/api';
import { setTheme, useTheme, type ThemeMode } from '../lib/theme';
import { timeAgo } from '../lib/util';

function useRepoFromPath(): { owner: string; repo: string } | null {
  const { pathname } = useLocation();
  const m = pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/\d+/);
  return m ? { owner: decodeURIComponent(m[1]), repo: decodeURIComponent(m[2]) } : null;
}

export function AppHeader() {
  const navigate = useNavigate();
  const repo = useRepoFromPath();
  const theme = useTheme();
  const { data: status } = useQuery({ queryKey: ['status'], queryFn: fetchers.status, refetchInterval: 30_000 });
  const { data: prs } = useQuery({ queryKey: ['prs'], queryFn: fetchers.prs, enabled: !!repo });
  const sync = useMutation({ mutationFn: (full: boolean) => api('POST', '/api/sync', { full }) });

  const online = !!status?.online;
  const s = status?.sync;
  const outboxCount = (status?.outbox.queued ?? 0) + (status?.outbox.held ?? 0) + (status?.outbox.failed ?? 0) + (status?.outbox.sending ?? 0);
  const needsAttention = (status?.outbox.held ?? 0) + (status?.outbox.failed ?? 0) > 0;

  let syncText = '';
  if (s?.running) syncText = `${s.phase ?? 'Syncing'}${s.total ? ` ${s.done ?? 0}/${s.total}` : ''}`;
  else if (sync.error) syncText = (sync.error as Error).message;
  else if (s?.lastError) syncText = s.lastError;
  else if (s?.lastRunAt) syncText = `Synced ${timeAgo(s.lastRunAt)}`;

  const repoPrs = repo ? (prs ?? []).filter((p) => p.owner.toLowerCase() === repo.owner.toLowerCase() && p.repo.toLowerCase() === repo.repo.toLowerCase()).length : 0;
  const gh = repo ? `https://github.com/${repo.owner}/${repo.repo}` : '';
  const repoFilter = repo ? `/?repo=${encodeURIComponent(`${repo.owner}/${repo.repo}`)}` : '/';
  const themeItem = (m: ThemeMode, label: string) => (
    <ActionList.Item key={m} selected={theme === m} onSelect={() => setTheme(m)}>
      {label}
    </ActionList.Item>
  );

  return (
    <header className="gh-header">
      <div className="gh-header-top">
        <ActionMenu>
          <ActionMenu.Anchor>
            <button type="button" className="gh-iconbtn" aria-label="Open menu">
              <ThreeBarsIcon />
            </button>
          </ActionMenu.Anchor>
          <ActionMenu.Overlay width="medium">
            <ActionList>
              <ActionList.Item onSelect={() => navigate('/')}>
                <ActionList.LeadingVisual>
                  <GitPullRequestIcon />
                </ActionList.LeadingVisual>
                Pull requests
              </ActionList.Item>
              <ActionList.Item onSelect={() => navigate('/outbox')}>
                <ActionList.LeadingVisual>
                  <InboxIcon />
                </ActionList.LeadingVisual>
                Outbox
              </ActionList.Item>
              <ActionList.Item onSelect={() => navigate('/settings')}>
                <ActionList.LeadingVisual>
                  <GearIcon />
                </ActionList.LeadingVisual>
                Settings
              </ActionList.Item>
              <ActionList.Divider />
              <ActionList.Group selectionVariant="single">
                <ActionList.GroupHeading>Theme</ActionList.GroupHeading>
                {themeItem('auto', 'Sync with system')}
                {themeItem('light', 'Light')}
                {themeItem('dark', 'Dark')}
              </ActionList.Group>
            </ActionList>
          </ActionMenu.Overlay>
        </ActionMenu>
        <Link to="/" className="gh-mark" title="Offline PRs" aria-label="Offline PRs home">
          <CloudOfflineIcon size={28} />
        </Link>
        <nav className="gh-crumbs" aria-label="Breadcrumb">
          {repo ? (
            <>
              <a href={`https://github.com/${repo.owner}`} target="_blank" rel="noreferrer">
                {repo.owner}
              </a>
              <span className="sep">/</span>
              <Link to={repoFilter} className="row" style={{ gap: 6 }}>
                <LockIcon size={14} />
                <b>{repo.repo}</b>
              </Link>
            </>
          ) : (
            <Link to="/">
              <b>Offline PRs</b>
            </Link>
          )}
        </nav>
        <span className="grow" />
        <span className="gh-sync-text truncate" title={syncText}>
          {s?.running && <Spinner size="small" style={{ verticalAlign: 'middle', marginRight: 6 }} />}
          {syncText}
        </span>
        <span
          className={`gh-net ${online ? 'online' : ''}`}
          title={
            online
              ? 'Connected to GitHub. Queued reviews are sent automatically.'
              : `No connection to GitHub${status?.lastOnlineAt ? ` since ${timeAgo(status.lastOnlineAt)}` : ''}. Everything cached still works; reviews wait in the outbox.`
          }
        >
          <i />
          {online ? 'Online' : 'Offline'}
        </span>
        <button
          type="button"
          className="gh-iconbtn"
          aria-label="Sync now"
          title={online ? 'Sync now: send the outbox, refresh your review queue and changed PRs' : 'Sync needs a connection'}
          disabled={!online || s?.running || sync.isPending}
          onClick={() => sync.mutate(false)}
        >
          <SyncIcon />
        </button>
        <Link to="/outbox" className="gh-iconbtn" aria-label="Outbox" title="Outbox: reviews and comments waiting to be sent">
          <InboxIcon />
          {outboxCount > 0 && <span className={`dot ${needsAttention ? 'attention' : ''}`}>{outboxCount}</span>}
        </Link>
        <Link to="/settings" className="gh-iconbtn" aria-label="Settings" title="Settings">
          <GearIcon />
        </Link>
        {status?.viewer?.avatarUrl ? <img className="gh-avatar-32" src={status.viewer.avatarUrl} alt={status.viewer.login} title={status.viewer.login} /> : null}
      </div>
      {repo && (
        <nav className="gh-repo-nav" aria-label="Repository">
          <a href={gh} target="_blank" rel="noreferrer">
            <CodeIcon /> Code
          </a>
          <a href={`${gh}/issues`} target="_blank" rel="noreferrer">
            <IssueOpenedIcon /> Issues
          </a>
          <Link to={repoFilter} className="selected">
            <GitPullRequestIcon /> Pull requests {repoPrs > 0 && <span className="gh-counter">{repoPrs}</span>}
          </Link>
          <a href={`${gh}/actions`} target="_blank" rel="noreferrer">
            <PlayIcon /> Actions
          </a>
          <a href={`${gh}/projects`} target="_blank" rel="noreferrer">
            <TableIcon /> Projects
          </a>
          <a href={`${gh}/security`} target="_blank" rel="noreferrer">
            <ShieldIcon /> Security
          </a>
          <a href={`${gh}/pulse`} target="_blank" rel="noreferrer">
            <GraphIcon /> Insights
          </a>
        </nav>
      )}
    </header>
  );
}
