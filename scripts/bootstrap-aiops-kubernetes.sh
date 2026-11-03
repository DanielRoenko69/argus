#!/bin/sh
# macOS/Linux counterpart of bootstrap-aiops-kubernetes.ps1.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
LAB_DIR="$ROOT_DIR/demo/aiops/kubernetes"
CLUSTER_NAME=argus-aiops
SKIP_DEMO_WORKLOAD=false

while [ "$#" -gt 0 ]; do
  case "$1" in
    --cluster-name) [ "$#" -ge 2 ] || exit 2; CLUSTER_NAME=$2; shift 2 ;;
    --skip-demo-workload) SKIP_DEMO_WORKLOAD=true; shift ;;
    *) printf '%s\n' "Unknown option: $1" >&2; exit 2 ;;
  esac
done

KIND_IMAGE='kindest/node:v1.34.8@sha256:02722c2dedddcfc00febf5d27fbeb9b7b2c14294c82109ff4a85d89ac9ba3256'
CHART='oci://ghcr.io/kagent-dev/tools/helm/kagent-tools'
CHART_VERSION='0.2.1'
CONTEXT="kind-$CLUSTER_NAME"

info() { printf '%s\n' "[aiops-kubernetes] $*"; }
fail() { printf '%s\n' "[aiops-kubernetes] ERROR: $*" >&2; exit 1; }

for command_name in docker kind kubectl helm; do
  command -v "$command_name" >/dev/null 2>&1 || fail "$command_name is required"
done
docker info >/dev/null 2>&1 || fail 'Docker is not ready'

if ! kind get clusters 2>/dev/null | grep -Fx "$CLUSTER_NAME" >/dev/null 2>&1; then
  info "Creating Kind cluster $CLUSTER_NAME with Kubernetes 1.34.8..."
  kind create cluster \
    --name "$CLUSTER_NAME" \
    --image "$KIND_IMAGE" \
    --config "$LAB_DIR/kind-cluster.yaml" \
    --wait 5m
else
  info "Kind cluster $CLUSTER_NAME already exists; reconciling workloads."
fi

kubectl --context "$CONTEXT" apply -f "$LAB_DIR/namespaces.yaml"
helm upgrade --install argus-kubernetes-tools "$CHART" \
  --version "$CHART_VERSION" \
  --kube-context "$CONTEXT" \
  --namespace argus-aiops-system \
  --values "$LAB_DIR/kagent-tools-values.yaml" \
  --wait \
  --timeout 5m
kubectl --context "$CONTEXT" apply -f "$LAB_DIR/network-policy.yaml"

if [ "$SKIP_DEMO_WORKLOAD" != true ]; then
  kubectl --context "$CONTEXT" apply -f "$LAB_DIR/demo-workload.yaml"
  kubectl --context "$CONTEXT" -n argus-demo rollout status deployment/checkout-api --timeout=3m
  kubectl --context "$CONTEXT" -n argus-demo rollout status deployment/catalog-api --timeout=3m
fi
kubectl --context "$CONTEXT" -n argus-aiops-system \
  rollout status deployment/argus-kubernetes-tools --timeout=3m

SERVICE_ACCOUNT='system:serviceaccount:argus-aiops-system:argus-kubernetes-tools'
assert_permission() {
  verb=$1
  resource=$2
  namespace=$3
  expected=$4
  actual=$(kubectl --context "$CONTEXT" auth can-i "$verb" "$resource" \
    --namespace "$namespace" --as="$SERVICE_ACCOUNT" | tr '[:upper:]' '[:lower:]' | tr -d '\r\n')
  [ "$actual" = "$expected" ] || fail "Unexpected permission: $verb $resource in $namespace was $actual; expected $expected"
}

assert_permission get pods argus-demo yes
assert_permission delete pods argus-demo no
assert_permission get secrets argus-demo no
assert_permission get pods kube-system no

info 'Kubernetes evidence lab is ready.'
info "Context: $CONTEXT"
info 'Host MCP endpoint: http://127.0.0.1:18084/mcp'
kubectl --context "$CONTEXT" get nodes -o wide
