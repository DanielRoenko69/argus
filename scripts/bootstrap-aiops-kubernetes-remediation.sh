#!/bin/sh
# macOS/Linux counterpart of bootstrap-aiops-kubernetes-remediation.ps1.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
CLUSTER_NAME=argus-aiops

while [ "$#" -gt 0 ]; do
  case "$1" in
    --cluster-name) [ "$#" -ge 2 ] || exit 2; CLUSTER_NAME=$2; shift 2 ;;
    *) printf '%s\n' "Unknown option: $1" >&2; exit 2 ;;
  esac
done

CONTEXT="kind-$CLUSTER_NAME"
NAMESPACE=argus-aiops-system
IMAGE=argus-aiops-remediation-connector:local
MANIFEST="$ROOT_DIR/demo/aiops/kubernetes/remediation-connector.yaml"
SERVICE_ACCOUNT=system:serviceaccount:argus-aiops-system:argus-kubernetes-remediation

info() { printf '%s\n' "[aiops-remediation] $*"; }
fail() { printf '%s\n' "[aiops-remediation] ERROR: $*" >&2; exit 1; }

for command_name in docker kind kubectl; do
  command -v "$command_name" >/dev/null 2>&1 || fail "$command_name is required"
done
kubectl config get-contexts -o name | grep -Fx "$CONTEXT" >/dev/null 2>&1 \
  || fail "Kubernetes context $CONTEXT does not exist; bootstrap the AIOps cluster first"

info 'Building and loading the workload-scoped remediation connector...'
docker build \
  -f "$ROOT_DIR/demo/aiops/kubernetes/remediation-connector/Dockerfile" \
  -t "$IMAGE" "$ROOT_DIR"
kind load docker-image "$IMAGE" --name "$CLUSTER_NAME"

info 'Installing the isolated connector and verifying its least-privilege RBAC...'
kubectl --context "$CONTEXT" apply -f "$MANIFEST"
kubectl --context "$CONTEXT" -n "$NAMESPACE" \
  rollout status deployment/argus-kubernetes-remediation --timeout=3m

assert_permission() {
  verb=$1
  resource=$2
  namespace=$3
  expected=$4
  case "$resource" in
    */*)
      resource_name=${resource%%/*}
      subresource=${resource#*/}
      actual=$(kubectl --context "$CONTEXT" auth can-i "$verb" "$resource_name" \
        "--subresource=$subresource" --namespace "$namespace" --as="$SERVICE_ACCOUNT" || true)
      ;;
    *)
      actual=$(kubectl --context "$CONTEXT" auth can-i "$verb" "$resource" \
        --namespace "$namespace" --as="$SERVICE_ACCOUNT" || true)
      ;;
  esac
  actual=$(printf '%s' "$actual" | tr '[:upper:]' '[:lower:]' | tr -d '\r\n')
  [ "$actual" = "$expected" ] \
    || fail "Unexpected permission: $verb $resource in $namespace was $actual; expected $expected"
}

assert_permission get deployments argus-demo yes
assert_permission patch deployments argus-demo yes
assert_permission get deployments/scale argus-demo yes
assert_permission update deployments/scale argus-demo yes
assert_permission list replicasets argus-demo yes
assert_permission delete pods argus-demo no
assert_permission get secrets argus-demo no
assert_permission get deployments/scale kube-system no

info "Connector ready on the private Docker endpoint http://$CLUSTER_NAME-control-plane:30085/mcp"
