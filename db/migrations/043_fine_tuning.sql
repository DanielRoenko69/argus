CREATE TABLE IF NOT EXISTS mcp_fine_tuning_jobs (
  id               VARCHAR(64) PRIMARY KEY,
  api_key_prefix   VARCHAR(8) NOT NULL,
  provider         VARCHAR(32) NOT NULL DEFAULT 'openai',
  provider_job_id  VARCHAR(128),
  status           VARCHAR(32) DEFAULT 'created',
  model            VARCHAR(128),
  fine_tuned_model VARCHAR(128),
  training_file    VARCHAR(128),
  validation_file  VARCHAR(128),
  hyperparameters  JSONB DEFAULT '{}',
  trained_tokens   INTEGER,
  error            JSONB,
  created_at       TIMESTAMPTZ DEFAULT now(),
  finished_at      TIMESTAMPTZ
);
