import { CheckCircleIcon, CodeIcon, DatabaseIcon, DownloadIcon, IssueOpenedIcon } from '@primer/octicons-react';
import { Button, Checkbox, FormControl, NavList, Select, Spinner, TextInput } from '@primer/react';
import type { Settings } from '@shared/types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type MouseEvent } from 'react';
import { ErrorNote } from '../components/common';
import { api, fetchers } from '../lib/api';

const SECTIONS = [
  { id: 'offline', label: 'Offline cache', icon: DownloadIcon },
  { id: 'code', label: 'Code & editor', icon: CodeIcon },
  { id: 'jira', label: 'Jira', icon: IssueOpenedIcon },
  { id: 'storage', label: 'Storage', icon: DatabaseIcon },
];

export function SettingsPage() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ['settings'], queryFn: fetchers.settings });
  const { data: status } = useQuery({ queryKey: ['status'], queryFn: fetchers.status });
  const [s, setS] = useState<Settings | null>(null);
  const [section, setSection] = useState('offline');
  useEffect(() => {
    if (data && !s) setS(data.settings);
  }, [data, s]);
  const save = useMutation({
    mutationFn: (next: Settings) => api('PUT', '/api/settings', next),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] }),
  });

  if (isLoading || !s || !data) {
    return <div className="gh-page narrow">{isLoading ? <Spinner /> : <ErrorNote error={error} />}</div>;
  }
  const set = (patch: Partial<Settings>) => {
    save.reset();
    setS({ ...s, ...patch });
  };
  const saveRow = (
    <div className="row" style={{ marginTop: 24 }}>
      <Button variant="primary" onClick={() => save.mutate(s)} disabled={save.isPending}>
        Save settings
      </Button>
      {save.isSuccess && (
        <span className="row small" style={{ color: 'var(--fgColor-success)', gap: 4 }}>
          <CheckCircleIcon /> Saved
        </span>
      )}
      <ErrorNote error={save.error} />
    </div>
  );
  const viewer = status?.viewer;

  return (
    <div className="gh-page narrow gh-settings">
      <aside className="gh-settings-nav">
        {viewer && (
          <div className="gh-settings-who">
            {viewer.avatarUrl ? <img src={viewer.avatarUrl} alt="" width={32} height={32} /> : null}
            <div>
              <div className="name">{viewer.login}</div>
              <div className="muted small">gitOff settings</div>
            </div>
          </div>
        )}
        <NavList aria-label="Settings">
          {SECTIONS.map((x) => (
            <NavList.Item
              key={x.id}
              href={`#${x.id}`}
              aria-current={section === x.id ? 'page' : undefined}
              onClick={(e: MouseEvent) => {
                e.preventDefault();
                setSection(x.id);
                document.getElementById(x.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }}
            >
              <NavList.LeadingVisual>
                <x.icon />
              </NavList.LeadingVisual>
              {x.label}
            </NavList.Item>
          ))}
        </NavList>
      </aside>

      <div className="gh-settings-main">
        <section id="offline">
          <div className="gh-subhead">
            <h2 className="gh-subhead-heading">Offline cache</h2>
          </div>
          <p className="muted gh-subhead-note">What gets downloaded when you sync, so it's there when the connection isn't.</p>
          <div className="col gh-form">
            <FormControl>
              <Checkbox checked={s.queue.reviewRequested} onChange={(e) => set({ queue: { ...s.queue, reviewRequested: e.target.checked } })} />
              <FormControl.Label>Pull requests where my review is requested</FormControl.Label>
              <FormControl.Caption>Each one also gets a worktree you can open in your editor.</FormControl.Caption>
            </FormControl>
            <FormControl>
              <Checkbox checked={s.queue.authored} onChange={(e) => set({ queue: { ...s.queue, authored: e.target.checked } })} />
              <FormControl.Label>My own open pull requests</FormControl.Label>
              <FormControl.Caption>No worktree unless you ask for one on the PR page.</FormControl.Caption>
            </FormControl>
            <FormControl disabled={!s.queue.authored}>
              <FormControl.Label>Only my PRs updated in the last N days</FormControl.Label>
              <TextInput
                type="number"
                min={0}
                value={String(s.queue.authoredMaxAgeDays)}
                onChange={(e) => set({ queue: { ...s.queue, authoredMaxAgeDays: Number(e.target.value) } })}
              />
              <FormControl.Caption>0 keeps all of them.</FormControl.Caption>
            </FormControl>
            <FormControl>
              <Checkbox checked={s.linkedPrs} onChange={(e) => set({ linkedPrs: e.target.checked })} />
              <FormControl.Label>Open pull requests linked from a PR's description</FormControl.Label>
              <FormControl.Caption>For example the matching backend PR. Only full links and owner/repo#123 references count.</FormControl.Caption>
            </FormControl>
            <FormControl>
              <Checkbox checked={s.media.videos} onChange={(e) => set({ media: { ...s.media, videos: e.target.checked } })} />
              <FormControl.Label>Download screen recordings</FormControl.Label>
              <FormControl.Caption>Images are always downloaded.</FormControl.Caption>
            </FormControl>
            <div className="row wrap" style={{ gap: 16, alignItems: 'flex-start' }}>
              <FormControl disabled={!s.media.videos}>
                <FormControl.Label>Largest video to keep (MB)</FormControl.Label>
                <TextInput type="number" min={1} value={String(s.media.maxVideoMB)} onChange={(e) => set({ media: { ...s.media, maxVideoMB: Number(e.target.value) } })} />
              </FormControl>
              <FormControl>
                <FormControl.Label>Sync every N minutes while online</FormControl.Label>
                <TextInput type="number" min={0} value={String(s.autoSyncMinutes)} onChange={(e) => set({ autoSyncMinutes: Number(e.target.value) })} />
                <FormControl.Caption>0 turns automatic sync off.</FormControl.Caption>
              </FormControl>
            </div>
          </div>
          {saveRow}
        </section>

        <section id="code">
          <div className="gh-subhead spacious">
            <h2 className="gh-subhead-heading">Code & editor</h2>
          </div>
          <div className="col gh-form">
            <FormControl>
              <FormControl.Label>Folders with your clones</FormControl.Label>
              <TextInput block value={s.codeRoots.join(', ')} onChange={(e) => set({ codeRoots: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} />
              <FormControl.Caption>Comma separated. A PR's worktree is created next to the matching clone, e.g. ~/code/my-app-review-123.</FormControl.Caption>
            </FormControl>
            <FormControl>
              <FormControl.Label>Worktree folder (optional)</FormControl.Label>
              <TextInput block value={s.worktreeDir ?? ''} placeholder="Next to the clone" onChange={(e) => set({ worktreeDir: e.target.value || null })} />
            </FormControl>
            <FormControl>
              <FormControl.Label>Editor</FormControl.Label>
              <Select value={s.editor} onChange={(e) => set({ editor: e.target.value as Settings['editor'] })}>
                <Select.Option value="cursor">Cursor{data.editors.includes('cursor') ? '' : ' (not found)'}</Select.Option>
                <Select.Option value="code">VS Code{data.editors.includes('code') ? '' : ' (not found)'}</Select.Option>
              </Select>
            </FormControl>
            <FormControl>
              <FormControl.Label>Custom "Prepare to run" commands</FormControl.Label>
              <RepoJson value={s.repos} onChange={(repos) => set({ repos })} />
              <FormControl.Caption>
                JSON, keyed by repository: <code>{'{"owner/repo": {"prepare": "make setup"}}'}</code>. Without one, gitOff copies your .env files and installs dependencies with the
                repo's package manager.
              </FormControl.Caption>
            </FormControl>
          </div>
          {saveRow}
        </section>

        <section id="jira">
          <div className="gh-subhead spacious">
            <h2 className="gh-subhead-heading">Jira</h2>
            {data.jiraConfigured && (
              <span className="ob-state success">
                <CheckCircleIcon size={12} /> Connected
              </span>
            )}
          </div>
          <JiraForm configured={data.jiraConfigured} learned={data.learnedJira?.baseUrl ?? null} settings={s} />
        </section>

        <section id="storage">
          <div className="gh-subhead spacious">
            <h2 className="gh-subhead-heading">Storage</h2>
          </div>
          <p>
            Everything gitOff downloads lives in <code>{data.home}</code>: pull request snapshots, images and videos, the outbox, and these settings. Delete that folder to start
            over. gitOff only talks to GitHub, to the hosts of images and videos in the pull requests you cache, and to your Jira site if you connect one. There is no
            telemetry.
          </p>
        </section>
      </div>
    </div>
  );
}

function RepoJson({ value, onChange }: { value: Settings['repos']; onChange: (v: Settings['repos']) => void }) {
  const [text, setText] = useState(JSON.stringify(value, null, 2));
  const [bad, setBad] = useState(false);
  return (
    <>
      <textarea
        className="mono gh-textarea"
        rows={4}
        spellCheck={false}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          try {
            onChange(JSON.parse(e.target.value || '{}'));
            setBad(false);
          } catch {
            setBad(true);
          }
        }}
      />
      {bad && <FormControl.Validation variant="error">Not valid JSON yet</FormControl.Validation>}
    </>
  );
}

function JiraForm({ configured, learned, settings }: { configured: boolean; learned: string | null; settings: Settings }) {
  const qc = useQueryClient();
  const [baseUrl, setBaseUrl] = useState(settings.jira.baseUrl || learned || '');
  const [email, setEmail] = useState(settings.jira.email ?? '');
  const [token, setToken] = useState('');
  const login = useMutation({
    mutationFn: () => api<{ name: string }>('POST', '/api/jira/login', { baseUrl, email, token }),
    onSuccess: () => {
      setToken('');
      qc.invalidateQueries({ queryKey: ['settings'] });
      qc.invalidateQueries({ queryKey: ['status'] });
    },
  });
  return (
    <>
      <p className="muted gh-subhead-note">
        Jira tickets mentioned in a pull request (title, branch, description or commits) are cached with their description and comments. Create an API token at{' '}
        <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noreferrer">
          id.atlassian.com
        </a>
        . On macOS it's stored in your Keychain, not in a file. On Linux, set the <code>JIRA_API_TOKEN</code> environment variable before starting gitOff instead.
      </p>
      <div className="col gh-form">
        <FormControl>
          <FormControl.Label>Jira site</FormControl.Label>
          <TextInput block value={baseUrl} placeholder="https://yourcompany.atlassian.net" onChange={(e) => setBaseUrl(e.target.value)} />
        </FormControl>
        <FormControl>
          <FormControl.Label>Atlassian account email</FormControl.Label>
          <TextInput block type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </FormControl>
        <FormControl>
          <FormControl.Label>API token</FormControl.Label>
          <TextInput block type="password" autoComplete="off" value={token} placeholder={configured ? '•••••••• (saved)' : ''} onChange={(e) => setToken(e.target.value)} />
        </FormControl>
      </div>
      <div className="row wrap" style={{ marginTop: 24 }}>
        <Button onClick={() => login.mutate()} disabled={!baseUrl || !email || !token || login.isPending}>
          {configured ? 'Update Jira connection' : 'Connect Jira'}
        </Button>
        {login.data && <span className="small" style={{ color: 'var(--fgColor-success)' }}>Connected as {login.data.name}. Tickets download on the next sync.</span>}
      </div>
      <ErrorNote error={login.error} />
    </>
  );
}
