import type { Pool } from 'pg';

export type TaskState =
  | 'TASK_STATE_SUBMITTED'
  | 'TASK_STATE_WORKING'
  | 'TASK_STATE_COMPLETED'
  | 'TASK_STATE_FAILED'
  | 'TASK_STATE_CANCELED'
  | 'TASK_STATE_REJECTED'
  | 'TASK_STATE_INPUT_REQUIRED';

export interface A2aTask {
  id: string;
  contextId: string;
  status: {
    state: TaskState;
    timestamp: string;
    message?: { messageId: string; role: 'ROLE_AGENT'; parts: Array<{ text: string }> };
  };
  artifacts?: Array<{
    artifactId: string;
    name: string;
    description?: string;
    parts: Array<{ data: Record<string, unknown> }>;
  }>;
  history?: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown>;
}

export interface TaskListCursor {
  updatedAt: string;
  taskId: string;
}

export interface TaskListEntry {
  task: A2aTask;
  createdAt: string;
  updatedAt: string;
}

export interface TaskListPage {
  items: TaskListEntry[];
  nextCursor?: TaskListCursor;
}

export interface TaskStore {
  setup(): Promise<void>;
  ready(): Promise<boolean>;
  get(taskId: string): Promise<A2aTask | null>;
  list(limit: number, cursor?: TaskListCursor): Promise<TaskListPage>;
  save(task: A2aTask): Promise<void>;
}

function isInvestigationRun(task: A2aTask): boolean {
  if (task.metadata?.['operation'] === 'workflow.start') return true;
  return Boolean(task.artifacts?.some(artifact => artifact.parts.some(part => part.data['kind'] === 'aiops-investigation-plan')));
}

export class InMemoryTaskStore implements TaskStore {
  private readonly tasks = new Map<string, TaskListEntry>();
  async setup(): Promise<void> {}
  async ready(): Promise<boolean> { return true; }
  async get(taskId: string): Promise<A2aTask | null> {
    const entry = this.tasks.get(taskId);
    return entry ? structuredClone(entry.task) : null;
  }
  async list(limit: number, cursor?: TaskListCursor): Promise<TaskListPage> {
    const entries = [...this.tasks.values()]
      .filter(entry => isInvestigationRun(entry.task))
      .filter(entry => !cursor || entry.updatedAt < cursor.updatedAt
        || (entry.updatedAt === cursor.updatedAt && entry.task.id < cursor.taskId))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)
        || right.task.id.localeCompare(left.task.id));
    const page = entries.slice(0, limit);
    const last = page.at(-1);
    return {
      items: structuredClone(page),
      ...(entries.length > limit && last
        ? { nextCursor: { updatedAt: last.updatedAt, taskId: last.task.id } }
        : {}),
    };
  }
  async save(task: A2aTask): Promise<void> {
    const existing = this.tasks.get(task.id);
    const now = new Date().toISOString();
    this.tasks.set(task.id, {
      task: structuredClone(task),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }
}

export class PostgresTaskStore implements TaskStore {
  constructor(private readonly pool: Pool) {}

  async setup(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS argus_aiops_tasks (
        task_id UUID PRIMARY KEY,
        context_id UUID NOT NULL,
        state TEXT NOT NULL,
        task JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_argus_aiops_tasks_updated
        ON argus_aiops_tasks (updated_at DESC);
    `);
  }

  async ready(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async get(taskId: string): Promise<A2aTask | null> {
    const result = await this.pool.query<{ task: A2aTask }>(
      'SELECT task FROM argus_aiops_tasks WHERE task_id=$1',
      [taskId],
    );
    return result.rows[0]?.task ?? null;
  }

  async list(limit: number, cursor?: TaskListCursor): Promise<TaskListPage> {
    const result = await this.pool.query<{ task: A2aTask; created_at: Date; updated_at: Date }>(
      `SELECT task, created_at, updated_at
       FROM argus_aiops_tasks
       WHERE (task #>> '{metadata,operation}' = 'workflow.start'
         OR task @> '{"artifacts":[{"parts":[{"data":{"kind":"aiops-investigation-plan"}}]}]}'::jsonb
       )
         AND ($2::timestamptz IS NULL OR (updated_at, task_id) < ($2::timestamptz, $3::uuid))
       ORDER BY updated_at DESC, task_id DESC
       LIMIT $1`,
      [limit + 1, cursor?.updatedAt ?? null, cursor?.taskId ?? null],
    );
    const hasMore = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);
    const items = rows.map(row => ({
      task: row.task,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    }));
    const last = items.at(-1);
    return {
      items,
      ...(hasMore && last
        ? { nextCursor: { updatedAt: last.updatedAt, taskId: last.task.id } }
        : {}),
    };
  }

  async save(task: A2aTask): Promise<void> {
    await this.pool.query(
      `INSERT INTO argus_aiops_tasks (task_id, context_id, state, task)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (task_id) DO UPDATE SET
         state=EXCLUDED.state,
         task=EXCLUDED.task,
         updated_at=NOW()`,
      [task.id, task.contextId, task.status.state, JSON.stringify(task)],
    );
  }
}
