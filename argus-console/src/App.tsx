import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { LoadingState } from './components/Ui';

const HomePage = lazy(() => import('./pages/HomePage').then(module => ({ default: module.HomePage })));
const AgentsPage = lazy(() => import('./pages/AgentsPage').then(module => ({ default: module.AgentsPage })));
const AgentStudioPage = lazy(() => import('./pages/AgentStudioPage').then(module => ({ default: module.AgentStudioPage })));
const KnowledgePage = lazy(() => import('./pages/KnowledgePage').then(module => ({ default: module.KnowledgePage })));
const EvaluationPage = lazy(() => import('./pages/EvaluationPage').then(module => ({ default: module.EvaluationPage })));
const QualityInboxPage = lazy(() => import('./pages/QualityInboxPage').then(module => ({ default: module.QualityInboxPage })));
const SkillsPage = lazy(() => import('./pages/SkillsPage').then(module => ({ default: module.SkillsPage })));
const PublicWidgetsPage = lazy(() => import('./pages/PublicWidgetsPage').then(module => ({ default: module.PublicWidgetsPage })));
const WorkflowsPage = lazy(() => import('./pages/WorkflowsPage').then(module => ({ default: module.WorkflowsPage })));
const WorkflowStudioPage = lazy(() => import('./pages/WorkflowStudioPage').then(module => ({ default: module.WorkflowStudioPage })));
const RunsPage = lazy(() => import('./pages/RunsPage').then(module => ({ default: module.RunsPage })));
const RunDetailPage = lazy(() => import('./pages/RunDetailPage').then(module => ({ default: module.RunDetailPage })));
const McpFabricPage = lazy(() => import('./pages/McpFabricPage').then(module => ({ default: module.McpFabricPage })));
const CapabilitiesPage = lazy(() => import('./pages/CapabilitiesPage').then(module => ({ default: module.CapabilitiesPage })));
const BundleDetailPage = lazy(() => import('./pages/BundleDetailPage').then(module => ({ default: module.BundleDetailPage })));
const GovernancePage = lazy(() => import('./pages/GovernancePage').then(module => ({ default: module.GovernancePage })));
const PoliciesPage = lazy(() => import('./pages/PoliciesPage').then(module => ({ default: module.PoliciesPage })));
const RuntimeControlsPage = lazy(() => import('./pages/RuntimeControlsPage').then(module => ({ default: module.RuntimeControlsPage })));
const CompliancePage = lazy(() => import('./pages/CompliancePage').then(module => ({ default: module.CompliancePage })));
const ObservePage = lazy(() => import('./pages/ObservePage').then(module => ({ default: module.ObservePage })));
const LiveActivityPage = lazy(() => import('./pages/LiveActivityPage').then(module => ({ default: module.LiveActivityPage })));
const AuditTrailPage = lazy(() => import('./pages/AuditTrailPage').then(module => ({ default: module.AuditTrailPage })));
const LogsPage = lazy(() => import('./pages/LogsPage').then(module => ({ default: module.LogsPage })));
const ServiceHealthPage = lazy(() => import('./pages/ServiceHealthPage').then(module => ({ default: module.ServiceHealthPage })));
const SlosPage = lazy(() => import('./pages/SlosPage').then(module => ({ default: module.SlosPage })));
const DependencyMapPage = lazy(() => import('./pages/DependencyMapPage').then(module => ({ default: module.DependencyMapPage })));
const AlertsPage = lazy(() => import('./pages/AlertsPage').then(module => ({ default: module.AlertsPage })));
const SettingsPage = lazy(() => import('./pages/SettingsPage').then(module => ({ default: module.SettingsPage })));
const IdentitySecurityPage = lazy(() => import('./pages/IdentitySecurityPage').then(module => ({ default: module.IdentitySecurityPage })));
const ConnectionsPage = lazy(() => import('./pages/ConnectionsPage').then(module => ({ default: module.ConnectionsPage })));
const ApiKeysPage = lazy(() => import('./pages/ApiKeysPage').then(module => ({ default: module.ApiKeysPage })));
const UsersPage = lazy(() => import('./pages/UsersPage').then(module => ({ default: module.UsersPage })));
const PlatformConfigPage = lazy(() => import('./pages/PlatformConfigPage').then(module => ({ default: module.PlatformConfigPage })));
const PlatformReadinessPage = lazy(() => import('./pages/PlatformReadinessPage').then(module => ({ default: module.PlatformReadinessPage })));
const ModelsPage = lazy(() => import('./pages/ModelsPage').then(module => ({ default: module.ModelsPage })));
const SolutionPackPage = lazy(() => import('./pages/SolutionPackPage').then(module => ({ default: module.SolutionPackPage })));

export default function App() {
  return (
    <AppShell>
      <Suspense fallback={<LoadingState label="Loading Argus workspace…" />}>
        <Routes>
          <Route path="/home" element={<HomePage />} />
          <Route path="/build/agents" element={<AgentsPage />} />
          <Route path="/build/agents/manage" element={<AgentStudioPage />} />
          <Route path="/build/knowledge" element={<KnowledgePage />} />
          <Route path="/build/evaluations" element={<EvaluationPage />} />
          <Route path="/build/skills" element={<SkillsPage />} />
          <Route path="/build/agents/channels" element={<PublicWidgetsPage />} />
          <Route path="/build/public-widgets" element={<PublicWidgetsPage />} />
          <Route path="/settings/public-channels" element={<PublicWidgetsPage />} />
          <Route path="/build/workflows" element={<WorkflowsPage />} />
          <Route path="/build/workflows/studio" element={<WorkflowStudioPage />} />
          <Route path="/build/workflows/studio/:workflowId" element={<WorkflowStudioPage />} />
          <Route path="/runs" element={<RunsPage />} />
          <Route path="/runs/:kind/:runId" element={<RunDetailPage />} />
          <Route path="/mcp-fabric" element={<McpFabricPage />} />
          <Route path="/mcp-fabric/capabilities" element={<CapabilitiesPage />} />
          <Route path="/mcp-fabric/bundles/:bundleId" element={<BundleDetailPage />} />
          <Route path="/governance" element={<GovernancePage />} />
          <Route path="/governance/policies" element={<PoliciesPage />} />
          <Route path="/governance/runtime-controls" element={<RuntimeControlsPage />} />
          <Route path="/settings/models/runtime-controls" element={<RuntimeControlsPage />} />
          <Route path="/governance/compliance" element={<CompliancePage />} />
          <Route path="/governance/compliance/runs/:runId" element={<CompliancePage />} />
          <Route path="/solutions/compliance" element={<CompliancePage />} />
          <Route path="/solutions/compliance/runs/:runId" element={<CompliancePage />} />
          <Route path="/observe" element={<ObservePage />} />
          <Route path="/observe/activity" element={<LiveActivityPage />} />
          <Route path="/observe/audit" element={<AuditTrailPage />} />
          <Route path="/observe/logs" element={<LogsPage />} />
          <Route path="/observe/quality" element={<QualityInboxPage />} />
          <Route path="/observe/health" element={<ServiceHealthPage />} />
          <Route path="/observe/slos" element={<SlosPage />} />
          <Route path="/observe/dependencies" element={<DependencyMapPage />} />
          <Route path="/observe/alerts" element={<AlertsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/settings/identity" element={<IdentitySecurityPage />} />
          <Route path="/connections" element={<ConnectionsPage />} />
          <Route path="/settings/api-keys" element={<ApiKeysPage />} />
          <Route path="/settings/users" element={<UsersPage />} />
          <Route path="/settings/platform" element={<PlatformConfigPage />} />
          <Route path="/settings/readiness" element={<PlatformReadinessPage />} />
          <Route path="/settings/models" element={<ModelsPage />} />
          <Route path="/solutions/:packId" element={<SolutionPackPage />} />
          <Route path="*" element={<Navigate to="/home" replace />} />
        </Routes>
      </Suspense>
    </AppShell>
  );
}
