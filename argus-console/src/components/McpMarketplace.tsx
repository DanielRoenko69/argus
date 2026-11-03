import { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  Check,
  Copy,
  ExternalLink,
  PackageSearch,
  Plus,
  Search,
  Server,
  ShieldAlert,
  ShieldCheck,
  X,
} from 'lucide-react';
import {
  MCP_CATALOG,
  MCP_CATALOG_CATEGORIES,
  type McpCatalogItem,
} from '../data/mcpCatalog';
import type { FabricManagementBackend } from '../types';
import { BrandIcon } from './BrandIcon';

function repositoryUrl(repository: string): string {
  return `https://${repository.replace(/^https?:\/\//, '')}`;
}

function normalizedUrl(value: string): string {
  return value.replace(/\/$/, '').toLowerCase();
}

function isConnected(item: McpCatalogItem, connections: FabricManagementBackend[]): boolean {
  const suggested = normalizedUrl(item.suggestedUrl);
  return connections.some(connection =>
    connection.name === item.id
    || normalizedUrl(connection.endpoint) === suggested
    || normalizedUrl(connection.baseUrl) === suggested,
  );
}

export function McpMarketplace({
  connections,
  initialSelection = null,
  onClose,
  onConnect,
  onCustom,
}: {
  connections: FabricManagementBackend[];
  initialSelection?: string | null;
  onClose: () => void;
  onConnect: (item: McpCatalogItem) => void;
  onCustom: (type: 'mcp' | 'http') => void;
}) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'vendor' | 'community' | string>('all');
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    MCP_CATALOG.some(item => item.id === initialSelection) ? initialSelection : null
  );
  const [copied, setCopied] = useState(false);
  const selected = MCP_CATALOG.find(item => item.id === selectedId) ?? null;
  const connectedIds = useMemo(
    () => new Set(MCP_CATALOG.filter(item => isConnected(item, connections)).map(item => item.id)),
    [connections],
  );
  const filtered = useMemo(() => {
    const normalized = search.trim().toLowerCase();
    return MCP_CATALOG.filter(item => {
      const matchesFilter = filter === 'all'
        || filter === 'vendor' && item.publisherKind === 'vendor'
        || filter === 'community' && item.publisherKind === 'community'
        || item.category === filter;
      if (!matchesFilter) return false;
      return !normalized
        || `${item.name} ${item.publisher} ${item.description} ${item.category} ${item.tags.join(' ')} ${item.tools.join(' ')}`
          .toLowerCase()
          .includes(normalized);
    });
  }, [filter, search]);

  useEffect(() => {
    document.body.classList.add('has-dialog');
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (selectedId) setSelectedId(null);
        else onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.classList.remove('has-dialog');
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose, selectedId]);

  const copyLaunchHint = async () => {
    if (!selected?.launchHint) return;
    try {
      await navigator.clipboard.writeText(selected.launchHint);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="marketplace-layer" role="presentation" onMouseDown={onClose}>
      <section
        className="marketplace-shell"
        role="dialog"
        aria-modal="true"
        aria-labelledby="marketplace-title"
        onMouseDown={event => event.stopPropagation()}
      >
        <header className="marketplace-header">
          <div className="marketplace-title">
            <span><PackageSearch size={20} /></span>
            <div>
              <small>MCP FABRIC · CURATED CATALOG</small>
              <h2 id="marketplace-title">Connect trusted building blocks</h2>
              <p>Choose a preset, review its publisher and deployment guidance, then finish the configuration in Argus.</p>
            </div>
          </div>
          <div className="marketplace-header-actions">
            <a href="https://registry.modelcontextprotocol.io/" target="_blank" rel="noreferrer">
              Official MCP Registry <ExternalLink size={13} />
            </a>
            <button type="button" aria-label="Close marketplace" onClick={onClose}><X size={18} /></button>
          </div>
        </header>

        <div className="marketplace-stats">
          <span><b>{MCP_CATALOG.length}</b> curated presets</span>
          <span><b>{MCP_CATALOG.filter(item => item.publisherKind === 'vendor').length}</b> vendor presets</span>
          <span><b>{connectedIds.size}</b> already connected</span>
          <span className="marketplace-safety"><ShieldAlert size={14} />Metadata is not a security approval</span>
        </div>

        <div className="marketplace-toolbar">
          <label className="marketplace-search">
            <Search size={16} />
            <input
              autoFocus
              value={search}
              onChange={event => setSearch(event.target.value)}
              placeholder="Search servers, capabilities and publishers"
            />
            {search && <button type="button" aria-label="Clear search" onClick={() => setSearch('')}><X size={13} /></button>}
          </label>
          <button type="button" className="marketplace-custom" onClick={() => onCustom('mcp')}><Plus size={14} />Custom MCP</button>
          <button type="button" className="marketplace-custom" onClick={() => onCustom('http')}><Plus size={14} />HTTP backend</button>
        </div>

        <nav className="marketplace-filters" aria-label="Catalog filters">
          <button type="button" className={filter === 'all' ? 'is-active' : ''} onClick={() => setFilter('all')}>All</button>
          <button type="button" className={filter === 'vendor' ? 'is-active' : ''} onClick={() => setFilter('vendor')}>
            <ShieldCheck size={12} />Vendor
          </button>
          <button type="button" className={filter === 'community' ? 'is-active' : ''} onClick={() => setFilter('community')}>Community</button>
          {MCP_CATALOG_CATEGORIES.map(category => (
            <button
              type="button"
              className={filter === category ? 'is-active' : ''}
              onClick={() => setFilter(category)}
              key={category}
            >
              {category}
            </button>
          ))}
        </nav>

        <div className={`marketplace-content${selected ? ' has-detail' : ''}`}>
          <div className="marketplace-results">
            <div className="marketplace-result-count">
              <span>{filtered.length} result{filtered.length === 1 ? '' : 's'}</span>
              <small>Presets only prefill configuration. Argus never executes the launch command.</small>
            </div>
            {filtered.length > 0 ? (
              <div className="marketplace-grid">
                {filtered.map(item => {
                  const connected = connectedIds.has(item.id);
                  return (
                    <article
                      className={`marketplace-card${selectedId === item.id ? ' is-selected' : ''}`}
                      key={item.id}
                    >
                      <button type="button" onClick={() => setSelectedId(item.id)}>
                        <div className="marketplace-card-head">
                          <BrandIcon brand={item.id} label={item.name} className="marketplace-icon" />
                          <span className={`publisher-badge publisher-${item.publisherKind}`}>
                            {item.publisherKind === 'vendor' && <ShieldCheck size={11} />}
                            {item.publisherKind === 'reference' ? 'Reference' : item.publisherKind}
                          </span>
                        </div>
                        <h3>{item.name}</h3>
                        <span className="marketplace-publisher">{item.publisher}</span>
                        <p>{item.description}</p>
                        <div className="marketplace-tags">
                          {item.tags.map(tag => <span key={tag}>{tag}</span>)}
                        </div>
                        <footer>
                          <span>{item.category}</span>
                          {connected
                            ? <strong className="is-connected"><Check size={12} />Connected</strong>
                            : <strong>Review <ArrowRight size={12} /></strong>}
                        </footer>
                      </button>
                    </article>
                  );
                })}
              </div>
            ) : (
              <div className="marketplace-empty">
                <PackageSearch size={28} />
                <b>No matching presets</b>
                <span>Try another capability, publisher or category.</span>
              </div>
            )}
          </div>

          {selected && (
            <aside className="marketplace-detail">
              <div className="marketplace-detail-head">
                <BrandIcon brand={selected.id} label={selected.name} className="marketplace-detail-icon" />
                <div>
                  <span className="eyebrow">{selected.category}</span>
                  <h3>{selected.name}</h3>
                  <p>{selected.publisher}</p>
                </div>
                <button type="button" aria-label="Close server details" onClick={() => setSelectedId(null)}><X size={15} /></button>
              </div>

              <div className={`marketplace-review-state publisher-${selected.publisherKind}`}>
                {selected.publisherKind === 'vendor' ? <ShieldCheck size={17} /> : <ShieldAlert size={17} />}
                <div>
                  <b>{selected.publisherKind === 'vendor' ? 'Vendor-maintained preset' : selected.publisherKind === 'reference' ? 'MCP reference preset' : 'Community-maintained preset'}</b>
                  <span>Verify repository, release and requested permissions before production use.</span>
                </div>
              </div>

              <p className="marketplace-detail-description">{selected.description}</p>

              <dl className="marketplace-facts">
                <div><dt>Suggested endpoint</dt><dd><code>{selected.suggestedUrl}</code></dd></div>
                <div>
                  <dt>Repository</dt>
                  <dd><a href={repositoryUrl(selected.repository)} target="_blank" rel="noreferrer">{selected.repository}<ExternalLink size={11} /></a></dd>
                </div>
              </dl>

              <div className="marketplace-launch">
                <div>
                  <span>Deployment guidance</span>
                  <button type="button" onClick={copyLaunchHint}>{copied ? <Check size={12} /> : <Copy size={12} />}{copied ? 'Copied' : 'Copy'}</button>
                </div>
                <code>{selected.launchHint || 'Review the publisher repository for current deployment instructions.'}</code>
                <small>This command is never executed by Argus.</small>
              </div>

              <div className="marketplace-tools">
                <div><span>Capability preview</span><b>{selected.tools.length || 'Dynamic'}</b></div>
                {selected.tools.length > 0
                  ? (
                      <div>
                        {selected.tools.slice(0, 12).map(tool => <code key={tool}>{tool}</code>)}
                        {selected.tools.length > 12 && <span>+{selected.tools.length - 12} more</span>}
                      </div>
                    )
                  : <p>Capabilities will be discovered from the live server after connection.</p>}
              </div>

              <div className="marketplace-detail-actions">
                <button type="button" className="button button-secondary" onClick={() => setSelectedId(null)}>Back</button>
                <button type="button" className="button button-primary" onClick={() => onConnect(selected)}>
                  <Server size={15} />{connectedIds.has(selected.id) ? 'Connect another' : 'Configure connection'}
                </button>
              </div>
            </aside>
          )}
        </div>
      </section>
    </div>
  );
}
