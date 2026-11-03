import { useEffect } from 'react';
import { ArrowRight, Boxes, ShieldCheck, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { FabricBundle, FabricManagementBackend, FabricManagementBundle, FabricServer } from '../types';
import { BrandIcon, resolveBackendBrand } from './BrandIcon';
import { HealthBadge } from './Ui';

function BackendMark({ server }: { server: Pick<FabricServer, 'name' | 'endpoint'> }) {
  return (
    <BrandIcon
      brand={resolveBackendBrand(server.name, server.endpoint) ?? ''}
      label={server.name}
      className="bundle-backend-icon"
    />
  );
}

export function BundleInspectorDialog({
  bundle,
  managedBundle,
  connections,
  backends,
  onClose,
}: {
  bundle: FabricBundle;
  managedBundle: FabricManagementBundle | null;
  connections: FabricServer[];
  backends: FabricManagementBackend[];
  onClose: () => void;
}) {
  useEffect(() => {
    document.body.classList.add('has-dialog');
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.classList.remove('has-dialog');
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  return (
    <div className="editor-layer" role="presentation" onMouseDown={onClose}>
      <section className="bundle-inspector-dialog" role="dialog" aria-modal="true" aria-labelledby="bundle-inspector-title" onMouseDown={event => event.stopPropagation()}>
        <header className="editor-header">
          <div className="bundle-inspector-title">
            <span><Boxes size={20} /></span>
            <div>
              <span className="eyebrow">MCP FABRIC · BUNDLE DETAILS</span>
              <h2 id="bundle-inspector-title">{bundle.label}</h2>
              <p>{managedBundle?.description || 'Reusable access boundary for governed backend tools.'}</p>
            </div>
          </div>
          <button className="editor-close" type="button" aria-label="Close bundle details" onClick={onClose}><X size={17} /></button>
        </header>
        <div className="bundle-inspector-body">
          <div className="bundle-quick-facts">
            <span><small>Connections</small><b>{bundle.serverCount}</b></span>
            <span><small>Effective tools</small><b>{bundle.toolCount}</b></span>
            <span><small>Workflows</small><b>{managedBundle?.workflowCount ?? '—'}</b></span>
            <span><small>Policy consumers</small><b>{managedBundle?.compositeCount ?? '—'}</b></span>
          </div>
          <div className="bundle-quick-columns">
            <div>
              <small>CONNECTED BACKENDS</small>
              <div className="bundle-backend-list">
                {connections.length > 0 ? connections.map(server => (
                  <span key={server.id}>
                    <BackendMark server={server} />
                    <b>{server.name}</b>
                    <HealthBadge state={server.state} />
                  </span>
                )) : <em>No backend assigned.</em>}
              </div>
            </div>
            <div>
              <small>TOOL POLICY</small>
              <div className="bundle-policy-list">
                {managedBundle?.toolPolicies.length ? managedBundle.toolPolicies.map(policy => {
                  const backend = backends.find(item => item.id === policy.backendId);
                  return (
                    <span key={`${policy.backendId}-${policy.mode}`}>
                      <ShieldCheck size={14} />
                      <b>{backend?.name ?? `Backend #${policy.backendId}`}</b>
                      <em>{policy.mode === 'all' ? 'All discovered tools' : `${policy.allowedToolNames.length} selected tools`}</em>
                    </span>
                  );
                }) : <em>All assigned backend tools; downstream identity policies can narrow access.</em>}
              </div>
            </div>
          </div>
        </div>
        <footer className="bundle-inspector-footer">
          <span><ShieldCheck size={13} />Effective access is recalculated from current bundle and identity policies.</span>
          <Link className="button button-primary" to={`/mcp-fabric/bundles/${bundle.id}`}>Open full bundle <ArrowRight size={14} /></Link>
        </footer>
      </section>
    </div>
  );
}
