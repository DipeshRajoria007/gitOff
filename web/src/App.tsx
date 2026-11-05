import { Route, Routes } from 'react-router';
import { AppHeader } from './components/AppHeader';
import { useServerEvents } from './lib/events';
import { Dashboard } from './pages/Dashboard';
import { JiraPage } from './pages/Jira';
import { OutboxPage } from './pages/Outbox';
import { PullRequestPage } from './pages/PullRequest';
import { SettingsPage } from './pages/Settings';

export function App() {
  useServerEvents();
  return (
    <>
      <AppHeader />
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/outbox" element={<OutboxPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/jira/:key" element={<JiraPage />} />
        <Route path="/:owner/:repo/pull/:number/*" element={<PullRequestPage />} />
        <Route path="*" element={<div className="container muted">Page not found.</div>} />
      </Routes>
    </>
  );
}
