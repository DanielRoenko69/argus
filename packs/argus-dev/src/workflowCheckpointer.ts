import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';

// Shared by built-in and dynamically published workflows. Construction is
// side-effect free; normal server startup owns the one-time schema setup.
const PG_URL = process.env['POSTGRES_CONNECTION_URL']
  ?? 'postgresql://aiops:aiops123@localhost:5432/aiops';

export const workflowCheckpointer = PostgresSaver.fromConnString(PG_URL);
