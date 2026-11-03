import dotenv from 'dotenv';
dotenv.config();

import assert from 'node:assert/strict';
import pg from 'pg';
import { getAiopsOutcomes } from '../observability/aiopsOutcomes.js';

const connectionString = process.env['POSTGRES_CONNECTION_URL'] ?? process.env['DATABASE_URL'] ?? '';
if (!connectionString) throw new Error('POSTGRES_CONNECTION_URL or DATABASE_URL is required');

const pool = new pg.Pool({ connectionString, max: 1 });
try {
  const result = await getAiopsOutcomes(pool, 30);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.window.days, 30);
  assert.equal(result.signals.total, result.signals.native + result.signals.provider);
  assert.ok(result.signals.total >= result.incidents.actionable, 'raw signals cannot be lower than actionable incidents');
  assert.equal(result.incidents.actionable, result.incidents.firing + result.incidents.recovered);
  assert.equal(result.incidents.actionable, result.incidents.correlated + result.incidents.standalone);
  assert.equal(result.incidents.suppressedSignals, result.signals.total - result.incidents.actionable);
  assert.ok(result.investigations.coveragePercent >= 0 && result.investigations.coveragePercent <= 100);
  assert.ok(result.investigations.completionRatePercent >= 0 && result.investigations.completionRatePercent <= 100);
  assert.ok(result.remediations.successRatePercent >= 0 && result.remediations.successRatePercent <= 100);
  assert.ok(result.topServices.length <= 8);
  assert.ok(result.graph.nodes.length <= 32);
  assert.ok(result.graph.edges.length <= 80);
  const graphNodeIds = new Set(result.graph.nodes.map(node => node.id));
  assert.ok(result.graph.edges.every(edge => graphNodeIds.has(edge.source) && graphNodeIds.has(edge.target)));
  assert.ok(result.graph.nodes.flatMap(node => node.providerLinks).every(link => {
    if (!link.externalHref) return true;
    const parsed = new URL(link.externalHref);
    return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password && !parsed.hash;
  }));
  assert.ok(result.profileAttribution.profileBoundInvestigations <= 1_000);
  assert.equal(
    result.profileAttribution.telemetryLinkedInvestigations,
    result.profileAttribution.profiles.reduce((sum, profile) => sum + profile.usage.telemetryLinkedInvestigations, 0),
  );
  assert.equal(
    result.profileAttribution.totalTokens,
    result.profileAttribution.profiles.reduce((sum, profile) => sum + profile.usage.totalTokens, 0),
  );
  assert.ok(result.profileAttribution.recordedCostUsd >= 0);
  for (const profile of result.profileAttribution.profiles) {
    assert.match(profile.profile.sha256, /^[a-f0-9]{64}$/i);
    assert.ok(profile.evidence.policyCoveragePercent >= 0 && profile.evidence.policyCoveragePercent <= 100);
    assert.equal(new Set(profile.evidence.lanes.map(lane => lane.lane)).size, profile.evidence.lanes.length);
    assert.equal(profile.evidence.configuredLanes, profile.evidence.lanes.length);
    assert.ok(profile.evidence.lanes.every(lane => lane.coveragePercent >= 0 && lane.coveragePercent <= 100));
    assert.ok(profile.usage.telemetryLinkedInvestigations <= profile.investigations);
    assert.ok(profile.usage.tokenAttributedInvestigations <= profile.investigations);
    assert.ok(profile.usage.costAttributedInvestigations <= profile.investigations);
    assert.equal(profile.usage.totalTokens, profile.usage.inputTokens + profile.usage.outputTokens);
    assert.ok(profile.usage.recordedCostUsd >= 0);
  }

  console.log(JSON.stringify({
    ok: true,
    tokenFree: true,
    mutationFree: true,
    windowDays: result.window.days,
    signals: result.signals.total,
    actionableIncidents: result.incidents.actionable,
    compressionRatio: result.incidents.compressionRatio,
    investigationCoveragePercent: result.investigations.coveragePercent,
    remediationSuccessRatePercent: result.remediations.successRatePercent,
    recurringServices: result.recurrence.servicesWithRepeatIncidents,
    graphNodes: result.graph.nodes.length,
    graphEdges: result.graph.edges.length,
    profileBoundInvestigations: result.profileAttribution.profileBoundInvestigations,
    profileEvidenceRevisions: result.profileAttribution.profiles.length,
    telemetryLinkedInvestigations: result.profileAttribution.telemetryLinkedInvestigations,
    reportedTokens: result.profileAttribution.totalTokens,
    recordedCostUsd: result.profileAttribution.recordedCostUsd,
  }, null, 2));
} finally {
  await pool.end();
}
