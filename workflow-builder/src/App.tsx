import { useParams, useSearchParams, Link } from 'react-router-dom';
import { lazy, Suspense, useEffect, useState } from 'react';
import { ReactFlowProvider } from 'reactflow';
import { Canvas } from './canvas/Canvas';
import { Sidebar } from './sidebar/Sidebar';
import { TopBar } from './canvas/TopBar';
import { useFlow, restoreFromFlow } from './api/workflows';
import { useBuilderStore } from './stores/builderStore';
import { useExecutionStream } from './api/execution';
import { useKeyboardShortcuts } from './canvas/useKeyboardShortcuts';
import { useSaveFlow, buildSavePayload } from './api/workflows';
import { useAutosave, checkRecovery, clearRecovery, payloadToFlowArrays, type Snapshot } from './stores/autosave';
import { RecoveryBanner } from './canvas/RecoveryBanner';
import { NewWorkflowButton } from './canvas/NewWorkflowButton';
import { useUnsavedGuard } from './stores/unsavedGuard';
import { requestWorkflowRun } from './lib/builderEvents';
import { useStudioBridge } from './lib/studioBridge';
import { useExecutionStore } from './stores/executionStore';
import { useWorkflowReplay } from './api/replay';

const PropertiesPanel = lazy(() => import('./properties/PropertiesPanel').then((module) => ({ default: module.PropertiesPanel })));
const ExecutionLog = lazy(() => import('./execution/ExecutionLog').then((module) => ({ default: module.ExecutionLog })));
const CopilotPanel = lazy(() => import('./copilot/CopilotPanel').then((module) => ({ default: module.CopilotPanel })));
const CommandPalette = lazy(() => import('./canvas/CommandPalette').then((module) => ({ default: module.CommandPalette })));
const SearchReplace = lazy(() => import('./canvas/SearchReplace').then((module) => ({ default: module.SearchReplace })));
const TRACE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function App() {
  const { id } = useParams<{ id?: string }>();
  const [searchParams] = useSearchParams();
  const workflowId = id ? Number(id) : null;
  const replayParam = searchParams.get('replay')?.trim() ?? '';
  const replayTraceId = TRACE_ID_PATTERN.test(replayParam) ? replayParam : null;
  const executionParam = Number(searchParams.get('execution'));
  const inspectedExecutionId = Number.isSafeInteger(executionParam) && executionParam > 0 ? executionParam : null;
  const [copilotOpen, setCopilotOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [searchOpen, setSearchOpen]   = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const selectedNodeId = useBuilderStore((state) => state.selectedNodeId);

  useStudioBridge(workflowId);

  // U2: warn before leaving the tab while there are unsaved changes.
  useUnsavedGuard();

  return (
    <ReactFlowProvider>
      <div className="builder-shell flex h-screen w-screen flex-col bg-background text-foreground">
        <TopBar
          workflowId={workflowId}
          replayMode={replayTraceId != null}
          initialRunId={inspectedExecutionId}
          copilotOpen={copilotOpen}
          onToggleCopilot={() => setCopilotOpen((v) => !v)}
          onToggleLibrary={() => setLibraryOpen((v) => !v)}
        />
        <div className="builder-workspace flex flex-1 overflow-hidden">
          <Sidebar mobileOpen={libraryOpen} onClose={() => setLibraryOpen(false)} />
          <main className="builder-main flex-1 relative min-w-0">
            {workflowId == null ? (
              <EmptyState />
            ) : (
              <WorkflowEditor
                workflowId={workflowId}
                replayTraceId={replayTraceId}
                onOpenPalette={() => setPaletteOpen(true)}
                onOpenSearch={() => setSearchOpen(true)}
                onToggleCopilot={() => setCopilotOpen((v) => !v)}
              />
            )}
            {copilotOpen && (
              <Suspense fallback={null}>
                <CopilotPanel open workflowId={workflowId} onClose={() => setCopilotOpen(false)} />
              </Suspense>
            )}
            {searchOpen && (
              <Suspense fallback={null}>
                <SearchReplace open onClose={() => setSearchOpen(false)} />
              </Suspense>
            )}
          </main>
          {selectedNodeId && !replayTraceId && (
            <Suspense fallback={null}>
              <PropertiesPanel workflowId={workflowId} />
            </Suspense>
          )}
        </div>
        {paletteOpen && (
          <Suspense fallback={null}>
            <CommandPalette
              open
              onClose={() => setPaletteOpen(false)}
              onToggleCopilot={() => setCopilotOpen((v) => !v)}
            />
          </Suspense>
        )}
      </div>
    </ReactFlowProvider>
  );
}

interface WorkflowEditorProps {
  workflowId: number;
  replayTraceId: string | null;
  onOpenPalette: () => void;
  onOpenSearch:  () => void;
  onToggleCopilot: () => void;
}

function WorkflowEditor({ workflowId, replayTraceId, onOpenPalette, onOpenSearch, onToggleCopilot }: WorkflowEditorProps) {
  const { data, isLoading, error } = useFlow(workflowId);
  const replayQuery = useWorkflowReplay(workflowId, replayTraceId);
  const loadFlow = useBuilderStore((s) => s.loadFlow);
  const reset = useBuilderStore((s) => s.reset);
  const setReadOnly = useBuilderStore((s) => s.setReadOnly);
  const save = useSaveFlow();
  const logOpen = useExecutionStore((state) => state.logOpen);

  // Subscribe to live execution events (no-op when no execution active)
  useExecutionStream(workflowId);

  // Autosave every 30s to localStorage (crash-recovery)
  useAutosave(workflowId);

  // Keyboard: Cmd+Z/Y, Cmd+S, Cmd+Enter, Cmd+D, Del, F, Cmd+L, Cmd+K, Cmd+F
  useKeyboardShortcuts({
    onSave: () => {
      if (replayTraceId) return;
      const s = useBuilderStore.getState();
      const payload = buildSavePayload(s.nodes, s.edges, s.viewport, data?.agent_requirements ?? []);
      save.mutate({ id: workflowId, payload }, { onSuccess: () => useBuilderStore.getState().markClean() });
    },
    // Route keyboard execution through TopBar so Cmd+Enter receives the same
    // save, Agent preflight and input-modal gates as the visible Run button.
    onRun: () => { if (!replayTraceId) requestWorkflowRun(workflowId); },
    onOpenPalette,
    onOpenSearch,
    onToggleCopilot,
  });

  // Crash-recovery: a newer local autosave snapshot than the server copy.
  const [recovery, setRecovery] = useState<Snapshot | null>(null);

  // When workflow data arrives, hydrate the store + apply RBAC read-only,
  // then offer to restore a fresher local autosave snapshot if one exists.
  //
  // A background React Query refetch must never replace local edits. The old
  // effect cleanup reset the canvas before every new `data` object, so a focus
  // refetch could make a block disappear immediately after it was added.
  useEffect(() => {
    if (!data) return;
    setReadOnly(replayTraceId != null || data.can_edit === false);
    if (useBuilderStore.getState().dirty) return;

    const { nodes, edges, viewport } = restoreFromFlow(data);
    loadFlow(nodes, edges, viewport);
    setRecovery(checkRecovery(workflowId, data));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, replayTraceId]);

  // Reset only when leaving this workflow (or unmounting the editor), not on
  // each server response for the same workflow.
  useEffect(() => () => {
    reset();
    setReadOnly(false);
    setRecovery(null);
  }, [workflowId, reset, setReadOnly]);

  const acceptRecovery = () => {
    if (recovery) {
      const { nodes, edges, viewport } = payloadToFlowArrays(recovery.payload);
      loadFlow(nodes, edges, viewport);
    }
    clearRecovery(workflowId);
    setRecovery(null);
  };

  const declineRecovery = () => {
    clearRecovery(workflowId);
    setRecovery(null);
  };

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-small">
        Workflow wird geladen…
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center max-w-md">
          <p className="text-destructive text-small mb-2">Fehler beim Laden:</p>
          <p className="text-xs text-muted-foreground font-mono">{String(error)}</p>
        </div>
      </div>
    );
  }
  return (
    <>
      {recovery && <RecoveryBanner onRestore={acceptRecovery} onDismiss={declineRecovery} />}
      <Canvas
        workflowId={workflowId}
        replayTraceId={replayTraceId}
        replay={replayQuery.data ?? null}
        replayLoading={replayQuery.isLoading}
        replayError={replayQuery.error ? String(replayQuery.error) : null}
      />
      {logOpen && (
        <Suspense fallback={null}>
          <ExecutionLog workflowId={workflowId} />
        </Suspense>
      )}
    </>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-center max-w-md">
        <h2 className="text-md font-medium mb-2">Kein Workflow ausgewählt</h2>
        <p className="text-small text-muted-foreground mb-4">
          Wähle einen Workflow aus der Liste oder erstelle einen neuen.
        </p>
        <div className="flex items-center justify-center gap-3">
          <NewWorkflowButton variant="cta" />
          <Link
            to="/"
            className="inline-block px-4 py-2 rounded-md bg-secondary text-foreground text-small font-medium hover:bg-secondary/80 transition-colors"
          >
            Zur Workflow-Liste
          </Link>
        </div>
      </div>
    </div>
  );
}
