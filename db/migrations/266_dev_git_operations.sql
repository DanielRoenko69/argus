-- Provider write intent and safe receipt. No credentials, request text or raw output.
CREATE TABLE argus_dev_git_operations (
  tenant_key TEXT NOT NULL,
  workspace_key TEXT NOT NULL,
  environment TEXT NOT NULL,
  root_trace_id UUID NOT NULL,
  operation_key TEXT NOT NULL CHECK (operation_key ~ '^[a-f0-9]{64}$'),
  request_sha256 TEXT NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  backend_id INTEGER NOT NULL,
  principal_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('push','pull-request')),
  status TEXT NOT NULL CHECK (status IN ('started','completed')),
  receipt JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_key, workspace_key, environment, root_trace_id, operation_key),
  CHECK ((status='completed') = (receipt IS NOT NULL AND completed_at IS NOT NULL))
);
