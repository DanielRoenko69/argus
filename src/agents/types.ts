// Agent Gateway — core type definitions

export interface Agent {
  id: number;
  name: string;
  label: string;
  description: string;
  model: string;
  temperature: number;
  max_tokens: number;
  system_prompt: string | null;
  prompt_revision_id?: number | null;
  agent_role: string | null;
  composite_id: number | null;
  gitea_project: string | null;
  enabled: boolean;
  max_iterations: number;
  created_by: number | null;
  created_at: string;
  updated_at: string;
  // PR-Context / Dev Pipeline
  agent_mode: 'chat' | 'worker' | 'reviewer';
  task_type: string | null;
  pr_branch: string | null;
  pr_number: number | null;
  ticket_id: string | null;
  allowed_paths: string[] | null;
  bitbucket_repo: string | null;
  bundle_ids: number[] | null;
  llm_api_key: string | null; // optional encrypted provider key (DIRECT_AGENT_API_KEYS=true)
  llm_credential_profile_id?: number | null; // reusable provider-scoped credential profile
  runtime_profile_id?: number | null; // execution runtime override (e.g. Codex subscription)
  thinking_budget: number; // Anthropic extended-thinking; 0 = off (mig 078)
  untrusted_tool_output_enforcement: boolean; // A2AS tag-wrapping; default on (mig 080)
  // Entra ID per-agent SP (mig 081). NULL when ENTRA_AGENT_REGISTRATION=false or sync not yet attempted.
  entra_object_id: string | null;
  entra_app_id: string | null;
  entra_blueprint_id: string | null;
  entra_synced_at: string | null;
  entra_sync_error: string | null;
  codegraph_enabled: boolean; // opt-in for codegraph_* MCP tools (mig 082)
  visibility: 'internal' | 'public'; // who can see this agent in chat (mig 114)
  min_role: string | null; // minimum role to see/use in chat; NULL = all (mig 117)
  risk_level: 'low' | 'medium' | 'high'; // governance classification (mig 059)
  human_oversight_required: boolean; // sensitive writes pause for a reviewer (mig 059/123)
}

export interface PrContext {
  branch?: string;
  pr_number?: number;
  ticket_id?: string;
  task_type?: string;
  build_log?: string;
  allowed_paths?: string[];
  repo?: string;
  /** Internal, execution-grant-bound checkout root. Never supplied by the model. */
  workspace_dir?: string;
  /** Immutable native Code Intelligence evidence selected for this exact checkout. */
  code_index_snapshot_id?: number;
  code_index_commit_sha?: string;
}

export interface AgentWithRag extends Agent {
  rag_indexes: RagIndexRef[];
  code_indexes?: AgentCodeIndexRef[];
  composite_name: string | null;
  skills: SkillRef[];
}

export interface RagIndexRef {
  id: number;
  name: string;
  label: string;
  priority: number;
}

/** Commit-bound repository knowledge assigned independently from document RAG. */
export interface AgentCodeIndexRef {
  id: number;
  repository_key: string;
  branch_name: string;
  commit_sha: string;
  provider: string;
  file_count: number;
  symbol_count: number;
  edge_count: number;
  priority: number;
}

export interface CreateAgentInput {
  name: string;
  label: string;
  description?: string;
  model?: string;
  temperature?: number;
  max_tokens?: number;
  system_prompt?: string;
  agent_role?: string;
  composite_id?: number | null;
  gitea_project?: string | null;
  enabled?: boolean;
  max_iterations?: number;
  agent_mode?: 'chat' | 'worker' | 'reviewer';
  task_type?: string | null;
  pr_branch?: string | null;
  pr_number?: number | null;
  ticket_id?: string | null;
  allowed_paths?: string[] | null;
  bitbucket_repo?: string | null;
  bundle_ids?: number[] | null;
  llm_api_key?: string | null;
  llm_credential_profile_id?: number | null;
  runtime_profile_id?: number | null;
  thinking_budget?: number;
  untrusted_tool_output_enforcement?: boolean;
  codegraph_enabled?: boolean;
  visibility?: 'internal' | 'public';
  min_role?: string | null;
  risk_level?: 'low' | 'medium' | 'high';
  human_oversight_required?: boolean;
}

export interface UpdateAgentInput {
  label?: string;
  description?: string;
  model?: string;
  temperature?: number;
  max_tokens?: number;
  system_prompt?: string | null;
  agent_role?: string | null;
  composite_id?: number | null;
  gitea_project?: string | null;
  enabled?: boolean;
  max_iterations?: number;
  agent_mode?: 'chat' | 'worker' | 'reviewer';
  task_type?: string | null;
  pr_branch?: string | null;
  pr_number?: number | null;
  ticket_id?: string | null;
  allowed_paths?: string[] | null;
  bitbucket_repo?: string | null;
  bundle_ids?: number[] | null;
  llm_api_key?: string | null;
  llm_credential_profile_id?: number | null;
  runtime_profile_id?: number | null;
  thinking_budget?: number;
  untrusted_tool_output_enforcement?: boolean;
  codegraph_enabled?: boolean;
  visibility?: 'internal' | 'public';
  min_role?: string | null;
  risk_level?: 'low' | 'medium' | 'high';
  human_oversight_required?: boolean;
}

// ── RAG Indexes ──────────────────────────────────────────────

export interface RagIndex {
  id: number;
  name: string;
  label: string;
  description: string;
  provider: string;
  endpoint: string;
  index_name: string;
  api_key: string | null;
  semantic_config: string | null;
  top_k: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  /** Provider vector field. Optional for Azure hybrid search; required by vector-native search adapters. */
  vector_field?: string | null;
  /** Provider-specific, non-secret adapter settings. Secrets always stay in api_key. */
  adapter_config?: RagAdapterConfig;
  /** When true: generate a hypothetical-document via LLM and search with that embedding (HyDE, mig 085) */
  hyde_enabled?: boolean;
}

export interface RagAdapterConfig {
  text_field?: string;
  source_field?: string;
  id_field?: string;
  namespace?: string;
  auth_mode?: 'api_key' | 'basic' | 'bearer';
}

export interface CreateRagIndexInput {
  name: string;
  label: string;
  description?: string;
  provider?: string;
  endpoint: string;
  index_name: string;
  api_key?: string | null;
  semantic_config?: string | null;
  vector_field?: string | null;
  adapter_config?: RagAdapterConfig;
  top_k?: number;
  enabled?: boolean;
}

export interface UpdateRagIndexInput {
  label?: string;
  description?: string;
  provider?: string;
  endpoint?: string;
  index_name?: string;
  api_key?: string | null;
  semantic_config?: string | null;
  vector_field?: string | null;
  adapter_config?: RagAdapterConfig;
  top_k?: number;
  enabled?: boolean;
}

// ── Skills ───────────────────────────────────────────────────

export interface Skill {
  current_revision_id?: number;
  id: number;
  name: string;
  label: string;
  description: string;
  content: string;
  category: string | null;
  icon: string;
  source_url: string | null;
  source_ref: string | null;
  imported_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SkillRef {
  revision_id?: number;
  current_revision_id?: number;
  id: number;
  name: string;
  label: string;
  icon: string;
  category: string | null;
  position: number;
}

export interface CreateSkillInput {
  name: string;
  label: string;
  description?: string;
  content: string;
  category?: string | null;
  icon?: string;
  source_url?: string | null;
  source_ref?: string | null;
  imported_at?: string | null;
}

export interface UpdateSkillInput {
  label?: string;
  description?: string;
  content?: string;
  category?: string | null;
  icon?: string;
  source_url?: string | null;
  source_ref?: string | null;
  imported_at?: string | null;
}

// ── Sessions ─────────────────────────────────────────────────

export interface AgentSession {
  id: string;
  agent_id: number;
  user_id: number | null;
  messages: ChatMessage[];
  created_at: string;
  last_active: string;
  active_leaf_id?: string | null; // tip of the visible branch; null = legacy/linear (mig 119)
  pr_context: PrContext | null;
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface Citation { source: string; snippet: string; score: number; index: string }

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  citations?: Citation[]; // RAG sources for this assistant turn (authenticated /chat; persisted)
  id?: string;               // tree node id (server-assigned on append)
  parentId?: string | null;  // tree edge; null/absent at the conversation root
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}
