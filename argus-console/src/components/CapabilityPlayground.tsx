import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  Braces,
  CheckCircle2,
  Clock3,
  Eye,
  LockKeyhole,
  Play,
  Power,
  Send,
  ShieldCheck,
  X,
} from 'lucide-react';
import type {
  CapabilityParameter,
  CapabilityPlaygroundMutation,
  CapabilityPlaygroundParameters,
  CapabilityPlaygroundResult,
  CapabilityStudioItem,
} from '../types';

type ParameterDraft = Record<string, string | boolean>;

export function supportsCapabilityPlayground(capability: CapabilityStudioItem): boolean {
  return capability.source === 'managed'
    && capability.managedId != null
    && capability.backend.startsWith('custom:');
}

function initialParameterValues(parameters: CapabilityParameter[]): ParameterDraft {
  return Object.fromEntries(parameters.map(parameter => {
    if (parameter.type === 'boolean') {
      return [parameter.name, parameter.default?.toLowerCase() === 'true'];
    }
    return [parameter.name, parameter.default ?? ''];
  }));
}

function stringParameterValue(draft: ParameterDraft, name: string): string {
  const value = draft[name];
  return typeof value === 'string' ? value : '';
}

function prepareParameters(
  definitions: CapabilityParameter[],
  draft: ParameterDraft,
): { parameters: CapabilityPlaygroundParameters; error: string | null } {
  const parameters: CapabilityPlaygroundParameters = {};
  for (const definition of definitions) {
    const value = draft[definition.name];
    if (definition.type === 'boolean') {
      parameters[definition.name] = value === true;
      continue;
    }

    const rawText = typeof value === 'string' ? value : '';
    const normalizedText = rawText.trim();
    if (!normalizedText) {
      if (definition.required) return { parameters: {}, error: `${definition.name} is required.` };
      continue;
    }
    if (definition.type === 'number') {
      const numberValue = Number(normalizedText);
      if (!Number.isFinite(numberValue)) return { parameters: {}, error: `${definition.name} must be a valid number.` };
      parameters[definition.name] = numberValue;
    } else {
      parameters[definition.name] = rawText;
    }
  }
  return { parameters, error: null };
}

function formatBody(body: string, contentType: string | null): string {
  if (!body || !contentType?.toLowerCase().includes('json')) return body;
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

export function CapabilityPlayground({
  capability,
  running,
  activating,
  error,
  onRun,
  onActivate,
  onClose,
}: {
  capability: CapabilityStudioItem;
  running: boolean;
  activating: boolean;
  error: string | null;
  onRun: (input: CapabilityPlaygroundMutation) => Promise<CapabilityPlaygroundResult>;
  onActivate: () => Promise<void>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<ParameterDraft>(() => initialParameterValues(capability.parameters));
  const [result, setResult] = useState<CapabilityPlaygroundResult | null>(null);
  const [validationError, setValidationError] = useState('');
  const [writeConfirmed, setWriteConfirmed] = useState(false);
  const [activity, setActivity] = useState<'preview' | 'execute' | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const busy = running || activating;
  const busyRef = useRef(busy);
  const onCloseRef = useRef(onClose);
  busyRef.current = busy;
  onCloseRef.current = onClose;
  const headerEntries = useMemo(() => Object.entries(result?.request.headers ?? {}), [result]);
  const effectiveIsWrite = result?.capability.isWrite ?? capability.isWrite;
  const effectiveRiskLevel = result?.capability.riskLevel ?? capability.riskLevel;
  const executionSucceeded = Boolean(result?.executed && result.response && result.response.status >= 200 && result.response.status < 300);
  const activationReady = Boolean(result && (effectiveIsWrite ? !result.executed || executionSucceeded : executionSucceeded));

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusableSelector = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href]';
    if (!dialogRef.current?.contains(document.activeElement)) {
      dialogRef.current?.querySelector<HTMLElement>(focusableSelector)?.focus();
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) {
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(focusableSelector));
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      previousFocus?.focus();
    };
  }, []);

  const changeParameter = (name: string, value: string | boolean) => {
    setDraft(current => ({ ...current, [name]: value }));
    setResult(null);
    setWriteConfirmed(false);
    setValidationError('');
  };

  const run = async (execute: boolean, confirmWrite = false) => {
    const prepared = prepareParameters(capability.parameters, draft);
    if (prepared.error) {
      setValidationError(prepared.error);
      return;
    }
    setValidationError('');
    setResult(null);
    setWriteConfirmed(false);
    setActivity(execute ? 'execute' : 'preview');
    try {
      const next = await onRun({
        parameters: prepared.parameters,
        execute,
        confirmWrite,
      });
      setResult(next);
      if (execute) setWriteConfirmed(false);
    } catch {
      // The mutation owner exposes the sanitized server error through the error prop.
    } finally {
      setActivity(null);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(false);
  };

  return (
    <div className="editor-layer capability-playground-layer" role="presentation" onMouseDown={() => { if (!busy) onClose(); }}>
      <section
        ref={dialogRef}
        className="bundle-editor capability-playground"
        role="dialog"
        aria-modal="true"
        aria-labelledby="capability-playground-title"
        aria-describedby="capability-playground-description"
        onMouseDown={event => event.stopPropagation()}
      >
        <header className="editor-header capability-playground-header">
          <div className="capability-playground-title">
            <span className={effectiveIsWrite ? 'is-write' : ''}><Play size={19} /></span>
            <div>
              <span className="eyebrow">MCP FABRIC · SAFE TEST ENVIRONMENT</span>
              <h2 id="capability-playground-title">Test <code>{capability.name}</code></h2>
              <p id="capability-playground-description">Render the exact request first, then run it with server-enforced runtime guardrails.</p>
            </div>
          </div>
          <div className="capability-playground-badges" aria-label="Capability posture">
            <span className={effectiveIsWrite ? 'is-write' : 'is-read'}>{effectiveIsWrite ? 'WRITE' : 'READ'}</span>
            <span className={`risk-${effectiveRiskLevel}`}>{effectiveRiskLevel} risk</span>
            <span className={capability.enabled ? 'is-enabled' : 'is-staged'}>{capability.enabled ? 'ACTIVE' : 'STAGED'}</span>
          </div>
          <button type="button" className="editor-close" aria-label="Close capability playground" disabled={busy} onClick={onClose}><X size={18} /></button>
        </header>

        <form className="capability-playground-body" onSubmit={submit}>
          <div className="capability-playground-inputs">
            <section className="playground-section">
              <div className="playground-section-heading">
                <span><Braces size={15} /></span>
                <div><small>INPUT CONTRACT</small><h3>Runtime parameters</h3></div>
                <strong>{capability.parameters.length}</strong>
              </div>
              {capability.parameters.length > 0 ? (
                <div className="playground-parameter-list">
                  {capability.parameters.map((parameter, index) => (
                    parameter.type === 'boolean' ? (
                      <label className="playground-boolean-field" key={parameter.name}>
                        <input
                          autoFocus={index === 0}
                          type="checkbox"
                          checked={draft[parameter.name] === true}
                          onChange={event => changeParameter(parameter.name, event.target.checked)}
                        />
                        <span><b>{parameter.name}{parameter.required && <em>required</em>}</b><small>{parameter.description || 'Boolean input'}</small></span>
                        <strong>{draft[parameter.name] === true ? 'TRUE' : 'FALSE'}</strong>
                      </label>
                    ) : (
                      <label className="editor-field playground-parameter-field" key={parameter.name}>
                        <span>{parameter.name}{parameter.required && <em>required</em>}<i>{parameter.type}</i></span>
                        <input
                          autoFocus={index === 0}
                          type={parameter.type === 'number' ? 'number' : 'text'}
                          step={parameter.type === 'number' ? 'any' : undefined}
                          required={parameter.required}
                          value={stringParameterValue(draft, parameter.name)}
                          onChange={event => changeParameter(parameter.name, event.target.value)}
                          placeholder={parameter.default ? `Default: ${parameter.default}` : parameter.required ? 'Required value' : 'Optional'}
                        />
                        <small>{parameter.description || `${parameter.type} input for this capability.`}</small>
                      </label>
                    )
                  ))}
                </div>
              ) : (
                <div className="playground-no-parameters"><CheckCircle2 size={17} /><span><b>No runtime inputs</b><small>This capability can be rendered and tested as-is.</small></span></div>
              )}
            </section>

            <section className={`playground-safety-card${effectiveIsWrite ? ' is-write' : ''}`}>
              {effectiveIsWrite ? <AlertTriangle size={17} /> : <ShieldCheck size={17} />}
              <div>
                <small>{effectiveIsWrite ? 'TWO-STEP WRITE GATE' : 'ISOLATED READ TEST'}</small>
                <b>{effectiveIsWrite ? 'Preview before execution' : result ? 'Preview verified as read-only' : 'Preview before execution'}</b>
                <p>{effectiveIsWrite
                  ? 'Argus renders a masked request first. Execution stays locked until you explicitly confirm this exact parameter set.'
                  : result
                    ? 'Argus verified the effective method. The test uses the same authentication, egress and response limits as the runtime.'
                    : 'Argus verifies the effective method on the server before any upstream request is sent.'}</p>
              </div>
            </section>

            {effectiveIsWrite && result && !result.executed && (
              <label className={`playground-write-confirmation${writeConfirmed ? ' is-confirmed' : ''}`}>
                <input type="checkbox" checked={writeConfirmed} onChange={event => setWriteConfirmed(event.target.checked)} />
                <LockKeyhole size={16} />
                <span><b>Confirm this write request</b><small>I reviewed the rendered target and payload and understand that execution may change upstream state.</small></span>
              </label>
            )}

            {(validationError || error) && (
              <div className="editor-error playground-error" role="alert"><AlertTriangle size={15} /><span>{validationError || error}</span></div>
            )}

            <div className="playground-actions">
              <button type="button" className="button button-secondary" disabled={busy} onClick={() => void run(false)}>
                <Eye size={14} />{running && activity === 'preview' ? 'Rendering…' : result && !result.executed ? 'Refresh preview' : 'Preview request'}
              </button>
              {effectiveIsWrite ? (
                <button
                  type="button"
                  className="button button-danger playground-execute-write"
                  disabled={busy || !result || result.executed || !writeConfirmed}
                  onClick={() => void run(true, true)}
                ><Send size={14} />{running && activity === 'execute' ? 'Executing…' : 'Execute confirmed write'}</button>
              ) : result ? (
                <button type="button" className="button button-primary" disabled={busy} onClick={() => void run(true)}>
                  <Play size={14} />{running && activity === 'execute' ? 'Running…' : 'Run read test'}
                </button>
              ) : null}
            </div>
          </div>

          <div className="capability-playground-output" aria-live="polite">
            {result ? (
              <>
                <section className="playground-request-card">
                  <header>
                    <span><Eye size={14} /></span>
                    <div><small>MASKED REQUEST PREVIEW</small><h3>Rendered upstream request</h3></div>
                    <em className={effectiveIsWrite ? 'is-write' : ''}>{result.request.method}</em>
                  </header>
                  <div className="playground-request-target"><code>{result.request.target}</code></div>
                  <div className="playground-code-block">
                    <span>HEADERS · SECRETS MASKED BY ARGUS</span>
                    {headerEntries.length > 0 ? (
                      <dl>{headerEntries.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl>
                    ) : <small>No additional request headers</small>}
                  </div>
                  {result.request.body != null && (
                    <div className="playground-code-block">
                      <span>BODY</span>
                      <pre>{result.request.body || '(empty body)'}</pre>
                    </div>
                  )}
                </section>

                {result.response ? (
                  <section className={`playground-response-card${result.response.status >= 400 ? ' is-error' : ''}`}>
                    <header>
                      <span><CheckCircle2 size={14} /></span>
                      <div><small>UPSTREAM RESPONSE</small><h3>{result.response.status} {result.response.statusText}</h3></div>
                      <div className="playground-response-meta"><span><Clock3 size={12} />{result.response.durationMs} ms</span>{result.response.contentType && <code>{result.response.contentType}</code>}</div>
                    </header>
                    <pre>{formatBody(result.response.body, result.response.contentType)}</pre>
                    {result.response.truncated && <div className="playground-truncated"><AlertTriangle size={13} />Response truncated at the safe playground limit.</div>}
                  </section>
                ) : (
                  <div className="playground-response-empty"><LockKeyhole size={18} /><span><b>Not executed</b><small>The request above is a safe preview. No upstream state was read or changed.</small></span></div>
                )}

                {!capability.enabled && activationReady && (
                  <section className="playground-activation-card">
                    <span><Power size={17} /></span>
                    <div><small>{effectiveIsWrite && !result.executed ? 'WRITE PREVIEW REVIEWED' : 'TEST PASSED'}</small><b>Ready for runtime activation</b><p>{effectiveIsWrite && !result.executed ? 'Activation does not execute the write request.' : 'Enable this capability without leaving the playground.'}</p></div>
                    <button
                      type="button"
                      className="button button-primary"
                      disabled={busy}
                      onClick={() => {
                        if (!window.confirm(`Activate ${capability.name} for authorized runtimes?`)) return;
                        void onActivate().catch(() => undefined);
                      }}
                    ><Power size={14} />{activating ? 'Activating…' : 'Activate capability'}</button>
                  </section>
                )}
              </>
            ) : (
              <div className="playground-output-empty">
                <span><Eye size={21} /></span>
                <b>Request preview appears here</b>
                <p>Credentials are injected and masked only on the server. They never enter your browser or parameter form.</p>
              </div>
            )}
          </div>
        </form>
      </section>
    </div>
  );
}
