import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { Button } from '@/ui/button';
import { Play, Save, Check, AlertCircle, Square, ScrollText, Undo2, Redo2, LayoutGrid, History, Sparkles, Download, GitCommit, Moon, Sun, PanelLeftOpen, Bot } from 'lucide-react';
import { useBuilderStore } from '@/stores/builderStore';
import { useExecutionStore } from '@/stores/executionStore';
import { useSaveFlow, buildSavePayload, useWorkflowAgentPreflight } from '@/api/workflows';
import { autoLayout } from './autoLayout';
import { ValidationBadge } from '@/execution/ValidationBadge';
import { AgentPreflightBadge } from '@/execution/AgentPreflightBadge';
import { useFlow } from '@/api/workflows';
import { downloadFlowAsJson } from './exportImport';
import { ComplianceTagsPreset } from '@/statistics/ComplianceTagsPreset';
import { MaintenanceWindow } from '@/statistics/MaintenanceWindow';
import { OversightToggle } from '@/statistics/OversightToggle';
import { SubscribeButton } from '@/statistics/SubscribeButton';
import { downloadRunbook } from './exportImport';
import { FileText } from 'lucide-react';
import { InlineRename } from './InlineRename';
import { CanvasModeButton, useCanvasMode } from './CanvasMode';
import { Breadcrumb } from './Breadcrumb';
import { NewWorkflowButton } from './NewWorkflowButton';
import { isEmbeddedStudio } from '@/lib/studioBridge';
import { AgentContractEditor } from '@/statistics/AgentContractEditor';
import { requestedWorkflowId, WORKFLOW_RUN_REQUEST_EVENT } from '@/lib/builderEvents';

const RunsDrawer = lazy(() => import('@/execution/RunsDrawer').then((module) => ({ default: module.RunsDrawer })));
const RunModal = lazy(() => import('@/execution/RunModal').then((module) => ({ default: module.RunModal })));
const VersionsDrawer = lazy(() => import('@/versioning/VersionsDrawer').then((module) => ({ default: module.VersionsDrawer })));

interface TopBarProps {
  workflowId: number | null;
  replayMode?: boolean;
  initialRunId?: number | null;
  copilotOpen?: boolean;
  onToggleCopilot?: () => void;
  onToggleLibrary?: () => void;
}

export function TopBar({ workflowId, replayMode = false, initialRunId = null, copilotOpen, onToggleCopilot, onToggleLibrary }: TopBarProps) {
  const [runsOpen, setRunsOpen] = useState(initialRunId != null);
  const [runModalOpen, setRunModalOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [agentContractOpen, setAgentContractOpen] = useState(false);
  const { fullscreen, toggle: toggleFullscreen } = useCanvasMode();
  const dirty = useBuilderStore((s) => s.dirty);
  const markClean = useBuilderStore((s) => s.markClean);
  const nodes = useBuilderStore((s) => s.nodes);
  const edges = useBuilderStore((s) => s.edges);
  const viewport = useBuilderStore((s) => s.viewport);
  const { data: flow } = useFlow(workflowId);
  const save = useSaveFlow();
  const hasAgentNodes = nodes.some((node) => node.type === 'argus.agent');
  const agentPreflight = useWorkflowAgentPreflight(workflowId, hasAgentNodes && !dirty);
  const running = useExecutionStore((s) => s.running);
  const finalStatus = useExecutionStore((s) => s.finalStatus);
  const finalError = useExecutionStore((s) => s.finalError);
  const toggleLog = useExecutionStore((s) => s.toggleLog);
  const logOpen = useExecutionStore((s) => s.logOpen);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [theme, setTheme] = useState<'dark' | 'light'>(() =>
    localStorage.getItem('argus-theme') === 'light' ? 'light' : 'dark'
  );
  const embeddedStudio = isEmbeddedStudio();

  useEffect(() => {
    document.documentElement.classList.toggle('light', theme === 'light');
    localStorage.setItem('argus-theme', theme);
  }, [theme]);

  useEffect(() => {
    if (initialRunId != null) setRunsOpen(true);
  }, [initialRunId]);

  const onSave = useCallback(async (): Promise<boolean> => {
    if (!workflowId || replayMode) return false;
    const payload = buildSavePayload(nodes, edges, viewport, flow?.agent_requirements ?? []);
    try {
      await save.mutateAsync({ id: workflowId, payload });
      markClean();
      setSavedAt(new Date().toLocaleTimeString());
      return true;
    } catch {
      /* error surfaced via save.error */
      return false;
    }
  }, [edges, flow?.agent_requirements, markClean, nodes, replayMode, save, viewport, workflowId]);

  const onRun = useCallback(async (): Promise<void> => {
    if (!workflowId || replayMode) return;
    // Auto-save first if dirty
    if (dirty && !await onSave()) return;
    // The Run modal owns the combined Agent + MCP Fabric start preflight. It
    // must remain reachable when blocked so every finding stays actionable.
    setRunModalOpen(true);
  }, [dirty, onSave, replayMode, workflowId]);

  useEffect(() => {
    const handleRunRequest = (event: Event) => {
      if (requestedWorkflowId(event) === workflowId) void onRun();
    };
    window.addEventListener(WORKFLOW_RUN_REQUEST_EVENT, handleRunRequest);
    return () => window.removeEventListener(WORKFLOW_RUN_REQUEST_EVENT, handleRunRequest);
  }, [onRun, workflowId]);

  return (
    <header className="builder-topbar">
      <div className="builder-topbar-primary">
        <div className="builder-workflow-identity">
          <div className="builder-product-context">
            {embeddedStudio ? <span>ARGUS · WORKFLOW STUDIO</span> : <Breadcrumb />}
          </div>
          <div className="builder-workflow-title-row">
            <span className={`builder-status-orb ${running || dirty ? 'is-attention' : 'is-ready'}`} />
            <div className="builder-workflow-title">
              {workflowId
                ? <InlineRename workflowId={workflowId} />
                : <span className="text-small font-medium">Workflow Studio</span>}
            </div>
            {running && <span className="builder-status-label is-running">läuft…</span>}
            {!running && dirty && <span className="builder-status-label is-dirty">ungesichert</span>}
            {!running && finalStatus === 'completed' && (
              <span className="builder-status-label is-success"><Check className="w-3 h-3" /> erfolgreich</span>
            )}
            {!running && finalStatus === 'failed' && (
              <span className="builder-status-label is-error" title={finalError ?? ''}><AlertCircle className="w-3 h-3" /> fehlgeschlagen</span>
            )}
          </div>
        </div>

        <div className="builder-primary-actions">
          {save.isError && (
            <span className="builder-save-state is-error">
              <AlertCircle className="w-3 h-3" /> Speichern fehlgeschlagen
            </span>
          )}
          {!dirty && !running && savedAt && (
            <span className="builder-save-state is-saved">
              <Check className="w-3 h-3" /> {savedAt}
            </span>
          )}
          {!embeddedStudio && (
            <Button
              variant="ghost"
              size="icon"
              className="builder-theme-button"
              aria-label={theme === 'dark' ? 'Helles Theme aktivieren' : 'Dunkles Theme aktivieren'}
              title={theme === 'dark' ? 'Helles Theme' : 'Dunkles Theme'}
              onClick={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')}
            >
              {theme === 'dark' ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
            </Button>
          )}
          <AgentPreflightBadge
            visible={hasAgentNodes}
            dirty={dirty}
            loading={agentPreflight.isLoading}
            refreshing={agentPreflight.isFetching}
            error={agentPreflight.isError}
            preflight={agentPreflight.data}
            onRefresh={() => void agentPreflight.refetch()}
            onOpenContract={() => setAgentContractOpen(true)}
          />
          <Button
            variant="outline"
            size="sm"
            aria-label="Workflow speichern"
            disabled={!workflowId || replayMode || !dirty || save.isPending || running}
            onClick={onSave}
          >
            <Save className="w-3.5 h-3.5" />
            <span className="builder-action-label">{save.isPending ? 'Speichern…' : 'Speichern'}</span>
          </Button>
          <Button
            variant="default"
            size="sm"
            aria-label="Workflow ausführen"
            disabled={!workflowId || replayMode || save.isPending || running}
            onClick={onRun}
            title={replayMode ? 'Replay ist schreibgeschützt' : 'Workflow ausführen und Start-Preflight prüfen'}
          >
            {running ? <Square className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
            <span className="builder-action-label">{running ? 'läuft…' : agentPreflight.isFetching && hasAgentNodes ? 'Prüfe…' : 'Ausführen'}</span>
          </Button>
        </div>
      </div>

      <div className="builder-commandbar" aria-label="Workflow-Werkzeuge">
        <div className="builder-commandbar-scroll">
          <div className="builder-toolbar-group">
            <Button variant="ghost" size="sm" className="xl:hidden" onClick={onToggleLibrary} title="Blockbibliothek öffnen">
              <PanelLeftOpen className="w-3.5 h-3.5" /> Blöcke
            </Button>
            <NewWorkflowButton />
          </div>
          <ToolbarDivider />
          <div className="builder-toolbar-group">
            <UndoRedoButtons />
            <Button variant="ghost" size="icon" title="Auto-Layout (Cmd+L)" disabled={!workflowId} onClick={onAutoLayout}>
              <LayoutGrid className="w-3.5 h-3.5" />
            </Button>
          </div>
          <ToolbarDivider />
          <div className="builder-toolbar-group">
            <ValidationBadge workflowId={workflowId} />
            <Button
              variant={agentContractOpen ? 'default' : 'ghost'}
              size="sm"
              disabled={!workflowId}
              onClick={() => setAgentContractOpen(true)}
              title="Portable Agent roles and execution requirements"
            >
              <Bot className="w-3.5 h-3.5" /> Agent contract
            </Button>
            <Button
              variant={copilotOpen ? 'default' : 'ghost'}
              size="sm"
              disabled={!workflowId}
              onClick={onToggleCopilot}
              title="Copilot — beschreibe, was du bauen möchtest"
            >
              <Sparkles className="w-3.5 h-3.5" /> Copilot
            </Button>
            <Button variant="ghost" size="sm" disabled={!workflowId} onClick={() => setVersionsOpen((v) => !v)} title="Versionsverlauf">
              <GitCommit className="w-3.5 h-3.5" /> Versionen
            </Button>
            <Button variant="ghost" size="sm" disabled={!workflowId} onClick={() => setRunsOpen((v) => !v)} title="Ausführungsverlauf">
              <History className="w-3.5 h-3.5" /> Runs
            </Button>
          </div>
          <ToolbarDivider />
          <div className="builder-toolbar-group">
            <ExportButton workflowId={workflowId} />
            <RunbookButton workflowId={workflowId} />
            <SubscribeButton workflowId={workflowId} />
            <CanvasModeButton fullscreen={fullscreen} onToggle={toggleFullscreen} />
            <Button variant="ghost" size="sm" disabled={!workflowId} onClick={toggleLog}>
              <ScrollText className="w-3.5 h-3.5" />
              {logOpen ? 'Log schließen' : 'Log'}
            </Button>
          </div>
          <ToolbarDivider />
          <div className="builder-toolbar-group builder-governance-tools">
            <OversightToggle workflowId={workflowId} />
            <MaintenanceWindow workflowId={workflowId} />
            <ComplianceTagsPreset workflowId={workflowId} />
          </div>
        </div>
      </div>

      {runsOpen && (
        <Suspense fallback={null}>
          <RunsDrawer open workflowId={workflowId} initialRunId={initialRunId} onClose={() => setRunsOpen(false)} />
        </Suspense>
      )}
      {runModalOpen && (
        <Suspense fallback={null}>
          <RunModal open workflowId={workflowId} onClose={() => setRunModalOpen(false)} />
        </Suspense>
      )}
      {versionsOpen && (
        <Suspense fallback={null}>
          <VersionsDrawer open workflowId={workflowId} onClose={() => setVersionsOpen(false)} />
        </Suspense>
      )}
      {workflowId && (
        <AgentContractEditor
          workflowId={workflowId}
          open={agentContractOpen}
          onClose={() => setAgentContractOpen(false)}
        />
      )}
    </header>
  );

  function onAutoLayout(): void {
    const laid = autoLayout(nodes, edges);
    useBuilderStore.getState().setNodes(laid);
  }
}

function ToolbarDivider() {
  return <span className="builder-toolbar-divider" aria-hidden="true" />;
}

function ExportButton({ workflowId }: { workflowId: number | null }) {
  const { data: flow } = useFlow(workflowId);
  return (
    <Button
      variant="ghost"
      size="icon"
      title="Workflow als JSON exportieren"
      disabled={!flow}
      onClick={() => flow && downloadFlowAsJson(flow)}
    >
      <Download className="w-3.5 h-3.5" />
    </Button>
  );
}

function RunbookButton({ workflowId }: { workflowId: number | null }) {
  const { data: flow } = useFlow(workflowId);
  return (
    <Button
      variant="ghost"
      size="icon"
      title="Runbook als Markdown exportieren"
      disabled={!flow || !workflowId}
      onClick={() => flow && workflowId && void downloadRunbook(workflowId, flow.name)}
    >
      <FileText className="w-3.5 h-3.5" />
    </Button>
  );
}

function UndoRedoButtons() {
  const undo = useBuilderStore((s) => s.undo);
  const redo = useBuilderStore((s) => s.redo);
  const past = useBuilderStore((s) => s.past.length);
  const future = useBuilderStore((s) => s.future.length);
  return (
    <>
      <Button variant="ghost" size="icon" title="Undo (Cmd+Z)" disabled={past === 0} onClick={undo}>
        <Undo2 className="w-3.5 h-3.5" />
      </Button>
      <Button variant="ghost" size="icon" title="Redo (Cmd+Shift+Z)" disabled={future === 0} onClick={redo}>
        <Redo2 className="w-3.5 h-3.5" />
      </Button>
    </>
  );
}
