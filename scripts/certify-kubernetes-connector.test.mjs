import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  buildInClusterKubeconfig,
  evaluateConnectorSnapshot,
  kubectlContextArgs,
  validateConnectorContract,
} from './certify-kubernetes-connector.mjs';

const digest = 'sha256:50b431281d3e32666f27a292962fd486aabaac157083a844d037c12137e353aa';

const contract = JSON.parse(await readFile(resolve('demo/aiops/kubernetes/connector-contract.in-cluster.json'), 'utf8'));
const aksContract = JSON.parse(await readFile(resolve('demo/aiops/kubernetes/connector-contract.aks.example.json'), 'utf8'));
const eksContract = JSON.parse(await readFile(resolve('demo/aiops/kubernetes/connector-contract.eks.example.json'), 'utf8'));
const gkeContract = JSON.parse(await readFile(resolve('demo/aiops/kubernetes/connector-contract.gke.example.json'), 'utf8'));
const openShiftContract = JSON.parse(await readFile(resolve('demo/aiops/kubernetes/connector-contract.openshift.example.json'), 'utf8'));

function secureSnapshot() {
  const labels = {
    'app.kubernetes.io/instance': 'argus-kubernetes-connector',
    'app.kubernetes.io/name': 'argus-kubernetes-connector',
  };
  const podSpec = {
    serviceAccountName: 'argus-kubernetes-connector',
    securityContext: { seccompProfile: { type: 'RuntimeDefault' } },
    containers: [{
      name: 'tools',
      args: ['--port', '8084', '--tools=k8s', '--read-only'],
      readinessProbe: { httpGet: { path: '/health', port: 'http-tools' } },
      securityContext: {
        runAsNonRoot: true,
        allowPrivilegeEscalation: false,
        readOnlyRootFilesystem: true,
        capabilities: { drop: ['ALL'] },
      },
    }],
    volumes: [{
      name: 'kube-api-access',
      projected: { sources: [{ serviceAccountToken: { expirationSeconds: 3607, path: 'token' } }] },
    }],
  };
  return {
    deployment: {
      status: { availableReplicas: 1 },
      spec: { template: { metadata: { labels }, spec: podSpec } },
    },
    service: { spec: { type: 'ClusterIP', selector: labels } },
    serviceAccount: { secrets: [] },
    pods: {
      items: [{
        metadata: { labels },
        spec: podSpec,
        status: { containerStatuses: [{ name: 'tools', imageID: `ghcr.io/kagent-dev/kagent/tools@${digest}` }] },
      }],
    },
    endpointSlices: { items: [{ endpoints: [{ conditions: { ready: true } }] }] },
    networkPolicies: {
      items: [{
        spec: {
          podSelector: { matchLabels: { ...labels } },
          policyTypes: ['Ingress'],
          ingress: [{
            from: [{ podSelector: { matchLabels: { 'argus.eu/kubernetes-connector-client': 'true' } } }],
            ports: [{ port: 8084, protocol: 'TCP' }],
          }],
        },
      }],
    },
    clusterRoleBindings: { items: [] },
    legacyTokenSecrets: { items: [] },
    networkPolicyProbe: { allowed: true, denied: true },
    permissions: {
      'get:pods:argus-demo': true,
      'get:pods/log:argus-demo': true,
      'delete:pods:argus-demo': false,
      'get:secrets:argus-demo': false,
      'get:pods:kube-system': false,
    },
  };
}

function secureAksSnapshot() {
  const snapshot = secureSnapshot();
  const cloud = aksContract.spec.identity.cloud;
  const issuer = 'https://westeurope.oic.prod-aks.azure.com/example/';
  const template = snapshot.deployment.spec.template;
  const pod = snapshot.pods.items[0];
  template.metadata.labels['azure.workload.identity/use'] = 'true';
  pod.metadata.labels['azure.workload.identity/use'] = 'true';
  snapshot.serviceAccount.metadata = {
    annotations: {
      'azure.workload.identity/client-id': cloud.clientId,
      'azure.workload.identity/tenant-id': cloud.tenantId,
      'azure.workload.identity/service-account-token-expiration': String(cloud.tokenExpirationSeconds),
    },
  };
  const container = pod.spec.containers[0];
  container.env = [
    { name: 'AZURE_AUTHORITY_HOST', value: 'https://login.microsoftonline.com/' },
    { name: 'AZURE_CLIENT_ID', value: cloud.clientId },
    { name: 'AZURE_TENANT_ID', value: cloud.tenantId },
    { name: 'AZURE_FEDERATED_TOKEN_FILE', value: cloud.tokenFile },
  ];
  container.volumeMounts = [{ name: 'azure-identity-token', mountPath: '/var/run/secrets/azure/tokens', readOnly: true }];
  pod.spec.volumes.push({
    name: 'azure-identity-token',
    projected: {
      sources: [{
        serviceAccountToken: {
          audience: cloud.tokenAudience,
          expirationSeconds: cloud.tokenExpirationSeconds,
          path: 'azure-identity-token',
        },
      }],
    },
  });
  snapshot.networkPolicies.items[0].spec.ingress[0].ports[0].port = aksContract.spec.endpoint.port;
  snapshot.permissions = {
    'get:pods:argus-production': true,
    'get:pods/log:argus-production': true,
    'delete:pods:argus-production': false,
    'get:secrets:argus-production': false,
    'get:pods:kube-system': false,
  };
  snapshot.cloudIdentity = {
    cluster: {
      oidcIssuerProfile: { enabled: true, issuerUrl: issuer },
      securityProfile: { workloadIdentity: { enabled: true } },
    },
    managedIdentity: { clientId: cloud.clientId, tenantId: cloud.tenantId },
    federatedCredential: {
      issuer,
      subject: `system:serviceaccount:${aksContract.spec.namespace}:${aksContract.spec.workload.serviceAccount}`,
      audiences: [cloud.tokenAudience],
    },
  };
  return snapshot;
}

function secureEksSnapshot() {
  const snapshot = secureSnapshot();
  const cloud = eksContract.spec.identity.cloud;
  const pod = snapshot.pods.items[0];
  snapshot.serviceAccount.metadata = { annotations: {} };
  const container = pod.spec.containers[0];
  container.env = [
    { name: 'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE', value: cloud.tokenFile },
    { name: 'AWS_CONTAINER_CREDENTIALS_FULL_URI', value: cloud.credentialEndpoint },
  ];
  container.volumeMounts = [{
    name: 'eks-pod-identity-token',
    mountPath: '/var/run/secrets/pods.eks.amazonaws.com/serviceaccount',
    readOnly: true,
  }];
  pod.spec.volumes.push({
    name: 'eks-pod-identity-token',
    projected: {
      defaultMode: 420,
      sources: [{
        serviceAccountToken: {
          audience: cloud.tokenAudience,
          expirationSeconds: cloud.tokenExpirationSeconds,
          path: 'eks-pod-identity-token',
        },
      }],
    },
  });
  snapshot.networkPolicies.items[0].spec.ingress[0].ports[0].port = eksContract.spec.endpoint.port;
  snapshot.permissions = {
    'get:pods:argus-production': true,
    'get:pods/log:argus-production': true,
    'delete:pods:argus-production': false,
    'get:secrets:argus-production': false,
    'get:pods:kube-system': false,
  };
  snapshot.podIdentityAgent = {
    status: { desiredNumberScheduled: 3, numberReady: 3 },
  };
  snapshot.cloudIdentity = {
    cluster: { name: cloud.aws.clusterName, status: 'ACTIVE' },
    addon: {
      addonName: 'eks-pod-identity-agent',
      clusterName: cloud.aws.clusterName,
      status: 'ACTIVE',
      health: { issues: [] },
    },
    association: {
      clusterName: cloud.aws.clusterName,
      namespace: eksContract.spec.namespace,
      serviceAccount: eksContract.spec.workload.serviceAccount,
      roleArn: cloud.roleArn,
      associationId: 'a-1234567890abcdefg',
      disableSessionTags: false,
    },
    iamRole: {
      Arn: cloud.roleArn,
      RoleName: cloud.aws.roleName,
      AssumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [{
          Effect: 'Allow',
          Principal: { Service: 'pods.eks.amazonaws.com' },
          Action: ['sts:AssumeRole', 'sts:TagSession'],
          Condition: {
            StringEquals: {
              'aws:RequestTag/eks-cluster-name': cloud.aws.clusterName,
              'aws:RequestTag/kubernetes-namespace': eksContract.spec.namespace,
              'aws:RequestTag/kubernetes-service-account': eksContract.spec.workload.serviceAccount,
            },
          },
        }],
      },
    },
  };
  return snapshot;
}

function secureGkeSnapshot() {
  const snapshot = secureSnapshot();
  const gcp = gkeContract.spec.identity.cloud.gcp;
  const principal = `principal://iam.googleapis.com/projects/${gcp.projectNumber}/locations/global/workloadIdentityPools/${gcp.projectId}.svc.id.goog/kubernetes.serviceaccount.uid/${gcp.serviceAccountUid}`;
  snapshot.serviceAccount.metadata = {
    uid: gcp.serviceAccountUid,
    annotations: {},
  };
  snapshot.deployment.spec.template.spec.nodeSelector = {
    'iam.gke.io/gke-metadata-server-enabled': 'true',
  };
  snapshot.networkPolicies.items[0].spec.ingress[0].ports[0].port = gkeContract.spec.endpoint.port;
  snapshot.permissions = {
    'get:pods:argus-production': true,
    'get:pods/log:argus-production': true,
    'delete:pods:argus-production': false,
    'get:secrets:argus-production': false,
    'get:pods:kube-system': false,
  };
  snapshot.cloudIdentity = {
    project: {
      projectId: gcp.projectId,
      projectNumber: gcp.projectNumber,
    },
    cluster: {
      name: gcp.clusterName,
      location: gcp.location,
      status: 'RUNNING',
      workloadIdentityConfig: { workloadPool: `${gcp.projectId}.svc.id.goog` },
      autopilot: { enabled: false },
      networkConfig: { datapathProvider: 'ADVANCED_DATAPATH' },
      nodePools: [{ config: { workloadMetadataConfig: { mode: 'GKE_METADATA' } } }],
    },
    iamPolicy: {
      bindings: [
        { role: 'roles/container.clusterViewer', members: [principal] },
        { role: 'roles/viewer', members: ['user:operator@example.com'] },
      ],
    },
  };
  return snapshot;
}

function secureOpenShiftSnapshot() {
  const snapshot = secureSnapshot();
  const openshift = openShiftContract.spec.identity.cloud.openshift;
  const certificate = openshift.servingCertificate;
  const podSpec = snapshot.pods.items[0].spec;
  snapshot.serviceAccount.metadata = { annotations: {} };
  snapshot.pods.items[0].metadata.annotations = { 'openshift.io/scc': 'restricted-v2' };
  snapshot.service.metadata = {
    annotations: {
      'service.beta.openshift.io/serving-cert-secret-name': certificate.secretName,
      'service.beta.openshift.io/serving-cert-signed-by': 'openshift-service-serving-signer@1712345678',
    },
  };
  snapshot.service.spec.ports = [{
    name: 'https',
    port: openShiftContract.spec.endpoint.port,
    targetPort: certificate.targetPort,
  }];
  podSpec.containers.push({
    name: certificate.tlsContainer,
    image: certificate.tlsImage,
    securityContext: {
      runAsNonRoot: true,
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ['ALL'] },
    },
    volumeMounts: [{ name: 'serving-cert', mountPath: certificate.mountPath, readOnly: true }],
  });
  podSpec.volumes.push({ name: 'serving-cert', secret: { secretName: certificate.secretName } });
  snapshot.networkPolicies.items[0].spec.ingress[0].ports[0].port = openShiftContract.spec.endpoint.port;
  snapshot.permissions = {
    'get:pods:argus-production': true,
    'get:pods/log:argus-production': true,
    'delete:pods:argus-production': false,
    'get:secrets:argus-production': false,
    'get:pods:openshift-config': false,
  };
  snapshot.cloudIdentity = {
    namespace: { metadata: { labels: {} } },
    clusterVersion: {
      metadata: { name: 'version', generation: 7 },
      status: {
        observedGeneration: 7,
        desired: { version: '4.20.3' },
        conditions: [
          { type: 'Available', status: 'True' },
          { type: 'Progressing', status: 'False' },
          { type: 'Degraded', status: 'False' },
          { type: 'Failing', status: 'False' },
        ],
      },
    },
    servingCertSecret: {
      type: 'kubernetes.io/tls',
      data: { 'tls.crt': 'Y2VydA==', 'tls.key': 'a2V5' },
    },
    routes: { items: [] },
    sccPermissions: Object.fromEntries(openshift.forbiddenSccs.map(scc => [scc, false])),
  };
  return snapshot;
}

test('accepts the checked-in in-cluster contract and a least-privilege snapshot', () => {
  assert.deepEqual(validateConnectorContract(contract), []);
  const report = evaluateConnectorSnapshot(contract, secureSnapshot());
  assert.equal(report.overall, 'passed');
  assert.equal(report.checks.every(check => check.status === 'passed'), true);
});

test('uses the mounted ServiceAccount context inside a certifier CronJob', () => {
  assert.deepEqual(kubectlContextArgs('in-cluster'), []);
  assert.deepEqual(kubectlContextArgs('kind-argus-aiops'), ['--context', 'kind-argus-aiops']);
});

test('builds an explicit in-cluster kubeconfig without putting the token in kubectl arguments', () => {
  const kubeconfig = buildInClusterKubeconfig({
    host: '10.96.0.1',
    port: '443',
    caPath: resolve('demo/aiops/kubernetes/connector-contract.schema.json'),
    token: 'header.payload.signature',
  });
  assert.equal(kubeconfig.clusters[0].cluster.server, 'https://10.96.0.1:443');
  assert.equal(kubeconfig.clusters[0].cluster['certificate-authority'], resolve('demo/aiops/kubernetes/connector-contract.schema.json'));
  assert.equal(kubeconfig.users[0].user.token, 'header.payload.signature');
  assert.equal(kubeconfig['current-context'], 'argus-in-cluster');
  assert.deepEqual(kubectlContextArgs('in-cluster'), []);
});

test('fails when a NetworkPolicy exists but does not select the connector workload', () => {
  const snapshot = secureSnapshot();
  snapshot.networkPolicies.items[0].spec.podSelector.matchLabels['app.kubernetes.io/name'] = 'wrong-name';
  const report = evaluateConnectorSnapshot(contract, snapshot);
  assert.equal(report.overall, 'failed');
  assert.equal(report.checks.find(check => check.id === 'network-policy.selects-workload')?.status, 'failed');
  assert.equal(report.checks.find(check => check.id === 'network-policy.restricted-ingress')?.status, 'failed');
});

test('fails when the cluster accepts traffic that the NetworkPolicy should deny', () => {
  const snapshot = secureSnapshot();
  snapshot.networkPolicyProbe.denied = false;
  const report = evaluateConnectorSnapshot(contract, snapshot);
  assert.equal(report.checks.find(check => check.id === 'network-policy.enforced')?.status, 'failed');
});

test('fails when the ServiceAccount receives a namespace-wide ClusterRoleBinding', () => {
  const snapshot = secureSnapshot();
  snapshot.clusterRoleBindings.items.push({ subjects: [{ kind: 'Group', name: 'system:serviceaccounts:argus-aiops-system' }] });
  const report = evaluateConnectorSnapshot(contract, snapshot);
  assert.equal(report.checks.find(check => check.id === 'rbac.no-cluster-binding')?.status, 'failed');
});

test('allows the built-in service-account issuer discovery binding only', () => {
  const snapshot = secureSnapshot();
  snapshot.clusterRoleBindings.items.push({
    metadata: { name: 'system:service-account-issuer-discovery' },
    roleRef: { kind: 'ClusterRole', name: 'system:service-account-issuer-discovery' },
    subjects: [{ kind: 'Group', name: 'system:serviceaccounts' }],
  });
  const report = evaluateConnectorSnapshot(contract, snapshot);
  assert.equal(report.checks.find(check => check.id === 'rbac.no-cluster-binding')?.status, 'passed');
});

test('requires TLS when a contract claims the production profile', () => {
  const production = structuredClone(contract);
  production.spec.profile = 'production';
  assert.match(validateConnectorContract(production).join('\n'), /requires an https endpoint/);
  assert.match(validateConnectorContract(production).join('\n'), /requires zero NetworkPolicy probe stabilization time/);
});

test('accepts the AKS example contract and complete Workload Identity evidence', () => {
  assert.deepEqual(validateConnectorContract(aksContract), []);
  const report = evaluateConnectorSnapshot(aksContract, secureAksSnapshot());
  assert.equal(report.overall, 'passed');
  assert.equal(report.checks.filter(check => check.id.startsWith('identity.aks.')).length, 6);
  assert.equal(report.checks.filter(check => check.id.startsWith('identity.aks.')).every(check => check.status === 'passed'), true);
});

test('fails AKS certification when the federated credential binds another subject', () => {
  const snapshot = secureAksSnapshot();
  snapshot.cloudIdentity.federatedCredential.subject = 'system:serviceaccount:other:connector';
  const report = evaluateConnectorSnapshot(aksContract, snapshot);
  assert.equal(report.checks.find(check => check.id === 'identity.aks.federated-credential')?.status, 'failed');
});

test('fails AKS certification when webhook injection is missing or a static client secret exists', () => {
  const snapshot = secureAksSnapshot();
  snapshot.pods.items[0].spec.containers[0].volumeMounts = [];
  snapshot.pods.items[0].spec.containers[0].env.push({ name: 'AZURE_CLIENT_SECRET', valueFrom: { secretKeyRef: { name: 'azure', key: 'secret' } } });
  const report = evaluateConnectorSnapshot(aksContract, snapshot);
  assert.equal(report.checks.find(check => check.id === 'identity.aks.webhook-injection')?.status, 'failed');
  assert.equal(report.checks.find(check => check.id === 'identity.aks.no-client-secret')?.status, 'failed');
});

test('rejects a cloud identity mode on the wrong managed Kubernetes platform', () => {
  const wrongPlatform = structuredClone(aksContract);
  wrongPlatform.spec.platform = 'gke';
  assert.match(validateConnectorContract(wrongPlatform).join('\n'), /requires platform aks/);
});

test('accepts the EKS example contract and complete Pod Identity evidence', () => {
  assert.deepEqual(validateConnectorContract(eksContract), []);
  const report = evaluateConnectorSnapshot(eksContract, secureEksSnapshot());
  assert.equal(report.overall, 'passed');
  assert.equal(report.checks.filter(check => check.id.startsWith('identity.eks.')).length, 7);
  assert.equal(report.checks.filter(check => check.id.startsWith('identity.eks.')).every(check => check.status === 'passed'), true);
});

test('fails EKS certification when IRSA or static credentials can precede Pod Identity', () => {
  const snapshot = secureEksSnapshot();
  snapshot.serviceAccount.metadata.annotations['eks.amazonaws.com/role-arn'] = 'arn:aws:iam::111122223333:role/legacy-irsa';
  snapshot.pods.items[0].spec.containers[0].env.push({ name: 'AWS_ACCESS_KEY_ID', valueFrom: { secretKeyRef: { name: 'aws', key: 'access-key' } } });
  const report = evaluateConnectorSnapshot(eksContract, snapshot);
  assert.equal(report.checks.find(check => check.id === 'identity.eks.no-irsa-annotation')?.status, 'failed');
  assert.equal(report.checks.find(check => check.id === 'identity.eks.default-credential-chain')?.status, 'failed');
});

test('fails EKS certification when association or trust policy escape the workload scope', () => {
  const snapshot = secureEksSnapshot();
  snapshot.cloudIdentity.association.namespace = 'other';
  delete snapshot.cloudIdentity.iamRole.AssumeRolePolicyDocument.Statement[0].Condition.StringEquals['aws:RequestTag/kubernetes-service-account'];
  const report = evaluateConnectorSnapshot(eksContract, snapshot);
  assert.equal(report.checks.find(check => check.id === 'identity.eks.association')?.status, 'failed');
  assert.equal(report.checks.find(check => check.id === 'identity.eks.iam-trust')?.status, 'failed');
});

test('accepts the GKE example contract and direct ServiceAccount UID evidence', () => {
  assert.deepEqual(validateConnectorContract(gkeContract), []);
  const report = evaluateConnectorSnapshot(gkeContract, secureGkeSnapshot());
  assert.equal(report.overall, 'passed');
  assert.equal(report.checks.filter(check => check.id.startsWith('identity.gke.')).length, 7);
  assert.equal(report.checks.filter(check => check.id.startsWith('identity.gke.')).every(check => check.status === 'passed'), true);
});

test('fails GKE certification when GSA impersonation or a static key can precede federation', () => {
  const snapshot = secureGkeSnapshot();
  snapshot.serviceAccount.metadata.annotations['iam.gke.io/gcp-service-account'] = 'legacy@argus-production.iam.gserviceaccount.com';
  snapshot.pods.items[0].spec.containers[0].env = [{
    name: 'GOOGLE_APPLICATION_CREDENTIALS',
    valueFrom: { secretKeyRef: { name: 'google-key', key: 'credentials.json' } },
  }];
  const report = evaluateConnectorSnapshot(gkeContract, snapshot);
  assert.equal(report.checks.find(check => check.id === 'identity.gke.direct-principal')?.status, 'failed');
  assert.equal(report.checks.find(check => check.id === 'identity.gke.no-static-credentials')?.status, 'failed');
});

test('fails GKE certification when the UID principal lacks a role or receives a basic role', () => {
  const snapshot = secureGkeSnapshot();
  const principal = snapshot.cloudIdentity.iamPolicy.bindings[0].members[0];
  snapshot.cloudIdentity.iamPolicy.bindings[0].members = ['user:other@example.com'];
  snapshot.cloudIdentity.iamPolicy.bindings.push({ role: 'roles/editor', members: [principal] });
  const report = evaluateConnectorSnapshot(gkeContract, snapshot);
  assert.equal(report.checks.find(check => check.id === 'identity.gke.iam-roles')?.status, 'failed');
  assert.equal(report.checks.find(check => check.id === 'identity.gke.no-basic-roles')?.status, 'failed');
});

test('fails GKE certification when a restricted egress policy blocks the metadata server', () => {
  const snapshot = secureGkeSnapshot();
  snapshot.networkPolicies.items.push({
    spec: {
      podSelector: { matchLabels: snapshot.deployment.spec.template.metadata.labels },
      policyTypes: ['Egress'],
      egress: [{
        to: [{ ipBlock: { cidr: '169.254.169.252/32' } }],
        ports: [{ port: 988, protocol: 'TCP' }],
      }],
    },
  });
  const report = evaluateConnectorSnapshot(gkeContract, snapshot);
  assert.equal(report.checks.find(check => check.id === 'identity.gke.metadata-egress')?.status, 'failed');
});

test('rejects Owner or Editor as a declared GKE connector role', () => {
  const broad = structuredClone(gkeContract);
  broad.spec.identity.cloud.gcp.requiredRoles = ['roles/editor'];
  assert.match(validateConnectorContract(broad).join('\n'), /roles\/editor is too broad/);
});

test('accepts the OpenShift example with restricted SCC and service-ca TLS evidence', () => {
  assert.deepEqual(validateConnectorContract(openShiftContract), []);
  const report = evaluateConnectorSnapshot(openShiftContract, secureOpenShiftSnapshot());
  assert.equal(report.overall, 'passed');
  assert.equal(report.checks.filter(check => check.id.startsWith('identity.openshift.')).length, 8);
  assert.equal(report.checks.filter(check => check.id.startsWith('identity.openshift.')).every(check => check.status === 'passed'), true);
});

test('fails OpenShift certification when the Pod or ServiceAccount can use a dangerous SCC', () => {
  const snapshot = secureOpenShiftSnapshot();
  snapshot.pods.items[0].metadata.annotations['openshift.io/scc'] = 'privileged';
  snapshot.cloudIdentity.sccPermissions.privileged = true;
  const report = evaluateConnectorSnapshot(openShiftContract, snapshot);
  assert.equal(report.checks.find(check => check.id === 'identity.openshift.restricted-scc')?.status, 'failed');
  assert.equal(report.checks.find(check => check.id === 'identity.openshift.no-dangerous-scc')?.status, 'failed');
});

test('fails OpenShift certification when OAuth or an external Route is attached', () => {
  const snapshot = secureOpenShiftSnapshot();
  snapshot.serviceAccount.metadata.annotations['serviceaccounts.openshift.io/oauth-redirecturi.argus'] = 'https://external.example/callback';
  snapshot.cloudIdentity.routes.items.push({ spec: { to: { kind: 'Service', name: openShiftContract.spec.workload.service } } });
  const report = evaluateConnectorSnapshot(openShiftContract, snapshot);
  assert.equal(report.checks.find(check => check.id === 'identity.openshift.no-oauth-client')?.status, 'failed');
  assert.equal(report.checks.find(check => check.id === 'identity.openshift.internal-only')?.status, 'failed');
});

test('fails OpenShift certification when the service certificate reaches the tools container', () => {
  const snapshot = secureOpenShiftSnapshot();
  snapshot.pods.items[0].spec.containers[0].volumeMounts = [{
    name: 'serving-cert',
    mountPath: '/var/run/secrets/argus-serving-cert',
    readOnly: true,
  }];
  const report = evaluateConnectorSnapshot(openShiftContract, snapshot);
  assert.equal(report.checks.find(check => check.id === 'identity.openshift.tls-boundary')?.status, 'failed');
});

test('fails OpenShift certification when the namespace enables a platform security bypass', () => {
  const snapshot = secureOpenShiftSnapshot();
  snapshot.cloudIdentity.namespace.metadata.labels['openshift.io/run-level'] = '1';
  const report = evaluateConnectorSnapshot(openShiftContract, snapshot);
  assert.equal(report.checks.find(check => check.id === 'identity.openshift.namespace-safety')?.status, 'failed');
});

test('fails OpenShift certification for a progressing cluster below the declared version', () => {
  const snapshot = secureOpenShiftSnapshot();
  snapshot.cloudIdentity.clusterVersion.status.desired.version = '4.13.42';
  snapshot.cloudIdentity.clusterVersion.status.conditions.find(condition => condition.type === 'Progressing').status = 'True';
  const report = evaluateConnectorSnapshot(openShiftContract, snapshot);
  assert.equal(report.checks.find(check => check.id === 'identity.openshift.cluster-version')?.status, 'failed');
});

test('rejects an OpenShift contract that skips service-ca verification or uses an unpinned proxy', () => {
  const unsafe = structuredClone(openShiftContract);
  delete unsafe.spec.security.networkPolicyProbe.caFile;
  unsafe.spec.identity.cloud.openshift.servingCertificate.tlsImage = 'docker.io/nginxinc/nginx-unprivileged:latest';
  const errors = validateConnectorContract(unsafe).join('\n');
  assert.match(errors, /TLS proxy image must be pinned by digest/);
  assert.match(errors, /must verify TLS with the mounted service-ca\.crt/);
});
