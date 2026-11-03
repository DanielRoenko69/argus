import PDFDocument from 'pdfkit';
import type { AuditReportRun } from './reportTypes.js';

function collectPdf(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

export async function auditReportPdf(run: AuditReportRun): Promise<Buffer> {
  if (!run.summary || !run.evidencePack || run.status !== 'completed') throw new Error('completed report evidence is required');
  const artifactTime = new Date(run.completedAt ?? run.createdAt);
  const doc = new PDFDocument({
    margin: 48,
    size: 'A4',
    info: {
      Title: run.summary.title,
      Author: 'Argus Audit Evidence',
      Subject: `${run.reportType} evidence report ${run.id}`,
      Producer: 'Argus canonical audit reporting',
      CreationDate: artifactTime,
      ModDate: artifactTime,
    },
  });
  const output = collectPdf(doc);
  const color = '#6956e8';
  doc.fillColor(color).fontSize(10).text('ARGUS · SIGNED AUDIT EVIDENCE');
  doc.moveDown(0.6).fillColor('#111827').fontSize(22).text(run.summary.title);
  doc.moveDown(0.25).fillColor('#526173').fontSize(9)
    .text(`Report ${run.id}  ·  ${run.periodFrom} — ${run.periodTo}`)
    .text(`Scope ${run.workspaceKey}/${run.tenantKey}/${run.environment}`)
    .text(`Type ${run.reportType}  ·  Trigger ${run.triggerType}  ·  Completed ${run.completedAt}`);
  doc.moveDown().fillColor('#111827').fontSize(13).text('Executive summary');
  doc.moveDown(0.35).fontSize(10)
    .text(`${run.summary.eventCount} canonical events from ${run.summary.actorCount} identities. `
      + `${run.summary.successCount} successful, ${run.summary.deniedCount} denied and ${run.summary.failureCount} failed. `
      + `${run.summary.criticalRiskCount} events were classified as critical risk.`);
  doc.moveDown().fontSize(13).text('Integrity and provenance');
  doc.moveDown(0.35).fontSize(9)
    .text(`Verification: ${run.verificationState?.toUpperCase()}`)
    .text(`Evidence pack: ${run.packId}`)
    .text(`Pack digest (SHA-256): ${run.packDigest}`)
    .text(`Signed checkpoint: ${run.checkpointId}`)
    .text(`Checkpoint key: ${run.evidencePack.verificationKey.keyId}`)
    .text(`Signed chain entries: ${run.chainEntryCount}`);
  doc.moveDown().fontSize(13).text('Most frequent actions');
  doc.moveDown(0.35).fontSize(9);
  if (run.summary.topActions.length === 0) doc.text('No events matched this report window.');
  for (const item of run.summary.topActions) doc.text(`• ${item.action}: ${item.count}`);
  doc.moveDown().fontSize(13).text('Control evidence mapping');
  doc.moveDown(0.35).fontSize(9);
  for (const mapping of run.summary.controlCoverage) {
    doc.text(`${mapping.framework} · ${mapping.control}`, { continued: false }).fillColor('#526173').text(mapping.evidence).fillColor('#111827');
  }
  doc.moveDown().fontSize(13).text('Declared limitations');
  doc.moveDown(0.35).fontSize(9);
  if (run.evidencePack.manifest.declaredGaps.length === 0) doc.text('No declared gaps.');
  for (const gap of run.evidencePack.manifest.declaredGaps) doc.text(`• ${gap.code}: ${gap.description}`);
  doc.moveDown().fontSize(8).fillColor('#526173')
    .text('This report is evidence support, not a certification. The embedded JSON evidence pack is authoritative; this PDF is a deterministic human-readable projection.');
  doc.end();
  return output;
}

export function auditReportArtifact(run: AuditReportRun, format: 'json' | 'jsonl' | 'csv'): string {
  if (!run.evidencePack || run.status !== 'completed') throw new Error('completed report evidence is required');
  if (format === 'json') {
    // Reviews are a separate append-only ledger and may be added after report
    // completion. Excluding them keeps the signed report artifact byte-stable.
    const { evidencePack, reviews: _reviews, ...report } = run;
    return JSON.stringify({ schemaVersion: 1, report, evidencePack }, null, 2);
  }
  if (format === 'jsonl') return run.evidencePack.artifacts.eventsJsonl;
  return run.evidencePack.artifacts.eventsCsv;
}
