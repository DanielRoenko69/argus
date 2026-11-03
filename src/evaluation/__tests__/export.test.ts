import { buildEvaluationExport, evaluationCsvCell, serializeEvaluationExport } from '../export.js';
import { evaluationDigest } from '../contracts.js';
import { datasetContentDigest, evaluationCaseContent } from '../store.js';
import { scoreEvaluationOutput } from '../scoring.js';
import { evaluationComparisonPdf, evaluationPdfText, evaluationPdfApiSetting } from '../pdf.js';

function fixture() {
  const rules={ version:'argus.deterministic.v1',assertions:[{ type:'text_equals',value:'OK' }] };
  const c={ id:1,case_key:'one',input_redacted:'=HYPERLINK("https://example.invalid")',context_redacted:{ api_key:'private-fixture-value' },expected_output:'OK',rules,metadata:{},source_trace_id:null,source_span_id:null };
  const cases=[c],dataset={ id:1,version:1,contract_version:1,content_sha256:datasetContentDigest(cases as never) };
  const records=[1,2].map(id => {
    const snapshot={ context_mode:'isolated_reference',agent:{ bundle_ids:[] },execution:{ type:'argus',isolation_verified:true,executor_version:'argus.native-reference.v1',effective_model:'fixture' },evaluator:{ rules } };
    const judgement=scoreEvaluationOutput(id===1 ? 'OK' : 'Wrong',rules);
    const experiment={ id,comparison_id:1,dataset_id:1,tenant_key:'default',workspace_key:'default',agent_id:1,status:'completed',evidence_kind:'frozen_v1',
      dataset_sha256:dataset.content_sha256,configuration_snapshot:snapshot,configuration_sha256:evaluationDigest(snapshot),evaluator_sha256:evaluationDigest(snapshot.evaluator),
      expected_cases:[{ id:1,case_key:'one',sha256:evaluationDigest(evaluationCaseContent(c as never)) }],baseline_experiment_id:id===1 ? null : 1 };
    return { position:id,round:1,variant:id===1 ? 'baseline' : 'candidate',experiment_id:id,configuration_sha256:experiment.configuration_sha256,experiment,
      attempts:[{ case_id:1,attempt:1,trace_id:'trace',started_at:'2026-09-23T12:00:00.000Z' }],results:[{ id,case_id:1,attempt:1,status:judgement.status,output_redacted:id===1 ? 'OK' : 'Wrong',
        scores:judgement.scores,evaluator_version:judgement.version,latency_ms:1,input_tokens:null,output_tokens:null,cost_usd:null,evidence:{ executor_version:'argus.native-reference.v1',judgement,measurements:{ usage_source:'unknown',cost_source:'unknown' } } }] };
  });
  const plan=records.map(({ position,round,variant,experiment_id,configuration_sha256 }) => ({ position,round,variant,experiment_id,configuration_sha256 }));
  return { detail:{ comparison:{ id:1,name:'Fixture',dataset_id:1,status:'completed',repetitions:1,plan,plan_sha256:evaluationDigest(plan),completed_at:'2026-09-23T12:00:00.000Z' },records },record:{ dataset,cases } };
}
function build(f=fixture()) { return buildEvaluationExport(f.detail as never,f.record as never); }
describe('evaluation exports',() => {
  it('never presents Agent API defaults as applied Codex execution parameters',() => {
    const agent={ temperature:0.7,max_tokens:4096 };
    const codex={ agent,execution:{ type:'codex' } },native={ agent,execution:{ type:'argus' } };
    expect(evaluationPdfApiSetting(codex,'temperature')).toBe('Not applied (Codex runtime)');
    expect(evaluationPdfApiSetting(codex,'max_tokens')).toBe('Not applied (Codex runtime)');
    expect(evaluationPdfApiSetting(native,'temperature')).toBe(0.7);
    expect(evaluationPdfApiSetting(native,'max_tokens')).toBe(4096);
    expect(evaluationPdfApiSetting({ agent:{},execution:{ type:'argus' } },'max_tokens')).toBeUndefined();
  });
  it('renders a deterministic, multipage PDF from redacted evidence without modifying JSON',async() => {
    const doc=build(),before=JSON.stringify(doc);
    const pdf=await evaluationComparisonPdf(doc);
    expect(pdf.subarray(0,5).toString()).toBe('%PDF-');
    expect(pdf).toEqual(await evaluationComparisonPdf(build()));
    expect(pdf.toString('latin1')).not.toMatch(/\/JavaScript|\/Launch|\/URI\b/);
    expect(pdf.toString('latin1')).not.toContain('private-fixture-value');
    expect(pdf.toString('latin1').match(/\/Type \/Page\b/g)!.length).toBeGreaterThan(2);
    expect(JSON.stringify(doc)).toBe(before);
  });
  it('rejects a changed projection or missing timestamp before rendering',async() => {
    const doc=build();doc.payload.comparison.name='tampered';
    await expect(evaluationComparisonPdf(doc)).rejects.toMatchObject({ code:'EVALUATION_EXPORT_INTEGRITY' });
    const invalid=fixture();invalid.detail.comparison.completed_at='invalid';
    await expect(evaluationComparisonPdf(build(invalid))).rejects.toMatchObject({ code:'EVALUATION_EXPORT_INTEGRITY' });
  });
  it('preserves Unicode visibly and explicitly labels bounded text excerpts',() => {
    expect(evaluationPdfText('Grüße 東京 😀')).toBe('Grüße [U+6771][U+4EAC] [U+1F600]');
    expect(evaluationPdfText('abcdef',3)).toBe('abc [excerpt; 6 characters in JSON]');
    expect(evaluationPdfText(null)).toBe('unknown');
    expect(evaluationPdfText(0)).toBe('0');
  });
  it('fails closed instead of returning a truncated oversized PDF',async() => {
    const doc=build();
    doc.payload.summary.rounds=Array.from({ length:500 },() => doc.payload.summary.rounds[0]);
    doc.payload_sha256=evaluationDigest(doc.payload);
    await expect(evaluationComparisonPdf(doc)).rejects.toMatchObject({ code:'EVALUATION_PDF_TOO_LARGE',status:413 });
  });
  it('exports a failed gate with all evidence, honest null measurements and stable hashes',() => {
    const doc=build(); expect(doc.payload.summary.comparison_state).toBe('failed');
    expect(doc.payload.experiments).toHaveLength(2);
    expect(doc.payload.experiments[0]!.results[0]!.cost_usd).toBeNull();
    expect(doc.payload_sha256).toBe(evaluationDigest(doc.payload));
    expect(serializeEvaluationExport(doc,'json')).toEqual(serializeEvaluationExport(build(),'json'));
    expect(JSON.stringify(doc)).not.toContain('private-fixture-value');
    expect(doc.payload.limitations.join(' ')).toContain('Unsigned');
  });
  it('keeps all historical technical attempts, not only the latest outcome',() => {
    const f=fixture(),r=f.detail.records[0]!;
    r.attempts.push({ ...r.attempts[0]!,attempt:2 }); r.results[0]!.attempt=2;
    r.results.unshift({ ...r.results[0]!,attempt:1,status:'error' as never,output_redacted:'',scores:{} as never,evidence:{} as never });
    const doc=build(f),csv=serializeEvaluationExport(doc,'csv').toString();
    expect(doc.payload.experiments[0]!.results).toHaveLength(2);
    expect(csv.split('\r\n').filter(Boolean)).toHaveLength(4);
    expect(csv).toContain('"unknown","unknown"');
    expect(csv).toContain('"\'=HYPERLINK(""https://example.invalid"")"');
  });
  it.each(['queued','running','failed','cancelled','interrupted'])('rejects incomplete %s plans',status => {
    const f=fixture(); f.detail.comparison.status=status; expect(() => build(f)).toThrow(/Complete the comparison/);
  });
  it.each(['plan','dataset','snapshot','results'])('rejects altered %s evidence',field => {
    const f=fixture();
    if(field==='plan') f.detail.comparison.plan_sha256='wrong';
    if(field==='dataset') f.record.cases[0]!.input_redacted='Changed';
    if(field==='snapshot') f.detail.records[0]!.experiment.configuration_sha256='wrong';
    if(field==='results') f.detail.records[0]!.results=[];
    expect(() => build(f)).toThrow(/verification/);
  });
  it.each(['=1+1','+SUM(A1)','-1','@cmd',' \t=1','\tplain','\rline','\nline','\uFEFF=1'])('neutralizes formula/control prefix %j',value => {
    expect(evaluationCsvCell(value)).toMatch(/^"'/);
  });
  it('quotes commas, double quotes, Unicode and line breaks; null is empty, not zero',() => {
    expect(evaluationCsvCell('ä,"x"\ny')).toBe('"ä,""x""\ny"');
    expect(evaluationCsvCell(null)).toBe('""'); expect(evaluationCsvCell(0)).toBe('"0"');
    expect(serializeEvaluationExport(build(),'csv').subarray(0,3)).toEqual(Buffer.from([239,187,191]));
  });
});
