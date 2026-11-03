import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getEvaluationStarterSets, importEvaluationStarterSet } from '../api';
import type { EvaluationDataset, EvaluationStarterSet } from '../types';
import { ErrorState, LoadingState } from './Ui';
import { EvaluationCurationDialog } from './EvaluationCurationDialog';

export function EvaluationStarterSets({ datasets,onSelect }:{ datasets:EvaluationDataset[]; onSelect:(id:number)=>void }) {
  const query=useQuery({ queryKey:['evaluation-starter-sets'],queryFn:getEvaluationStarterSets,staleTime:60_000 });
  const client=useQueryClient();
  const [selected,setSelected]=useState<EvaluationStarterSet|null>(null),[reviewed,setReviewed]=useState(false);
  const [requestId,setRequestId]=useState(() => crypto.randomUUID());
  const save=useMutation({ mutationFn:importEvaluationStarterSet,onSuccess:async result => {
    await client.invalidateQueries({ queryKey:['evaluation-datasets'] }); onSelect(result.dataset.id); setSelected(null);
  } });
  const existing=(set:EvaluationStarterSet) => datasets.find(d => d.dataset_key===set.key && d.version===set.version);
  return <section className="panel evaluation-starters" aria-label="Starter test sets">
    <div className="panel-heading"><div><span className="eyebrow">START WITH REALISTIC TASKS</span><h2>Dev & AIOps starter sets</h2></div><small>Synthetic · no model calls</small></div>
    <p className="evaluation-muted">24 reference tasks covering CI, approvals, repository access, logs, metrics and evidence gaps. Import a draft, inspect its cases, then activate explicitly. These checks assess answers, not live backend execution.</p>
    {query.isLoading && <LoadingState label="Loading starter sets…" />}{query.error && <ErrorState error={query.error} />}
    <div className="evaluation-ab-grid">{query.data?.starter_sets.map(set => <article key={set.key}>
      <h3>{set.name}</h3><p>{set.cases.length} cases · v{set.version} · every criterion mandatory</p>
      {existing(set) ? <button className="button button-secondary" onClick={() => onSelect(existing(set)!.id)}>Open imported {set.key.includes('aiops') ? 'AIOps' : 'Dev'} set</button>
        : <button className="button button-secondary" onClick={() => { setSelected(set); setReviewed(false); setRequestId(crypto.randomUUID()); save.reset(); }}>Review {set.key.includes('aiops') ? 'AIOps' : 'Dev'} starter set</button>}
    </article>)}</div>
    {selected && <EvaluationCurationDialog title="Review starter test set" busy={save.isPending} onClose={() => setSelected(null)}>
      <h3>{selected.name}</h3><p>{selected.description}</p>
      <div className="evaluation-case-list">{selected.cases.map(c => <details key={c.caseKey}><summary><b>{c.caseKey}</b><span>{c.rules.assertions.length} criteria</span></summary>
        <h4>Task</h4><pre>{String(c.input)}</pre><h4>Reference context</h4><pre>{String(c.context)}</pre>
        <h4>Expected decision</h4><pre>{JSON.stringify(c.expectedOutput,null,2)}</pre><p>{String(c.metadata.rationale)}</p>
        <h4>Mandatory criteria</h4><pre>{JSON.stringify(c.rules,null,2)}</pre>
      </details>)}</div>
      <p className="evaluation-muted">The import is versioned and atomic. It creates a draft only; no Agent is selected and nothing runs. Expected answers and criteria are not sent to the model.</p>
      <label className="evaluation-review-check"><input type="checkbox" checked={reviewed} disabled={save.isPending} onChange={e => setReviewed(e.target.checked)} />I reviewed these synthetic reference cases and will validate their suitability before activation.</label>
      {save.error && <ErrorState error={save.error} />}
      <div className="evaluation-dialog-footer"><button className="button button-primary" disabled={!reviewed || save.isPending} onClick={() => save.mutate({ key:selected.key,digest:selected.content_sha256,requestId })}>{save.isPending ? 'Importing…' : `Import ${selected.cases.length} cases as draft`}</button></div>
    </EvaluationCurationDialog>}
  </section>;
}
