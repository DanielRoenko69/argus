import pg from 'pg';
import { createHash } from 'node:crypto';
import { logger } from '../lib/logger.js';
import type { Skill, CreateSkillInput, UpdateSkillInput, SkillRef } from './types.js';

export async function listSkills(pool: pg.Pool): Promise<Skill[]> {
  const { rows } = await pool.query<Skill>(
    'SELECT * FROM mcp_skills ORDER BY category NULLS LAST, label',
  );
  return rows;
}

export async function getSkill(pool: pg.Pool, id: number): Promise<Skill | null> {
  const { rows } = await pool.query<Skill>('SELECT * FROM mcp_skills WHERE id=$1', [id]);
  return rows[0] ?? null;
}

export async function createSkill(pool: pg.Pool, input: CreateSkillInput): Promise<Skill> {
  const { rows } = await pool.query<Skill>(
    `INSERT INTO mcp_skills (name, label, description, content, category, icon, source_url, source_ref, imported_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [
      input.name, input.label, input.description ?? '',
      input.content, input.category ?? null,
      input.icon ?? '🔧',
      input.source_url ?? null,
      input.source_ref ?? null,
      input.imported_at ?? null,
    ],
  );
  logger.info({ name: input.name }, 'Skill created');
  return rows[0];
}

/** Upsert by name — used by argus-skills sync to refresh imported skills idempotently. */
export async function upsertSkillByName(pool: pg.Pool, input: CreateSkillInput): Promise<{ skill: Skill; created: boolean }> {
  const existing = await pool.query<Skill>('SELECT * FROM mcp_skills WHERE name=$1', [input.name]);
  if (existing.rows.length === 0) {
    const skill = await createSkill(pool, input);
    return { skill, created: true };
  }
  const id = existing.rows[0]!.id;
  const skill = await updateSkill(pool, id, {
    label: input.label,
    description: input.description ?? '',
    content: input.content,
    category: input.category ?? null,
    icon: input.icon,
    source_url: input.source_url ?? null,
    source_ref: input.source_ref ?? null,
    imported_at: input.imported_at ?? new Date().toISOString(),
  });
  return { skill, created: false };
}

export async function updateSkill(pool: pg.Pool, id: number, input: UpdateSkillInput): Promise<Skill> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (input.label !== undefined)       { sets.push(`label=$${idx++}`);       values.push(input.label); }
  if (input.description !== undefined) { sets.push(`description=$${idx++}`); values.push(input.description); }
  if (input.content !== undefined)     { sets.push(`content=$${idx++}`);     values.push(input.content); }
  if (input.category !== undefined)    { sets.push(`category=$${idx++}`);    values.push(input.category || null); }
  if (input.icon !== undefined)        { sets.push(`icon=$${idx++}`);        values.push(input.icon); }
  if (input.source_url !== undefined)  { sets.push(`source_url=$${idx++}`);  values.push(input.source_url); }
  if (input.source_ref !== undefined)  { sets.push(`source_ref=$${idx++}`);  values.push(input.source_ref); }
  if (input.imported_at !== undefined) { sets.push(`imported_at=$${idx++}`); values.push(input.imported_at); }

  if (sets.length === 0) {
    const existing = await getSkill(pool, id);
    if (!existing) throw new Error(`Skill ${id} not found`);
    return existing;
  }

  values.push(id);
  const { rows } = await pool.query<Skill>(
    `UPDATE mcp_skills SET ${sets.join(', ')} WHERE id=$${idx} RETURNING *`,
    values,
  );
  if (rows.length === 0) throw new Error(`Skill ${id} not found`);
  logger.info({ skillId: id }, 'Skill updated');
  return rows[0];
}

export async function deleteSkill(pool: pg.Pool, id: number): Promise<void> {
  const skill = await getSkill(pool, id);
  if (!skill) throw new Error(`Skill ${id} not found`);
  await pool.query('DELETE FROM mcp_skills WHERE id=$1', [id]);
  logger.info({ skillId: id }, 'Skill deleted');
}

export async function setAgentSkills(pool: pg.Pool, agentId: number, skillIds: number[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await replaceAgentSkills(client, agentId, skillIds);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getAgentSkillContents(pool: pg.Pool, agentId: number): Promise<string[]> {
  return (await readPinnedAgentSkills(pool,agentId)).map(r => r.content);
}

/** Caller owns the transaction. Reordering and Blueprint upgrades preserve pins. */
export async function replaceAgentSkills(client:Pick<pg.PoolClient,'query'>,agentId:number,skillIds:number[]) {
  await client.query('SELECT id FROM mcp_agents WHERE id=$1 FOR UPDATE',[agentId]);
  await client.query('DELETE FROM mcp_agent_skills WHERE agent_id=$1 AND NOT (skill_id=ANY($2::int[]))',[agentId,skillIds]);
  for (const [position,id] of [...new Set(skillIds)].entries()) {
    await client.query(`INSERT INTO mcp_agent_skills(agent_id,skill_id,position) VALUES($1,$2,$3)
      ON CONFLICT(agent_id,skill_id) DO UPDATE SET position=EXCLUDED.position`,[agentId,id,position]);
  }
}

export interface PinnedAgentSkill { id:number;name:string;content:string;position:number;revision_id:number;content_sha256:string }
export class SkillPinUnavailableError extends Error {
  constructor() { super('An assigned Skill is disabled or its pinned content failed verification. Review the Skill Library or remove the assignment.');this.name='SkillPinUnavailableError'; }
}
export const skillContentDigest=(content:string)=>createHash('sha256').update(content,'utf8').digest('hex');
export async function readPinnedAgentSkills(client:Pick<pg.Pool,'query'>,agentId:number,lock=false):Promise<PinnedAgentSkill[]> {
  const { rows }=await client.query(`SELECT s.id,s.name,r.content,ags.position,ags.revision_id,r.content_sha256,s.enabled
    FROM mcp_skills s JOIN mcp_agent_skills ags ON ags.skill_id=s.id
    JOIN mcp_skill_revisions r ON r.id=ags.revision_id AND r.skill_id=s.id
    WHERE ags.agent_id=$1 ORDER BY ags.position,s.label ${lock ? 'FOR SHARE OF s,ags' : ''}`,[agentId]);
  return rows.map(({ enabled,...r })=>{
    if (!enabled || skillContentDigest(r.content)!==r.content_sha256) throw new SkillPinUnavailableError();
    return { ...r,revision_id:Number(r.revision_id) } as PinnedAgentSkill;
  });
}

export async function getAgentSkillRefs(pool: pg.Pool, agentId: number): Promise<SkillRef[]> {
  const { rows } = await pool.query<SkillRef>(
    `SELECT s.id, s.name, s.label, s.icon, s.category, ags.position, ags.revision_id, s.current_revision_id
     FROM mcp_skills s
     JOIN mcp_agent_skills ags ON ags.skill_id = s.id
     WHERE ags.agent_id = $1
     ORDER BY ags.position, s.label`,
    [agentId],
  );
  return rows;
}
