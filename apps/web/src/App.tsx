import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useSession } from './auth/SessionContext';
import { AppShell } from './components/AppShell';
import { Loading } from './components/ui';
import { LoginView } from './views/LoginView';
import { RecorderView } from './views/RecorderView';
import { SourcesView } from './views/SourcesView';
import { ConnectionView } from './views/ConnectionView';
import { QuestionsView } from './views/QuestionsView';
import { JournalView } from './views/JournalView';
import { EntityView } from './views/EntityView';
import { AgentsView } from './views/AgentsView';
import { SystemView } from './views/SystemView';
import { SettingsView } from './views/SettingsView';

function RequireOwner({ children }: { children: JSX.Element }) {
  const { status } = useSession();
  const location = useLocation();
  if (status === 'loading') return <Loading />;
  if (status === 'anonymous') return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return children;
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/app" replace />} />
      <Route path="/login" element={<LoginView />} />
      <Route
        path="/app"
        element={
          <RequireOwner>
            <AppShell />
          </RequireOwner>
        }
      >
        <Route index element={<RecorderView />} />
        <Route path="sources" element={<SourcesView />} />
        <Route path="sources/:connectionId" element={<ConnectionView />} />
        <Route path="questions" element={<QuestionsView />} />
        <Route path="journal" element={<JournalView />} />
        <Route path="journal/:entryId" element={<JournalView />} />
        <Route path="entities/:type/:id" element={<EntityView />} />
        <Route path="agents" element={<AgentsView />} />
        <Route path="system" element={<SystemView />} />
        <Route path="settings" element={<SettingsView />} />
      </Route>
      <Route path="*" element={<Navigate to="/app" replace />} />
    </Routes>
  );
}
