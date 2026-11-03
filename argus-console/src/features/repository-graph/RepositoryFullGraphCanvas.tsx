import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Focus, Minus, Plus } from 'lucide-react';
import { fullGraphNodeId, layoutRepositoryFullGraph } from './fullGraphLayout';
import type { RepositoryFullGraph } from './types';

interface RepositoryFullGraphCanvasProps {
  graph: RepositoryFullGraph;
  selectedNodeId: string | null;
  onSelect: (nodeId: string) => void;
}

interface ViewTransform { scale: number; x: number; y: number }

const PALETTE = ['#5eead4', '#818cf8', '#f472b6', '#fb7185', '#fbbf24', '#60a5fa', '#a78bfa', '#34d399', '#fb923c', '#22d3ee', '#e879f9', '#a3e635', '#fda4af', '#93c5fd'];
const MIN_SCALE = 0.18;
const MAX_SCALE = 8;

function nodeLabel(graph: RepositoryFullGraph, pointIndex: number): string {
  if (pointIndex < graph.files.length) {
    const path = graph.files[pointIndex]?.[1] ?? '';
    return path.split('/').at(-1) ?? path;
  }
  return graph.symbols[pointIndex - graph.files.length]?.[1] ?? '';
}

export function RepositoryFullGraphCanvas({ graph, selectedNodeId, onSelect }: RepositoryFullGraphCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const layerRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; originX: number; originY: number; moved: boolean } | null>(null);
  const [view, setView] = useState<ViewTransform>({ scale: 1, x: 0, y: 0 });
  const [layerVersion, setLayerVersion] = useState(0);
  const layout = useMemo(() => layoutRepositoryFullGraph(graph), [graph]);
  const pointIndexById = useMemo(() => {
    const values = new Map<string, number>();
    graph.files.forEach((file, index) => values.set(`file:${file[0]}`, index));
    graph.symbols.forEach((symbol, index) => values.set(`symbol:${symbol[0]}`, graph.files.length + index));
    return values;
  }, [graph]);
  const selectedIndex = selectedNodeId ? pointIndexById.get(selectedNodeId) ?? null : null;

  const fit = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const width = Math.max(320, canvas.clientWidth);
    const height = Math.max(260, canvas.clientHeight);
    const scale = Math.max(MIN_SCALE, Math.min(1, Math.min(width / layout.width, height / layout.height) * 0.92));
    setView({ scale, x: (width - layout.width * scale) / 2, y: (height - layout.height * scale) / 2 });
  }, [layout.height, layout.width]);

  useEffect(() => {
    const layer = document.createElement('canvas');
    layer.width = layout.width;
    layer.height = layout.height;
    const context = layer.getContext('2d');
    if (!context) return;
    context.lineCap = 'round';
    context.lineWidth = 0.42;
    context.strokeStyle = 'rgba(125, 145, 178, 0.13)';
    context.beginPath();
    graph.edges.forEach(edge => {
      const source = graph.files.length + edge[0];
      const target = graph.files.length + edge[1];
      context.moveTo(layout.x[source]!, layout.y[source]!);
      context.lineTo(layout.x[target]!, layout.y[target]!);
    });
    context.stroke();

    context.lineWidth = 0.36;
    context.strokeStyle = 'rgba(125, 145, 178, 0.1)';
    context.beginPath();
    graph.symbols.forEach((symbol, symbolIndex) => {
      const pointIndex = graph.files.length + symbolIndex;
      context.moveTo(layout.x[symbol[3]]!, layout.y[symbol[3]]!);
      context.lineTo(layout.x[pointIndex]!, layout.y[pointIndex]!);
    });
    context.stroke();

    for (let group = 0; group < layout.modules.length; group += 1) {
      context.fillStyle = PALETTE[group % PALETTE.length]!;
      context.beginPath();
      for (let pointIndex = 0; pointIndex < layout.x.length; pointIndex += 1) {
        if (layout.moduleIndex[pointIndex] !== group) continue;
        const isFile = pointIndex < graph.files.length;
        const radius = isFile ? 2.7 + Math.min(2.8, Math.log2(layout.degree[pointIndex]! + 1) * 0.42) : 1.15 + Math.min(1.7, Math.log2(layout.degree[pointIndex]! + 1) * 0.23);
        context.moveTo(layout.x[pointIndex]! + radius, layout.y[pointIndex]!);
        context.arc(layout.x[pointIndex]!, layout.y[pointIndex]!, radius, 0, Math.PI * 2);
      }
      context.fill();
    }

    context.font = '600 13px ui-monospace, SFMono-Regular, Menlo, monospace';
    context.textAlign = 'center';
    context.fillStyle = 'rgba(195, 207, 228, 0.72)';
    layout.modules.forEach(module => context.fillText(module.name, module.x, module.y - 8));
    layerRef.current = layer;
    setLayerVersion(value => value + 1);
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fit);
    else fit();
  }, [fit, graph, layout]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const layer = layerRef.current;
    if (!canvas || !layer) return;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(320, canvas.clientWidth);
    const height = Math.max(260, canvas.clientHeight);
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }
    const context = canvas.getContext('2d');
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    context.save();
    context.translate(view.x, view.y);
    context.scale(view.scale, view.scale);
    context.drawImage(layer, 0, 0);
    if (selectedIndex != null) {
      const selectedX = layout.x[selectedIndex]!;
      const selectedY = layout.y[selectedIndex]!;
      context.strokeStyle = '#ffffff';
      context.fillStyle = '#ffffff';
      context.lineWidth = 2 / view.scale;
      context.beginPath();
      context.arc(selectedX, selectedY, 7 / view.scale, 0, Math.PI * 2);
      context.stroke();
      context.font = `${Math.max(10, 12 / view.scale)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      context.fillText(nodeLabel(graph, selectedIndex), selectedX + 10 / view.scale, selectedY - 10 / view.scale);
    }
    context.restore();
  }, [graph, layerVersion, layout, selectedIndex, view]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => fit());
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [fit]);

  const zoom = (factor: number, clientX?: number, clientY?: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const anchorX = clientX == null ? rect.width / 2 : clientX - rect.left;
    const anchorY = clientY == null ? rect.height / 2 : clientY - rect.top;
    setView(current => {
      const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, current.scale * factor));
      const worldX = (anchorX - current.x) / current.scale;
      const worldY = (anchorY - current.y) / current.scale;
      return { scale, x: anchorX - worldX * scale, y: anchorY - worldY * scale };
    });
  };

  return <section className="repository-full-graph-canvas" aria-label="Complete repository graph visual view">
    <div className="repository-full-graph-controls" aria-label="Complete graph controls">
      <button type="button" aria-label="Zoom out" onClick={() => zoom(0.78)}><Minus size={14} /></button>
      <output aria-label="Current zoom">{Math.round(view.scale * 100)}%</output>
      <button type="button" aria-label="Zoom in" onClick={() => zoom(1.28)}><Plus size={14} /></button>
      <button type="button" aria-label="Fit complete graph to view" onClick={fit}><Focus size={14} /></button>
    </div>
    <canvas
      ref={canvasRef}
      tabIndex={0}
      role="img"
      aria-label={`Complete repository graph with ${graph.files.length + graph.symbols.length} nodes and ${graph.symbols.length + graph.edges.length} relations`}
      onWheel={event => { event.preventDefault(); zoom(event.deltaY < 0 ? 1.16 : 0.86, event.clientX, event.clientY); }}
      onPointerDown={event => {
        dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, originX: view.x, originY: view.y, moved: false };
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.classList.add('is-panning');
      }}
      onPointerMove={event => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const dx = event.clientX - drag.x;
        const dy = event.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
        setView(current => ({ ...current, x: drag.originX + dx, y: drag.originY + dy }));
      }}
      onPointerUp={event => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        dragRef.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
        event.currentTarget.classList.remove('is-panning');
        if (drag.moved) return;
        const rect = event.currentTarget.getBoundingClientRect();
        const worldX = (event.clientX - rect.left - view.x) / view.scale;
        const worldY = (event.clientY - rect.top - view.y) / view.scale;
        const threshold = Math.max(7, 12 / view.scale);
        let nearest = -1;
        let nearestDistance = threshold * threshold;
        for (let pointIndex = 0; pointIndex < layout.x.length; pointIndex += 1) {
          const dx = layout.x[pointIndex]! - worldX;
          const dy = layout.y[pointIndex]! - worldY;
          const distance = dx * dx + dy * dy;
          if (distance >= nearestDistance) continue;
          nearest = pointIndex;
          nearestDistance = distance;
        }
        const nodeId = fullGraphNodeId(graph, nearest);
        if (nodeId) onSelect(nodeId);
      }}
      onPointerCancel={event => {
        dragRef.current = null;
        event.currentTarget.classList.remove('is-panning');
      }}
    />
  </section>;
}
