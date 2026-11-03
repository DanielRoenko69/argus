// cred_ref selector for an argus.tool node. Stores only { bundle_id } in node
// data (or undefined for the selected connection identity). Never holds a secret.
//
// NOTE: when a bundle has multiple backends, backend_cred_id would disambiguate
// (accepted by the executor but out of v1 UI scope — add here when needed).

import { useAccessibleBundles } from '@/api/bundles';

const selectCls =
  'w-full px-2.5 py-1.5 rounded-md bg-input border border-border text-small focus:outline-none focus:ring-1 focus:ring-ring';

export interface CredRefSelectProps {
  value: { bundle_id: number } | undefined;
  onChange: (next: { bundle_id: number } | undefined) => void;
}

export function CredRefSelect({ value, onChange }: CredRefSelectProps) {
  const { data, isLoading } = useAccessibleBundles();
  const bundles = data ?? [];
  return (
    <select
      className={selectCls}
      value={value?.bundle_id ?? ''}
      onChange={(e) => {
        const v = e.target.value;
        onChange(v === '' ? undefined : { bundle_id: Number(v) });
      }}
    >
      <option value="">Use credential stored on the Fabric connection</option>
      {isLoading && <option disabled>lädt…</option>}
      {bundles.map((b) => (
        <option key={b.id} value={b.id}>
          {b.name}
        </option>
      ))}
    </select>
  );
}
