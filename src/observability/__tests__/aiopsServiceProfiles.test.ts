import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { jest } from '@jest/globals';
import type pg from 'pg';
import {
  activateAiOpsServiceProfileRecord,
  AiOpsServiceProfileError,
  appendAiOpsServiceProfileRevisionRecord,
  createAiOpsServiceProfileRecord,
  recordAiOpsServiceProfileValidationRecord,
  toAiOpsServiceProfileResource,
} from '../aiopsServiceProfiles.js';
import {
  aiOpsServiceProfileReadinessSchema,
  aiOpsServiceProfileResourceSchema,
  hashAiOpsServiceProfileConfig,
} from '../aiopsServiceProfileContracts.js';

const fixture = (name: string): unknown => JSON.parse(readFileSync(resolve(
  process.cwd(),
  'docs/specs/aiops-service-profiles',
  name,
), 'utf8'));

const activeFixture = () => aiOpsServiceProfileResourceSchema.parse(
  fixture('service-profile-active.v1.fixture.json'),
);

function profileRow(options: {
  revision?: number;
  activeRevision?: number | null;
  status?: 'draft' | 'active' | 'paused' | 'archived';
  config?: ReturnType<typeof activeFixture>['latestRevision']['config'];
} = {}) {
  const profile = activeFixture();
  const config = options.config ?? profile.latestRevision.config;
  const revision = options.revision ?? 1;
  const activeRevision = options.activeRevision === undefined ? null : options.activeRevision;
  const hash = hashAiOpsServiceProfileConfig(config);
  return {
    id: 41,
    status: options.status ?? 'draft',
    active_revision: activeRevision,
    active_sha256: activeRevision == null ? null : hash,
    latest_revision: revision,
    latest_sha256: hash,
    latest_profile_json: config,
    latest_created_at: new Date('2026-09-08T10:00:00.000Z'),
    latest_created_by_actor_id: 7,
    latest_created_by_username: 'alex',
    created_at: new Date('2026-09-08T09:00:00.000Z'),
    updated_at: new Date('2026-09-08T10:00:00.000Z'),
  };
}

describe('AIOps service profile registry', () => {
  it('creates a draft with one immutable content-addressed revision', async () => {
    const profile = activeFixture();
    const row = profileRow();
    const query = jest.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('INSERT INTO mcp_observability_aiops_service_profiles')) return { rows: [{ id: 41 }] };
      if (sql.includes('INSERT INTO mcp_observability_aiops_service_profile_revisions')) return { rows: [] };
      if (sql.includes('JOIN LATERAL')) return { rows: [row] };
      throw new Error(`Unexpected query: ${sql}`);
    });

    const created = await createAiOpsServiceProfileRecord(
      { query } as unknown as pg.Pool,
      profile.latestRevision.config,
      { id: 7, username: 'alex' },
    );

    expect(created).toMatchObject({ id: 41, status: 'draft', activeRevision: null });
    const revisionInsert = query.mock.calls.find(call => String(call[0]).includes('service_profile_revisions'));
    expect(revisionInsert?.[1]).toEqual(expect.arrayContaining([
      41,
      1,
      hashAiOpsServiceProfileConfig(profile.latestRevision.config),
    ]));
  });

  it('appends revision two without moving the active revision pointer', async () => {
    const profile = activeFixture();
    const updated = structuredClone(profile.latestRevision.config);
    updated.service.description = 'Updated bounded profile description.';
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('FOR UPDATE OF profile')) return { rows: [{
        service_name: 'checkout-api', environment: 'production', latest_revision: 1,
        latest_sha256: hashAiOpsServiceProfileConfig(profile.latestRevision.config),
      }] };
      if (sql.includes('INSERT INTO mcp_observability_aiops_service_profile_revisions')) return { rows: [] };
      if (sql.includes('UPDATE mcp_observability_aiops_service_profiles')) return { rows: [] };
      if (sql.includes('JOIN LATERAL')) return { rows: [profileRow({ revision: 2, config: updated })] };
      throw new Error(`Unexpected query: ${sql}`);
    });

    const revised = await appendAiOpsServiceProfileRevisionRecord(
      { query } as unknown as pg.Pool,
      41,
      1,
      updated,
      { id: 7, username: 'alex' },
    );

    expect(revised.latestRevision).toMatchObject({ revision: 2, config: { service: { description: updated.service.description } } });
    expect(revised.activeRevision).toBeNull();
  });

  it('fails optimistic concurrency before inserting a revision', async () => {
    const profile = activeFixture();
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('FOR UPDATE OF profile')) return { rows: [{
        service_name: 'checkout-api', environment: 'production', latest_revision: 3,
        latest_sha256: hashAiOpsServiceProfileConfig(profile.latestRevision.config),
      }] };
      throw new Error(`Unexpected query: ${sql}`);
    });

    await expect(appendAiOpsServiceProfileRevisionRecord(
      { query } as unknown as pg.Pool,
      41,
      2,
      profile.latestRevision.config,
      { id: 7, username: 'alex' },
    )).rejects.toMatchObject({ status: 409, code: 'revision_conflict' });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('persists readiness evidence against the exact revision hash', async () => {
    const readiness = aiOpsServiceProfileReadinessSchema.parse(
      fixture('profile-readiness-partial.v1.fixture.json'),
    );
    const row = profileRow({ revision: readiness.revision });
    const validationRow = {
      id: 9,
      profile_id: readiness.profileId,
      revision: readiness.revision,
      profile_sha256: readiness.profileSha256,
      status: 'warning' as const,
      readiness_json: readiness,
      validated_by_actor_id: 7,
      validated_by_username: 'alex',
      validated_at: new Date('2026-09-08T10:15:00.000Z'),
    };
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('JOIN LATERAL')) return { rows: [row] };
      if (sql.includes('SELECT profile_sha256')) return { rows: [{ profile_sha256: readiness.profileSha256 }] };
      if (sql.includes('INSERT INTO mcp_observability_aiops_profile_validations')) return { rows: [validationRow] };
      throw new Error(`Unexpected query: ${sql}`);
    });

    await expect(recordAiOpsServiceProfileValidationRecord(
      { query } as unknown as pg.Pool,
      readiness,
      { id: 7, username: 'alex' },
    )).resolves.toMatchObject({ status: 'warning', profileSha256: readiness.profileSha256 });
  });

  it('activates only an exactly validated revision', async () => {
    const profile = activeFixture();
    const hash = hashAiOpsServiceProfileConfig(profile.latestRevision.config);
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('FOR UPDATE OF profile')) return { rows: [{
        service_name: 'checkout-api', environment: 'production', latest_revision: 1, latest_sha256: hash,
      }] };
      if (sql.includes('FROM mcp_observability_aiops_profile_validations validation')) {
        return { rows: [{ status: 'passed', profile_sha256: hash, profile_json: profile.latestRevision.config }] };
      }
      if (sql.includes('jsonb_array_elements_text')) return { rows: [] };
      if (sql.includes("SET status='active'")) return { rows: [] };
      if (sql.includes('JOIN LATERAL')) return { rows: [profileRow({ activeRevision: 1, status: 'active' })] };
      throw new Error(`Unexpected query: ${sql}`);
    });

    const activated = await activateAiOpsServiceProfileRecord(
      { query } as unknown as pg.Pool,
      41,
      1,
      1,
    );
    expect(activated).toMatchObject({ status: 'active', activeRevision: { revision: 1, sha256: hash } });
  });

  it('rejects an active auto-investigation rule already owned by another profile', async () => {
    const profile = activeFixture();
    profile.latestRevision.config.detection.autoInvestigate = true;
    profile.latestRevision.config.detection.nativeAlertRuleIds = [73];
    const hash = hashAiOpsServiceProfileConfig(profile.latestRevision.config);
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('FOR UPDATE OF profile')) return { rows: [{
        service_name: 'checkout-api', environment: 'production', latest_revision: 1, latest_sha256: hash,
      }] };
      if (sql.includes('FROM mcp_observability_aiops_profile_validations validation')) {
        return { rows: [{ status: 'passed', profile_sha256: hash, profile_json: profile.latestRevision.config }] };
      }
      if (sql.includes('jsonb_array_elements_text')) {
        return { rows: [{ id: 42, service_name: 'orders-api', environment: 'production' }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    await expect(activateAiOpsServiceProfileRecord(
      { query } as unknown as pg.Pool,
      41,
      1,
      1,
    )).rejects.toMatchObject({ status: 409, code: 'identity_conflict' });
    expect(query.mock.calls.some(call => String(call[0]).includes("SET status='active'"))).toBe(false);
  });

  it('rejects activation without successful validation evidence', async () => {
    const profile = activeFixture();
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('FOR UPDATE OF profile')) return { rows: [{
        service_name: 'checkout-api', environment: 'production', latest_revision: 1,
        latest_sha256: hashAiOpsServiceProfileConfig(profile.latestRevision.config),
      }] };
      if (sql.includes('FROM mcp_observability_aiops_profile_validations validation')) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    });

    await expect(activateAiOpsServiceProfileRecord(
      { query } as unknown as pg.Pool,
      41,
      1,
      1,
    )).rejects.toEqual(expect.objectContaining<Partial<AiOpsServiceProfileError>>({
      status: 422,
      code: 'validation_required',
    }));
  });

  it('composes the API resource with shared tags and caller-specific actions', () => {
    const resource = toAiOpsServiceProfileResource(
      {
        id: 41,
        status: 'draft',
        activeRevision: null,
        latestRevision: activeFixture().latestRevision,
        createdAt: '2026-09-08T09:00:00.000Z',
        updatedAt: '2026-09-08T10:00:00.000Z',
      },
      {
        tags: [{ id: '2', label: 'payments', color: null }],
        allowedActions: ['read', 'edit', 'validate'],
      },
    );
    expect(aiOpsServiceProfileResourceSchema.parse(resource)).toMatchObject({
      tags: [{ label: 'payments', color: null }],
      allowedActions: ['read', 'edit', 'validate'],
    });
  });
});
