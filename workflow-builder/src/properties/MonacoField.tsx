// Monaco code editor wrapper for the FunctionNode's `function_code` field.
// Lazy-imported so it doesn't bloat the initial bundle.

import { lazy, Suspense } from 'react';
import { Loader2 } from 'lucide-react';

const Editor = lazy(() =>
  import('@monaco-editor/react').then((m) => ({ default: m.default }))
);

interface Props {
  value: string;
  onChange: (v: string) => void;
  language?: string;
  height?: number | string;
}

export function MonacoField({ value, onChange, language = 'javascript', height = 220 }: Props) {
  return (
    <div className="rounded-md overflow-hidden border border-border bg-input">
      <Suspense
        fallback={
          <div className="flex items-center justify-center text-xs text-muted-foreground" style={{ height }}>
            <Loader2 className="w-3 h-3 animate-spin mr-1" /> Editor lädt…
          </div>
        }
      >
        <Editor
          height={height}
          language={language}
          theme="vs-dark"
          value={value}
          onChange={(v) => onChange(v ?? '')}
          options={{
            minimap:    { enabled: false },
            fontSize:   12,
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            wordWrap:   'on',
            tabSize:    2,
            padding:    { top: 8, bottom: 8 },
            scrollbar:  { vertical: 'auto', horizontal: 'auto', verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
            renderWhitespace: 'selection',
            automaticLayout: true,
          }}
        />
      </Suspense>
    </div>
  );
}
