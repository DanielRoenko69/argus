// Schema-driven config form for an argus.tool node. Given a tool's declared
// parameter schema (PaletteTool.parameters from Component B), auto-renders a
// typed field per parameter: string→text, number→number, boolean→checkbox.
// Required params get an asterisk + validate(); descriptions render as help
// text. Values may contain {{ }} templates (passed through verbatim). When the
// tool is freeform (no schema), a raw-JSON args editor is shown instead.
//
// Stateless w.r.t. node data: parent owns `args` and receives the next args
// object via onChange. validate() is a static, pure helper used by callers.

import { useMemo, useState } from 'react';
import type { ToolParam } from '@/api/palette';

const inputCls =
  'w-full px-2.5 py-1.5 rounded-md bg-input border border-border text-small focus:outline-none focus:ring-1 focus:ring-ring';

export interface ToolConfigFormProps {
  parameters: ToolParam[];
  args: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  /** Force the JSON editor regardless of `parameters`. */
  freeform?: boolean;
}

/** True when a value satisfies a required field (non-empty or a {{ }} template). */
function isProvided(value: unknown): boolean {
  if (typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.trim().length > 0;
  return value != null;
}

interface ToolConfigFormComponent {
  (props: ToolConfigFormProps): React.ReactNode;
  /** Returns the names of required params missing from `args`. Pure. */
  validate: (parameters: ToolParam[], args: Record<string, unknown>) => string[];
}

export const ToolConfigForm: ToolConfigFormComponent = (props) => {
  const { parameters, args, onChange, freeform } = props;
  const useJson = freeform || parameters.length === 0;

  if (useJson) {
    return <JsonArgsEditor args={args} onChange={onChange} />;
  }

  function setField(name: string, value: unknown): void {
    const next = { ...args };
    if (value === undefined) delete next[name];
    else next[name] = value;
    onChange(next);
  }

  return (
    <div className="space-y-3">
      {parameters.map((p) => {
        const id = `tcf-${p.name}`;
        const value = args[p.name];
        return (
          <div key={p.name} className="space-y-1">
            <label htmlFor={id} className="text-xs font-medium text-muted-foreground flex items-center gap-0.5">
              <span>{p.name}</span>
              {p.required && <span className="text-red-400" aria-hidden="true">*</span>}
            </label>
            <ParamInput id={id} param={p} value={value} onChange={(v) => setField(p.name, v)} />
            {p.description && (
              <p className="text-[11px] text-muted-foreground/80 leading-tight">{p.description}</p>
            )}
          </div>
        );
      })}
    </div>
  );
};

ToolConfigForm.validate = (parameters, args) =>
  parameters.filter((p) => p.required && !isProvided(args[p.name])).map((p) => p.name);

interface ParamInputProps {
  id: string;
  param: ToolParam;
  value: unknown;
  onChange: (v: unknown) => void;
}

function ParamInput({ id, param, value, onChange }: ParamInputProps) {
  switch (param.type) {
    case 'boolean':
      return (
        <input
          id={id}
          type="checkbox"
          checked={Boolean(value ?? param.default ?? false)}
          onChange={(e) => onChange(e.target.checked)}
          className="w-4 h-4 accent-primary"
        />
      );
    case 'number':
      return (
        <input
          id={id}
          type="number"
          // Allow {{ }} templates even in a number field: keep as string when not numeric.
          value={value === undefined ? (param.default as number | undefined) ?? '' : String(value)}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === '') return onChange(undefined);
            if (raw.includes('{{')) return onChange(raw);
            const n = Number(raw);
            onChange(Number.isNaN(n) ? raw : n);
          }}
          className={inputCls}
        />
      );
    case 'string':
    default:
      return (
        <input
          id={id}
          type="text"
          value={value === undefined ? (param.default as string | undefined) ?? '' : String(value)}
          placeholder="{{ var }} oder Literal"
          onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
          className={inputCls}
        />
      );
  }
}

function JsonArgsEditor({
  args,
  onChange,
}: {
  args: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const initial = useMemo(() => JSON.stringify(args ?? {}, null, 2), [args]);
  const [text, setText] = useState(initial);
  const [error, setError] = useState<string | null>(null);

  function handle(raw: string): void {
    setText(raw);
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setError('args must be a JSON object');
        return;
      }
      setError(null);
      onChange(parsed as Record<string, unknown>);
    } catch {
      setError('Invalid JSON');
    }
  }

  return (
    <div className="space-y-1">
      <label htmlFor="tcf-json" className="text-xs font-medium text-muted-foreground">
        Raw JSON args
      </label>
      <textarea
        id="tcf-json"
        value={text}
        rows={8}
        spellCheck={false}
        onChange={(e) => handle(e.target.value)}
        className={`${inputCls} font-mono`}
      />
      {error && <p className="text-[11px] text-red-400">{error}</p>}
    </div>
  );
}
