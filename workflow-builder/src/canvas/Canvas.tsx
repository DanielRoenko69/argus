// Workflow canvas. Wires React Flow to the Zustand store + drop handler.

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from 'react';
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  useReactFlow,
  applyNodeChanges,
  applyEdgeChanges,
  ConnectionLineType,
  MarkerType,
  type Node,
  type NodeChange,
  type EdgeChange,
  type Connection,
} from 'reactflow';
import { useBuilderStore } from '@/stores/builderStore';
import { getNodeTypes, getNodeDefinition, getAllNodeDefinitions } from '@/nodes/registry';
import '@/nodes'; // populate registry
import { ContextMenu, type MenuAction } from './ContextMenu';
import { autoLayout } from './autoLayout';
import { ArgusEdge } from './ArgusEdge';
import { Trash2, X } from 'lucide-react';
import type { WorkflowReplay } from '@/api/replay';
import { decorateWorkflowReplay } from '@/lib/workflowReplay';
import { ReplayEvidenceDrawer } from './ReplayEvidenceDrawer';
import { ReplayRunControls } from './ReplayRunControls';

const EDGE_TYPES = { argus: ArgusEdge };
const DEFAULT_EDGE_OPTIONS = {
  type: 'argus',
  markerEnd: {
    type: MarkerType.ArrowClosed,
    width: 16,
    height: 16,
    color: 'hsl(var(--muted-foreground))',
  },
};

interface CanvasProps {
  workflowId: number;
  replayTraceId?: string | null;
  replay?: WorkflowReplay | null;
  replayLoading?: boolean;
  replayError?: string | null;
}

interface MenuState {
  kind: 'node' | 'pane';
  x: number;
  y: number;
  flowX?: number;
  flowY?: number;
  nodeId?: string;
}

export function Canvas({ workflowId, replayTraceId = null, replay = null, replayLoading = false, replayError = null }: CanvasProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const { project, setViewport } = useReactFlow();
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [selectedReplayNodeId, setSelectedReplayNodeId] = useState<string | null>(null);

  const {
    nodes, edges, setNodes, setEdges, addNode, connect, selectNodes, removeNode, removeNodes, duplicateNode,
    readOnly, setViewport: setStoreVp,
  } = useBuilderStore();
  const selectedNodeIds = nodes.filter((node) => node.selected).map((node) => node.id);

  const nodeTypes = useMemo(() => getNodeTypes(), []);
  const replayGraph = useMemo(
    () => decorateWorkflowReplay(nodes, edges, replayTraceId ? replay : null),
    [edges, nodes, replay, replayTraceId],
  );
  const replayDecisions = replay
    ? Object.values(replay.steps).filter((step) => step.selectedTarget)
    : [];
  const selectedReplayNode = selectedReplayNodeId
    ? nodes.find((node) => node.id === selectedReplayNodeId) ?? null
    : null;
  const selectedReplayStep = selectedReplayNodeId && replay
    ? replay.steps[selectedReplayNodeId] ?? null
    : null;

  useEffect(() => setSelectedReplayNodeId(null), [replayTraceId]);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      // React Flow fires 'dimensions' (mount-time measurement) and 'select'
      // changes that are NOT user edits. Applying them via setNodes would flip
      // the store dirty on a freshly loaded workflow — spuriously arming the
      // unsaved-changes guard + autosave/recovery. Keep those clean.
      const benign = changes.every((c) => c.type === 'dimensions' || c.type === 'select');
      setNodes(applyNodeChanges(changes, nodes), benign ? { skipHistory: true, skipDirty: true } : undefined);
    },
    [nodes, setNodes]
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const benign = changes.every((c) => c.type === 'select');
      setEdges(applyEdgeChanges(changes, edges), benign ? { skipHistory: true, skipDirty: true } : undefined);
    },
    [edges, setEdges]
  );
  const onConnect = useCallback((conn: Connection) => connect(conn), [connect]);

  const onDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      const type = e.dataTransfer.getData('application/argus-node-type');
      if (!type || !wrapperRef.current) return;
      const def = getNodeDefinition(type);
      if (!def) return;

      const bounds = wrapperRef.current.getBoundingClientRect();
      const position = project({
        x: e.clientX - bounds.left,
        y: e.clientY - bounds.top,
      });

      const id = `${type}.${crypto.randomUUID().slice(0, 8)}`;
      const seedRaw = e.dataTransfer.getData('application/argus-node-seed');
      let seed: Record<string, unknown> = {};
      if (seedRaw) {
        try {
          const parsed = JSON.parse(seedRaw) as unknown;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            seed = parsed as Record<string, unknown>;
          }
        } catch {
          seed = {};
        }
      }
      const node: Node = {
        id,
        type,
        position,
        data: { ...def.defaultData(), ...seed },
      };
      addNode(node);
    },
    [project, addNode]
  );

  const onNodeClick = useCallback((event: MouseEvent, node: Node) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey) return;
    selectNodes([node.id]);
    if (replayTraceId) setSelectedReplayNodeId(node.id);
  }, [replayTraceId, selectNodes]);
  const onPaneClick = useCallback(() => {
    selectNodes([]);
    setSelectedReplayNodeId(null);
    setMenu(null);
  }, [selectNodes]);
  const onSelectionChange = useCallback(({ nodes: selectedNodes }: { nodes: Node[] }) => {
    selectNodes(selectedNodes.map((node) => node.id));
  }, [selectNodes]);

  // ── Context menus ──────────────────────────────────────────────
  const onNodeContextMenu = useCallback((e: MouseEvent, node: Node) => {
    e.preventDefault();
    setMenu({ kind: 'node', x: e.clientX, y: e.clientY, nodeId: node.id });
    selectNodes([node.id]);
  }, [selectNodes]);

  const onPaneContextMenu = useCallback((e: MouseEvent | globalThis.MouseEvent) => {
    e.preventDefault();
    if (!wrapperRef.current) return;
    const bounds = wrapperRef.current.getBoundingClientRect();
    const flowPos = project({ x: e.clientX - bounds.left, y: e.clientY - bounds.top });
    setMenu({ kind: 'pane', x: e.clientX, y: e.clientY, flowX: flowPos.x, flowY: flowPos.y });
  }, [project]);

  const buildMenu = useCallback((): MenuAction[] => {
    if (!menu) return [];
    if (menu.kind === 'node' && menu.nodeId) {
      const id = menu.nodeId;
      return [
        { label: 'Duplizieren',    icon: 'Copy',   shortcut: '⌘D', onClick: () => duplicateNode(id) },
        { label: 'Löschen',        icon: 'Trash2', shortcut: 'Entf', destructive: true, onClick: () => removeNode(id) },
        { divider: true, label: '' },
        { label: 'Alle auswählen', icon: 'BoxSelect', shortcut: '⌘A', onClick: () => selectNodes(nodes.map((node) => node.id)) },
      ];
    }
    // pane menu — add-block grouped
    const addBlock: MenuAction[] = getAllNodeDefinitions().slice(0, 12).map((def) => ({
      label: def.label,
      icon: def.icon,
      onClick: () => {
        const newId = `${def.type}.${crypto.randomUUID().slice(0, 8)}`;
        addNode({
          id: newId,
          type: def.type,
          position: { x: menu.flowX ?? 0, y: menu.flowY ?? 0 },
          data: def.defaultData(),
        });
      },
    }));
    return [
      ...addBlock,
      { divider: true, label: '' },
      { label: 'Alle auswählen', icon: 'BoxSelect', shortcut: '⌘A', onClick: () => selectNodes(nodes.map((node) => node.id)), disabled: nodes.length === 0 },
      { label: 'Automatisch anordnen', icon: 'LayoutGrid', shortcut: '⌘L', onClick: () => setNodes(autoLayout(nodes, edges)) },
    ];
  }, [menu, addNode, duplicateNode, removeNode, selectNodes, setNodes, nodes, edges]);

  return (
    <div ref={wrapperRef} className="builder-canvas w-full h-full" onDragOver={onDragOver} onDrop={onDrop}>
      <div className="builder-canvas-meta" aria-label={`${nodes.length} Blöcke und ${edges.length} Verbindungen`}>
        <span>CANVAS · WF-{workflowId}</span>
        <strong>{nodes.length} {nodes.length === 1 ? 'Block' : 'Blöcke'}</strong>
        <i />
        <strong>{edges.length} {edges.length === 1 ? 'Verbindung' : 'Verbindungen'}</strong>
      </div>
      {replayTraceId && (
        <div className="builder-replay-banner" role="status" aria-label="Workflow run replay">
          <span>RUN REPLAY</span>
          <strong>{replayLoading ? 'Evidence wird geladen…' : replayError ? 'Replay nicht verfügbar' : replay?.status ?? 'unknown'}</strong>
          {!replayLoading && !replayError && replayDecisions.map((decision) => (
            <em key={decision.id}>{decision.label}: {decision.result} → {decision.selectedTarget}</em>
          ))}
          <small>{replayTraceId.slice(0, 8)}… · schreibgeschützt</small>
          <a href={`/build/workflows/studio/${workflowId}`} target="_top">Replay schließen</a>
        </div>
      )}
      {replayTraceId && replay && (
        <ReplayRunControls workflowId={workflowId} replay={replay} />
      )}
      {nodes.length === 0 && (
        <div className="builder-canvas-empty" aria-hidden="true">
          <span>+</span>
          <strong>Baue deinen ersten Ablauf</strong>
          <p>Wähle einen Block aus der Bibliothek oder öffne die Befehlspalette mit ⌘K.</p>
        </div>
      )}
      {selectedNodeIds.length > 1 && (
        <div className="builder-selection-toolbar" role="status" aria-label={`${selectedNodeIds.length} Blöcke ausgewählt`}>
          <span>{selectedNodeIds.length} BLÖCKE</span>
          <strong>Mehrfachauswahl</strong>
          {!readOnly && (
            <button type="button" onClick={() => removeNodes(selectedNodeIds)} aria-label="Ausgewählte Blöcke löschen" title="Ausgewählte Blöcke löschen">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
          <button type="button" onClick={() => selectNodes([])} aria-label="Auswahl aufheben" title="Auswahl aufheben">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
      <ReactFlow
        nodes={replayGraph.nodes}
        edges={replayGraph.edges}
        nodeTypes={nodeTypes}
        edgeTypes={EDGE_TYPES}
        defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
        connectionLineType={ConnectionLineType.SmoothStep}
        connectionLineStyle={{ stroke: 'hsl(var(--primary))', strokeWidth: 2 }}
        connectionRadius={28}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        onSelectionChange={onSelectionChange}
        onNodeContextMenu={onNodeContextMenu}
        onPaneContextMenu={onPaneContextMenu}
        onMoveEnd={(_e, vp) => { setViewport(vp); setStoreVp(vp); }}
        fitView
        fitViewOptions={{ padding: 0.22, minZoom: 0.45, maxZoom: 1.25 }}
        minZoom={0.2}
        maxZoom={2}
        selectionOnDrag
        panOnDrag={[1, 2]}
        multiSelectionKeyCode={['Meta', 'Control']}
        selectionKeyCode="Shift"
        zoomOnDoubleClick={false}
        snapToGrid
        snapGrid={[16, 16]}
        deleteKeyCode={null}
        className="builder-react-flow"
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={16} size={1} color="hsl(var(--border))" />
        <Controls className="!bg-card !border-border" showInteractive={false} />
        <MiniMap
          className="!bg-card !border-border"
          nodeColor={(node) => node.type?.startsWith('trigger.')
            ? 'hsl(var(--teal))'
            : node.type?.startsWith('logic.')
              ? 'hsl(var(--amber))'
              : 'hsl(var(--primary))'}
          maskColor="hsl(var(--background) / 0.78)"
        />
      </ReactFlow>
      {replayTraceId && selectedReplayNode && (
        <ReplayEvidenceDrawer
          nodeId={selectedReplayNode.id}
          nodeLabel={typeof selectedReplayNode.data?.label === 'string' ? selectedReplayNode.data.label : selectedReplayNode.id}
          nodeType={selectedReplayNode.type ?? 'unknown'}
          rootTraceId={replayTraceId}
          step={selectedReplayStep}
          onClose={() => {
            setSelectedReplayNodeId(null);
            selectNodes([]);
          }}
        />
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={buildMenu()} onClose={() => setMenu(null)} />}
    </div>
  );
}
