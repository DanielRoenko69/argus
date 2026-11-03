-- Native, provider-neutral code intelligence snapshots.
--
-- A snapshot is immutable once it reaches `ready`: repository, branch,
-- commit SHA and provider identify the exact code state used by an Agent run.
-- Parsing still happens in the existing agent-workspace; PostgreSQL stores the
-- normalized graph, lexical search documents and optional pgvector embeddings.

CREATE TABLE IF NOT EXISTS mcp_code_index_snapshots (
  id                    BIGSERIAL PRIMARY KEY,
  repository_key        VARCHAR(512) NOT NULL,
  branch_name           VARCHAR(255) NOT NULL,
  commit_sha            VARCHAR(64) NOT NULL,
  provider              VARCHAR(64) NOT NULL DEFAULT 'graphify',
  source_graph_digest   CHAR(64) NOT NULL,
  parser_version        VARCHAR(128),
  graph_schema_version  VARCHAR(128),
  embedding_model       VARCHAR(255),
  status                VARCHAR(24) NOT NULL DEFAULT 'building'
                        CHECK (status IN ('building', 'ready', 'failed', 'superseded')),
  file_count            INTEGER NOT NULL DEFAULT 0 CHECK (file_count >= 0),
  symbol_count          INTEGER NOT NULL DEFAULT 0 CHECK (symbol_count >= 0),
  edge_count            INTEGER NOT NULL DEFAULT 0 CHECK (edge_count >= 0),
  document_count        INTEGER NOT NULL DEFAULT 0 CHECK (document_count >= 0),
  error_message         TEXT,
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at           TIMESTAMPTZ,
  CONSTRAINT mcp_code_index_repository_nonempty
    CHECK (length(btrim(repository_key)) > 0),
  CONSTRAINT mcp_code_index_branch_nonempty
    CHECK (length(btrim(branch_name)) > 0),
  CONSTRAINT mcp_code_index_commit_sha
    CHECK (commit_sha ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'),
  CONSTRAINT mcp_code_index_source_digest
    CHECK (source_graph_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT mcp_code_index_metadata_size
    CHECK (octet_length(metadata::text) <= 65536),
  CONSTRAINT mcp_code_index_finished_state
    CHECK ((status = 'building' AND finished_at IS NULL)
       OR (status <> 'building' AND finished_at IS NOT NULL)),
  UNIQUE (repository_key, branch_name, commit_sha, provider)
);

CREATE INDEX IF NOT EXISTS idx_code_index_latest_ready
  ON mcp_code_index_snapshots (repository_key, branch_name, finished_at DESC)
  WHERE status = 'ready';

CREATE TABLE IF NOT EXISTS mcp_code_index_files (
  id            BIGSERIAL PRIMARY KEY,
  index_id      BIGINT NOT NULL REFERENCES mcp_code_index_snapshots(id) ON DELETE CASCADE,
  path          TEXT NOT NULL,
  language      VARCHAR(64),
  content_hash  CHAR(64) NOT NULL,
  byte_size     INTEGER NOT NULL CHECK (byte_size >= 0),
  line_count    INTEGER NOT NULL CHECK (line_count >= 0),
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT mcp_code_file_path_nonempty CHECK (length(path) > 0),
  CONSTRAINT mcp_code_file_path_size CHECK (octet_length(path) <= 4096),
  CONSTRAINT mcp_code_file_hash CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT mcp_code_file_metadata_size CHECK (octet_length(metadata::text) <= 65536),
  UNIQUE (index_id, path),
  UNIQUE (index_id, id)
);

CREATE INDEX IF NOT EXISTS idx_code_files_language
  ON mcp_code_index_files (index_id, language);

CREATE TABLE IF NOT EXISTS mcp_code_index_symbols (
  id              BIGSERIAL PRIMARY KEY,
  index_id        BIGINT NOT NULL,
  file_id         BIGINT NOT NULL,
  name            VARCHAR(512) NOT NULL,
  qualified_name  TEXT NOT NULL,
  kind            VARCHAR(64) NOT NULL,
  signature       TEXT,
  start_line      INTEGER NOT NULL CHECK (start_line >= 1),
  end_line        INTEGER NOT NULL CHECK (end_line >= start_line),
  content_hash    CHAR(64),
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT mcp_code_symbol_index_fk
    FOREIGN KEY (index_id) REFERENCES mcp_code_index_snapshots(id) ON DELETE CASCADE,
  CONSTRAINT mcp_code_symbol_file_fk
    FOREIGN KEY (index_id, file_id) REFERENCES mcp_code_index_files(index_id, id) ON DELETE CASCADE,
  CONSTRAINT mcp_code_symbol_qualified_name_nonempty CHECK (length(qualified_name) > 0),
  CONSTRAINT mcp_code_symbol_qualified_name_size CHECK (octet_length(qualified_name) <= 8192),
  CONSTRAINT mcp_code_symbol_hash CHECK (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT mcp_code_symbol_metadata_size CHECK (octet_length(metadata::text) <= 65536),
  UNIQUE (index_id, file_id, qualified_name, kind, start_line),
  UNIQUE (index_id, id)
);

CREATE INDEX IF NOT EXISTS idx_code_symbols_exact_name
  ON mcp_code_index_symbols (index_id, lower(name));
CREATE INDEX IF NOT EXISTS idx_code_symbols_qualified_name
  ON mcp_code_index_symbols (index_id, lower(qualified_name));
CREATE INDEX IF NOT EXISTS idx_code_symbols_file
  ON mcp_code_index_symbols (index_id, file_id, start_line);

CREATE TABLE IF NOT EXISTS mcp_code_index_edges (
  id                BIGSERIAL PRIMARY KEY,
  index_id          BIGINT NOT NULL,
  source_symbol_id  BIGINT NOT NULL,
  target_symbol_id  BIGINT NOT NULL,
  relation          VARCHAR(64) NOT NULL,
  provenance        VARCHAR(24) NOT NULL DEFAULT 'extracted'
                    CHECK (provenance IN ('extracted', 'inferred', 'ambiguous', 'runtime')),
  confidence        REAL NOT NULL DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT mcp_code_edge_index_fk
    FOREIGN KEY (index_id) REFERENCES mcp_code_index_snapshots(id) ON DELETE CASCADE,
  CONSTRAINT mcp_code_edge_source_fk
    FOREIGN KEY (index_id, source_symbol_id) REFERENCES mcp_code_index_symbols(index_id, id) ON DELETE CASCADE,
  CONSTRAINT mcp_code_edge_target_fk
    FOREIGN KEY (index_id, target_symbol_id) REFERENCES mcp_code_index_symbols(index_id, id) ON DELETE CASCADE,
  CONSTRAINT mcp_code_edge_metadata_size CHECK (octet_length(metadata::text) <= 65536),
  UNIQUE (index_id, source_symbol_id, target_symbol_id, relation, provenance)
);

CREATE INDEX IF NOT EXISTS idx_code_edges_outbound
  ON mcp_code_index_edges (index_id, source_symbol_id, relation);
CREATE INDEX IF NOT EXISTS idx_code_edges_inbound
  ON mcp_code_index_edges (index_id, target_symbol_id, relation);

CREATE TABLE IF NOT EXISTS mcp_code_search_documents (
  id               BIGSERIAL PRIMARY KEY,
  index_id         BIGINT NOT NULL,
  file_id          BIGINT NOT NULL,
  symbol_id        BIGINT,
  chunk_kind       VARCHAR(64) NOT NULL,
  chunk_ordinal    INTEGER NOT NULL DEFAULT 0 CHECK (chunk_ordinal >= 0),
  content          TEXT NOT NULL,
  content_hash     CHAR(64) NOT NULL,
  search_vector    TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
  embedding        HALFVEC,
  embedding_model  VARCHAR(255),
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT mcp_code_search_index_fk
    FOREIGN KEY (index_id) REFERENCES mcp_code_index_snapshots(id) ON DELETE CASCADE,
  CONSTRAINT mcp_code_search_file_fk
    FOREIGN KEY (index_id, file_id) REFERENCES mcp_code_index_files(index_id, id) ON DELETE CASCADE,
  CONSTRAINT mcp_code_search_symbol_fk
    FOREIGN KEY (index_id, symbol_id) REFERENCES mcp_code_index_symbols(index_id, id) ON DELETE CASCADE,
  CONSTRAINT mcp_code_search_content_nonempty CHECK (length(content) > 0),
  CONSTRAINT mcp_code_search_content_size CHECK (octet_length(content) <= 1048576),
  CONSTRAINT mcp_code_search_hash CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT mcp_code_search_embedding_model
    CHECK ((embedding IS NULL AND embedding_model IS NULL)
        OR (embedding IS NOT NULL AND embedding_model IS NOT NULL)),
  CONSTRAINT mcp_code_search_metadata_size CHECK (octet_length(metadata::text) <= 65536)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_code_search_document_identity
  ON mcp_code_search_documents
  (index_id, file_id, COALESCE(symbol_id, 0), chunk_kind, chunk_ordinal);
CREATE INDEX IF NOT EXISTS idx_code_search_fulltext
  ON mcp_code_search_documents USING GIN (search_vector);
CREATE INDEX IF NOT EXISTS idx_code_search_symbol
  ON mcp_code_search_documents (index_id, symbol_id)
  WHERE symbol_id IS NOT NULL;

COMMENT ON TABLE mcp_code_index_snapshots IS
  'Immutable, commit-bound code intelligence index identities used as provenance by Argus Agent runs.';
COMMENT ON TABLE mcp_code_index_edges IS
  'Provider-neutral code relations such as CALLS, IMPORTS, INHERITS, IMPLEMENTS and REFERENCES.';
COMMENT ON COLUMN mcp_code_search_documents.embedding IS
  'Optional provider-neutral code embedding. Every snapshot must use one embedding model and dimension.';
