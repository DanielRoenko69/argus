import PDFDocument from 'pdfkit';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { EvaluationError, evaluationDigest } from './contracts.js';
import type { EvaluationExport } from './export.js';

export const EVALUATION_PDF_VERSION='argus.evaluation.pdf.v1';
export const MAX_EVALUATION_PDF_PAGES=200;
const MAX_BYTES=16*1024*1024;
const object=(v:unknown):Record<string,unknown> => v && typeof v==='object' && !Array.isArray(v) ? v as Record<string,unknown> : {};
const unknown='unknown';
const number=(v:unknown,digits=0) => typeof v==='number' && Number.isFinite(v) ? v.toFixed(digits) : unknown;
const percent=(v:unknown) => typeof v==='number' && Number.isFinite(v) ? `${(v*100).toFixed(1)}%` : unknown;

/** Agent API defaults are retained in provenance, but are not applied by Codex. */
export function evaluationPdfApiSetting(configuration:{ agent:Record<string,unknown>;execution:Record<string,unknown> },key:'temperature'|'max_tokens'):unknown {
  return configuration.execution['type']==='codex' ? 'Not applied (Codex runtime)' : configuration.agent[key];
}

/** Portable built-in fonts: preserve unsupported code points visibly, never as missing glyphs. */
export function evaluationPdfText(value:unknown,limit=400):string {
  const text=value==null ? unknown : String(value);
  const points=Array.from(text),excerpt=points.slice(0,limit).join('');
  const safe=Array.from(excerpt.normalize('NFC')).map(c => {
    const n=c.codePointAt(0)!;
    if (c==='\n' || n>=32 && n<=126 || n>=160 && n<=255) return c;
    if (c==='\t' || c==='\r') return ' ';
    return `[U+${n.toString(16).toUpperCase().padStart(4,'0')}]`;
  }).join('');
  return safe+(points.length>limit ? ` [excerpt; ${points.length} characters in JSON]` : '');
}
function sizeError():never {
  throw new EvaluationError('EVALUATION_PDF_TOO_LARGE',`PDF exceeds ${MAX_EVALUATION_PDF_PAGES} pages or 16 MiB. Use JSON/CSV or a smaller comparison; no partial PDF was exported.`,413);
}

/** Human-readable projection of the already verified, force-redacted export. No provider or URL access. */
export async function evaluationComparisonPdf(document:EvaluationExport):Promise<Buffer> {
  const p=document.payload;
  if (evaluationDigest(p)!==document.payload_sha256) throw new EvaluationError('EVALUATION_EXPORT_INTEGRITY','Export projection digest mismatch',409);
  const date=new Date(p.comparison.completed_at ?? p.comparison.created_at);
  if (!Number.isFinite(date.getTime())) throw new EvaluationError('EVALUATION_EXPORT_INTEGRITY','Completed comparison timestamp is missing',409);
  // Layout owns every page break. A zero bottom margin keeps footer text from
  // creating an implicit PDFKit overflow page; content still uses 42 pt margins.
  const doc=new PDFDocument({ size:'A4',margin:0,bufferPages:true,autoFirstPage:false,compress:true,
    info:{ Title:`Argus Evaluation ${p.comparison.id}`,Author:'Argus',Producer:EVALUATION_PDF_VERSION,
      Subject:'Frozen A/B evaluation evidence - unsigned result report',CreationDate:date,ModDate:date } });
  const chunks:Buffer[]=[];
  let bytes=0;
  const output=new Promise<Buffer>((fulfil,reject) => {
    doc.on('data',(chunk:Buffer) => {
      bytes+=chunk.length;
      if(bytes>MAX_BYTES) { doc.destroy(); reject(new EvaluationError('EVALUATION_PDF_TOO_LARGE','PDF exceeds 16 MiB; no partial PDF was exported.',413)); }
      else chunks.push(chunk);
    });
    doc.on('end',() => fulfil(Buffer.concat(chunks)));
    doc.on('error',reject);
  });
  // A synchronous layout failure must not leave an unhandled stream rejection.
  void output.catch(() => {});
  const ink='#172033',muted='#526078',purple='#6554d9',teal='#087f83',line='#dce2ed';
  const left=42,width=511,bottom=772;
  let y=86,pages=0;
  try {
    // Both locations contain the same tracked asset; Docker packages the built Console.
    const built=resolve('argus-console/dist/brand/argus-wordmark.png');
    // Use one cached path, not a new Buffer per page: async PNG embeddings could
    // otherwise finish out of order and break byte-identical idempotent retries.
    const logo=existsSync(built) ? built : resolve('argus-console/public/brand/argus-wordmark.png');
    const font=(size=10,bold=false,color=ink) => doc.font(bold?'Helvetica-Bold':'Helvetica').fontSize(size).fillColor(color);
    const page=() => {
      if (++pages>MAX_EVALUATION_PDF_PAGES) sizeError();
      doc.addPage();
      doc.image(logo,left,28,{ width:102 });
      font(8,true,purple).text('EVALUATION / A-B COMPARISON',260,36,{ width:293,align:'right',lineBreak:false });
      doc.moveTo(left,67).lineTo(left+width,67).lineWidth(0.7).strokeColor(line).stroke();
      y=86;
    };
    const room=(height:number) => { if(height>bottom-86) sizeError(); if(y+height>bottom) page(); };
    const paragraph=(text:unknown,size=10,color=ink,bold=false) => {
      const value=evaluationPdfText(text,2400);
      font(size,bold,color);
      const height=doc.heightOfString(value,{ width,lineGap:3 });
      room(height+10);font(size,bold,color).text(value,left,y,{ width,lineGap:3 });y+=height+10;
    };
    const section=(title:string) => { room(85);y+=10;paragraph(title,15,purple,true); };
    const table=(headers:string[],rows:unknown[][],widths:number[]) => {
      const row=(values:unknown[],header=false) => {
        const texts=values.map(v => evaluationPdfText(v));
        font(header?9:9.5,header);
        const height=Math.max(28,...texts.map((v,i) => doc.heightOfString(v,{ width:widths[i]-16,lineGap:2 })+16));
        if(y+height>bottom) { page(); if(!header) row(headers,true); }
        if(y+height>bottom) sizeError();
        const top=y;
        if(header) doc.rect(left,top,width,height).fill('#edf0f8');
        let x=left;
        texts.forEach((text,i) => { font(header?9:9.5,header,header?purple:ink).text(text,x+8,top+8,{ width:widths[i]-16,lineGap:2 });x+=widths[i]; });
        y+=height;doc.moveTo(left,y).lineTo(left+width,y).lineWidth(0.5).strokeColor(line).stroke();
      };
      row(headers,true);rows.forEach(r => row(r));y+=12;
    };
    page();
    paragraph('Evaluation report',27,ink,true);
    paragraph(p.comparison.name,16,muted);
    paragraph(`Comparison #${p.comparison.id} | ${p.dataset.name} | Dataset v${p.dataset.version}`,10,muted);
    paragraph(`Completed ${date.toISOString()} | Scope ${p.comparison.tenant_key}/${p.comparison.workspace_key}/${p.comparison.environment}`,9,muted);
    const gate=p.summary.comparison_state==='passed'?'PASSED':'FAILED';
    room(68);
    doc.roundedRect(left,y,width,58,6).fill(gate==='PASSED'?'#e6f4f0':'#fff0ed');
    font(17,true,gate==='PASSED'?teal:'#b94335').text(`Quality gate: ${gate}`,left+15,y+12,{ width:width-30 });
    font(9,false,ink).text('Execution completed. Gate result is not a deployment approval.',left+15,y+37,{ width:width-30 });y+=74;
    const coverage=p.summary.cost_coverage;
    table(['Scope','Recorded evidence'],[
      ['Test cases / repetitions',`${p.cases.length} / ${p.comparison.repetitions}`],
      ['Experiments / planned requests',`${p.summary.completed_steps}/${p.summary.total_steps} / ${p.summary.planned_requests}`],
      ['Order',p.comparison.order_mode==='alternating'?'Alternating whole datasets A-B / B-A':'Baseline first A-B each round'],
      ['Known cost subtotal (USD)',`${number(coverage.known_subtotal_usd,6)} | coverage ${coverage.measured}/${coverage.total} attempts`],
      ['Total cost',coverage.measured===coverage.total && coverage.total>0 ? `${number(coverage.known_subtotal_usd,6)} USD (catalog estimate)` : 'Unknown - incomplete cost coverage'],
    ],[184,327]);
    paragraph('Answer-only, isolated reference evaluation. No tools, live service actions or LLM judge. Exporting this report makes no model calls.',10,muted);
    paragraph('Unsigned result report, not a Compliance Report or certification. Repetitions do not establish statistical significance or general model superiority.',10,muted);
    section('1 / Frozen configurations');
    const first=(variant:string) => p.experiments.find(e => e.variant===variant)!;
    const a=first('baseline'),b=first('candidate');
    const config=(r:typeof a) => ({ agent:object(r.experiment.configuration_snapshot?.['agent']),execution:object(r.experiment.configuration_snapshot?.['execution']),skills:r.experiment.configuration_snapshot?.['skills'] });
    const ac=config(a),bc=config(b);
    table(['Configuration','A / Baseline','B / Candidate'],[
      ['Agent',ac.agent['label'] ?? ac.agent['name'] ?? a.experiment.agent_id,bc.agent['label'] ?? bc.agent['name'] ?? b.experiment.agent_id],
      ['Requested alias',a.experiment.model_ref,b.experiment.model_ref],
      ['Effective model',ac.execution['effective_model'],bc.execution['effective_model']],
      ['Runtime / executor',`${ac.execution['type']} / ${ac.execution['executor_version']}`,`${bc.execution['type']} / ${bc.execution['executor_version']}`],
      ['Temperature',evaluationPdfApiSetting(ac,'temperature'),evaluationPdfApiSetting(bc,'temperature')],
      ['Configured output tokens',evaluationPdfApiSetting(ac,'max_tokens'),evaluationPdfApiSetting(bc,'max_tokens')],
      ['Reasoning effort',ac.execution['reasoning_effort'],bc.execution['reasoning_effort']],
      ['Frozen Skills',Array.isArray(ac.skills)?ac.skills.length:unknown,Array.isArray(bc.skills)?bc.skills.length:unknown],
      ['Redacted prompt SHA-256',evaluationDigest(ac.agent['system_prompt'] ?? null),evaluationDigest(bc.agent['system_prompt'] ?? null)],
      ['Configuration SHA-256',a.experiment.configuration_sha256,b.experiment.configuration_sha256],
    ],[137,187,187]);
    paragraph('These are frozen execution settings, not a new token limit. Codex applies its runtime model and reasoning; Agent API temperature/output defaults are not applied. Full prompts, Skills, reference context and answers remain in the redacted JSON manifest.',9,muted);
    section('2 / A-B results by round');
    for(const round of p.summary.rounds) {
      const e=round.evidence!;
      room(120);paragraph(`Round ${round.round} / ${e.comparison_state?.toUpperCase()}`,12,ink,true);
      table(['Metric','A / Baseline','B / Candidate'],[
        ['Overall score',percent(e.baseline?.overall),percent(e.candidate.overall)],
        ['Cases / technical errors',`${e.baseline?.cases} / ${e.baseline?.errors}`,`${e.candidate.cases} / ${e.candidate.errors}`],
        ['Mean latency (ms)',number(e.baseline?.latencyMs),number(e.candidate.latencyMs)],
        ['Median / p95 (ms)',`${number(e.baseline?.medianLatencyMs)} / ${number(e.baseline?.p95LatencyMs)}`,`${number(e.candidate.medianLatencyMs)} / ${number(e.candidate.p95LatencyMs)}`],
        ['Cost coverage (all attempts)',`${e.baseline?.costCoverage.measured}/${e.baseline?.costCoverage.total}`,`${e.candidate.costCoverage.measured}/${e.candidate.costCoverage.total}`],
        ['Known subtotal (USD)',number(e.baseline?.costCoverage.knownSubtotalUsd,6),number(e.candidate.costCoverage.knownSubtotalUsd,6)],
        ['Usage complete / partial / unknown',`${e.baseline?.usageCoverage.complete} / ${e.baseline?.usageCoverage.partial} / ${e.baseline?.usageCoverage.unknown}`,`${e.candidate.usageCoverage.complete} / ${e.candidate.usageCoverage.partial} / ${e.candidate.usageCoverage.unknown}`],
      ],[211,150,150]);
      table(['Gate check','Observed','Threshold','Result'],e.result!.checks.map(c => [c.name,number(c.observed,4),number(c.threshold,4),c.status]),[221,100,100,90]);
    }
    paragraph('Scores and latencies describe latest case results; cost and usage coverage include all historical and unresolved attempts. p95 is descriptive, not a confidence interval.',9,muted);
    section('3 / Case outcomes and failed checks');
    paragraph('All cases and both variants are listed. Criteria are numbered from 1. Raw task/context/answer content is intentionally not included in this PDF; inspect the JSON for the full redacted evidence.',9,muted);
    const caseRows:unknown[][]=[];
    for(const r of p.experiments) for(const c of p.cases) {
      const v=r.results.filter(v => v.case_id===c.id).sort((a,b) => b.attempt-a.attempt)[0];
      const assertions=object(v?.evidence?.['judgement'])['assertions'];
      const failed=Array.isArray(assertions)?assertions.filter(a => object(a)['passed']===false).map(a => {
        const assertion=object(a);return `#${Number(assertion['index'])+1} ${assertion['type']}: ${assertion['reason']}`;
      }).join('\n'):unknown;
      caseRows.push([`${r.round} / ${r.variant==='baseline'?'A':'B'}`,`${c.case_key}\nCase #${c.id}`,`${v?.status}\n${percent(v?.scores['overall'])}`,failed || 'All criteria matched']);
    }
    table(['Round / side','Case','Outcome','Failed criteria'],caseRows,[72,170,80,189]);
    section('4 / Attempt history and measurements');
    paragraph('One row per dispatched attempt, including earlier technical failures. Unknown is not zero. Full measurement provenance and trace references are retained in JSON/CSV.',9,muted);
    for(const r of p.experiments) {
      room(85);paragraph(`Round ${r.round} / ${r.variant==='baseline'?'A':'B'} / Experiment #${r.experiment.id}`,11,ink,true);
      const rows:unknown[][]=[];
      for(const c of p.cases) {
        const attempts=[...new Set([...r.results.filter(v => v.case_id===c.id).map(v => v.attempt),...r.attempts.filter(v => v.case_id===c.id).map(v => v.attempt)])].sort((a,b) => a-b);
        for(const attempt of attempts) {
          const v=r.results.find(v => v.case_id===c.id && v.attempt===attempt);
          rows.push([`#${c.id} / ${attempt}`,v?.status ?? 'unresolved',number(v?.latency_ms),`${number(v?.input_tokens)} / ${number(v?.output_tokens)}`,number(v?.cost_usd,6)]);
        }
      }
      table(['Case / try','Status','ms','Tokens in / out','USD estimate'],rows,[90,90,76,145,110]);
    }
    section('5 / Provenance and verification');
    table(['Reference','Value'],[
      ['PDF renderer',EVALUATION_PDF_VERSION],['Export schema',document.schema_version],
      ['Payload SHA-256',document.payload_sha256],['Dataset SHA-256',p.dataset.content_sha256],['Plan SHA-256',p.comparison.plan_sha256],
      ['Created / started',`${p.comparison.created_at} / ${p.comparison.started_at ?? unknown}`],
      ['Comparison in Argus',p.evidence_refs.comparison_path],['Canonical audit query',p.evidence_refs.audit_query],
    ],[159,352]);
    table(['Round / side / experiment','Configuration SHA-256','Evaluator SHA-256'],p.experiments.map(r => [
      `${r.round} / ${r.variant==='baseline'?'A':'B'} / #${r.experiment.id}`,r.experiment.configuration_sha256,r.experiment.evaluator_sha256,
    ]),[125,193,193]);
    paragraph('The payload digest binds the complete redacted JSON projection, not PDF bytes. Download headers carry the PDF byte SHA-256 and canonical audit event ID; the browser verifies the bytes before saving. Audit proves export preparation, not receipt. No signature or external timestamp is embedded.',9,muted);
    section('6 / Scope and limitations');
    for(const limitation of p.limitations) paragraph(limitation,9,muted);
    paragraph('PDF is a curated human-readable projection, not a replacement for JSON. Long display labels/check lists are marked as excerpts; complete values remain in JSON. Non-Latin characters unsupported by the portable PDF font appear as [U+XXXX]. No embedded scripts, remote resources or automatic external links.',9,muted);
    const range=doc.bufferedPageRange();
    if(range.count!==pages) throw new EvaluationError('EVALUATION_PDF_LAYOUT','Unexpected report pagination; no partial PDF was exported.',500);
    for(let i=0;i<range.count;i++) {
      doc.switchToPage(i);
      doc.moveTo(left,791).lineTo(left+width,791).lineWidth(0.5).strokeColor(line).stroke();
      font(8,false,muted).text(`ARGUS | Evaluation #${p.comparison.id} | Unsigned result evidence`,left,803,{ lineBreak:false });
      font(8,false,muted).text(`${i+1} / ${range.count}`,490,803,{ width:63,align:'right',lineBreak:false });
    }
    if(doc.bufferedPageRange().count!==pages) throw new EvaluationError('EVALUATION_PDF_LAYOUT','Unexpected footer pagination; no partial PDF was exported.',500);
    doc.end();
    return await output;
  } catch(error) { doc.destroy();throw error; }
}
