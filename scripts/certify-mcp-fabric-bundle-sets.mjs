#!/usr/bin/env node

import 'dotenv/config';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import pg from 'pg';

const { Pool } = pg;
const REPORT_PATH = process.env.ARGUS_FABRIC_PROFILE_CERT_REPORT
  || 'test-results/mcp-fabric-bundle-set-certification.json';

function databaseUrl() {
  const user = process.env.POSTGRES_USER?.trim() || 'aiops';
  const password = process.env.POSTGRES_PASSWORD?.trim();
  const database = process.env.POSTGRES_DB?.trim() || 'aiops';
  const port = process.env.POSTGRES_PORT?.trim() || '5432';
  if (!password) throw new Error('POSTGRES_PASSWORD is required');
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${encodeURIComponent(database)}`;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function safeError(error) {
  return String(error instanceof Error ? error.message : error)
    .replace(/(?:password|passphrase|secret|token|authorization|bearer|cookie|credential)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 1_000) || 'unknown error';
}

async function responseJson(response, label) {
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${label} returned non-JSON status ${response.status}`);
  }
  if (!response.ok) {
    throw new Error(`${label} failed (${response.status}): ${body?.code ?? body?.error ?? 'unknown error'}`);
  }
  return body;
}

function sortedStrings(values) {
  return [...values].map(String).sort((left, right) => left.localeCompare(right));
}

function sameStrings(left, right) {
  return JSON.stringify(sortedStrings(left)) === JSON.stringify(sortedStrings(right));
}

function secretSafe(manifest) {
  const pending = [manifest];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== 'object') continue;
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    for (const [key, value] of Object.entries(current)) {
      if (/password|secret|token|api[_-]?key|authorization|credential|cookie|private[_-]?key/i.test(key)) return false;
      pending.push(value);
    }
  }
  return true;
}

async function waitForProfileAudits(pool, profileIds, deadlineMs = 5_000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const result = await pool.query(
      `SELECT action, object_id, object_label, changed_by, after_state, created_at
         FROM mcp_admin_audit_log
        WHERE table_name='mcp_fabric_profiles'
          AND object_id = ANY($1::text[])
          AND action IN ('exported','applied')
        ORDER BY created_at`,
      [profileIds.map(String)],
    );
    if (result.rows.length >= 2) return result.rows;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
  }
  return [];
}

async function waitForRestoreAudits(pool, profileId, requestId, deadlineMs = 5_000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const result = await pool.query(
      `SELECT action, object_id, changed_by, after_state, created_at
         FROM mcp_admin_audit_log
        WHERE table_name='mcp_fabric_profiles'
          AND object_id=$1
          AND action = ANY($2::text[])
          AND after_state->>'restore_request_id'=$3
        ORDER BY created_at`,
      [String(profileId), ['restore_requested', 'restore_approved', 'restore_applied'], requestId],
    );
    if (result.rows.length >= 3) return result.rows;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
  }
  return [];
}

async function waitForScheduledDriftObservation(pool, profileId, profileRevision, manifestDigest, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const result = await pool.query(
      `SELECT status, check_source, profile_revision, manifest_digest, checked_at
         FROM mcp_fabric_profile_drift_state
        WHERE profile_id=$1`,
      [profileId],
    );
    const observation = result.rows[0];
    if (observation?.status === 'in_sync'
      && observation.check_source === 'scheduled'
      && observation.profile_revision === profileRevision
      && observation.manifest_digest === manifestDigest) {
      return observation;
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 250));
  }
  return null;
}

async function cleanup(pool, fixture) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL argus.allow_fabric_profile_version_purge = 'on'");
    if (fixture.sessionId || fixture.reviewerSessionId) {
      await client.query('DELETE FROM mcp_sessions WHERE id = ANY($1::text[])', [
        [fixture.sessionId, fixture.reviewerSessionId].filter(Boolean),
      ]);
    }
    await client.query('DELETE FROM mcp_fabric_profiles WHERE name = ANY($1::text[])', [fixture.profileNames]);
    await client.query('DELETE FROM mcp_composites WHERE name = ANY($1::text[])', [fixture.compositeNames]);
    await client.query('DELETE FROM mcp_service_bundles WHERE name = ANY($1::text[])', [fixture.bundleNames]);
    if (fixture.reviewerUsername) {
      await client.query('DELETE FROM mcp_users WHERE username=$1', [fixture.reviewerUsername]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  const remaining = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM mcp_fabric_profiles WHERE name = ANY($1::text[])) AS profiles,
       (SELECT count(*)::int FROM mcp_composites WHERE name = ANY($2::text[])) AS composites,
       (SELECT count(*)::int FROM mcp_service_bundles WHERE name = ANY($3::text[])) AS bundles,
       (SELECT count(*)::int FROM mcp_group_composites WHERE group_name=$4) AS group_bindings`,
    [fixture.profileNames, fixture.compositeNames, fixture.bundleNames, fixture.groupName],
  );
  const counts = remaining.rows[0];
  assert(counts?.profiles === 0 && counts.composites === 0 && counts.bundles === 0 && counts.group_bindings === 0,
    'Certification fixture cleanup left live Fabric resources behind');
  return counts;
}

async function certify(pool, baseUrl, fixture) {
  const tables = await pool.query(
    `SELECT to_regclass('mcp_fabric_profiles')::text AS profiles,
            to_regclass('mcp_fabric_profile_versions')::text AS profile_versions,
            to_regclass('mcp_fabric_profile_restore_requests')::text AS profile_restores,
            to_regclass('mcp_fabric_profile_group_bindings')::text AS group_mappings,
            to_regclass('mcp_fabric_profile_drift_state')::text AS drift_state,
            to_regclass('mcp_admin_audit_log')::text AS audits,
            to_regclass('mcp_canonical_audit_events')::text AS canonical_audits,
            to_regclass('mcp_canonical_audit_outbox')::text AS canonical_outbox`,
  );
  assert(tables.rows[0]?.profiles && tables.rows[0]?.profile_versions && tables.rows[0]?.profile_restores && tables.rows[0]?.group_mappings && tables.rows[0]?.drift_state && tables.rows[0]?.audits
    && tables.rows[0]?.canonical_audits && tables.rows[0]?.canonical_outbox,
  'Bundle Set, SSO mapping or canonical audit migrations are not applied');

  const admin = await pool.query(
    `SELECT id, username FROM mcp_users
      WHERE enabled=true AND role='platform_admin'
      ORDER BY id LIMIT 1`,
  );
  assert(admin.rows[0], 'No enabled platform administrator exists for certification');
  await pool.query(
    `INSERT INTO mcp_sessions (id,user_id,expires_at,ip_address,user_agent)
     VALUES ($1,$2,now()+interval '15 minutes','127.0.0.1','fabric-bundle-set-certifier')`,
    [fixture.sessionId, admin.rows[0].id],
  );
  const reviewer = (await pool.query(
    `INSERT INTO mcp_users (username,password_hash,display_name,role,enabled)
     VALUES ($1,'certification-not-a-login','Bundle Set Restore Reviewer','platform_admin',true)
     RETURNING id,username`,
    [fixture.reviewerUsername],
  )).rows[0];
  await pool.query(
    `INSERT INTO mcp_sessions (id,user_id,expires_at,ip_address,user_agent)
     VALUES ($1,$2,now()+interval '15 minutes','127.0.0.1','fabric-bundle-set-restore-reviewer')`,
    [fixture.reviewerSessionId, reviewer.id],
  );

  const candidate = await pool.query(
    `SELECT backend.id, backend.name, backend.backend_type,
            array_agg(tool.id ORDER BY tool.name) AS tool_ids,
            array_agg(tool.name ORDER BY tool.name) AS tool_names
       FROM mcp_backends backend
       JOIN mcp_tools tool
         ON (tool.backend=backend.name OR tool.backend='custom:' || backend.name)
        AND tool.enabled=true
      WHERE backend.enabled=true
      GROUP BY backend.id, backend.name, backend.backend_type
     HAVING count(tool.id) >= 2
      ORDER BY CASE WHEN backend.name='gitea_local' THEN 0 ELSE 1 END, count(tool.id) DESC, backend.id
      LIMIT 1`,
  );
  const backend = candidate.rows[0];
  assert(backend, 'No enabled backend with at least two tools is available');
  const selectedToolIds = backend.tool_ids.slice(0, 2).map(Number);
  const selectedToolNames = backend.tool_names.slice(0, 2).map(String);
  const skill = (await pool.query('SELECT id, name FROM mcp_skills ORDER BY id LIMIT 1')).rows[0];
  assert(skill, 'No local skill is available for Bundle Set certification');

  const seedComposite = (await pool.query(
    `INSERT INTO mcp_composites (
       name, description, included_bundle_ids, tool_allow_patterns, tool_deny_patterns, enabled
     ) VALUES ($1,'Pre-existing SSO access preserved by the Bundle Set certifier','{}','{}','{}',true)
     RETURNING id`,
    [fixture.seedCompositeName],
  )).rows[0];
  await pool.query(
    'INSERT INTO mcp_group_composites (group_name,composite_id) VALUES ($1,$2)',
    [fixture.groupName, seedComposite.id],
  );

  const sourceBundle = (await pool.query(
    `INSERT INTO mcp_service_bundles (name,label,description,icon)
     VALUES ($1,$2,$3,'◈') RETURNING id`,
    [fixture.sourceBundleName, 'Certification source', 'Ephemeral Bundle Set lifecycle fixture'],
  )).rows[0];
  await pool.query('INSERT INTO mcp_backend_bundles (backend_id,bundle_id) VALUES ($1,$2)', [backend.id, sourceBundle.id]);
  await pool.query(
    `INSERT INTO mcp_bundle_backend_tool_policies (backend_id,bundle_id,mode,allowed_tool_names)
     VALUES ($1,$2,'selected',$3)`,
    [backend.id, sourceBundle.id, selectedToolNames],
  );
  await pool.query(
    `INSERT INTO mcp_tool_bundles (tool_id,bundle_id)
     SELECT unnest($1::int[]),$2`,
    [selectedToolIds, sourceBundle.id],
  );
  await pool.query(
    'INSERT INTO mcp_bundle_skills (bundle_id,skill_id,position) VALUES ($1,$2,0)',
    [sourceBundle.id, skill.id],
  );

  const traceId = randomBytes(16).toString('hex');
  let spanSequence = 0;
  const requestIds = [];
  const api = async (path, method = 'GET', body, sessionId = fixture.sessionId) => {
    const requestId = randomUUID();
    requestIds.push(requestId);
    spanSequence += 1;
    const spanId = spanSequence.toString(16).padStart(16, '0');
    return responseJson(await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        cookie: `argus_session=${sessionId}`,
        origin: baseUrl,
        accept: 'application/json',
        'content-type': 'application/json',
        'x-request-id': requestId,
        traceparent: `00-${traceId}-${spanId}-01`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), `${method} ${path}`);
  };

  const exported = await api('/api/ui/mcp-fabric/profiles/export', 'POST', {
    name: fixture.sourceProfileName,
    label: 'Certification export',
    description: 'Ephemeral secret-free export used by the lifecycle certifier',
    version: '1.0.0',
    bundleIds: [Number(sourceBundle.id)],
    createComposite: true,
    groupBindings: [{ logicalName: 'platform-engineers', required: true }],
  });
  const manifest = exported.profile?.manifest;
  assert(manifest?.kind === 'FabricProfile', 'Export did not return a FabricProfile manifest');
  assert(secretSafe(manifest), 'Exported manifest contains a sensitive field name');
  assert(manifest.spec?.bundles?.length === 1, 'Export did not retain exactly one source bundle');
  assert(sameStrings(manifest.spec.bundles[0].connectors[0].toolPolicy.allowedToolNames, selectedToolNames),
    'Export did not retain the selected tool policy');
  assert(sameStrings(manifest.spec.bundles[0].skills, [skill.name]), 'Export did not retain the assigned skill');
  assert(manifest.spec.access?.groupBindings?.length === 1
    && manifest.spec.access.groupBindings[0].logicalName === 'platform-engineers',
  'Export did not retain the portable SSO group alias');

  const reexported = await api('/api/ui/mcp-fabric/profiles/export', 'POST', {
    name: fixture.sourceProfileName,
    label: 'Certification export',
    description: 'Second immutable revision used by the lifecycle certifier',
    version: '1.0.1',
    bundleIds: [Number(sourceBundle.id)],
    createComposite: true,
    groupBindings: [{ logicalName: 'platform-engineers', required: true }],
  });
  assert(reexported.profile?.id === exported.profile.id && reexported.profile?.revision === 2,
    'Repeated export did not append the second profile revision');
  assert(reexported.profile?.manifestDigest !== exported.profile.manifestDigest,
    'Changed Bundle Set metadata did not produce a new manifest digest');

  const versionHistory = await api(`/api/ui/mcp-fabric/profiles/${exported.profile.id}/versions`);
  assert(versionHistory.versions?.length === 2
    && versionHistory.versions[0]?.revision === 2
    && versionHistory.versions[1]?.revision === 1,
  'Bundle Set version history did not return both immutable revisions in descending order');
  assert(versionHistory.versions.every(version => secretSafe(version.manifest)),
    'Bundle Set version history contains a sensitive field name');

  const versionDiff = await api(
    `/api/ui/mcp-fabric/profiles/${exported.profile.id}/versions/diff?from=1&to=2`,
  );
  assert(versionDiff.diff?.from?.manifestDigest === exported.profile.manifestDigest
    && versionDiff.diff?.to?.manifestDigest === reexported.profile.manifestDigest,
  'Bundle Set version diff is not bound to the exact source and target digests');
  assert(versionDiff.diff?.counts?.changed >= 1
    && versionDiff.diff?.changes?.some(change => change.scope === 'metadata' && change.field === 'version'),
  'Bundle Set version diff did not expose the changed manifest metadata');

  let immutableVersionRejected = false;
  try {
    await pool.query(
      'UPDATE mcp_fabric_profile_versions SET manifest_version=$1 WHERE profile_id=$2 AND revision=1',
      ['tampered', exported.profile.id],
    );
  } catch (error) {
    immutableVersionRejected = /immutable/i.test(String(error?.message ?? error));
  }
  assert(immutableVersionRejected, 'Database allowed an immutable Bundle Set revision to be modified');

  const importedManifest = structuredClone(manifest);
  importedManifest.metadata.name = fixture.importProfileName;
  importedManifest.metadata.label = 'Certification import';
  importedManifest.spec.bundles[0].name = fixture.destinationBundleName;
  importedManifest.spec.bundles[0].label = 'Certification destination';
  importedManifest.spec.access.compositeName = fixture.compositeName;

  const preview = await api('/api/ui/mcp-fabric/profiles/import/preview', 'POST', {
    manifest: importedManifest,
    mappings: { groups: { 'platform-engineers': fixture.groupName } },
  });
  assert(preview.plan?.blockers?.length === 0, `Import preview is blocked: ${JSON.stringify(preview.plan?.blockers ?? [])}`);
  assert(preview.plan.actions
    .filter(action => action.kind !== 'group')
    .every(action => action.operation === 'create'), 'Fresh import preview did not plan create actions');
  const groupAction = preview.plan.actions.find(action => action.kind === 'group');
  assert(groupAction?.operation === 'bind' && groupAction.target === fixture.groupName,
    'Import preview did not expose the local SSO group binding');
  assert(/^[a-f0-9]{64}$/.test(preview.plan.planToken), 'Import preview did not issue a valid plan token');

  const applied = await api('/api/ui/mcp-fabric/profiles/import/apply', 'POST', {
    manifest: importedManifest,
    mappings: { groups: { 'platform-engineers': fixture.groupName } },
    planToken: preview.plan.planToken,
  });
  assert(applied.profile?.name === fixture.importProfileName, 'Apply did not persist the imported profile');
  assert(applied.bundleIds?.length === 1 && applied.compositeId, 'Apply did not create the bundle and access composite');
  assert(applied.groupBindings?.length === 1
    && applied.groupBindings[0].groupName === fixture.groupName,
  'Apply did not return the resolved SSO group binding');
  const destinationBundleId = Number(applied.bundleIds[0]);

  const topology = await pool.query(
    `SELECT
       (SELECT array_agg(backend.name ORDER BY backend.name)
          FROM mcp_backend_bundles assignment JOIN mcp_backends backend ON backend.id=assignment.backend_id
         WHERE assignment.bundle_id=$1) AS backends,
       (SELECT jsonb_agg(jsonb_build_object('backend',backend.name,'mode',policy.mode,'tools',policy.allowed_tool_names) ORDER BY backend.name)
          FROM mcp_bundle_backend_tool_policies policy JOIN mcp_backends backend ON backend.id=policy.backend_id
         WHERE policy.bundle_id=$1) AS policies,
       (SELECT array_agg(tool.name ORDER BY tool.name)
          FROM mcp_tool_bundles assignment JOIN mcp_tools tool ON tool.id=assignment.tool_id
         WHERE assignment.bundle_id=$1) AS tools,
       (SELECT array_agg(skill.name ORDER BY assignment.position,skill.name)
          FROM mcp_bundle_skills assignment JOIN mcp_skills skill ON skill.id=assignment.skill_id
         WHERE assignment.bundle_id=$1) AS skills`,
    [destinationBundleId],
  );
  const actual = topology.rows[0];
  assert(sameStrings(actual.backends ?? [], [backend.name]), 'Applied backend mapping differs from the exported manifest');
  assert(actual.policies?.length === 1 && actual.policies[0].mode === 'selected'
    && sameStrings(actual.policies[0].tools, selectedToolNames), 'Applied tool policy differs from the export');
  assert(sameStrings(actual.tools ?? [], selectedToolNames), 'Applied effective tools differ from the selected policy');
  assert(sameStrings(actual.skills ?? [], [skill.name]), 'Applied skills differ from the export');

  const composite = await pool.query(
    'SELECT id,included_bundle_ids,enabled FROM mcp_composites WHERE name=$1',
    [fixture.compositeName],
  );
  assert(composite.rows[0]?.enabled && sameStrings(composite.rows[0].included_bundle_ids, [destinationBundleId]),
    'Applied composite does not contain exactly the imported bundle');

  const groupAccess = await pool.query(
    `SELECT composite_id FROM mcp_group_composites
      WHERE group_name=$1 ORDER BY composite_id`,
    [fixture.groupName],
  );
  assert(sameStrings(groupAccess.rows.map(row => row.composite_id), [seedComposite.id, applied.compositeId]),
    'Bundle Set apply replaced existing SSO group access instead of adding to it');
  const groupProvenance = await pool.query(
    `SELECT logical_name, group_name, composite_id, assignment_owned
       FROM mcp_fabric_profile_group_bindings WHERE profile_id=$1`,
    [applied.profile.id],
  );
  assert(groupProvenance.rows.length === 1
    && groupProvenance.rows[0].logical_name === 'platform-engineers'
    && groupProvenance.rows[0].group_name === fixture.groupName
    && groupProvenance.rows[0].composite_id === applied.compositeId
    && groupProvenance.rows[0].assignment_owned === true,
  'Applied SSO group mapping provenance is incomplete');

  const listed = await api('/api/ui/mcp-fabric/profiles');
  const importedRecord = listed.profiles?.find(profile => profile.name === fixture.importProfileName);
  assert(importedRecord && sameStrings(importedRecord.installedBundleIds, [destinationBundleId]),
    'Saved Bundle Set catalog does not expose the applied resource IDs');
  assert(importedRecord.appliedMappings?.groups?.['platform-engineers'] === fixture.groupName,
    'Saved Bundle Set catalog does not retain the environment-local group mapping');
  assert(listed.groups?.some(group => group.name === fixture.groupName),
    'Bundle Set catalog does not expose the mapped local SSO group');

  let scheduledWorkerObservation = null;
  if (fixture.scheduledWaitMs > 0) {
    scheduledWorkerObservation = await waitForScheduledDriftObservation(
      pool,
      applied.profile.id,
      applied.profile.revision,
      applied.profile.manifestDigest,
      fixture.scheduledWaitMs,
    );
    assert(scheduledWorkerObservation,
      `Scheduled drift worker did not observe the applied Bundle Set within ${fixture.scheduledWaitMs}ms`);
  }

  const inSync = await api(`/api/ui/mcp-fabric/profiles/${applied.profile.id}/drift/check`, 'POST');
  assert(inSync.drift?.status === 'in_sync' && inSync.drift?.counts?.total === 0,
    `Freshly applied Bundle Set was not in sync: ${JSON.stringify(inSync.drift ?? null)}`);
  const storedInSync = (await pool.query(
    `SELECT status, finding_count, check_source, profile_revision, manifest_digest
       FROM mcp_fabric_profile_drift_state WHERE profile_id=$1`,
    [applied.profile.id],
  )).rows[0];
  assert(storedInSync?.status === 'in_sync' && storedInSync.finding_count === 0
    && storedInSync.check_source === 'manual'
    && storedInSync.profile_revision === applied.profile.revision
    && storedInSync.manifest_digest === applied.profile.manifestDigest,
  'Fresh drift result was not persisted against the exact applied profile revision');
  const listedAfterCheck = await api('/api/ui/mcp-fabric/profiles');
  const listedDrift = listedAfterCheck.profiles?.find(profile => profile.id === applied.profile.id)?.drift;
  assert(listedDrift?.status === 'in_sync' && listedDrift.source === 'manual',
    'Bundle Set catalog did not project the latest persisted drift state');
  await pool.query(
    `UPDATE mcp_bundle_backend_tool_policies SET mode='all', allowed_tool_names='{}'
      WHERE backend_id=$1 AND bundle_id=$2`,
    [backend.id, destinationBundleId],
  );
  const drifted = await api(`/api/ui/mcp-fabric/profiles/${applied.profile.id}/drift/check`, 'POST');
  assert(drifted.drift?.status === 'drifted'
    && drifted.drift?.findings?.some(finding => finding.code === 'tool_policy_changed'),
  'Explicit Bundle Set drift did not detect a changed backend tool policy');
  const storedDrift = (await pool.query(
    `SELECT status, finding_count, critical_count, findings, finding_digest, transition_sequence
       FROM mcp_fabric_profile_drift_state WHERE profile_id=$1`,
    [applied.profile.id],
  )).rows[0];
  assert(storedDrift?.status === 'drifted' && storedDrift.finding_count >= 1
    && storedDrift.critical_count >= 1 && /^[a-f0-9]{64}$/.test(storedDrift.finding_digest)
    && storedDrift.transition_sequence >= 2,
  'Persisted Bundle Set drift state is incomplete');
  assert(storedDrift.findings?.some(finding => finding.code === 'tool_policy_changed')
    && storedDrift.findings.every(finding => !('expected' in finding) && !('actual' in finding)),
  'Persisted drift findings are missing or contain unbounded expected/actual topology');
  await pool.query(
    `UPDATE mcp_bundle_backend_tool_policies SET mode='selected', allowed_tool_names=$3
      WHERE backend_id=$1 AND bundle_id=$2`,
    [backend.id, destinationBundleId, selectedToolNames],
  );

  const changedManifest = structuredClone(importedManifest);
  changedManifest.metadata.version = '1.0.1';
  changedManifest.metadata.description = 'Changed head revision used to certify approval-gated restore';
  changedManifest.spec.bundles[0].description = 'Changed destination metadata before restore';
  const changedPreview = await api('/api/ui/mcp-fabric/profiles/import/preview', 'POST', {
    manifest: changedManifest,
    mappings: { groups: { 'platform-engineers': fixture.groupName } },
  });
  assert(changedPreview.plan?.blockers?.length === 0, 'Changed Bundle Set head preview is blocked');
  const changedHead = await api('/api/ui/mcp-fabric/profiles/import/apply', 'POST', {
    manifest: changedManifest,
    mappings: { groups: { 'platform-engineers': fixture.groupName } },
    planToken: changedPreview.plan.planToken,
  });
  assert(changedHead.profile?.id === applied.profile.id && changedHead.profile?.revision === 2,
    'Changed Bundle Set head did not append revision 2');
  assert(changedHead.profile?.manifestDigest !== applied.profile.manifestDigest,
    'Changed Bundle Set head did not receive a distinct manifest digest');

  const restorePreview = await api('/api/ui/mcp-fabric/profiles/import/preview', 'POST', {
    manifest: importedManifest,
    mappings: { groups: { 'platform-engineers': fixture.groupName } },
  });
  assert(restorePreview.plan?.blockers?.length === 0 && /^[a-f0-9]{64}$/.test(restorePreview.plan?.planToken),
    'Historical Bundle Set restore preview is blocked or unbound');
  const restoreRequested = await api(`/api/ui/mcp-fabric/profiles/${applied.profile.id}/restores`, 'POST', {
    targetRevision: 1,
    mappings: { groups: { 'platform-engineers': fixture.groupName } },
    planToken: restorePreview.plan.planToken,
    comment: 'Return the certification Bundle Set to its reviewed baseline',
  });
  assert(restoreRequested.request?.status === 'pending'
    && restoreRequested.request?.requestedBy === Number(admin.rows[0].id)
    && restoreRequested.request?.targetRevision === 1,
  'Restore request is not bound to the requesting administrator and target revision');
  const restoreDecision = await api(
    `/api/ui/mcp-fabric/profiles/restores/${restoreRequested.request.id}/decision`,
    'POST',
    { decision: 'approved', comment: 'Independent certification reviewer approved the exact digest' },
    fixture.reviewerSessionId,
  );
  assert(restoreDecision.request?.status === 'approved'
    && restoreDecision.request?.decidedBy === Number(reviewer.id)
    && restoreDecision.request?.decidedBy !== restoreDecision.request?.requestedBy,
  'Restore approval did not enforce an independent Platform Admin');
  const restoreApplied = await api(
    `/api/ui/mcp-fabric/profiles/restores/${restoreRequested.request.id}/apply`,
    'POST',
    undefined,
    fixture.reviewerSessionId,
  );
  assert(restoreApplied.restoreRequest?.status === 'applied'
    && restoreApplied.profile?.revision === 3
    && restoreApplied.profile?.manifestDigest === applied.profile.manifestDigest,
  'Approved restore did not append a new head revision with the historical target digest');
  const restoredVersions = await api(`/api/ui/mcp-fabric/profiles/${applied.profile.id}/versions`);
  assert(restoredVersions.versions?.length === 3
    && sameStrings(restoredVersions.versions.map(version => version.revision), [1, 2, 3])
    && restoredVersions.versions[0]?.manifestDigest === applied.profile.manifestDigest,
  'Restore history does not retain the immutable source, changed head and restored head revisions');
  const restoreAudits = await waitForRestoreAudits(pool, applied.profile.id, restoreRequested.request.id);
  assert(restoreAudits.length === 3
    && restoreAudits.some(row => row.action === 'restore_requested' && row.changed_by === admin.rows[0].username)
    && restoreAudits.filter(row => row.action !== 'restore_requested').every(row => row.changed_by === reviewer.username),
  'Restore audit evidence does not retain the requester/reviewer separation of duties');
  assert(restoreAudits.every(row => secretSafe(row.after_state)),
    'Restore audit evidence contains sensitive field names');

  const audits = await waitForProfileAudits(pool, [exported.profile.id, applied.profile.id]);
  assert(audits.length >= 2, 'Bundle Set export/apply audit evidence was not persisted');
  assert(audits.every(row => row.changed_by === admin.rows[0].username), 'Bundle Set audit actor differs from the authenticated administrator');
  assert(audits.every(row => secretSafe(row.after_state)), 'Bundle Set audit evidence contains sensitive field names');
  assert(audits.some(row => row.action === 'exported' && row.after_state?.manifest_digest === exported.profile.manifestDigest),
    'Export audit evidence is not bound to the manifest digest');
  assert(audits.some(row => row.action === 'applied' && row.after_state?.manifest_digest === applied.profile.manifestDigest),
    'Apply audit evidence is not bound to the manifest digest');

  const canonicalAudits = await pool.query(
    `SELECT event_id, actor_id, actor_auth_method, action, trace_id, span_id, request_id,
            payload_summary, payload_digest, event_hash
       FROM mcp_canonical_audit_events
      WHERE request_id = ANY($1::text[])
        AND action = ANY($2::text[])
      ORDER BY sequence`,
    [requestIds, [
      'mcp.fabric_profile.exported',
      'mcp.fabric_profile.import_previewed',
      'mcp.fabric_profile.applied',
      'mcp.fabric_profile.drift_checked',
    ]],
  );
  const canonicalActions = canonicalAudits.rows.map(row => row.action);
  assert(canonicalActions.includes('mcp.fabric_profile.exported')
    && canonicalActions.includes('mcp.fabric_profile.import_previewed')
    && canonicalActions.includes('mcp.fabric_profile.applied')
    && canonicalActions.filter(action => action === 'mcp.fabric_profile.drift_checked').length === 2,
  `Canonical lifecycle evidence is incomplete: ${JSON.stringify(canonicalActions)}`);
  assert(canonicalAudits.rows.every(row => row.actor_id === String(admin.rows[0].id)
    && row.actor_auth_method === 'session'),
  'Canonical Bundle Set evidence is not bound to the authenticated administrator');
  assert(canonicalAudits.rows.every(row => row.trace_id === traceId && row.span_id && requestIds.includes(row.request_id)),
    'Canonical Bundle Set evidence is not correlated to its incoming trace, span and request');
  assert(canonicalAudits.rows.every(row => /^[a-f0-9]{64}$/.test(row.payload_digest)
    && /^[a-f0-9]{64}$/.test(row.event_hash) && secretSafe(row.payload_summary)),
  'Canonical Bundle Set evidence has an invalid digest/hash or contains a sensitive field name');
  const outbox = await pool.query(
    'SELECT count(*)::int AS count FROM mcp_canonical_audit_outbox WHERE event_id = ANY($1::uuid[])',
    [canonicalAudits.rows.map(row => row.event_id)],
  );
  assert(outbox.rows[0]?.count === canonicalAudits.rows.length,
    'Canonical Bundle Set evidence was not durably staged in the audit outbox');

  return {
    checks: {
      secret_free_export: true,
      selected_tool_policy_round_trip: true,
      skill_round_trip: true,
      dry_run_without_mutation: true,
      digest_bound_plan_apply: true,
      backend_mapping_round_trip: true,
      effective_tool_round_trip: true,
      access_composite_round_trip: true,
      portable_sso_alias_round_trip: true,
      immutable_revision_history: true,
      digest_bound_revision_diff: true,
      database_version_tamper_rejected: true,
      additive_sso_group_binding: true,
      sso_mapping_provenance: true,
      saved_profile_projection: true,
      audit_actor_and_digest_evidence: true,
      fresh_apply_reports_in_sync: true,
      tool_policy_drift_detected: true,
      persistent_drift_state: true,
      bounded_persisted_findings: true,
      drift_catalog_projection: true,
      canonical_lifecycle_evidence: true,
      trace_span_request_correlation: true,
      canonical_audit_outbox: true,
      approval_gated_restore: true,
      restore_separation_of_duties: true,
      restore_appends_immutable_head: true,
      restore_audit_evidence: true,
      ...(fixture.scheduledWaitMs > 0 ? { scheduled_worker_observation: true } : {}),
    },
    scheduledWorker: scheduledWorkerObservation
      ? { status: 'passed', checkedAt: scheduledWorkerObservation.checked_at }
      : { status: 'not_run', reason: 'ARGUS_FABRIC_PROFILE_CERT_SCHEDULED_WAIT_SEC was not set' },
    fixture: {
      backend: backend.name,
      tools: selectedToolNames,
      skill: skill.name,
      ssoGroup: fixture.groupName,
    },
    transientArtifacts: {
      exportProfileId: exported.profile.id,
      importProfileId: applied.profile.id,
      destinationBundleId,
      compositeId: applied.compositeId,
    },
    correlation: {
      traceId,
      requestIds,
      auditObjectIds: audits.map(row => row.object_id),
      canonicalAuditEventIds: canonicalAudits.rows.map(row => row.event_id),
      restoreRequestId: restoreRequested.request.id,
      manifestDigests: [
        exported.profile.manifestDigest,
        reexported.profile.manifestDigest,
        applied.profile.manifestDigest,
      ],
    },
  };
}

async function main() {
  const suffix = randomBytes(6).toString('hex');
  const fixture = {
    sessionId: randomUUID(),
    reviewerSessionId: randomUUID(),
    reviewerUsername: `argus-cert-reviewer-${suffix}`,
    sourceBundleName: `argus_cert_source_${suffix}`,
    destinationBundleName: `argus_cert_destination_${suffix}`,
    sourceProfileName: `argus_cert_export_${suffix}`,
    importProfileName: `argus_cert_import_${suffix}`,
    compositeName: `argus_cert_access_${suffix}`,
    seedCompositeName: `argus_cert_existing_access_${suffix}`,
    groupName: `argus-cert-sso-${suffix}`,
    scheduledWaitMs: Math.max(0, Math.min(
      600_000,
      Number.parseInt(process.env.ARGUS_FABRIC_PROFILE_CERT_SCHEDULED_WAIT_SEC || '0', 10) * 1_000 || 0,
    )),
  };
  fixture.bundleNames = [fixture.sourceBundleName, fixture.destinationBundleName];
  fixture.profileNames = [fixture.sourceProfileName, fixture.importProfileName];
  fixture.compositeNames = [fixture.compositeName, fixture.seedCompositeName];
  const pool = new Pool({ connectionString: databaseUrl(), max: 2, connectionTimeoutMillis: 10_000 });
  const baseUrl = (process.env.ARGUS_BASE_URL?.trim() || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const report = { generatedAt: new Date().toISOString(), status: 'failed', baseUrl };
  try {
    report.certification = await certify(pool, baseUrl, fixture);
    report.status = 'passed';
  } catch (error) {
    report.error = safeError(error);
  } finally {
    try {
      report.cleanup = { status: 'passed', remaining: await cleanup(pool, fixture) };
    } catch (cleanupError) {
      report.cleanup = { status: 'failed', error: safeError(cleanupError) };
      report.status = 'failed';
    }
    await pool.end().catch(() => undefined);
  }
  await mkdir(dirname(resolve(REPORT_PATH)), { recursive: true });
  await writeFile(resolve(REPORT_PATH), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== 'passed') process.exitCode = 2;
}

main().catch(error => {
  process.stderr.write(`${safeError(error)}\n`);
  process.exitCode = 2;
});
