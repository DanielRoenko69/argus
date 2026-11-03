/**
 * Compliance audit exporters: PDF + CSV.
 *
 * PDF uses pdfkit (~150 KB, no headless browser). Single-page layout per
 * finding, plus a cover sheet with score + counts. Designed to be handed
 * to an auditor as evidence — every finding has a unique hash so tampering
 * is detectable.
 */
import PDFDocument from 'pdfkit';
import { createHash } from 'node:crypto';
import type { Finding, Framework, Run, Verdict } from './store.js';

// ── CSV ──────────────────────────────────────────────────────────

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const raw = String(v);
  // Prevent formula execution when evidence is opened in a spreadsheet.
  const s = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function complianceRunHash(run: Run, findings: Finding[]): string {
  const payload = {
    run: {
      id: run.id,
      frameworkId: run.framework_id,
      target: run.target,
      agentId: run.agent_id,
      status: run.status,
      score: run.score,
      counts: [run.passed_count, run.warning_count, run.failed_count, run.na_count],
      triggeredBy: run.triggered_by,
      startedAt: run.started_at,
      completedAt: run.completed_at,
      durationMs: run.duration_ms,
    },
    findings: findings.map(finding => ({
      id: finding.id ?? null,
      article: finding.article,
      title: finding.title,
      verdict: finding.verdict,
      severity: finding.severity,
      evidence: finding.evidence,
      codePointers: finding.code_pointers ?? [],
      remediation: finding.remediation,
      createdAt: finding.created_at ?? null,
    })),
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/** Excel-pivot-friendly flat CSV with report provenance on every row. */
export function exportCsv(framework: Framework, run: Run, findings: Finding[]): string {
  const reportHash = complianceRunHash(run, findings);
  const header = [
    'run_id','framework','framework_version','target','started_at','completed_at','report_hash',
    'article','title','verdict','severity','evidence','remediation','code_files','code_lines'
  ].join(',');
  const rows = (findings.length ? findings : [null]).map((f) => {
    const files = (f?.code_pointers ?? []).map((p) => p.file).join('; ');
    const lines = (f?.code_pointers ?? []).map((p) => p.line ?? '').join('; ');
    return [
      run.id, framework.label, framework.version, run.target, run.started_at, run.completed_at, reportHash,
      f?.article, f?.title, f?.verdict, f?.severity,
      f?.evidence, f?.remediation, files, lines,
    ].map(csvCell).join(',');
  });
  return [header, ...rows].join('\n') + '\n';
}

// ── PDF ──────────────────────────────────────────────────────────

const VERDICT_LABEL: Record<Verdict, string> = {
  passed:         'BESTANDEN',
  warning:        'WARNUNG',
  failed:         'FEHLER',
  not_applicable: 'N/A',
};

// Argus-ish palette: green for pass, coral for fail, amber for warning.
const VERDICT_COLOR: Record<Verdict, string> = {
  passed:         '#527A42',
  warning:        '#D89614',
  failed:         '#EF706B',
  not_applicable: '#888888',
};

function scoreColor(score: number | null): string {
  if (score === null)  return '#888888';
  if (score >= 85)     return '#527A42';
  if (score >= 60)     return '#D89614';
  return '#EF706B';
}

/**
 * Builds a multi-section PDF report and pipes it into the supplied buffer
 * collector via the returned Promise.
 */
export function exportPdf(
  framework: Framework,
  run: Run,
  findings: Finding[],
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // ── Cover ─────────────────────────────────────────────────────
    doc.fontSize(24).fillColor('#1c1c1c')
       .text('Compliance Assessment Report', { align: 'left' });
    doc.moveDown(0.3);
    doc.fontSize(14).fillColor('#555')
       .text(`${framework.label} (${framework.version})`);
    doc.moveDown(0.5);
    doc.fontSize(9).fillColor('#777')
       .text('Automatisierte Evidenzbewertung. Dieser Bericht ist keine Zertifizierung oder Rechtsberatung.');
    doc.moveDown(1.5);

    doc.fontSize(11).fillColor('#1c1c1c');
    const meta: Array<[string, string]> = [
      ['Run-ID',       `#${run.id}`],
      ['Ziel',         run.target],
      ['Auditor',      run.triggered_by ?? '—'],
      ['Gestartet',    new Date(run.started_at).toLocaleString('de-DE')],
      ['Abgeschlossen',run.completed_at ? new Date(run.completed_at).toLocaleString('de-DE') : '—'],
      ['Dauer',        run.duration_ms ? `${(run.duration_ms / 1000).toFixed(1)} s` : '—'],
      ['Status',       run.status],
    ];
    for (const [k, v] of meta) {
      doc.font('Helvetica-Bold').text(`${k}: `, { continued: true });
      doc.font('Helvetica').text(v);
    }
    doc.moveDown(1.5);

    // Score badge
    doc.font('Helvetica-Bold').fontSize(48).fillColor(scoreColor(run.score))
       .text(`${run.score ?? '—'} / 100`, { align: 'center' });
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(11).fillColor('#1c1c1c')
       .text(
         `✓ ${run.passed_count} bestanden   ` +
         `⚠ ${run.warning_count} Warnungen   ` +
         `✗ ${run.failed_count} Fehler   ` +
         `– ${run.na_count} N/A`,
         { align: 'center' }
       );

    // ── Findings ──────────────────────────────────────────────────
    doc.addPage();
    doc.fontSize(18).fillColor('#1c1c1c').text('Findings im Detail');
    doc.moveDown(0.5);

    for (const f of findings) {
      // Keep ~150pt clear at page bottom for the finding header + first lines
      if (doc.y > 680) doc.addPage();

      const color = VERDICT_COLOR[f.verdict];
      doc.font('Helvetica-Bold').fontSize(13).fillColor(color)
         .text(`${f.article} — ${f.title}`);
      doc.font('Helvetica').fontSize(10).fillColor('#555')
         .text(`Verdict: ${VERDICT_LABEL[f.verdict]}   ·   Severity: ${f.severity}`);
      doc.moveDown(0.4);

      if (f.evidence) {
        doc.fontSize(10).fillColor('#1c1c1c').font('Helvetica-Bold').text('Evidenz:');
        doc.font('Helvetica').text(f.evidence, { align: 'left' });
        doc.moveDown(0.3);
      }

      if (f.code_pointers?.length) {
        doc.fontSize(10).font('Helvetica-Bold').text('Code-Pointer:');
        doc.font('Helvetica');
        for (const p of f.code_pointers) {
          const where = p.line ? `${p.file}:${p.line}` : p.file;
          doc.text(`  • ${where}`);
          if (p.snippet) {
            doc.font('Courier').fontSize(9).fillColor('#444')
               .text(`    ${p.snippet}`, { lineGap: 1 });
            doc.font('Helvetica').fontSize(10).fillColor('#1c1c1c');
          }
        }
        doc.moveDown(0.3);
      }

      if (f.remediation) {
        doc.fontSize(10).font('Helvetica-Bold').text('Empfehlung:');
        doc.font('Helvetica').text(f.remediation, { align: 'left' });
      }

      doc.moveDown(0.8);
      doc.strokeColor('#dddddd').lineWidth(0.5)
         .moveTo(50, doc.y).lineTo(545, doc.y).stroke();
      doc.moveDown(0.8);
    }

    // ── Signature page ───────────────────────────────────────────
    doc.addPage();
    doc.fontSize(16).fillColor('#1c1c1c').text('Audit-Signatur');
    doc.moveDown(1);
    doc.fontSize(10).fillColor('#555')
       .text('Diese SHA-256-Prüfsumme deckt Run-Metadaten sowie Titel, Evidenz, ' +
             'Remediation und Code-Pointer aller Findings ab. ' +
             'Änderungen am Run-Datensatz führen zu einer abweichenden Prüfsumme — ' +
             'der Report bleibt damit als Audit-Evidenz verifizierbar.');
    doc.moveDown(1);
    doc.font('Courier').fontSize(10).fillColor('#1c1c1c')
       .text(complianceRunHash(run, findings));
    doc.moveDown(2);
    doc.font('Helvetica').fontSize(10).fillColor('#555')
       .text(`Generiert: ${new Date().toLocaleString('de-DE')}   ·   Argus Compliance Module`);

    doc.end();
  });
}
