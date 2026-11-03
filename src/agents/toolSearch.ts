/**
 * toolSearch.ts â€” relevance-based tool filtering for worker agents.
 *
 * Reduces the tool list sent to the Coder agent from 85+ to ~10-15
 * by scoring each tool against the task description.
 * Core tools (workspace_*, git, subagent) are always included.
 */

/** Minimal tool shape â€” matches LlmTool in agentRunner.ts */
export interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, { type: string; description?: string }>;
      required?: string[];
    };
  };
}

/**
 * Tool name prefixes that are always included regardless of relevance score.
 * These are the fundamental tools a worker agent needs for any coding task.
 */
const CORE_TOOL_PREFIXES: string[] = [
  'workspace_',      // file I/O + shell
  '__call_agent',    // subagent dispatch (single + parallel)
];

/**
 * Exact tool names that are always included.
 * Supplement CORE_TOOL_PREFIXES for specific tools that don't share a prefix.
 */
const CORE_TOOL_NAMES: Set<string> = new Set([
  'gitea_create_pr',
  'gitea_list_prs',
  'gitea_get_pr',
  'gitea_merge_pr',
  'bitbucket_create_pr',
  'bitbucket_list_prs',
  'bitbucket_get_pr',
]);

/**
 * Maximum number of non-core tools to include even when they have no
 * keyword match (ensures the agent has some fallback tools available).
 */
const MIN_NON_CORE_TOOLS = 3;

/**
 * Maximum total non-core tools to include (scored + unscored fallback).
 * Keeps total context bounded.
 */
const MAX_NON_CORE_TOOLS = 12;

/** Tokenize text into lowercase words. */
function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(w => w.length > 2),  // skip trivial 1-2 char tokens
  );
}

/** Compute a bag-of-words for a single tool (name + description). */
function toolBag(tool: ToolDef): Set<string> {
  const text = `${tool.function.name} ${tool.function.description}`;
  return tokenize(text);
}

/** Score tool against task words: count of task words present in tool bag. */
function scoreToolAgainstTask(tool: ToolDef, taskWords: Set<string>): number {
  const bag = toolBag(tool);
  let score = 0;
  for (const word of taskWords) {
    if (bag.has(word)) score++;
  }
  return score;
}

/** Returns true if the tool is a core tool that should always be included. */
function isCoreToolName(name: string): boolean {
  if (CORE_TOOL_NAMES.has(name)) return true;
  return CORE_TOOL_PREFIXES.some(prefix => name.startsWith(prefix));
}

/**
 * Filter tools for a specific task description.
 *
 * @param tools - Full tool list from buildToolList()
 * @param taskDescription - The user's message / plan text for this turn
 * @returns Filtered list: all core tools + top-scored relevant tools
 */
export function filterToolsForTask(tools: ToolDef[], taskDescription: string): ToolDef[] {
  if (tools.length === 0) return tools;

  const taskWords = tokenize(taskDescription);

  // Partition into core tools (always kept) and candidates
  const coreTools: ToolDef[] = [];
  const candidates: ToolDef[] = [];

  for (const tool of tools) {
    if (isCoreToolName(tool.function.name)) {
      coreTools.push(tool);
    } else {
      candidates.push(tool);
    }
  }

  // Score each candidate
  const scored = candidates.map(tool => ({
    tool,
    score: scoreToolAgainstTask(tool, taskWords),
  }));

  // Sort by score descending, then alphabetically for determinism
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.tool.function.name.localeCompare(b.tool.function.name);
  });

  // Take up to MAX_NON_CORE_TOOLS from candidates:
  // - All tools with score > 0, capped at MAX_NON_CORE_TOOLS
  // - If fewer than MIN_NON_CORE_TOOLS scored, pad with highest-scored zero tools
  const withScore    = scored.filter(s => s.score > 0).slice(0, MAX_NON_CORE_TOOLS);
  const withoutScore = scored.filter(s => s.score === 0);

  const selectedCandidates: ToolDef[] = withScore.map(s => s.tool);
  if (selectedCandidates.length < MIN_NON_CORE_TOOLS) {
    const needed = MIN_NON_CORE_TOOLS - selectedCandidates.length;
    selectedCandidates.push(...withoutScore.slice(0, needed).map(s => s.tool));
  }

  return [...coreTools, ...selectedCandidates];
}
