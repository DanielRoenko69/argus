#!/usr/bin/env bash
set -euo pipefail

base_url="http://opensearch-sso:9200"
admin_auth="admin:${OPENSEARCH_INITIAL_ADMIN_PASSWORD}"

until curl --fail --silent --show-error --user "${admin_auth}" "${base_url}/_cluster/health" >/dev/null; do
  sleep 2
done

curl --fail --silent --show-error --user "${admin_auth}" \
  -H 'Content-Type: application/json' -X PUT \
  "${base_url}/_plugins/_security/api/roles/argus_demo_read" \
  -d '{"cluster_permissions":["cluster:monitor/health","cluster:monitor/state"],"index_permissions":[{"index_patterns":["argus-production-logs*"],"allowed_actions":["read"]}],"tenant_permissions":[]}' >/dev/null

curl --fail --silent --show-error --user "${admin_auth}" \
  -H 'Content-Type: application/json' -X PUT \
  "${base_url}/_plugins/_security/api/internalusers/argus-service" \
  -d "{\"password\":\"${OPENSEARCH_SERVICE_PASSWORD}\",\"backend_roles\":[\"argus_demo_service\"],\"attributes\":{\"owner\":\"argus\",\"purpose\":\"readonly-golden-path\"}}" >/dev/null

curl --fail --silent --show-error --user "${admin_auth}" \
  -H 'Content-Type: application/json' -X PUT \
  "${base_url}/_plugins/_security/api/rolesmapping/argus_demo_read" \
  -d '{"backend_roles":["argus_demo_service","argus-developers"],"hosts":[],"users":[]}' >/dev/null

curl --fail --silent --show-error --user "${admin_auth}" \
  -H 'Content-Type: application/json' -X PUT \
  "${base_url}/_plugins/_security/api/rolesmapping/all_access" \
  -d '{"backend_roles":["admin","argus-platform-admins"],"hosts":[],"users":[]}' >/dev/null

now="$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')"
before="$(date -u -d '90 seconds ago' +'%Y-%m-%dT%H:%M:%S.000Z')"

curl --fail --silent --show-error --user "${admin_auth}" \
  -H 'Content-Type: application/x-ndjson' -X POST \
  "${base_url}/_bulk?refresh=true" --data-binary @- >/dev/null <<NDJSON
{"index":{"_index":"argus-production-logs","_id":"checkout-healthy"}}
{"@timestamp":"2026-09-15T09:59:40.000Z","service":"checkout-api","environment":"production","level":"INFO","message":"checkout request completed","trace_id":"trace-checkout-001","duration_ms":182,"status_code":200,"release":"7b4ad9b"}
{"index":{"_index":"argus-production-logs","_id":"checkout-error"}}
{"@timestamp":"2026-09-15T10:00:00.000Z","service":"checkout-api","environment":"production","level":"ERROR","message":"payment-provider-timeout","trace_id":"trace-checkout-002","duration_ms":5000,"status_code":504,"release":"7b4ad9b"}
{"index":{"_index":"argus-production-logs","_id":"catalog-healthy"}}
{"@timestamp":"2026-09-15T10:00:10.000Z","service":"catalog-api","environment":"production","level":"INFO","message":"catalog refresh completed","trace_id":"trace-catalog-001","duration_ms":74,"status_code":200,"release":"f19c2a1"}
{"index":{"_index":"argus-production-logs","_id":"checkout-argus-demo-healthy"}}
{"@timestamp":"${before}","service":"checkout-api","environment":"argus-demo","level":"INFO","message":"checkout request completed before incident","trace_id":"trace-checkout-showcase-001","duration_ms":194,"status_code":200,"release":"showcase"}
{"index":{"_index":"argus-production-logs","_id":"checkout-argus-demo-error"}}
{"@timestamp":"${now}","service":"checkout-api","environment":"argus-demo","level":"ERROR","message":"payment-provider-timeout while authorizing checkout","trace_id":"trace-checkout-showcase-002","duration_ms":5200,"status_code":504,"release":"showcase"}
NDJSON

echo "OpenSearch production-like evidence is ready."
