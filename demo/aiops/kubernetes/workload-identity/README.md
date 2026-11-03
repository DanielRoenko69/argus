# Managed Kubernetes workload identity adapters

Argus treats Kubernetes API identity and cloud API identity as separate trust
planes:

1. The connector always uses its dedicated Kubernetes ServiceAccount and
   namespaced RBAC for Kubernetes API reads.
2. A cloud workload identity is optional. Enable it only when a connector also
   needs a cloud API such as Azure Monitor, Resource Graph or Key Vault.

Static cloud access keys and client secrets are not accepted by the connector
certification contract.

## AKS adapter

Prerequisites outside Argus:

- AKS OIDC issuer and Microsoft Entra Workload ID are enabled;
- a user-assigned managed identity exists;
- its federated credential has exactly:
  - issuer: the AKS OIDC issuer;
  - subject: `system:serviceaccount:<namespace>:<service-account>`;
  - audience: `api://AzureADTokenExchange`;
- Azure role assignments are scoped to only the resources the selected MCP
  provider needs.

Copy `../connector-contract.aks.example.json`, replace its example identifiers
and resource names, and apply the Kubernetes half of the binding:

```powershell
.\scripts\configure-aks-workload-identity.ps1 `
  -Context <aks-context> `
  -ClientId <managed-identity-client-id> `
  -TenantId <entra-tenant-id>
```

The script annotates only the dedicated ServiceAccount and adds the mandatory
`azure.workload.identity/use=true` fail-close label to the Deployment Pod
template. It does not create or modify Azure resources.

Run certification after the rollout:

```powershell
node scripts/certify-kubernetes-connector.mjs `
  --contract <your-aks-contract.json> `
  --report test-results/kubernetes-connector-aks.json
```

For an AKS contract, the gate additionally reads Azure state through the
authenticated Azure CLI and verifies:

- OIDC and Workload Identity are enabled on the declared cluster;
- the managed identity client and tenant IDs match the Kubernetes annotations;
- the federated credential binds the exact issuer, ServiceAccount subject and
  single token audience;
- the AKS admission webhook injected `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`,
  `AZURE_AUTHORITY_HOST`, `AZURE_FEDERATED_TOKEN_FILE`, the projected token and
  its read-only volume mount into every connector Pod;
- no `AZURE_CLIENT_SECRET` is present.

The certifier is read-only against Azure. Set `AZ_BIN` only when the Azure CLI
binary is not discoverable as `az`/`az.cmd`.

## EKS adapter

EKS Pod Identity is not IRSA. It does not use an OIDC provider or a
`eks.amazonaws.com/role-arn` ServiceAccount annotation. The association lives
in the EKS API and maps one cluster/namespace/ServiceAccount tuple to an IAM
role.

Prerequisites outside Argus:

- the `eks-pod-identity-agent` managed add-on is active on every node;
- an IAM role exists with the `pods.eks.amazonaws.com` service principal and
  both `sts:AssumeRole` and `sts:TagSession`;
- its trust policy uses `StringEquals` conditions for the exact
  `eks-cluster-name`, `kubernetes-namespace` and
  `kubernetes-service-account` request tags;
- IAM permission policies are limited to the AWS resources used by the chosen
  MCP provider;
- node access to IMDS is restricted according to the EKS security baseline.

Copy `../connector-contract.eks.example.json`, replace the account, role,
cluster, region and optional AWS CLI profile, then inspect or create the
association:

```powershell
.\scripts\configure-eks-pod-identity.ps1 `
  -Context <eks-context> `
  -ClusterName <eks-cluster> `
  -Region eu-central-1 `
  -RoleArn <iam-role-arn> `
  -Profile <aws-profile> `
  -CreateAssociation `
  -RestartDeployment
```

Without `-CreateAssociation`, the script is read-only against AWS and fails if
no association exists. It never replaces a mismatched IAM role automatically.
Without `-RestartDeployment`, it does not restart connector Pods.

The certification gate verifies the active cluster and add-on, ready Agent
DaemonSet, unique association, role ARN, enabled session tags, scoped trust
policy and injected container-credential token. It rejects IRSA annotations,
static AWS key variables, web-identity variables and Secret-based `envFrom`
because those can precede Pod Identity in the default AWS credential chain.

Set `AWS_BIN` only when the AWS CLI binary is not discoverable as `aws`.

## GKE adapter

Argus uses the recommended direct Workload Identity Federation principal. It
does not link the Kubernetes ServiceAccount to a Google IAM service account.
The IAM member is bound to the immutable Kubernetes ServiceAccount UID so the
same namespace and ServiceAccount name in another cluster cannot inherit the
connector permissions.

Prerequisites outside Argus:

- the cluster workload pool is `<project-id>.svc.id.goog`;
- every Standard node pool used by the connector has the GKE metadata server
  enabled; Autopilot already enables it;
- the Google Cloud APIs used by the selected MCP provider support direct
  Workload Identity Federation principals;
- required IAM roles are resource-scoped where the target API supports it;
- an egress-isolating NetworkPolicy permits the GKE metadata route.

Copy `../connector-contract.gke.example.json`, replace the project, location,
cluster, ServiceAccount UID and IAM roles, then inspect the binding:

```powershell
.\scripts\configure-gke-workload-identity.ps1 `
  -Context <gke-context> `
  -ProjectId <gcp-project-id> `
  -ProjectNumber <gcp-project-number> `
  -Location europe-west3 `
  -ClusterName <gke-cluster> `
  -ClusterMode standard `
  -RequiredRoles roles/container.clusterViewer
```

The script is read-only unless `-PatchNodeSelector`, `-AddIamBindings` or
`-RestartDeployment` is explicitly supplied. It refuses Owner and Editor,
does not enable Workload Identity on a cluster, does not change node pools and
does not remove a legacy `iam.gke.io/gcp-service-account` annotation.

The certification gate verifies the project number, running cluster,
workload pool, Standard/Autopilot mode, node-pool metadata mode, exact
ServiceAccount UID principal, required roles, absence of Owner/Editor and the
correct metadata-server egress route. It rejects GSA impersonation and Google
service-account keys injected through environment variables or mounted
Secrets.

Set `GCLOUD_BIN` only when the Google Cloud CLI binary is not discoverable as
`gcloud`/`gcloud.cmd`.

## OpenShift adapter

The OpenShift adapter keeps the connector internal and uses OpenShift-native
controls in addition to the common Kubernetes baseline:

- bounded, rotating ServiceAccount tokens and namespaced RBAC;
- admission through `restricted-v2` or `restricted-v3` only;
- no permission to use privileged, host-access or any-UID SCCs;
- no ServiceAccount OAuth client annotations;
- no OpenShift Route targeting the connector Service;
- automatic internal TLS certificates from the service-ca controller.

The serving certificate is mounted only into a dedicated TLS proxy container.
The MCP tools container never receives the private key. Copy
`../connector-contract.openshift.example.json`, replace the context and
deployment values, then add the supplied digest-pinned TLS overlay to an
existing connector Deployment:

```powershell
kubectl --context <openshift-context> -n argus-aiops-system apply `
  -f .\demo\aiops\kubernetes\openshift\tls-proxy-config.yaml
kubectl --context <openshift-context> -n argus-aiops-system patch `
  deployment argus-kubernetes-connector --type strategic `
  --patch-file .\demo\aiops\kubernetes\openshift\tls-proxy-deployment-patch.yaml
kubectl --context <openshift-context> -n argus-aiops-system patch `
  service argus-kubernetes-connector --type merge `
  --patch-file .\demo\aiops\kubernetes\openshift\tls-service-patch.yaml
```

Then inspect the platform boundary:

```powershell
.\scripts\configure-openshift-service-account.ps1 `
  -Context <openshift-context> `
  -MinimumVersion 4.14
```

The script is read-only unless `-RequestServingCertificate` or
`-RestartDeployment` is explicitly supplied. Requesting the certificate only
adds `service.beta.openshift.io/serving-cert-secret-name` to the internal
Service. The service-ca controller creates and rotates the TLS Secret. The
script never grants an SCC, creates an OAuth client, creates a Route or adds a
TLS sidecar automatically.

The overlay uses an unprivileged NGINX 1.28 multi-architecture image pinned by
digest. It disables privilege escalation, drops every capability, uses a
read-only root filesystem and places temporary files in a bounded in-memory
volume. The proxy keeps MCP streaming unbuffered and listens only on the
internal Service port.

The certification probe validates the HTTPS endpoint with the OpenShift
service CA mounted at
`/var/run/secrets/kubernetes.io/serviceaccount/service-ca.crt`; it never uses
an insecure certificate-skip flag.

Before certification, the Deployment must already contain the TLS proxy and a
read-only mount of the serving certificate. The certifier checks ClusterVersion
health, the SCC actually recorded on every Pod, dangerous SCC authorization,
the generated certificate, its private-key boundary and the absence of Routes
and OAuth annotations. It also rejects OpenShift run-level bypasses, privileged
namespace enforcement and an insufficiently hardened TLS proxy.

Set `KUBECTL_BIN` only when `kubectl` is not discoverable. The OpenShift APIs
are queried directly, so a separate `oc` binary is not required by the gate.
