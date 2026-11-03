import { createEmbedding } from '../llm/client.js';
import { logger } from '../lib/logger.js';
import { CodeIndexValidationError } from './store.js';
import type { PersistCodeIndexInput } from './types.js';

const MAX_EMBEDDING_DIMENSION = 4_096;
const NOMIC_PROFILE_SUFFIX = '@argus/nomic-retrieval-v1';
const QWEN3_CODE_PROFILE_SUFFIX = '@argus/qwen3-code-files-v2';
const QWEN3_CODE_QUERY_INSTRUCTION = 'Given a software issue, retrieve source code and tests that should be changed to resolve it.';

export type CodeEmbeddingProfile = 'plain' | 'nomic-retrieval' | 'qwen3-code-retrieval';

export interface CodeEmbeddingConfig {
  enabled: boolean;
  model: string | null;
  identity: string | null;
  profile: CodeEmbeddingProfile;
  batchSize: number;
  maxDocuments: number;
  maxInputBytes: number;
  timeoutMs: number;
}

type EmbeddingClient = (
  model: string,
  input: string | string[],
  options?: { timeoutMs?: number },
) => Promise<{ data: Array<{ embedding: number[]; index?: number }>; usage?: { prompt_tokens?: number; total_tokens?: number } }>;

function integer(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function enabled(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true';
}

export function codeEmbeddingConfig(environment: NodeJS.ProcessEnv = process.env): CodeEmbeddingConfig {
  const isEnabled = enabled(environment['ARGUS_CODE_EMBEDDINGS_ENABLED']);
  const rawModel = environment['ARGUS_CODE_EMBEDDING_MODEL'] ?? environment['EMBEDDING_MODEL'] ?? '';
  const model = rawModel.trim();
  if (isEnabled && (!model || model.length > 255 || /[\u0000-\u001f\u007f]/u.test(model))) {
    throw new CodeIndexValidationError('ARGUS_CODE_EMBEDDING_MODEL or EMBEDDING_MODEL is required when code embeddings are enabled');
  }
  const rawProfile = (environment['ARGUS_CODE_EMBEDDING_PROFILE'] ?? 'plain').trim().toLowerCase();
  if (!['plain', 'nomic-retrieval', 'qwen3-code-retrieval'].includes(rawProfile)) {
    throw new CodeIndexValidationError(
      'ARGUS_CODE_EMBEDDING_PROFILE must be plain, nomic-retrieval or qwen3-code-retrieval',
    );
  }
  const profile = rawProfile as CodeEmbeddingProfile;
  const profileSuffix = profile === 'nomic-retrieval'
    ? NOMIC_PROFILE_SUFFIX
    : profile === 'qwen3-code-retrieval' ? QWEN3_CODE_PROFILE_SUFFIX : '';
  const identity = isEnabled && model ? `${model}${profileSuffix}` : null;
  if (identity !== null && identity.length > 255) {
    throw new CodeIndexValidationError('code embedding model identity must not exceed 255 characters');
  }
  return {
    enabled: isEnabled,
    model: isEnabled ? model : null,
    identity,
    profile,
    batchSize: integer(environment['ARGUS_CODE_EMBEDDING_BATCH_SIZE'], 16, 1, 64),
    maxDocuments: integer(environment['ARGUS_CODE_EMBEDDING_MAX_DOCUMENTS'], 20_000, 1, 50_000),
    maxInputBytes: integer(environment['ARGUS_CODE_EMBEDDING_MAX_INPUT_BYTES'], 24_000, 1_024, 100_000),
    timeoutMs: integer(environment['ARGUS_CODE_EMBEDDING_TIMEOUT_MS'], 120_000, 1_000, 300_000),
  };
}

function truncateUtf8(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  return bytes.byteLength <= maximumBytes ? value : bytes.subarray(0, maximumBytes).toString('utf8');
}

function embeddingInput(
  document: PersistCodeIndexInput['documents'][number],
  maximumBytes: number,
  profile: CodeEmbeddingProfile,
): string {
  const identity = `path: ${document.filePath}\nchunk: ${document.chunkKind}${document.symbolKey ? `\nsymbol: ${document.symbolKey}` : ''}\n`;
  const prefix = profile === 'nomic-retrieval' ? 'search_document: ' : '';
  return truncateUtf8(`${prefix}${identity}${document.content}`, maximumBytes);
}

function embeddingProvider(identity: string): { model: string; profile: CodeEmbeddingProfile } {
  if (identity.endsWith(NOMIC_PROFILE_SUFFIX)) {
    return { model: identity.slice(0, -NOMIC_PROFILE_SUFFIX.length), profile: 'nomic-retrieval' };
  }
  if (identity.endsWith(QWEN3_CODE_PROFILE_SUFFIX)) {
    return { model: identity.slice(0, -QWEN3_CODE_PROFILE_SUFFIX.length), profile: 'qwen3-code-retrieval' };
  }
  return { model: identity, profile: 'plain' };
}

function orderedEmbeddings(
  data: Array<{ embedding: number[]; index?: number }>,
  expected: number,
): number[][] {
  if (data.length !== expected) {
    throw new CodeIndexValidationError(`embedding provider returned ${data.length} vectors for ${expected} documents`);
  }
  const hasIndexes = data.every(item => Number.isSafeInteger(item.index));
  const ordered = hasIndexes
    ? [...data].sort((left, right) => Number(left.index) - Number(right.index))
    : data;
  if (hasIndexes && ordered.some((item, index) => item.index !== index)) {
    throw new CodeIndexValidationError('embedding provider returned invalid vector indexes');
  }
  return ordered.map(item => {
    if (!Array.isArray(item.embedding) || item.embedding.length < 1
      || item.embedding.length > MAX_EMBEDDING_DIMENSION
      || item.embedding.some(value => !Number.isFinite(value))) {
      throw new CodeIndexValidationError('embedding provider returned an invalid vector');
    }
    return item.embedding;
  });
}

export async function embedCodeIndexDocuments(
  input: PersistCodeIndexInput,
  config: CodeEmbeddingConfig = codeEmbeddingConfig(),
  client: EmbeddingClient = createEmbedding,
): Promise<PersistCodeIndexInput> {
  if (!config.enabled || config.model === null) return input;
  const documents = input.documents.map(document => ({ ...document }));
  const selectedDocuments = documents
    .map((document, index) => ({ document, index }))
    .filter(({ document }) => config.profile !== 'qwen3-code-retrieval' || document.chunkKind === 'file');
  if (selectedDocuments.length > config.maxDocuments) {
    throw new CodeIndexValidationError(
      `code embedding profile selected ${selectedDocuments.length} documents, exceeding ARGUS_CODE_EMBEDDING_MAX_DOCUMENTS=${config.maxDocuments}`,
    );
  }
  const totalBatches = Math.ceil(selectedDocuments.length / config.batchSize);
  logger.info({
    repositoryKey: input.repositoryKey,
    commitSha: input.commitSha,
    embeddingModel: config.identity,
    documents: selectedDocuments.length,
    totalBatches,
    batchSize: config.batchSize,
  }, 'Code index embedding started');
  let dimension: number | null = null;
  let promptTokens = 0;
  for (let offset = 0; offset < selectedDocuments.length; offset += config.batchSize) {
    const batch = selectedDocuments.slice(offset, offset + config.batchSize);
    const response = await client(
      config.model,
      batch.map(({ document }) => embeddingInput(document, config.maxInputBytes, config.profile)),
      { timeoutMs: config.timeoutMs },
    );
    const vectors = orderedEmbeddings(response.data, batch.length);
    promptTokens += Number(response.usage?.prompt_tokens ?? response.usage?.total_tokens ?? 0) || 0;
    for (let index = 0; index < vectors.length; index += 1) {
      const vector = vectors[index]!;
      if (dimension === null) dimension = vector.length;
      if (vector.length !== dimension) {
        throw new CodeIndexValidationError('embedding provider returned inconsistent vector dimensions');
      }
      documents[batch[index]!.index]!.embedding = vector;
    }
    const completedBatches = Math.floor(offset / config.batchSize) + 1;
    if (completedBatches === totalBatches || completedBatches % 10 === 0) {
      logger.info({
        repositoryKey: input.repositoryKey,
        commitSha: input.commitSha,
        embeddingModel: config.identity,
        completedBatches,
        totalBatches,
        completedDocuments: Math.min(offset + batch.length, selectedDocuments.length),
        documents: selectedDocuments.length,
      }, 'Code index embedding progress');
    }
  }

  logger.info({
    repositoryKey: input.repositoryKey,
    commitSha: input.commitSha,
    embeddingModel: config.identity,
    documents: selectedDocuments.length,
    totalBatches,
    dimension,
    promptTokens,
  }, 'Code index embedding completed');

  return {
    ...input,
    embeddingModel: config.identity,
    metadata: {
      ...(input.metadata ?? {}),
      embedding: {
        model: config.identity,
        providerModel: config.model,
        profile: config.profile,
        dimension,
        documents: selectedDocuments.length,
        totalDocuments: documents.length,
        embeddedChunkKinds: config.profile === 'qwen3-code-retrieval' ? ['file'] : ['*'],
        batchSize: config.batchSize,
        maxInputBytes: config.maxInputBytes,
        promptTokens,
      },
    },
    documents,
  };
}

export async function createCodeQueryEmbedding(
  modelIdentity: string,
  query: string,
  timeoutMs = 120_000,
  client: EmbeddingClient = createEmbedding,
): Promise<number[]> {
  const { model, profile } = embeddingProvider(modelIdentity);
  const input = profile === 'nomic-retrieval'
    ? `search_query: ${query}`
    : profile === 'qwen3-code-retrieval'
      ? `Instruct: ${QWEN3_CODE_QUERY_INSTRUCTION}\nQuery:${query}`
      : query;
  const response = await client(model, input, { timeoutMs });
  return orderedEmbeddings(response.data, 1)[0]!;
}
