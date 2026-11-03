import type { Palette, PaletteIntegration, PaletteTool } from '@/api/palette';

export interface ToolNodeData {
  tool?: string | null;
  integration_id?: string | null;
}

export type ToolNodeState = 'ready' | 'checking' | 'unconfigured' | 'missing' | 'error';

export interface ToolNodePresentation {
  state: ToolNodeState;
  actionLabel: string;
  providerLabel: string | null;
  connectionLabel: string | null;
  brand: string | null;
  isWrite: boolean;
  riskLevel: 'low' | 'medium' | 'high';
  detail: string;
  tool: PaletteTool | null;
}

export function describeToolNode(
  data: ToolNodeData,
  palette: Palette | undefined,
  options: { loading?: boolean; error?: boolean } = {},
): ToolNodePresentation {
  const toolName = typeof data.tool === 'string' ? data.tool.trim() : '';
  const integration = findIntegration(palette, data.integration_id);

  if (!toolName) {
    return statePresentation('unconfigured', {
      actionLabel: 'Tool auswählen',
      providerLabel: integration?.label ?? null,
      connectionLabel: null,
      brand: integration?.brand ?? null,
      detail: 'Wähle eine berechtigte MCP-Fabric-Aktion.',
    });
  }

  if (options.error && !palette) {
    return statePresentation('error', {
      actionLabel: toolName,
      providerLabel: integration?.label ?? null,
      connectionLabel: null,
      brand: integration?.brand ?? null,
      detail: 'Der MCP-Fabric-Katalog ist nicht erreichbar.',
    });
  }

  if (!palette || options.loading) {
    return statePresentation('checking', {
      actionLabel: toolName,
      providerLabel: integration?.label ?? null,
      connectionLabel: null,
      brand: integration?.brand ?? null,
      detail: 'Berechtigung und Verbindung werden geprüft.',
    });
  }

  const tool = palette.tools.find((candidate) => candidate.name === toolName) ?? null;
  if (tool) {
    return {
      state: 'ready',
      actionLabel: tool.action_label ?? tool.name,
      providerLabel: tool.integration_label ?? integration?.label ?? null,
      connectionLabel: tool.connection_name ?? tool.backend ?? null,
      brand: tool.integration_brand ?? integration?.brand ?? null,
      isWrite: Boolean(tool.is_write),
      riskLevel: tool.risk_level ?? (tool.is_write ? 'medium' : 'low'),
      detail: tool.description || tool.name,
      tool,
    };
  }

  if (integration?.state === 'unconfigured') {
    return statePresentation('missing', {
      actionLabel: toolName,
      providerLabel: integration.label,
      connectionLabel: null,
      brand: integration.brand,
      detail: `${integration.label} muss im MCP Fabric verbunden werden.`,
    });
  }

  if (integration?.state === 'unavailable') {
    return statePresentation('missing', {
      actionLabel: toolName,
      providerLabel: integration.label,
      connectionLabel: null,
      brand: integration.brand,
      detail: `${integration.label} ist für diese Identität nicht verfügbar.`,
    });
  }

  return statePresentation('missing', {
    actionLabel: toolName,
    providerLabel: integration?.label ?? null,
    connectionLabel: null,
    brand: integration?.brand ?? null,
    detail: 'Das Tool fehlt im berechtigten MCP-Fabric-Katalog.',
  });
}

function findIntegration(palette: Palette | undefined, integrationId: string | null | undefined): PaletteIntegration | null {
  if (!integrationId) return null;
  return palette?.integrations?.find((candidate) => candidate.id === integrationId) ?? null;
}

function statePresentation(
  state: Exclude<ToolNodeState, 'ready'>,
  values: Pick<ToolNodePresentation, 'actionLabel' | 'providerLabel' | 'connectionLabel' | 'brand' | 'detail'>,
): ToolNodePresentation {
  return {
    state,
    ...values,
    isWrite: false,
    riskLevel: 'low',
    tool: null,
  };
}
