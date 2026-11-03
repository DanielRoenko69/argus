import type { RepositoryFullGraph } from './types';

export interface RepositoryFullGraphLayout {
  width: number;
  height: number;
  x: Float32Array;
  y: Float32Array;
  degree: Uint32Array;
  moduleIndex: Uint16Array;
  modules: Array<{ name: string; x: number; y: number }>;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

export function layoutRepositoryFullGraph(graph: RepositoryFullGraph): RepositoryFullGraphLayout {
  const nodeCount = graph.files.length + graph.symbols.length;
  const width = Math.max(1_800, Math.min(3_600, Math.round(Math.sqrt(Math.max(1, nodeCount)) * 20)));
  const height = Math.round(width * 0.66);
  const x = new Float32Array(nodeCount);
  const y = new Float32Array(nodeCount);
  const degree = new Uint32Array(nodeCount);
  const moduleIndex = new Uint16Array(nodeCount);
  const moduleNames = [...new Set(graph.files.map(file => file[3]))].sort((left, right) => left.localeCompare(right));
  const moduleLookup = new Map(moduleNames.map((name, index) => [name, index]));
  const filesByModule = new Map<number, number[]>();

  graph.files.forEach((file, fileIndex) => {
    const group = moduleLookup.get(file[3]) ?? 0;
    moduleIndex[fileIndex] = group;
    const groupedFiles = filesByModule.get(group);
    if (groupedFiles) groupedFiles.push(fileIndex);
    else filesByModule.set(group, [fileIndex]);
  });

  const columns = Math.max(1, Math.ceil(Math.sqrt(moduleNames.length * 1.5)));
  const rows = Math.max(1, Math.ceil(moduleNames.length / columns));
  const cellWidth = (width - 180) / columns;
  const cellHeight = (height - 160) / rows;
  const modules = moduleNames.map((name, index) => ({
    name,
    x: 90 + (index % columns + 0.5) * cellWidth,
    y: 80 + (Math.floor(index / columns) + 0.5) * cellHeight,
  }));

  for (const [group, fileIndexes] of filesByModule) {
    const center = modules[group]!;
    const phase = (hash(center.name) % 628) / 100;
    const radius = Math.max(24, Math.min(cellWidth, cellHeight) * 0.4);
    fileIndexes.forEach((fileIndex, ordinal) => {
      const distance = radius * Math.sqrt((ordinal + 0.5) / Math.max(1, fileIndexes.length));
      const angle = phase + ordinal * GOLDEN_ANGLE;
      x[fileIndex] = center.x + Math.cos(angle) * distance;
      y[fileIndex] = center.y + Math.sin(angle) * distance;
    });
  }

  const symbolOrdinalByFile = new Uint32Array(graph.files.length);
  graph.symbols.forEach((symbol, symbolIndex) => {
    const pointIndex = graph.files.length + symbolIndex;
    const fileIndex = symbol[3];
    const ordinal = symbolOrdinalByFile[fileIndex]++;
    const phase = (hash(`${symbol[0]}:${symbol[1]}`) % 628) / 100;
    const distance = 4 + Math.sqrt(ordinal + 1) * 2.7;
    const angle = phase + ordinal * GOLDEN_ANGLE;
    x[pointIndex] = x[fileIndex]! + Math.cos(angle) * distance;
    y[pointIndex] = y[fileIndex]! + Math.sin(angle) * distance;
    moduleIndex[pointIndex] = moduleIndex[fileIndex]!;
    degree[fileIndex] += 1;
    degree[pointIndex] += 1;
  });

  graph.edges.forEach(edge => {
    const source = graph.files.length + edge[0];
    const target = graph.files.length + edge[1];
    if (source >= nodeCount || target >= nodeCount) return;
    degree[source] += 1;
    degree[target] += 1;
  });

  return { width, height, x, y, degree, moduleIndex, modules };
}

export function fullGraphNodeId(graph: RepositoryFullGraph, pointIndex: number): string | null {
  if (pointIndex < 0) return null;
  if (pointIndex < graph.files.length) return `file:${graph.files[pointIndex]?.[0] ?? ''}`;
  const symbol = graph.symbols[pointIndex - graph.files.length];
  return symbol ? `symbol:${symbol[0]}` : null;
}
