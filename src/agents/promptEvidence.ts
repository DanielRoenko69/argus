import { createHash } from 'node:crypto';

/** Identifies the loaded Agent prompt only, not dynamically assembled run context. */
export function agentPromptEvidence(agent:{ system_prompt:string|null;prompt_revision_id?:number|string|null }) {
  return {
    agent_prompt_sha256:createHash('sha256').update(JSON.stringify(agent.system_prompt ?? null)).digest('hex'),
    agent_prompt_revision_id:agent.prompt_revision_id==null ? null : Number(agent.prompt_revision_id),
  };
}
