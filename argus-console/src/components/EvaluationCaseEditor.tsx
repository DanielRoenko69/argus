import { useState, type FormEvent } from 'react';
import type { EvaluationAssertion, EvaluationRules } from '../types';

const labels={ text_equals:'Exactly equals text',text_includes:'Contains text',text_excludes:'Does not contain text',
  json_object:'JSON object with required fields',json_field_equals:'JSON field equals a value' };
type RuleDraft={ id:string; type:EvaluationAssertion['type']; value:string; path:string; valueType:'text'|'number'|'boolean'|'null' };
const newRule=():RuleDraft => ({ id:crypto.randomUUID(),type:'text_includes',value:'',path:'',valueType:'text' });
function ruleValue(rule:RuleDraft):EvaluationAssertion {
  if (rule.type==='json_object') return { type:rule.type,required:rule.value.split(',').map(s => s.trim()).filter(Boolean) };
  if (rule.type==='json_field_equals') {
    const path=rule.path.split('.').map(s => s.trim());
    if (!path.every(Boolean) || path.some(s => ['__proto__','constructor','prototype'].includes(s))) throw new Error('Enter a valid JSON field path, for example incident.severity.');
    let value:string|number|boolean|null=rule.value;
    if (rule.valueType==='null') value=null;
    if (rule.valueType==='number') { value=Number(rule.value); if (!rule.value.trim() || !Number.isFinite(value)) throw new Error('Enter a finite numeric expected value.'); }
    if (rule.valueType==='boolean') { if (!['true','false'].includes(rule.value)) throw new Error('Use true or false for a boolean value.'); value=rule.value==='true'; }
    return { type:rule.type,path,value };
  }
  if (!rule.value.trim()) throw new Error('Enter the text to check in every criterion.');
  return { type:rule.type,value:rule.value };
}

export function EvaluationCaseEditor({ datasetId,saving,onSave,initial,requireReview=false,submitLabel='Add case' }:{ datasetId:number; saving:boolean; onSave:(id:number,input:Record<string,unknown>)=>void; initial?:{ caseKey:string; task:string }; requireReview?:boolean; submitLabel?:string }) {
  const [caseKey,setCaseKey]=useState(initial?.caseKey ?? '');
  const [task,setTask]=useState(initial?.task ?? ''); const [context,setContext]=useState(''); const [expected,setExpected]=useState('');
  const [reviewed,setReviewed]=useState(false);
  const [rules,setRules]=useState<RuleDraft[]>([newRule()]);
  const [advanced,setAdvanced]=useState(false); const [json,setJson]=useState(''); const [error,setError]=useState('');
  const payload=() => ({ case_key:caseKey.trim(),input:task,context:context || null,expected_output:expected || null,
    rules:{ version:'argus.deterministic.v1',assertions:rules.map(ruleValue) } satisfies EvaluationRules });
  const switchMode=() => {
    setError('');
    if (advanced) { setAdvanced(false); return; }
    try { setJson(JSON.stringify(payload(),null,2)); setAdvanced(true); }
    catch (e) { setError((e as Error).message); }
  };
  const submit=(event:FormEvent) => {
    event.preventDefault(); setError('');
    if (requireReview && !reviewed) { setError('Review the redacted input and define independent criteria before saving.'); return; }
    try {
      const input=advanced ? JSON.parse(json) : payload();
      if (!input || typeof input!=='object' || Array.isArray(input) || !String(input.case_key ?? '').trim()
        || input.input==null || !input.rules?.assertions?.length) throw new Error('Provide a case name, task and at least one criterion.');
      onSave(datasetId,input);
    } catch (e) { setError(e instanceof SyntaxError ? 'The advanced case must be valid JSON.' : (e as Error).message); }
  };
  const edit=(id:string,change:Partial<RuleDraft>) => setRules(rules.map(r => r.id===id ? { ...r,...change } : r));
  return <form className="evaluation-case-form" onSubmit={submit} onChange={e => { if ((e.target as HTMLInputElement).name!=='curation-review') setReviewed(false); }}>
    <div className="evaluation-form-header"><div><span className="eyebrow">TEST CASE</span><h3>What should a good answer do?</h3></div></div>
    <p className="evaluation-muted">Use a small, redacted task and reference text. Every criterion is mandatory; checks are exact and case-sensitive. Expected answers are kept for review, not sent to the model.</p>
    <fieldset className="evaluation-fields" disabled={saving}>
      {!advanced ? <>
        <label className="editor-field"><span>Case name</span><input required maxLength={160} value={caseKey} placeholder="checkout-incident-summary" onChange={e => setCaseKey(e.target.value)} /></label>
        <label className="editor-field"><span>Task</span><textarea aria-label="Task" required rows={3} value={task} placeholder="Summarize the incident and name the affected service." onChange={e => setTask(e.target.value)} /></label>
        <label className="editor-field"><span>Reference context (optional)</span><textarea rows={3} value={context} placeholder="Only this supplied context is available; no automatic knowledge retrieval." onChange={e => setContext(e.target.value)} /></label>
        <label className="editor-field"><span>Expected answer / reviewer notes (optional)</span><textarea rows={2} value={expected} onChange={e => setExpected(e.target.value)} /></label>
        <div className="evaluation-criteria">{rules.map((r,i) => <fieldset key={r.id} className="evaluation-criterion"><legend>Criterion {i+1}</legend>
          <label className="editor-field"><span>Check {i+1}</span><select value={r.type} onChange={e => edit(r.id,{ type:e.target.value as RuleDraft['type'] })}>
            {Object.entries(labels).map(([value,label]) => <option key={value} value={value}>{label}</option>)}
          </select></label>
          {r.type==='json_field_equals' && <div className="policy-field-grid">
            <label className="editor-field"><span>JSON field path {i+1}</span><input required value={r.path} placeholder="incident.severity" onChange={e => edit(r.id,{ path:e.target.value })} /></label>
            <label className="editor-field"><span>Value type {i+1}</span><select value={r.valueType} onChange={e => edit(r.id,{ valueType:e.target.value as RuleDraft['valueType'] })}><option value="text">Text</option><option value="number">Number</option><option value="boolean">Boolean</option><option value="null">Null</option></select></label>
          </div>}
          {!(r.type==='json_field_equals' && r.valueType==='null') && <label className="editor-field"><span>{r.type==='json_object' ? 'Required fields (comma separated)' : 'Expected value'} {i+1}</span><input required={r.type!=='json_object'} maxLength={8192} value={r.value} onChange={e => edit(r.id,{ value:e.target.value })} /></label>}
          <button type="button" className="button button-ghost" disabled={rules.length===1} aria-label={`Remove criterion ${i+1}`} onClick={() => setRules(rules.filter(x => x.id!==r.id))}>Remove</button>
        </fieldset>)}</div>
        <button type="button" className="button button-secondary" disabled={rules.length>=32} onClick={() => setRules([...rules,newRule()])}>Add criterion</button>
      </> : <><label className="editor-field"><span>Advanced case JSON</span><textarea required rows={16} value={json} onChange={e => setJson(e.target.value)} /></label><p>Switching back restores your form values; advanced JSON edits are not imported into the form.</p></>}
      {requireReview && <label className="evaluation-review-check"><input name="curation-review" type="checkbox" checked={reviewed} onChange={e => setReviewed(e.target.checked)} />I reviewed the redacted input and defined the expected behavior independently of the observed answer.</label>}
      <div className="evaluation-editor-actions"><button type="button" className="button button-ghost" onClick={switchMode}>{advanced ? 'Back to form values' : 'Advanced JSON'}</button>
        <button className="button button-primary" type="submit" disabled={requireReview && !reviewed}>{saving ? 'Saving…' : submitLabel}</button></div>
    </fieldset>
    {error && <p className="editor-error" role="alert">{error}</p>}
  </form>;
}
