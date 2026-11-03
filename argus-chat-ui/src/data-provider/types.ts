export interface Me {
  user: { id: number; username: string; display_name: string; role: string };
  shareLinksEnabled?: boolean;
  aiTransparency?: { enabled: boolean; notice: string };
}
export interface AgentSummary {
  id: number;
  name: string;
  label: string;
  description: string;
  model: string;
  supports_vision?: boolean;
  agent_mode?: 'chat' | 'worker' | 'reviewer' | string;
  risk_level?: 'low' | 'medium' | 'high';
  human_oversight_required?: boolean;
  ticket_id?: string | null;
  pr_branch?: string | null;
  pr_number?: number | null;
  repository?: string | null;
  skills?: string[];
}
export interface AllowedModels { models: { model_name: string; provider: string }[]; restricted: boolean; allowed_models?: string[] }
export interface Citation { source: string; snippet: string; score: number; index: string }
export interface ChatMessage { role: 'system'|'user'|'assistant'|'tool'; content: string|null; tool_calls?: unknown[]; tool_call_id?: string; name?: string; id?: string; parentId?: string|null; citations?: Citation[] }
export interface Session {
  id: string;
  agent_id: number;
  user_id: number|null;
  messages: ChatMessage[];
  created_at: string;
  last_active: string;
  active_leaf_id?: string|null;
  pr_context?: {
    ticket_id?: string;
    branch?: string;
    pr_number?: number;
    repo?: string;
    task_type?: string;
  } | null;
}
