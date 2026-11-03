import { useId, useMemo, useRef, useState } from 'react';
import { Boxes, FileCode2, Focus, GitBranch, Minus, Plus, ScanSearch, Waypoints } from 'lucide-react';
import {
  GRAPH_NODE_HEIGHT,
  GRAPH_NODE_WIDTH,
  graphEdgePath,
  layoutRepositoryGraph,
} from './graphLayout';
import type { RepositoryGraphEdge, RepositoryGraphNode } from './types';

interface RepositoryGraphCanvasProps {
  nodes: RepositoryGraphNode[];
  edges: RepositoryGraphEdge[];
  selectedNodeId: string | null;
  focusNodeId?: string | null;
  onSelect: (nodeId: string) => void;
  onActivate?: (nodeId: string) => void;
}

const MIN_ZOOM = 0.55;
const MAX_ZOOM = 1.6;

function NodeIcon({ type }: { type: RepositoryGraphNode['type'] }) {
  if (type === 'repository') return <GitBranch size={15} />;
  if (type === 'module') return <Boxes size={15} />;
  if (type === 'file') return <FileCode2 size={15} />;
  return <Waypoints size={15} />;
}

function clampZoom(value: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(value * 100) / 100));
}

function edgeWeight(edge: RepositoryGraphEdge): number {
  const count = Number(edge.metadata?.['relationCount'] ?? 1);
  return Math.min(4, 1.2 + Math.log2(Math.max(1, count)) * 0.35);
}

export function RepositoryGraphCanvas({ nodes, edges, selectedNodeId, focusNodeId = null, onSelect, onActivate }: RepositoryGraphCanvasProps) {
  const markerId = `repository-graph-arrow-${useId().replaceAll(':', '')}`;
  const viewportRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; left: number; top: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const layout = useMemo(() => layoutRepositoryGraph(nodes, edges, focusNodeId), [edges, focusNodeId, nodes]);
  const positioned = useMemo(() => new Map(layout.nodes.map(node => [node.id, node])), [layout.nodes]);

  const fit = () => {
    const viewport = viewportRef.current;
    if (!viewport) return setZoom(1);
    const availableWidth = Math.max(320, viewport.clientWidth - 28);
    const availableHeight = Math.max(240, viewport.clientHeight - 28);
    setZoom(clampZoom(Math.min(1, availableWidth / layout.width, availableHeight / layout.height)));
    viewport.scrollTo({ left: 0, top: 0, behavior: 'smooth' });
  };

  return <section className="repository-graph-canvas" aria-label="Repository graph visual view">
    <div className="repository-graph-canvas-controls" aria-label="Graph view controls">
      <button type="button" aria-label="Zoom out" onClick={() => setZoom(current => clampZoom(current - 0.15))}><Minus size={14} /></button>
      <output aria-label="Current zoom">{Math.round(zoom * 100)}%</output>
      <button type="button" aria-label="Zoom in" onClick={() => setZoom(current => clampZoom(current + 0.15))}><Plus size={14} /></button>
      <button type="button" aria-label="Fit graph to view" onClick={fit}><Focus size={14} /></button>
    </div>

    <div
      className="repository-graph-canvas-viewport"
      ref={viewportRef}
      tabIndex={0}
      aria-label="Scrollable graph canvas. Drag the background or use scrollbars to pan."
      onPointerDown={event => {
        if ((event.target as Element).closest('.repository-graph-node')) return;
        dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop };
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.classList.add('is-panning');
      }}
      onPointerMove={event => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        event.currentTarget.scrollLeft = drag.left - (event.clientX - drag.x);
        event.currentTarget.scrollTop = drag.top - (event.clientY - drag.y);
      }}
      onPointerUp={event => {
        if (dragRef.current?.pointerId !== event.pointerId) return;
        dragRef.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
        event.currentTarget.classList.remove('is-panning');
      }}
      onPointerCancel={event => {
        dragRef.current = null;
        event.currentTarget.classList.remove('is-panning');
      }}
    >
      <svg
        className="repository-graph-canvas-stage"
        width={layout.width * zoom}
        height={layout.height * zoom}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        role="img"
        aria-label={`Directed repository graph with ${nodes.length} nodes and ${edges.length} relations`}
      >
        <defs><marker id={markerId} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 z" /></marker></defs>
        <g className="repository-graph-edges">{edges.map(edge => {
          const source = positioned.get(edge.source);
          const target = positioned.get(edge.target);
          if (!source || !target) return null;
          return <g key={edge.id}>
            <path
              className={edge.type === 'contains' ? 'is-containment' : 'is-dependency'}
              d={graphEdgePath(source, target)}
              markerEnd={`url(#${markerId})`}
              style={{ strokeWidth: edge.type === 'contains' ? 1 : edgeWeight(edge) }}
            />
            <title>{edge.type}: {source.label} → {target.label}{edge.metadata?.['relationCount'] ? ` · ${edge.metadata['relationCount']} relations` : ''}</title>
          </g>;
        })}</g>
        <g className="repository-graph-nodes">{layout.nodes.map(node => {
          const selected = node.id === selectedNodeId;
          const focused = node.id === focusNodeId;
          return <g
            key={node.id}
            className={`repository-graph-node is-${node.type}${selected ? ' is-selected' : ''}${focused ? ' is-focus' : ''}`}
            transform={`translate(${node.x} ${node.y})`}
            role="button"
            tabIndex={0}
            aria-pressed={selected}
            aria-label={`${node.type} ${node.label}`}
            onClick={() => onSelect(node.id)}
            onDoubleClick={() => onActivate?.(node.id)}
            onKeyDown={event => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              onSelect(node.id);
            }}
          >
            <rect width={GRAPH_NODE_WIDTH} height={GRAPH_NODE_HEIGHT} rx="10" />
            <foreignObject x="12" y="11" width="26" height="26">
              <span className="repository-graph-node-icon"><NodeIcon type={node.type} /></span>
            </foreignObject>
            <text x="47" y="23" className="repository-graph-node-kind">{node.type}</text>
            <text x="47" y="42" className="repository-graph-node-label">{node.label.length > 20 ? `${node.label.slice(0, 19)}…` : node.label}</text>
            <title>{node.label} · {node.id}</title>
          </g>;
        })}</g>
      </svg>
    </div>

    <div className="repository-graph-minimap" aria-hidden="true">
      <ScanSearch size={12} />
      <svg viewBox={`0 0 ${layout.width} ${layout.height}`} preserveAspectRatio="xMidYMid meet">
        {layout.nodes.map(node => <rect key={node.id} x={node.x} y={node.y} width={GRAPH_NODE_WIDTH} height={GRAPH_NODE_HEIGHT} rx="6" className={`is-${node.type}${node.id === selectedNodeId ? ' is-selected' : ''}`} />)}
      </svg>
    </div>
  </section>;
}
