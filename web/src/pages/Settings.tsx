import { CheckCircleIcon } from '@primer/octicons-react';
import { Button, Checkbox, FormControl, Select, Spinner, TextInput } from '@primer/react';
import type { Settings } from '@shared/types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ErrorNote } from '../components/common';
import { api, fetchers } from '../lib/api';

export function SettingsPage() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ['settings'], queryFn: fetchers.settings });
  const [s, setS] = useState<Settings | null>(null);
  useEffect(() => {
    if (data && !s) setS(data.settings);
  }, [data, s]);
  const save = useMutation({
    mutationFn: (next: Settings) => api('PUT', '/api/settings', next),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] }),
  });

  if (isLoading || !s || !data) {
    return (
      <div className="container">
        {isLoading ? <Spinner /> : <ErrorNote error={error} />}
      </div>
    );
  }
  const set = (patch: Partial<Settings>) => setS({ ...s, ...patch });

  return (
    <div className="container" style={{ maxWidth: 820 }}>
      <h2 style={{ fontWeight: 400 }}>Settings</h2>
      <p className="muted small">Data folder: {data.home}</p>

      <div className="box" style={{ marginBottom: 16 }}>
        <div className="box-header">What to keep offline</div>
        <div style={{ padding: 16 }} className="col">
          <FormControl>
            <Checkbox checked={s.queue.reviewRequested} onChange={(e) => set({ queue: { ...s.queue, reviewRequested: e.target.checked } })} />
            <FormControl.Label>PRs where my review is requested</FormControl.Label>
          </FormControl>
          <FormControl>
            <Checkbox checked={s.queue.authored} onChange={(e) => set({ queue: { ...s.queue, authored: e.target.checked } })} />
            <FormControl.Label>My own open PRs</FormControl.Label>
          </FormControl>
          <FormControl>
            <FormControl.Label>…updated in the last N days (0 = all of them)</FormControl.Label>
            <TextInput
              type="number"
              value={String(s.queue.authoredMaxAgeDays)}
              onChange={(e) => set({ queue: { ...s.queue, authoredMaxAgeDays: Number(e.target.value) } })}
            />
            <FormControl.Caption>Your own PRs get a worktree only when you ask for one (button on the PR page).</FormControl.Caption>
          </FormControl>
          <FormControl>
            <Checkbox checked={s.linkedPrs} onChange={(e) => set({ linkedPrs: e.target.checked })} />
            <FormControl.Label>PRs linked from a PR's description (e.g. the matching backend PR)</FormControl.Label>
          </FormControl>
          <FormControl>
            <Checkbox checked={s.media.videos} onChange={(e) => set({ media: { ...s.media, videos: e.target.checked } })} />
            <FormControl.Label>Download screen recordings</FormControl.Label>
          </FormControl>
          <div className="row">
            <FormControl>
              <FormControl.Label>Max video size (MB)</FormControl.Label>
              <TextInput type="number" value={String(s.media.maxVideoMB)} onChange={(e) => set({ media: { ...s.media, maxVideoMB: Number(e.target.value) } })} />
            </FormControl>
            <FormControl>
              <FormControl.Label>Auto-sync every (minutes, 0 = off)</FormControl.Label>
              <TextInput type="number" value={String(s.autoSyncMinutes)} onChange={(e) => set({ autoSyncMinutes: Number(e.target.value) })} />
            </FormControl>
          </div>
        </div>
      </div>

      <div className="box" style={{ marginBottom: 16 }}>
        <div className="box-header">Code & editor</div>
        <div style={{ padding: 16 }} className="col">
          <FormControl>
            <FormControl.Label>Folders with your clones (comma separated)</FormControl.Label>
            <TextInput block value={s.codeRoots.join(', ')} onChange={(e) => set({ codeRoots: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} />
            <FormControl.Caption>PR worktrees are created next to the matching clone, e.g. ~/code/my-app-review-123.</FormControl.Caption>
          </FormControl>
          <FormControl>
            <FormControl.Label>Put worktrees in a different folder instead (optional)</FormControl.Label>
            <TextInput block value={s.worktreeDir ?? ''} placeholder="next to the clone" onChange={(e) => set({ worktreeDir: e.target.value || null })} />
          </FormControl>
          <FormControl>
            <FormControl.Label>Editor</FormControl.Label>
            <Select value={s.editor} onChange={(e) => set({ editor: e.target.value as Settings['editor'] })}>
              <Select.Option value="cursor">Cursor{data.editors.includes('cursor') ? '' : ' (not found)'}</Select.Option>
              <Select.Option value="code">VS Code{data.editors.includes('code') ? '' : ' (not found)'}</Select.Option>
            </Select>
          </FormControl>
          <FormControl>
            <FormControl.Label>Custom "prepare to run" commands (JSON: {'{"owner/repo": {"prepare": "make setup"}}'})</FormControl.Label>
            <RepoJson value={s.repos} onChange={(repos) => set({ repos })} />
          </FormControl>
        </div>
      </div>

      <div className="row" style={{ marginBottom: 24 }}>
        <Button variant="primary" onClick={() => save.mutate(s)} disabled={save.isPending}>
          Save settings
        </Button>
        {save.isSuccess && (
          <span className="row small" style={{ color: 'var(--fgColor-success)' }}>
            <CheckCircleIcon /> Saved
          </span>
        )}
        <ErrorNote error={save.error} />
      </div>

      <JiraBox configured={data.jiraConfigured} learned={data.learnedJira?.baseUrl ?? null} settings={s} />
    </div>
  );
}

function RepoJson({ value, onChange }: { value: Settings['repos']; onChange: (v: Settings['repos']) => void }) {
  const [text, setText] = useState(JSON.stringify(value, null, 2));
  const [bad, setBad] = useState(false);
  return (
    <>
      <textarea
        className="mono"
        rows={4}
        value={text}
        style={{ width: '100%', padding: 8, border: '1px solid var(--borderColor-default)', borderRadius: 6, background: 'var(--bgColor-default)', color: 'inherit' }}
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

function JiraBox({ configured, learned, settings }: { configured: boolean; learned: string | null; settings: Settings }) {
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
    <div className="box">
      <div className="box-header">
        Jira {configured && <span className="chip success">connected</span>}
      </div>
      <div style={{ padding: 16 }} className="col">
        <span className="muted small">
          Jira tickets mentioned in a PR (title, branch, description, commits) are cached with their description and comments. Create an API token at{' '}
          <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noreferrer">
            id.atlassian.com
          </a>
          . It is stored in your macOS Keychain, not in a file.
        </span>
        <FormControl>
          <FormControl.Label>Jira site</FormControl.Label>
          <TextInput block value={baseUrl} placeholder="https://yourcompany.atlassian.net" onChange={(e) => setBaseUrl(e.target.value)} />
        </FormControl>
        <FormControl>
          <FormControl.Label>Atlassian account email</FormControl.Label>
          <TextInput block value={email} onChange={(e) => setEmail(e.target.value)} />
        </FormControl>
        <FormControl>
          <FormControl.Label>API token</FormControl.Label>
          <TextInput block type="password" value={token} placeholder={configured ? '•••••••• (saved)' : ''} onChange={(e) => setToken(e.target.value)} />
        </FormControl>
        <div className="row">
          <Button onClick={() => login.mutate()} disabled={!baseUrl || !email || !token || login.isPending}>
            {configured ? 'Update Jira connection' : 'Connect Jira'}
          </Button>
          {login.data && <span className="small" style={{ color: 'var(--fgColor-success)' }}>Connected as {login.data.name}. Tickets download on the next sync.</span>}
          <ErrorNote error={login.error} />
        </div>
      </div>
    </div>
  );
}
