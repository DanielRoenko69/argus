-- 055: Drop legacy Canvas (visual workflow builder) tables.
--
-- Canvas was a React Flow-based visual workflow editor that was disabled
-- and removed from the codebase. The new workflow orchestration uses
-- LangGraph (see langgraph/ subfolder + src/api/coding.ts).
--
-- These tables had 0 rows in the production database when removed.

DROP TABLE IF EXISTS mcp_canvas_executions;
DROP TABLE IF EXISTS mcp_canvas_flows;
