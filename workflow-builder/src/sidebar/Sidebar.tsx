// Sidebar — categorized palette of node types.
// Items are HTML5-draggable; Canvas catches the drop and creates a node.

import { lazy, Suspense, useState, useRef, type DragEvent, type ChangeEvent } from 'react';
import { Plus, Search, Sparkles, Upload, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { getNodesByCategory, type NodeDefinition } from '@/nodes/registry';
import '@/nodes'; // populate registry
import { importFlowFromJson } from '@/canvas/exportImport';
import { usePalette, type Palette, type PaletteTool } from '@/api/palette';
import { groupIntegrations, resolveIntegrations, toolsForIntegration, type Integration } from './integrations';
import { BrandMark } from '@/components/BrandMark';
import { useBuilderStore } from '@/stores/builderStore';
import { cn } from '@/lib/utils';
import { getIcon } from '@/lib/iconRegistry';
import { portableToolNodeSeed } from '@/lib/portableToolBinding';
import { consoleStudioReturnPath, navigateToConsolePath } from '@/lib/studioBridge';

const TemplatesDialog = lazy(() => import('./TemplatesDialog').then((module) => ({ default: module.TemplatesDialog })));

const CATEGORIES: Array<{ id: 'triggers' | 'logic' | 'argus'; label: string }> = [
  { id: 'triggers', label: 'Auslöser' },
  { id: 'logic',    label: 'Logik' },
  { id: 'argus',    label: 'Argus Bausteine' },
];

function onDragStart(event: DragEvent<HTMLLIElement>, nodeType: string): void {
  event.dataTransfer.setData('application/argus-node-type', nodeType);
  event.dataTransfer.effectAllowed = 'move';
}

interface SidebarProps {
  mobileOpen?: boolean;
  onClose?: () => void;
}

export function Sidebar({ mobileOpen = false, onClose }: SidebarProps) {
  const [query, setQuery] = useState('');
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const q = query.trim().toLowerCase();

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setImportError(null);
    try {
      const r = await importFlowFromJson(f);
      navigate(`/${r.id}`);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  return (
    <>
      {mobileOpen && (
        <button
          type="button"
          className="builder-panel-backdrop"
          aria-label="Blockbibliothek schließen"
          onClick={onClose}
        />
      )}
      <aside
        aria-label="Blockbibliothek"
        className={cn('builder-sidebar w-64 shrink-0 border-r border-border flex flex-col', mobileOpen && 'is-open')}
      >
      <div className="builder-sidebar-heading">
        <div>
          <span>BUILD</span>
          <strong>Blockbibliothek</strong>
        </div>
        <button type="button" className="builder-panel-close xl:hidden" onClick={onClose} aria-label="Blockbibliothek schließen">
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="p-3 border-b border-border">
        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="Block suchen…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 rounded-md bg-input border border-border text-small placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-4">
        {CATEGORIES.map((cat) => {
          const items = getNodesByCategory(cat.id).filter(
            (n) => !q || n.label.toLowerCase().includes(q) || n.type.toLowerCase().includes(q)
          );
          if (items.length === 0 && q) return null;
          return (
            <div key={cat.id}>
              <h3 className="px-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">
                {cat.label}
              </h3>
              <ul className="space-y-0.5">
                {items.map((node) => (
                  <SidebarItem key={node.type} node={node} onAdded={onClose} />
                ))}
              </ul>
            </div>
          );
        })}
        <IntegrationsGroup query={q} onAdded={onClose} />
      </div>
      <div className="p-3 border-t border-border space-y-2">
        <button
          onClick={() => setTemplatesOpen(true)}
          className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md bg-primary/15 hover:bg-primary/25 border border-primary/30 text-primary text-xs font-medium transition-colors"
        >
          <Sparkles className="w-3.5 h-3.5" />
          Neu aus Template
        </button>
        <button
          onClick={() => fileInputRef.current?.click()}
          className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md bg-secondary hover:bg-secondary/70 border border-border text-foreground/80 hover:text-foreground text-xs font-medium transition-colors"
        >
          <Upload className="w-3.5 h-3.5" />
          JSON importieren
        </button>
        <input ref={fileInputRef} type="file" accept="application/json,.json" hidden onChange={onFile} />
        {importError && (
          <div className="text-[11px] text-red-400 break-words">{importError}</div>
        )}
        <div className="text-xs text-muted-foreground text-center">
          Ziehen oder mit + hinzufügen
        </div>
      </div>
      {templatesOpen && (
        <Suspense fallback={null}>
          <TemplatesDialog open onClose={() => setTemplatesOpen(false)} />
        </Suspense>
      )}
      </aside>
    </>
  );
}

function SidebarItem({ node, onAdded }: { node: NodeDefinition; onAdded?: () => void }) {
  const Icon = getIcon(node.icon);
  const addNode = useBuilderStore((state) => state.addNode);
  const nodeCount = useBuilderStore((state) => state.nodes.length);

  function addToCanvas() {
    addNode({
      id: `${node.type}.${crypto.randomUUID().slice(0, 8)}`,
      type: node.type,
      position: { x: 96 + (nodeCount % 5) * 32, y: 96 + (nodeCount % 4) * 36 },
      data: node.defaultData(),
    });
    onAdded?.();
  }

  return (
    <li
      draggable
      onDragStart={(e) => onDragStart(e, node.type)}
      className="group flex items-center gap-2 px-2 py-1.5 rounded-md text-small text-foreground/80 hover:bg-secondary hover:text-foreground cursor-grab active:cursor-grabbing transition-colors"
      title={node.description}
    >
      <Icon className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate flex-1">{node.label}</span>
      <button
        type="button"
        className="builder-add-block"
        onClick={(event) => { event.stopPropagation(); addToCanvas(); }}
        aria-label={`${node.label} hinzufügen`}
        title={`${node.label} zum Canvas hinzufügen`}
      >
        <Plus className="w-3 h-3" />
      </button>
    </li>
  );
}

function IntegrationsGroup({ query, onAdded }: { query: string; onAdded?: () => void }) {
  const [picker, setPicker] = useState<Integration | null>(null);
  const { data: palette, isLoading } = usePalette();
  const items = resolveIntegrations(palette).filter(
    (integration) => !query
      || integration.label.toLowerCase().includes(query)
      || integration.id.includes(query)
      || integration.category.toLowerCase().includes(query)
      || toolsForIntegration(integration, palette?.tools ?? []).some(tool =>
        `${tool.action_label ?? ''} ${tool.name}`.toLowerCase().includes(query))
  );
  const groups = groupIntegrations(items);
  const readyCount = items.filter((integration) => integration.state === 'ready').length;
  if (
    items.length === 0
    && query
    && !'integrations'.includes(query)
    && !'integrationen'.includes(query)
  ) return null;
  return (
    <div>
      <div className="builder-integration-heading px-2 mb-1">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Integrationen</h3>
        {!isLoading && <span>{readyCount} verbunden</span>}
      </div>
      <div className="builder-integration-groups">
        {groups.map((group) => (
          <section key={group.category} className="builder-integration-group" aria-label={`${group.category} integrations`}>
            <h4>{group.category}</h4>
            <ul className="space-y-0.5">
              {group.integrations.map((integration) => (
                <IntegrationItem
                  key={integration.id}
                  integration={integration}
                  onPick={() => setPicker(integration)}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
      {isLoading && <p className="px-2 py-1 text-[11px] text-muted-foreground">Integrationen werden geladen…</p>}
      {picker && <ToolPickerDialog integration={picker} palette={palette} onClose={() => setPicker(null)} onAdded={onAdded} />}
    </div>
  );
}

function IntegrationItem({ integration, onPick }: { integration: Integration; onPick: () => void }) {
  const ready = integration.state === 'ready';
  const configurable = integration.state === 'unconfigured' && integration.can_configure;

  function activate() {
    if (ready) onPick();
    else if (configurable) {
      const target = new URL(integration.configure_href, window.location.origin);
      target.searchParams.set('returnTo', consoleStudioReturnPath());
      navigateToConsolePath(`${target.pathname}${target.search}${target.hash}`);
    }
  }

  return (
    <li
      onClick={activate}
      className={cn(
        'builder-integration-item flex items-center gap-2 px-2 py-1.5 rounded-md text-small transition-colors',
        (ready || configurable) && 'hover:bg-secondary hover:text-foreground cursor-pointer',
        !ready && !configurable && 'is-unavailable',
      )}
      title={ready ? `${integration.label}-Tool wählen` : integration.description}
    >
      <BrandMark brand={integration.brand} label={integration.label} fallbackIcon={integration.fallback_icon} />
      <span className="truncate flex-1">{integration.label}</span>
      <span className="builder-integration-state" data-state={integration.state}>
        {ready ? integration.tool_count : configurable ? 'Setup' : '—'}
      </span>
    </li>
  );
}

function startToolDrag(event: DragEvent<HTMLLIElement>, tool: PaletteTool): void {
  event.dataTransfer.setData('application/argus-node-type', 'argus.tool');
  event.dataTransfer.setData(
    'application/argus-node-seed',
    JSON.stringify(portableToolNodeSeed(tool))
  );
  event.dataTransfer.effectAllowed = 'move';
}

function ToolPickerDialog({ integration, palette, onClose, onAdded }: { integration: Integration; palette: Palette | undefined; onClose: () => void; onAdded?: () => void }) {
  const addNode = useBuilderStore((state) => state.addNode);
  const nodeCount = useBuilderStore((state) => state.nodes.length);
  const tools = palette ? toolsForIntegration(integration, palette.tools) : [];

  function addTool(tool: PaletteTool) {
    addNode({
      id: `argus.tool.${crypto.randomUUID().slice(0, 8)}`,
      type: 'argus.tool',
      position: { x: 112 + (nodeCount % 5) * 32, y: 112 + (nodeCount % 4) * 36 },
      data: portableToolNodeSeed(tool),
    });
    onClose();
    onAdded?.();
  }
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
      role="dialog"
      aria-label={`${integration.label} Tools`}
    >
      <div
        className="w-96 max-h-[70vh] overflow-y-auto rounded-lg border border-border bg-card p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-small font-medium">{integration.label} — Tool wählen</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground p-1 rounded hover:bg-secondary">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        <p className="text-[11px] text-muted-foreground mb-2">
          Tool auf den Canvas ziehen oder direkt mit + hinzufügen.
        </p>
        {tools.length === 0 && (
          <p className="text-xs text-muted-foreground">Keine {integration.label}-Tools verfügbar (Bundle prüfen).</p>
        )}
        <ul className="space-y-0.5">
          {tools.map((t) => (
            <li
              key={t.id}
              draggable
              onDragStart={(e) => startToolDrag(e, t)}
              className="group flex flex-row items-center gap-2 px-2 py-1.5 rounded-md text-small text-foreground/80 hover:bg-secondary hover:text-foreground cursor-grab active:cursor-grabbing transition-colors"
              title={t.description}
            >
              <BrandMark brand={t.integration_brand} label={t.integration_label ?? integration.label} fallbackIcon={integration.fallback_icon} />
              <span className="min-w-0 flex-1 flex flex-col">
                <span className="truncate font-medium">{t.action_label ?? t.name}</span>
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground truncate">
                  {t.connection_name ?? t.integration_label ?? t.backend}
                  {t.is_write ? ` · ${t.risk_level ?? 'medium'} risk` : ''}
                </span>
                {t.description && <span className="text-[11px] text-muted-foreground truncate">{t.description}</span>}
              </span>
              <button
                type="button"
                className="builder-add-block"
                onClick={(event) => { event.stopPropagation(); addTool(t); }}
                aria-label={`${t.action_label ?? t.name} hinzufügen`}
              >
                <Plus className="w-3 h-3" />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
