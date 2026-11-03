// Custom edge: smooth bezier with editable label + delete-on-hover.
// Pattern adapted from sim/.../workflow-edge (Apache 2.0).

import { useState } from 'react';
import {
  BaseEdge, EdgeLabelRenderer, getSmoothStepPath,
  type EdgeProps,
} from 'reactflow';
import { X } from 'lucide-react';
import { useBuilderStore } from '@/stores/builderStore';
import { useExecutionStore } from '@/stores/executionStore';

export function ArgusEdge(props: EdgeProps) {
  const {
    id, source, sourceX, sourceY, targetX, targetY,
    sourcePosition, targetPosition, data, selected, markerEnd,
  } = props;
  const [hover, setHover] = useState(false);
  const setEdges = useBuilderStore((s) => s.setEdges);
  const edges = useBuilderStore((s) => s.edges);
  const readOnly = useBuilderStore((s) => s.readOnly);
  // Edge is "active" when its source step is currently running OR just completed.
  const srcExec = useExecutionStore((s) => s.stepStates[source]);
  const isActive = srcExec?.status === 'running';
  const wasActive = srcExec?.status === 'completed';

  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX, sourceY, sourcePosition,
    targetX, targetY, targetPosition,
    borderRadius: 8,
  });

  const label = (data as { label?: string } | undefined)?.label ?? '';
  const intent = (data as { intent?: 'success' | 'fail' | 'default' } | undefined)?.intent ?? 'default';
  const replayStatus = (data as { replayStatus?: 'selected' | 'skipped' | 'inactive' } | undefined)?.replayStatus;
  const stroke =
    replayStatus === 'selected' ? 'hsl(174 78% 48%)' :
    replayStatus === 'skipped' ? 'hsl(220 10% 35%)' :
    replayStatus === 'inactive' ? 'hsl(220 10% 30%)' :
    isActive            ? 'hsl(38 92% 55%)'  :   // amber pulse during run
    wasActive           ? 'hsl(142 70% 50%)' :   // green when source done
    intent === 'success' ? 'hsl(142 70% 50%)' :
    intent === 'fail'    ? 'hsl(0 70% 55%)'   :
    selected             ? 'hsl(263 70% 60%)' :
    hover                ? 'hsl(263 70% 55%)' :
    'hsl(0 0% 38%)';

  return (
    <>
      <BaseEdge
        id={`${id}-halo`}
        path={edgePath}
        style={{
          stroke: replayStatus === 'selected' || hover || selected || isActive ? stroke : 'transparent',
          strokeWidth: 7,
          opacity: replayStatus === 'selected' || hover || selected || isActive ? 0.16 : 0,
          filter: 'blur(2px)',
          transition: 'stroke .14s ease, opacity .14s ease',
        }}
      />
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          stroke,
          strokeWidth: replayStatus === 'selected' ? 2.7 : isActive ? 2.5 : (hover || selected ? 2 : 1.5),
          opacity: replayStatus === 'skipped' ? 0.3 : replayStatus === 'inactive' ? 0.45 : 1,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          transition: 'stroke .14s ease, stroke-width .14s ease, opacity .14s ease',
          ...(replayStatus === 'skipped'
            ? { strokeDasharray: '3 6' }
            : isActive ? { strokeDasharray: '8 4', animation: 'dash 1s linear infinite' } : {}),
        }}
        interactionWidth={20}
      />
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={20}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      />
      <EdgeLabelRenderer>
        <div
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          className="builder-edge-label absolute pointer-events-auto"
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
        >
          <div className="flex items-center gap-1">
            {label && (
              <span
                className="builder-edge-chip"
                data-intent={intent}
              >
                {label}
              </span>
            )}
            {!readOnly && (hover || selected) && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setEdges(edges.filter((e2) => e2.id !== id));
                }}
                className="builder-edge-delete"
                title="Verbindung löschen"
                aria-label="Verbindung löschen"
              >
                <X className="w-2.5 h-2.5" />
              </button>
            )}
          </div>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
