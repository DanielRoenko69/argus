import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function requiredString(value, path, errors) {
  if (typeof value !== 'string' || value.trim().length === 0) errors.push(`${path} must be a non-empty string`);
}

function isUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function versionAtLeast(value, minimum) {
  const actualParts = String(value ?? '').split('.').map(part => Number.parseInt(part, 10));
  const minimumParts = String(minimum ?? '').split('.').map(part => Number.parseInt(part, 10));
  if (actualParts.some(Number.isNaN) || minimumParts.some(Number.isNaN)) return false;
  const length = Math.max(actualParts.length, minimumParts.length);
  for (let index = 0; index < length; index += 1) {
    const actual = actualParts[index] ?? 0;
    const required = minimumParts[index] ?? 0;
    if (actual !== required) return actual > required;
  }
  return true;
}

export function validateConnectorContract(contract) {
  const errors = [];
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) return ['contract must be an object'];
  if (contract.apiVersion !== 'connectors.argus.eu/v1alpha1') errors.push('apiVersion must be connectors.argus.eu/v1alpha1');
  if (contract.kind !== 'KubernetesConnectorCertification') errors.push('kind must be KubernetesConnectorCertification');
  requiredString(contract.metadata?.name, 'metadata.name', errors);
  requiredString(contract.metadata?.targetId, 'metadata.targetId', errors);
  const spec = contract.spec;
  if (!spec || typeof spec !== 'object') return [...errors, 'spec must be an object'];
  if (!['in-cluster-read-only', 'production'].includes(spec.profile)) errors.push('spec.profile is unsupported');
  if (!['kubernetes', 'aks', 'eks', 'gke', 'openshift'].includes(spec.platform)) errors.push('spec.platform is unsupported');
  requiredString(spec.context, 'spec.context', errors);
  requiredString(spec.namespace, 'spec.namespace', errors);
  for (const field of ['deployment', 'service', 'serviceAccount', 'container']) {
    requiredString(spec.workload?.[field], `spec.workload.${field}`, errors);
  }
  if (!spec.workload?.selector || Object.keys(spec.workload.selector).length === 0) errors.push('spec.workload.selector must not be empty');
  if (spec.endpoint?.serviceType !== 'ClusterIP') errors.push('spec.endpoint.serviceType must be ClusterIP');
  if (!['http', 'https'].includes(spec.endpoint?.scheme)) errors.push('spec.endpoint.scheme must be http or https');
  if (!Number.isInteger(spec.endpoint?.port) || spec.endpoint.port < 1 || spec.endpoint.port > 65535) errors.push('spec.endpoint.port is invalid');
  if (!Array.isArray(spec.scope?.readNamespaces) || spec.scope.readNamespaces.length === 0) errors.push('spec.scope.readNamespaces must not be empty');
  if (!Array.isArray(spec.scope?.executionNamespaces) || spec.scope.executionNamespaces.length === 0) errors.push('spec.scope.executionNamespaces must not be empty');
  if (spec.scope?.readOnly !== true) errors.push('spec.scope.readOnly must be true');
  if (spec.scope?.allowSecrets !== false) errors.push('spec.scope.allowSecrets must be false');
  for (const namespace of spec.scope?.executionNamespaces ?? []) {
    if (!(spec.scope?.readNamespaces ?? []).includes(namespace)) errors.push(`execution namespace ${namespace} is not in readNamespaces`);
  }
  if (spec.identity?.kubernetes?.mode !== 'projected-service-account-token') errors.push('Kubernetes identity must use a projected service-account token');
  if (!Number.isInteger(spec.identity?.kubernetes?.maxTokenLifetimeSeconds)) errors.push('maxTokenLifetimeSeconds must be an integer');
  const cloudIdentity = spec.identity?.cloud;
  const cloudModePlatforms = {
    'aks-workload-identity': 'aks',
    'eks-pod-identity': 'eks',
    'gke-workload-identity': 'gke',
    'openshift-service-account': 'openshift',
  };
  if (!['none', ...Object.keys(cloudModePlatforms)].includes(cloudIdentity?.mode)) errors.push('spec.identity.cloud.mode is unsupported');
  if (cloudModePlatforms[cloudIdentity?.mode] && cloudModePlatforms[cloudIdentity.mode] !== spec.platform) {
    errors.push(`${cloudIdentity.mode} requires platform ${cloudModePlatforms[cloudIdentity.mode]}`);
  }
  if (cloudIdentity?.mode === 'aks-workload-identity') {
    if (!isUuid(cloudIdentity.clientId)) errors.push('AKS Workload Identity clientId must be a UUID');
    if (!isUuid(cloudIdentity.tenantId)) errors.push('AKS Workload Identity tenantId must be a UUID');
    if (cloudIdentity.tokenAudience !== 'api://AzureADTokenExchange') errors.push('AKS Workload Identity tokenAudience must be api://AzureADTokenExchange');
    if (cloudIdentity.tokenFile !== '/var/run/secrets/azure/tokens/azure-identity-token') errors.push('AKS Workload Identity tokenFile is invalid');
    if (!Number.isInteger(cloudIdentity.tokenExpirationSeconds) || cloudIdentity.tokenExpirationSeconds < 600 || cloudIdentity.tokenExpirationSeconds > 86400) errors.push('AKS Workload Identity tokenExpirationSeconds is invalid');
    for (const field of ['clusterResourceGroup', 'clusterName', 'identityResourceGroup', 'managedIdentityName', 'federatedCredentialName']) {
      requiredString(cloudIdentity.azure?.[field], `spec.identity.cloud.azure.${field}`, errors);
    }
    if (cloudIdentity.azure?.subscriptionId && !isUuid(cloudIdentity.azure.subscriptionId)) errors.push('Azure subscriptionId must be a UUID');
  }
  if (cloudIdentity?.mode === 'eks-pod-identity') {
    if (!/^arn:(aws|aws-us-gov|aws-cn):iam::[0-9]{12}:role\/.+/.test(cloudIdentity.roleArn ?? '')) errors.push('EKS Pod Identity roleArn is invalid');
    if (cloudIdentity.tokenAudience !== 'pods.eks.amazonaws.com') errors.push('EKS Pod Identity tokenAudience must be pods.eks.amazonaws.com');
    if (cloudIdentity.tokenFile !== '/var/run/secrets/pods.eks.amazonaws.com/serviceaccount/eks-pod-identity-token') errors.push('EKS Pod Identity tokenFile is invalid');
    if (cloudIdentity.tokenExpirationSeconds !== 86400) errors.push('EKS Pod Identity tokenExpirationSeconds must be 86400');
    if (cloudIdentity.credentialEndpoint !== 'http://169.254.170.23/v1/credentials') errors.push('EKS Pod Identity credentialEndpoint is invalid');
    for (const field of ['region', 'clusterName', 'roleName', 'agentMode']) {
      requiredString(cloudIdentity.aws?.[field], `spec.identity.cloud.aws.${field}`, errors);
    }
    if (cloudIdentity.aws?.agentMode !== 'addon') errors.push('EKS Pod Identity currently requires agentMode addon');
  }
  if (cloudIdentity?.mode === 'gke-workload-identity') {
    const gcp = cloudIdentity.gcp;
    if (cloudIdentity.metadataEndpoint !== 'http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token') errors.push('GKE Workload Identity metadataEndpoint is invalid');
    for (const field of ['projectId', 'projectNumber', 'location', 'clusterName', 'clusterMode', 'principalMode', 'serviceAccountUid']) {
      requiredString(gcp?.[field], `spec.identity.cloud.gcp.${field}`, errors);
    }
    if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(gcp?.projectId ?? '')) errors.push('GKE projectId is invalid');
    if (!/^[0-9]{6,32}$/.test(gcp?.projectNumber ?? '')) errors.push('GKE projectNumber is invalid');
    if (!['standard', 'autopilot'].includes(gcp?.clusterMode)) errors.push('GKE clusterMode must be standard or autopilot');
    if (gcp?.principalMode !== 'service-account-uid') errors.push('GKE principalMode must be service-account-uid');
    if (!isUuid(gcp?.serviceAccountUid)) errors.push('GKE serviceAccountUid must be a UUID');
    if (!Array.isArray(gcp?.requiredRoles) || gcp.requiredRoles.length === 0) errors.push('GKE requiredRoles must not be empty');
    for (const role of gcp?.requiredRoles ?? []) {
      if (!/^roles\/[A-Za-z0-9_.]+$/.test(role)) errors.push(`GKE required role ${role} is invalid`);
      if (['roles/owner', 'roles/editor'].includes(role)) errors.push(`GKE required role ${role} is too broad`);
    }
  }
  if (cloudIdentity?.mode === 'openshift-service-account') {
    const openshift = cloudIdentity.openshift;
    const expectedForbiddenSccs = ['anyuid', 'hostaccess', 'hostmount-anyuid', 'hostnetwork', 'node-exporter', 'privileged'];
    for (const field of ['clusterVersionName', 'minimumVersion']) {
      requiredString(openshift?.[field], `spec.identity.cloud.openshift.${field}`, errors);
    }
    if (openshift?.clusterVersionName !== 'version') errors.push('OpenShift clusterVersionName must be version');
    if (!versionAtLeast(openshift?.minimumVersion, '4.14')) errors.push('OpenShift minimumVersion must be 4.14 or newer');
    if (!Array.isArray(openshift?.allowedSccs) || openshift.allowedSccs.length === 0 || openshift.allowedSccs.some(scc => !['restricted-v2', 'restricted-v3'].includes(scc))) {
      errors.push('OpenShift allowedSccs must contain only restricted-v2 or restricted-v3');
    }
    if (JSON.stringify(openshift?.forbiddenSccs) !== JSON.stringify(expectedForbiddenSccs)) errors.push('OpenShift forbiddenSccs must use the Argus hardened set');
    if (openshift?.oauthClient !== false) errors.push('OpenShift connector must not be an OAuth client');
    if (openshift?.exposeRoute !== false) errors.push('OpenShift connector must not expose a Route');
    for (const field of ['secretName', 'tlsContainer', 'tlsImage', 'mountPath']) {
      requiredString(openshift?.servingCertificate?.[field], `spec.identity.cloud.openshift.servingCertificate.${field}`, errors);
    }
    if (!/^.+@sha256:[a-f0-9]{64}$/.test(openshift?.servingCertificate?.tlsImage ?? '')) errors.push('OpenShift TLS proxy image must be pinned by digest');
    if (!Number.isInteger(openshift?.servingCertificate?.targetPort) || openshift.servingCertificate.targetPort !== spec.endpoint?.port) {
      errors.push('OpenShift serving certificate targetPort must match the connector endpoint port');
    }
    if (spec.security?.networkPolicyProbe?.caFile !== '/var/run/secrets/kubernetes.io/serviceaccount/service-ca.crt') {
      errors.push('OpenShift NetworkPolicy probe must verify TLS with the mounted service-ca.crt');
    }
  }
  if (spec.security?.requireNetworkPolicyEnforcement === true) {
    requiredString(spec.security?.networkPolicyProbe?.image, 'spec.security.networkPolicyProbe.image', errors);
    requiredString(spec.security?.networkPolicyProbe?.healthPath, 'spec.security.networkPolicyProbe.healthPath', errors);
    if (!Number.isInteger(spec.security?.networkPolicyProbe?.timeoutSeconds)) errors.push('networkPolicyProbe.timeoutSeconds must be an integer');
    if (!Number.isInteger(spec.security?.networkPolicyProbe?.stabilizationSeconds)) errors.push('networkPolicyProbe.stabilizationSeconds must be an integer');
  }
  if (!Array.isArray(spec.permissionAssertions) || spec.permissionAssertions.length === 0) errors.push('spec.permissionAssertions must not be empty');
  if (spec.profile === 'production' && spec.endpoint?.scheme !== 'https') errors.push('production profile requires an https endpoint');
  if (spec.profile === 'production' && spec.security?.networkPolicyProbe?.stabilizationSeconds !== 0) errors.push('production profile requires zero NetworkPolicy probe stabilization time');
  return errors;
}

function selectorMatches(selector = {}, labels = {}) {
  const matchLabels = selector.matchLabels ?? {};
  if (!Object.entries(matchLabels).every(([key, value]) => labels[key] === value)) return false;
  return (selector.matchExpressions ?? []).every(expression => {
    const present = Object.hasOwn(labels, expression.key);
    const values = expression.values ?? [];
    if (expression.operator === 'In') return present && values.includes(labels[expression.key]);
    if (expression.operator === 'NotIn') return !present || !values.includes(labels[expression.key]);
    if (expression.operator === 'Exists') return present;
    if (expression.operator === 'DoesNotExist') return !present;
    return false;
  });
}

function check(id, passed, detail) {
  return { id, status: passed ? 'passed' : 'failed', detail };
}

function serviceAccountHasClusterBinding(bindings, namespace, name) {
  return (bindings?.items ?? []).some(binding => {
    const builtInIssuerDiscovery = binding.metadata?.name === 'system:service-account-issuer-discovery'
      && binding.roleRef?.kind === 'ClusterRole'
      && binding.roleRef?.name === 'system:service-account-issuer-discovery';
    if (builtInIssuerDiscovery) return false;
    return (binding.subjects ?? []).some(subject => {
    if (subject.kind === 'ServiceAccount') return subject.namespace === namespace && subject.name === name;
    if (subject.kind !== 'Group') return false;
    return subject.name === 'system:serviceaccounts' || subject.name === `system:serviceaccounts:${namespace}`;
    });
  });
}

function ingressRuleAllowsPort(rule, port) {
  if (!Array.isArray(rule.ports) || rule.ports.length === 0) return true;
  return rule.ports.some(entry => Number(entry.port) === Number(port));
}

function trimTrailingSlash(value) {
  return typeof value === 'string' ? value.replace(/\/+$/, '') : value;
}

function containerEnvironment(container) {
  return Object.fromEntries((container?.env ?? []).filter(entry => typeof entry.value === 'string').map(entry => [entry.name, entry.value]));
}

function evaluateAksWorkloadIdentity(spec, snapshot, checks) {
  const cloud = spec.identity.cloud;
  const serviceAccount = snapshot.serviceAccount;
  const deployment = snapshot.deployment;
  const pods = snapshot.pods?.items ?? [];
  const annotations = serviceAccount?.metadata?.annotations ?? {};
  const templateLabels = deployment?.spec?.template?.metadata?.labels ?? {};
  const expectedSubject = `system:serviceaccount:${spec.namespace}:${spec.workload.serviceAccount}`;
  const tokenDirectory = cloud.tokenFile.slice(0, cloud.tokenFile.lastIndexOf('/'));

  checks.push(check(
    'identity.aks.metadata',
    annotations['azure.workload.identity/client-id']?.toLowerCase() === cloud.clientId.toLowerCase()
      && annotations['azure.workload.identity/tenant-id']?.toLowerCase() === cloud.tenantId.toLowerCase()
      && Number(annotations['azure.workload.identity/service-account-token-expiration']) === cloud.tokenExpirationSeconds
      && templateLabels['azure.workload.identity/use'] === 'true',
    'ServiceAccount annotations and fail-close Pod label match the AKS identity contract',
  ));

  const injectedPods = pods.filter(pod => {
    const podContainer = (pod.spec?.containers ?? []).find(item => item.name === spec.workload.container);
    const environment = containerEnvironment(podContainer);
    const tokenVolume = (pod.spec?.volumes ?? []).find(volume => volume.name === 'azure-identity-token');
    const projectedToken = (tokenVolume?.projected?.sources ?? []).find(source => source.serviceAccountToken)?.serviceAccountToken;
    const tokenMount = (podContainer?.volumeMounts ?? []).find(mount => mount.name === 'azure-identity-token');
    return pod.metadata?.labels?.['azure.workload.identity/use'] === 'true'
      && environment.AZURE_CLIENT_ID?.toLowerCase() === cloud.clientId.toLowerCase()
      && environment.AZURE_TENANT_ID?.toLowerCase() === cloud.tenantId.toLowerCase()
      && environment.AZURE_FEDERATED_TOKEN_FILE === cloud.tokenFile
      && typeof environment.AZURE_AUTHORITY_HOST === 'string'
      && projectedToken?.audience === cloud.tokenAudience
      && projectedToken?.expirationSeconds <= cloud.tokenExpirationSeconds
      && tokenMount?.mountPath === tokenDirectory
      && tokenMount?.readOnly === true;
  }).length;
  checks.push(check('identity.aks.webhook-injection', pods.length > 0 && injectedPods === pods.length, `all ${pods.length} connector Pod(s) contain the expected AKS token projection and environment`));

  const staticSecretPresent = pods.some(pod => (pod.spec?.containers ?? []).some(podContainer => (podContainer.env ?? []).some(entry => entry.name === 'AZURE_CLIENT_SECRET')));
  checks.push(check('identity.aks.no-client-secret', !staticSecretPresent, 'no static Azure client secret is configured in the connector Pod'));

  const cluster = snapshot.cloudIdentity?.cluster;
  const issuer = trimTrailingSlash(cluster?.oidcIssuerProfile?.issuerUrl);
  checks.push(check(
    'identity.aks.cluster-federation',
    cluster?.oidcIssuerProfile?.enabled === true
      && typeof issuer === 'string'
      && issuer.startsWith('https://')
      && cluster?.securityProfile?.workloadIdentity?.enabled === true,
    'AKS OIDC issuer and Workload Identity are enabled',
  ));

  const managedIdentity = snapshot.cloudIdentity?.managedIdentity;
  checks.push(check(
    'identity.aks.managed-identity',
    managedIdentity?.clientId?.toLowerCase() === cloud.clientId.toLowerCase()
      && managedIdentity?.tenantId?.toLowerCase() === cloud.tenantId.toLowerCase(),
    'Azure managed identity matches the declared client and tenant',
  ));

  const credential = snapshot.cloudIdentity?.federatedCredential;
  checks.push(check(
    'identity.aks.federated-credential',
    trimTrailingSlash(credential?.issuer) === issuer
      && credential?.subject === expectedSubject
      && Array.isArray(credential?.audiences)
      && credential.audiences.length === 1
      && credential.audiences[0] === cloud.tokenAudience,
    'federated credential binds the exact issuer, ServiceAccount subject and token audience',
  ));
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

function decodeIamPolicy(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return undefined;
  for (const candidate of [value, (() => { try { return decodeURIComponent(value); } catch { return value; } })()]) {
    try { return JSON.parse(candidate); } catch { /* try the next representation */ }
  }
  return undefined;
}

function iamConditionEquals(statement, key, expected) {
  const condition = statement?.Condition?.StringEquals ?? {};
  return asArray(condition[key]).includes(expected);
}

function evaluateEksPodIdentity(spec, snapshot, checks) {
  const cloud = spec.identity.cloud;
  const serviceAccount = snapshot.serviceAccount;
  const pods = snapshot.pods?.items ?? [];
  const tokenDirectory = cloud.tokenFile.slice(0, cloud.tokenFile.lastIndexOf('/'));
  const irsaAnnotation = serviceAccount?.metadata?.annotations?.['eks.amazonaws.com/role-arn'];
  checks.push(check('identity.eks.no-irsa-annotation', !irsaAnnotation, 'ServiceAccount is not ambiguously configured for IRSA'));

  const forbiddenEnvironment = new Set([
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_WEB_IDENTITY_TOKEN_FILE',
    'AWS_ROLE_ARN',
  ]);
  const injectedPods = pods.filter(pod => {
    const podContainer = (pod.spec?.containers ?? []).find(item => item.name === spec.workload.container);
    const environment = containerEnvironment(podContainer);
    const tokenVolume = (pod.spec?.volumes ?? []).find(volume => volume.name === 'eks-pod-identity-token');
    const projectedToken = (tokenVolume?.projected?.sources ?? []).find(source => source.serviceAccountToken)?.serviceAccountToken;
    const tokenMount = (podContainer?.volumeMounts ?? []).find(mount => mount.name === 'eks-pod-identity-token');
    return environment.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE === cloud.tokenFile
      && environment.AWS_CONTAINER_CREDENTIALS_FULL_URI === cloud.credentialEndpoint
      && projectedToken?.audience === cloud.tokenAudience
      && projectedToken?.expirationSeconds === cloud.tokenExpirationSeconds
      && tokenMount?.mountPath === tokenDirectory
      && tokenMount?.readOnly === true;
  }).length;
  checks.push(check('identity.eks.pod-injection', pods.length > 0 && injectedPods === pods.length, `all ${pods.length} connector Pod(s) contain the expected EKS container credential endpoint and token projection`));

  const alternateCredentialsPresent = pods.some(pod => (pod.spec?.containers ?? []).some(podContainer => {
    const hasForbiddenEnv = (podContainer.env ?? []).some(entry => forbiddenEnvironment.has(entry.name));
    const hasSecretEnvFrom = (podContainer.envFrom ?? []).some(entry => Boolean(entry.secretRef));
    return hasForbiddenEnv || hasSecretEnvFrom;
  }));
  checks.push(check('identity.eks.default-credential-chain', !alternateCredentialsPresent, 'no static or IRSA credentials precede Pod Identity in the AWS default credential chain'));

  const cluster = snapshot.cloudIdentity?.cluster;
  checks.push(check(
    'identity.eks.cluster',
    cluster?.name === cloud.aws.clusterName && cluster?.status === 'ACTIVE',
    'declared EKS cluster is active',
  ));

  const addon = snapshot.cloudIdentity?.addon;
  const agent = snapshot.podIdentityAgent;
  checks.push(check(
    'identity.eks.agent',
    addon?.addonName === 'eks-pod-identity-agent'
      && addon?.clusterName === cloud.aws.clusterName
      && addon?.status === 'ACTIVE'
      && (addon?.health?.issues ?? []).length === 0
      && Number(agent?.status?.desiredNumberScheduled ?? 0) > 0
      && agent?.status?.numberReady === agent?.status?.desiredNumberScheduled,
    'EKS Pod Identity Agent add-on is active and ready on every scheduled node',
  ));

  const association = snapshot.cloudIdentity?.association;
  checks.push(check(
    'identity.eks.association',
    association?.clusterName === cloud.aws.clusterName
      && association?.namespace === spec.namespace
      && association?.serviceAccount === spec.workload.serviceAccount
      && association?.roleArn === cloud.roleArn
      && association?.disableSessionTags !== true,
    'Pod Identity association maps the exact cluster, namespace, ServiceAccount and IAM role with session tags enabled',
  ));

  const iamRole = snapshot.cloudIdentity?.iamRole;
  const policy = decodeIamPolicy(iamRole?.AssumeRolePolicyDocument);
  const trustStatement = asArray(policy?.Statement).find(statement => {
    const services = asArray(statement?.Principal?.Service);
    const actions = asArray(statement?.Action);
    return statement?.Effect === 'Allow'
      && services.includes('pods.eks.amazonaws.com')
      && actions.includes('sts:AssumeRole')
      && actions.includes('sts:TagSession');
  });
  const scopedTrust = trustStatement
    && iamConditionEquals(trustStatement, 'aws:RequestTag/eks-cluster-name', cloud.aws.clusterName)
    && iamConditionEquals(trustStatement, 'aws:RequestTag/kubernetes-namespace', spec.namespace)
    && iamConditionEquals(trustStatement, 'aws:RequestTag/kubernetes-service-account', spec.workload.serviceAccount);
  checks.push(check(
    'identity.eks.iam-trust',
    iamRole?.Arn === cloud.roleArn
      && iamRole?.RoleName === cloud.aws.roleName
      && Boolean(scopedTrust),
    'IAM role trust is restricted to the EKS service principal and exact cluster workload tags',
  ));
}

function gkePrincipal(gcp) {
  return `principal://iam.googleapis.com/projects/${gcp.projectNumber}/locations/global/workloadIdentityPools/${gcp.projectId}.svc.id.goog/kubernetes.serviceaccount.uid/${gcp.serviceAccountUid}`;
}

function gcpBindingHasMember(policy, role, member) {
  return (policy?.bindings ?? []).some(binding => binding.role === role && (binding.members ?? []).includes(member));
}

function gkeMetadataEgressAllowed(spec, snapshot) {
  const podLabels = snapshot.deployment?.spec?.template?.metadata?.labels ?? {};
  const egressPolicies = (snapshot.networkPolicies?.items ?? []).filter(policy => {
    const types = policy.spec?.policyTypes ?? [];
    return types.includes('Egress') && selectorMatches(policy.spec?.podSelector ?? {}, podLabels);
  });
  if (egressPolicies.length === 0) return true;
  const dataplaneV2 = snapshot.cloudIdentity?.cluster?.networkConfig?.datapathProvider === 'ADVANCED_DATAPATH';
  const expectedCidr = dataplaneV2 ? '169.254.169.254/32' : '169.254.169.252/32';
  const expectedPort = dataplaneV2 ? 80 : 988;
  return egressPolicies.some(policy => (policy.spec?.egress ?? []).some(rule => {
    const exactDestination = (rule.to ?? []).some(peer => peer.ipBlock?.cidr === expectedCidr && (peer.ipBlock?.except ?? []).length === 0);
    const ports = rule.ports ?? [];
    const portAllowed = ports.length === 0 || ports.some(port => Number(port.port) === expectedPort && (!port.protocol || port.protocol === 'TCP'));
    return exactDestination && portAllowed;
  }));
}

function evaluateGkeWorkloadIdentity(spec, snapshot, checks) {
  const gcp = spec.identity.cloud.gcp;
  const serviceAccount = snapshot.serviceAccount;
  const pods = snapshot.pods?.items ?? [];
  const principal = gkePrincipal(gcp);
  const annotations = serviceAccount?.metadata?.annotations ?? {};
  checks.push(check(
    'identity.gke.direct-principal',
    serviceAccount?.metadata?.uid === gcp.serviceAccountUid && !annotations['iam.gke.io/gcp-service-account'],
    'IAM principal is bound to the immutable Kubernetes ServiceAccount UID without legacy GSA impersonation',
  ));

  const forbiddenEnvironment = new Set([
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GOOGLE_CLOUD_KEYFILE_JSON',
    'GCLOUD_SERVICE_KEY',
  ]);
  const staticCredentialsPresent = pods.some(pod => {
    const podContainer = (pod.spec?.containers ?? []).find(item => item.name === spec.workload.container);
    const hasForbiddenEnv = (podContainer?.env ?? []).some(entry => forbiddenEnvironment.has(entry.name));
    const hasSecretEnvFrom = (podContainer?.envFrom ?? []).some(entry => Boolean(entry.secretRef));
    const mountedNames = new Set((podContainer?.volumeMounts ?? []).map(mount => mount.name));
    const hasMountedSecret = (pod.spec?.volumes ?? []).some(volume => mountedNames.has(volume.name) && Boolean(volume.secret));
    return hasForbiddenEnv || hasSecretEnvFrom || hasMountedSecret;
  });
  checks.push(check('identity.gke.no-static-credentials', !staticCredentialsPresent, 'connector Pods do not mount or inject Google service-account keys'));

  const cloud = snapshot.cloudIdentity;
  const cluster = cloud?.cluster;
  checks.push(check(
    'identity.gke.cluster',
    cloud?.project?.projectId === gcp.projectId
      && String(cloud?.project?.projectNumber) === gcp.projectNumber
      && cluster?.name === gcp.clusterName
      && cluster?.location === gcp.location
      && cluster?.status === 'RUNNING'
      && cluster?.workloadIdentityConfig?.workloadPool === `${gcp.projectId}.svc.id.goog`,
    'declared GKE cluster is running with the project-scoped workload identity pool',
  ));

  const autopilot = cluster?.autopilot?.enabled === true;
  const nodePools = cluster?.nodePools ?? [];
  const nodeSelector = snapshot.deployment?.spec?.template?.spec?.nodeSelector ?? {};
  const metadataServerReady = gcp.clusterMode === 'autopilot'
    ? autopilot && nodeSelector['iam.gke.io/gke-metadata-server-enabled'] === undefined
    : !autopilot
      && nodePools.length > 0
      && nodePools.every(nodePool => nodePool.config?.workloadMetadataConfig?.mode === 'GKE_METADATA')
      && nodeSelector['iam.gke.io/gke-metadata-server-enabled'] === 'true';
  checks.push(check(
    'identity.gke.metadata-server',
    metadataServerReady,
    gcp.clusterMode === 'autopilot'
      ? 'Autopilot provides Workload Identity Federation without a Standard-only node selector'
      : 'all Standard node pools and the connector scheduling constraint use the GKE metadata server',
  ));
  checks.push(check(
    'identity.gke.metadata-egress',
    gkeMetadataEgressAllowed(spec, snapshot),
    'connector egress policy permits the platform-specific GKE metadata server route',
  ));

  const iamPolicy = cloud?.iamPolicy;
  const missingRoles = gcp.requiredRoles.filter(role => !gcpBindingHasMember(iamPolicy, role, principal));
  checks.push(check(
    'identity.gke.iam-roles',
    missingRoles.length === 0,
    missingRoles.length === 0 ? `exact ServiceAccount UID principal has ${gcp.requiredRoles.length} declared IAM role(s)` : `missing IAM roles for exact principal: ${missingRoles.join(', ')}`,
  ));
  const basicRoles = ['roles/owner', 'roles/editor'].filter(role => gcpBindingHasMember(iamPolicy, role, principal));
  checks.push(check(
    'identity.gke.no-basic-roles',
    basicRoles.length === 0,
    basicRoles.length === 0 ? 'exact connector principal has no Owner or Editor basic role' : `over-privileged IAM roles found: ${basicRoles.join(', ')}`,
  ));
}

function clusterCondition(clusterVersion, type) {
  return (clusterVersion?.status?.conditions ?? []).find(condition => condition.type === type)?.status;
}

function evaluateOpenShiftServiceAccount(spec, snapshot, checks) {
  const openshift = spec.identity.cloud.openshift;
  const evidence = snapshot.cloudIdentity;
  const pods = snapshot.pods?.items ?? [];
  const serviceAccountAnnotations = snapshot.serviceAccount?.metadata?.annotations ?? {};
  const hasOAuthAnnotation = Object.keys(serviceAccountAnnotations).some(key => key.startsWith('serviceaccounts.openshift.io/oauth-'));
  checks.push(check(
    'identity.openshift.no-oauth-client',
    !hasOAuthAnnotation,
    'connector ServiceAccount has no OAuth redirect or challenge annotations',
  ));

  const admittedSccs = pods.map(pod => pod.metadata?.annotations?.['openshift.io/scc']);
  checks.push(check(
    'identity.openshift.restricted-scc',
    pods.length > 0 && admittedSccs.every(scc => openshift.allowedSccs.includes(scc)),
    `all ${pods.length} connector Pod(s) are admitted by the declared restricted SCC set`,
  ));
  const grantedForbiddenSccs = openshift.forbiddenSccs.filter(scc => evidence?.sccPermissions?.[scc] !== false);
  checks.push(check(
    'identity.openshift.no-dangerous-scc',
    grantedForbiddenSccs.length === 0,
    grantedForbiddenSccs.length === 0 ? 'connector ServiceAccount cannot use dangerous default SCCs' : `dangerous or unverified SCC permissions: ${grantedForbiddenSccs.join(', ')}`,
  ));
  const namespaceLabels = evidence?.namespace?.metadata?.labels ?? {};
  checks.push(check(
    'identity.openshift.namespace-safety',
    namespaceLabels['openshift.io/run-level'] === undefined
      && namespaceLabels['pod-security.kubernetes.io/enforce'] !== 'privileged',
    'connector namespace has no OpenShift run-level bypass or privileged Pod Security enforcement',
  ));

  const clusterVersion = evidence?.clusterVersion;
  const generationCurrent = clusterVersion?.metadata?.generation === clusterVersion?.status?.observedGeneration;
  checks.push(check(
    'identity.openshift.cluster-version',
    clusterVersion?.metadata?.name === openshift.clusterVersionName
      && generationCurrent
      && versionAtLeast(clusterVersion?.status?.desired?.version, openshift.minimumVersion)
      && clusterCondition(clusterVersion, 'Available') === 'True'
      && clusterCondition(clusterVersion, 'Progressing') === 'False'
      && clusterCondition(clusterVersion, 'Degraded') !== 'True'
      && clusterCondition(clusterVersion, 'Failing') !== 'True',
    `OpenShift ${openshift.minimumVersion}+ cluster version is current, available and stable`,
  ));

  const certificate = openshift.servingCertificate;
  const serviceAnnotations = snapshot.service?.metadata?.annotations ?? {};
  const secret = evidence?.servingCertSecret;
  checks.push(check(
    'identity.openshift.service-ca',
    serviceAnnotations['service.beta.openshift.io/serving-cert-secret-name'] === certificate.secretName
      && String(serviceAnnotations['service.beta.openshift.io/serving-cert-signed-by'] ?? '').startsWith('openshift-service-serving-signer@')
      && secret?.type === 'kubernetes.io/tls'
      && typeof secret?.data?.['tls.crt'] === 'string'
      && secret.data['tls.crt'].length > 0
      && typeof secret?.data?.['tls.key'] === 'string'
      && secret.data['tls.key'].length > 0,
    'OpenShift service-ca issued a rotating TLS serving certificate for the internal Service',
  ));

  const securelyMountedPods = pods.filter(pod => {
    const tlsContainer = (pod.spec?.containers ?? []).find(container => container.name === certificate.tlsContainer);
    const toolContainer = (pod.spec?.containers ?? []).find(container => container.name === spec.workload.container);
    const secretVolume = (pod.spec?.volumes ?? []).find(volume => volume.secret?.secretName === certificate.secretName);
    if (!secretVolume) return false;
    const tlsMount = (tlsContainer?.volumeMounts ?? []).find(mount => mount.name === secretVolume.name);
    const toolMount = (toolContainer?.volumeMounts ?? []).find(mount => mount.name === secretVolume.name);
    const tlsSecurity = tlsContainer?.securityContext ?? {};
    return tlsContainer?.image === certificate.tlsImage
      && tlsMount?.mountPath === certificate.mountPath
      && tlsMount?.readOnly === true
      && !toolMount
      && tlsSecurity.runAsNonRoot === true
      && tlsSecurity.allowPrivilegeEscalation === false
      && tlsSecurity.privileged !== true
      && tlsSecurity.readOnlyRootFilesystem === true
      && (tlsSecurity.capabilities?.drop ?? []).includes('ALL');
  }).length;
  const tlsServicePort = (snapshot.service?.spec?.ports ?? []).some(port => Number(port.port) === spec.endpoint.port && Number(port.targetPort) === certificate.targetPort);
  checks.push(check(
    'identity.openshift.tls-boundary',
    pods.length > 0 && securelyMountedPods === pods.length && tlsServicePort,
    'only the TLS proxy mounts the service certificate and the Service targets its declared port',
  ));

  const exposedRoutes = (evidence?.routes?.items ?? []).filter(route => {
    if (route.spec?.to?.kind === 'Service' && route.spec?.to?.name === spec.workload.service) return true;
    return (route.spec?.alternateBackends ?? []).some(backend => backend.kind === 'Service' && backend.name === spec.workload.service);
  });
  checks.push(check(
    'identity.openshift.internal-only',
    exposedRoutes.length === 0,
    'connector Service is not exposed through an OpenShift Route',
  ));
}

export function evaluateConnectorSnapshot(contract, snapshot) {
  const spec = contract.spec;
  const deployment = snapshot.deployment;
  const service = snapshot.service;
  const serviceAccount = snapshot.serviceAccount;
  const pods = snapshot.pods?.items ?? [];
  const podSpec = deployment?.spec?.template?.spec ?? {};
  const podLabels = deployment?.spec?.template?.metadata?.labels ?? {};
  const container = (podSpec.containers ?? []).find(item => item.name === spec.workload.container);
  const security = container?.securityContext ?? {};
  const args = container?.args ?? [];
  const checks = [];

  checks.push(check('deployment.available', Number(deployment?.status?.availableReplicas ?? 0) >= 1, 'at least one connector replica is available'));
  checks.push(check('workload.service-account', podSpec.serviceAccountName === spec.workload.serviceAccount && spec.workload.serviceAccount !== 'default', `deployment uses dedicated ServiceAccount ${spec.workload.serviceAccount}`));
  checks.push(check('workload.read-only-tools', args.includes('--read-only') && args.includes('--tools=k8s'), 'only the Kubernetes provider is registered and mutation tools are disabled'));
  checks.push(check('workload.host-isolation', podSpec.hostNetwork !== true && podSpec.hostPID !== true && podSpec.hostIPC !== true, 'host network, PID and IPC namespaces are disabled'));
  if (spec.security.requireNonRoot) checks.push(check('pod-security.non-root', security.runAsNonRoot === true, 'container requires a non-root user'));
  checks.push(check('pod-security.no-privilege-escalation', security.allowPrivilegeEscalation === false && security.privileged !== true, 'privilege escalation and privileged mode are disabled'));
  if (spec.security.requireReadOnlyRootFilesystem) checks.push(check('pod-security.read-only-root', security.readOnlyRootFilesystem === true, 'root filesystem is read-only'));
  if (spec.security.requireDropAllCapabilities) checks.push(check('pod-security.drop-capabilities', (security.capabilities?.drop ?? []).includes('ALL'), 'all Linux capabilities are dropped'));
  if (spec.security.requireSeccompRuntimeDefault) checks.push(check('pod-security.seccomp', podSpec.securityContext?.seccompProfile?.type === 'RuntimeDefault', 'RuntimeDefault seccomp profile is active'));
  if (spec.security.requireReadinessProbe) checks.push(check('pod-security.readiness-probe', Boolean(container?.readinessProbe), 'connector exposes a readiness probe'));

  checks.push(check('endpoint.cluster-ip', service?.spec?.type === spec.endpoint.serviceType && service?.spec?.type === 'ClusterIP', 'connector is not exposed through NodePort or LoadBalancer'));
  const serviceSelector = service?.spec?.selector ?? {};
  checks.push(check('endpoint.selector', Object.keys(serviceSelector).length > 0 && pods.some(pod => selectorMatches({ matchLabels: serviceSelector }, pod.metadata?.labels ?? {})), 'Service selector resolves to a connector Pod'));
  const readyEndpointCount = (snapshot.endpointSlices?.items ?? []).flatMap(slice => slice.endpoints ?? []).filter(endpoint => endpoint.conditions?.ready === true).length;
  checks.push(check('endpoint.ready', readyEndpointCount > 0, `${readyEndpointCount} ready endpoint(s) published`));

  const matchingPolicies = (snapshot.networkPolicies?.items ?? []).filter(policy => {
    const types = policy.spec?.policyTypes ?? [];
    return types.includes('Ingress') && selectorMatches(policy.spec?.podSelector ?? {}, podLabels);
  });
  checks.push(check('network-policy.selects-workload', matchingPolicies.length > 0, `${matchingPolicies.length} ingress policy/policies select the connector Pod`));
  if (spec.security.requireRestrictedIngress) {
    const relevantRules = matchingPolicies.flatMap(policy => policy.spec?.ingress ?? []).filter(rule => ingressRuleAllowsPort(rule, spec.endpoint.port));
    const hasRestrictedRule = relevantRules.some(rule => Array.isArray(rule.from) && rule.from.length > 0);
    const hasUnrestrictedRule = relevantRules.some(rule => !Array.isArray(rule.from) || rule.from.length === 0);
    checks.push(check('network-policy.restricted-ingress', hasRestrictedRule && !hasUnrestrictedRule, 'MCP ingress requires an explicit source selector'));
  }
  if (spec.security.requireNetworkPolicyEnforcement) {
    const probe = snapshot.networkPolicyProbe;
    checks.push(check(
      'network-policy.enforced',
      probe?.allowed === true && probe?.denied === true,
      probe?.allowed === true
        ? (probe?.denied === true ? 'labelled client reached the MCP health endpoint and an unlabelled Pod was blocked' : 'unlabelled Pod still reached the MCP health endpoint')
        : 'labelled connector client could not reach the MCP health endpoint',
    ));
  }

  const maxTokenLifetime = spec.identity.kubernetes.maxTokenLifetimeSeconds;
  const podsWithSafeToken = pods.filter(pod => (pod.spec?.volumes ?? []).some(volume => (volume.projected?.sources ?? []).some(source => {
    const expiration = source.serviceAccountToken?.expirationSeconds;
    return Number.isFinite(expiration) && expiration <= maxTokenLifetime;
  }))).length;
  checks.push(check('identity.projected-token', pods.length > 0 && podsWithSafeToken === pods.length, `all ${pods.length} connector Pod(s) use bounded projected ServiceAccount tokens`));
  if (spec.security.forbidLegacyServiceAccountToken) {
    const legacyTokens = (snapshot.legacyTokenSecrets?.items ?? []).filter(secret => secret.type === 'kubernetes.io/service-account-token' && secret.metadata?.annotations?.['kubernetes.io/service-account.name'] === spec.workload.serviceAccount);
    checks.push(check('identity.no-legacy-token', legacyTokens.length === 0 && (serviceAccount?.secrets ?? []).length === 0, 'no long-lived ServiceAccount token Secret is attached'));
  }
  if (spec.security.forbidClusterRoleBinding) {
    checks.push(check('rbac.no-cluster-binding', !serviceAccountHasClusterBinding(snapshot.clusterRoleBindings, spec.namespace, spec.workload.serviceAccount), 'ServiceAccount has no direct or namespace-wide ClusterRoleBinding'));
  }
  if (spec.identity.cloud.mode === 'aks-workload-identity') evaluateAksWorkloadIdentity(spec, snapshot, checks);
  if (spec.identity.cloud.mode === 'eks-pod-identity') evaluateEksPodIdentity(spec, snapshot, checks);
  if (spec.identity.cloud.mode === 'gke-workload-identity') evaluateGkeWorkloadIdentity(spec, snapshot, checks);
  if (spec.identity.cloud.mode === 'openshift-service-account') evaluateOpenShiftServiceAccount(spec, snapshot, checks);

  for (const assertion of spec.permissionAssertions) {
    const key = `${assertion.verb}:${assertion.resource}:${assertion.namespace}`;
    const actual = snapshot.permissions?.[key];
    checks.push(check(`rbac.${key}`, actual === assertion.allowed, `${assertion.allowed ? 'allow' : 'deny'} ${assertion.verb} ${assertion.resource} in ${assertion.namespace}`));
  }

  if (spec.workload.expectedImageDigest) {
    const digestMatches = pods.length > 0 && pods.every(pod => (pod.status?.containerStatuses ?? []).some(status => status.name === spec.workload.container && status.imageID?.includes(spec.workload.expectedImageDigest)));
    checks.push(check('supply-chain.image-digest', digestMatches, `running image resolves to ${spec.workload.expectedImageDigest}`));
  }
  if (spec.profile === 'production') checks.push(check('transport.tls', spec.endpoint.scheme === 'https', 'production MCP endpoint uses TLS'));

  return {
    apiVersion: 'certification.argus.eu/v1alpha1',
    kind: 'KubernetesConnectorCertificationReport',
    targetId: contract.metadata.targetId,
    platform: spec.platform,
    profile: spec.profile,
    overall: checks.every(item => item.status === 'passed') ? 'passed' : 'failed',
    checks,
  };
}

function resolveKubectl() {
  if (process.env.KUBECTL_BIN) return process.env.KUBECTL_BIN;
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const winget = resolve(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'kubectl.exe');
    if (existsSync(winget)) return winget;
  }
  return 'kubectl';
}

function resolveAzureCli() {
  if (process.env.AZ_BIN) return process.env.AZ_BIN;
  return process.platform === 'win32' ? 'az.cmd' : 'az';
}

function resolveAwsCli() {
  if (process.env.AWS_BIN) return process.env.AWS_BIN;
  return process.platform === 'win32' ? 'aws.exe' : 'aws';
}

function resolveGcloudCli() {
  if (process.env.GCLOUD_BIN) return process.env.GCLOUD_BIN;
  return process.platform === 'win32' ? 'gcloud.cmd' : 'gcloud';
}

export function kubectlContextArgs(context) {
  return context === 'in-cluster' ? [] : ['--context', context];
}

export function buildInClusterKubeconfig({ host, port, caPath, token }) {
  const normalizedHost = String(host ?? '').trim();
  const normalizedPort = Number.parseInt(String(port ?? ''), 10);
  const normalizedToken = String(token ?? '').trim();
  if (!normalizedHost || /[\s/]/.test(normalizedHost)) throw new Error('Kubernetes Service host is invalid');
  if (!Number.isInteger(normalizedPort) || normalizedPort < 1 || normalizedPort > 65_535) {
    throw new Error('Kubernetes Service port is invalid');
  }
  if (!caPath || !existsSync(caPath)) throw new Error('Kubernetes Service CA file is unavailable');
  if (!normalizedToken || normalizedToken.length > 16_384 || /\s/.test(normalizedToken)) {
    throw new Error('Kubernetes ServiceAccount token is invalid');
  }
  const serverHost = normalizedHost.includes(':') && !normalizedHost.startsWith('[')
    ? `[${normalizedHost}]`
    : normalizedHost;
  return {
    apiVersion: 'v1',
    kind: 'Config',
    clusters: [{
      name: 'argus-in-cluster',
      cluster: {
        server: `https://${serverHost}:${normalizedPort}`,
        'certificate-authority': caPath,
      },
    }],
    users: [{ name: 'argus-certifier', user: { token: normalizedToken } }],
    contexts: [{
      name: 'argus-in-cluster',
      context: { cluster: 'argus-in-cluster', user: 'argus-certifier' },
    }],
    'current-context': 'argus-in-cluster',
  };
}

async function configureInClusterKubectl(reportPath) {
  const tokenPath = '/var/run/secrets/kubernetes.io/serviceaccount/token';
  const caPath = '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt';
  const kubeconfig = buildInClusterKubeconfig({
    host: process.env.KUBERNETES_SERVICE_HOST,
    port: process.env.KUBERNETES_SERVICE_PORT_HTTPS ?? process.env.KUBERNETES_SERVICE_PORT,
    caPath,
    token: await readFile(tokenPath, 'utf8'),
  });
  const kubeconfigPath = resolve(dirname(reportPath), `.argus-kubeconfig-${process.pid}-${Date.now()}.json`);
  await mkdir(dirname(kubeconfigPath), { recursive: true });
  await writeFile(kubeconfigPath, `${JSON.stringify(kubeconfig)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  const previousKubeconfig = process.env.KUBECONFIG;
  process.env.KUBECONFIG = kubeconfigPath;
  return async () => {
    if (previousKubeconfig === undefined) delete process.env.KUBECONFIG;
    else process.env.KUBECONFIG = previousKubeconfig;
    await rm(kubeconfigPath, { force: true });
  };
}

function runKubectl(kubectl, context, args, { json = false, allowedStatuses = [0] } = {}) {
  const result = spawnSync(kubectl, [...kubectlContextArgs(context), ...args], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (!allowedStatuses.includes(result.status)) throw new Error(`kubectl ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`);
  return json ? JSON.parse(result.stdout) : result.stdout.trim();
}

function runJsonCommand(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', windowsHide: true });
  if (result.error) throw new Error(`${command} is required for this connector contract: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`);
  return JSON.parse(result.stdout);
}

function collectAksCloudIdentity(spec) {
  const cloud = spec.identity.cloud;
  const azure = cloud.azure;
  const az = resolveAzureCli();
  const subscription = azure.subscriptionId ? ['--subscription', azure.subscriptionId] : [];
  return {
    cluster: runJsonCommand(az, ['aks', 'show', '--resource-group', azure.clusterResourceGroup, '--name', azure.clusterName, ...subscription, '--only-show-errors', '--output', 'json']),
    managedIdentity: runJsonCommand(az, ['identity', 'show', '--resource-group', azure.identityResourceGroup, '--name', azure.managedIdentityName, ...subscription, '--only-show-errors', '--output', 'json']),
    federatedCredential: runJsonCommand(az, ['identity', 'federated-credential', 'show', '--resource-group', azure.identityResourceGroup, '--identity-name', azure.managedIdentityName, '--name', azure.federatedCredentialName, ...subscription, '--only-show-errors', '--output', 'json']),
  };
}

function collectEksCloudIdentity(spec) {
  const cloud = spec.identity.cloud;
  const awsConfig = cloud.aws;
  const aws = resolveAwsCli();
  const global = ['--region', awsConfig.region, '--no-cli-pager', '--output', 'json'];
  if (awsConfig.profile) global.unshift('--profile', awsConfig.profile);
  const associations = runJsonCommand(aws, [
    'eks', 'list-pod-identity-associations',
    '--cluster-name', awsConfig.clusterName,
    '--namespace', spec.namespace,
    '--service-account', spec.workload.serviceAccount,
    ...global,
  ]).associations ?? [];
  if (associations.length !== 1) throw new Error(`Expected exactly one EKS Pod Identity association, found ${associations.length}.`);
  const associationId = associations[0].associationId;
  return {
    cluster: runJsonCommand(aws, ['eks', 'describe-cluster', '--name', awsConfig.clusterName, ...global]).cluster,
    addon: runJsonCommand(aws, ['eks', 'describe-addon', '--cluster-name', awsConfig.clusterName, '--addon-name', 'eks-pod-identity-agent', ...global]).addon,
    association: runJsonCommand(aws, ['eks', 'describe-pod-identity-association', '--cluster-name', awsConfig.clusterName, '--association-id', associationId, ...global]).association,
    iamRole: runJsonCommand(aws, ['iam', 'get-role', '--role-name', awsConfig.roleName, ...global]).Role,
  };
}

function collectGkeCloudIdentity(spec) {
  const gcp = spec.identity.cloud.gcp;
  const gcloud = resolveGcloudCli();
  const configuration = gcp.configuration ? ['--configuration', gcp.configuration] : [];
  const common = [...configuration, '--project', gcp.projectId, '--quiet', '--format=json'];
  return {
    project: runJsonCommand(gcloud, ['projects', 'describe', gcp.projectId, ...common]),
    cluster: runJsonCommand(gcloud, ['container', 'clusters', 'describe', gcp.clusterName, '--location', gcp.location, ...common]),
    iamPolicy: runJsonCommand(gcloud, ['projects', 'get-iam-policy', gcp.projectId, ...common]),
  };
}

function collectOpenShiftIdentity(spec, kubectl, context) {
  const openshift = spec.identity.cloud.openshift;
  const json = args => runKubectl(kubectl, context, args, { json: true });
  const identity = `system:serviceaccount:${spec.namespace}:${spec.workload.serviceAccount}`;
  const sccPermissions = {};
  for (const scc of openshift.forbiddenSccs) {
    const result = runKubectl(kubectl, context, [
      'auth', 'can-i', 'use', `securitycontextconstraints.security.openshift.io/${scc}`, `--as=${identity}`,
    ], { allowedStatuses: [0, 1] });
    sccPermissions[scc] = result.toLowerCase() === 'yes';
  }
  return {
    clusterVersion: json(['get', 'clusterversion.config.openshift.io', openshift.clusterVersionName, '-o', 'json']),
    namespace: json(['get', 'namespace', spec.namespace, '-o', 'json']),
    servingCertSecret: json(['-n', spec.namespace, 'get', 'secret', openshift.servingCertificate.secretName, '-o', 'json']),
    routes: json(['-n', spec.namespace, 'get', 'routes.route.openshift.io', '-o', 'json']),
    sccPermissions,
  };
}

function collectCloudIdentity(spec, kubectl, context) {
  if (spec.identity.cloud.mode === 'aks-workload-identity') return collectAksCloudIdentity(spec);
  if (spec.identity.cloud.mode === 'eks-pod-identity') return collectEksCloudIdentity(spec);
  if (spec.identity.cloud.mode === 'gke-workload-identity') return collectGkeCloudIdentity(spec);
  if (spec.identity.cloud.mode === 'openshift-service-account') return collectOpenShiftIdentity(spec, kubectl, context);
  return undefined;
}

function runNetworkPolicyProbe(kubectl, spec, context) {
  const probe = spec.security.networkPolicyProbe;
  const suffix = `${process.pid}-${Date.now()}`;
  const allowedName = `argus-connector-allowed-${suffix}`;
  const deniedName = `argus-connector-denied-${suffix}`;
  const endpoint = `${spec.endpoint.scheme}://${spec.endpoint.host}:${spec.endpoint.port}${probe.healthPath}`;
  const execute = (name, labelled) => {
    const args = [
      ...kubectlContextArgs(context),
      'run', name,
      '-n', spec.namespace,
      `--image=${probe.image}`,
      '--restart=Never',
      '--rm', '-i',
    ];
    if (labelled) args.push('--labels=argus.eu/kubernetes-connector-client=true');
    args.push('--command', '--');
    if (probe.stabilizationSeconds > 0) {
      args.push('sh', '-c', 'sleep "$1"; shift; exec "$@"', 'argus-probe', String(probe.stabilizationSeconds));
    }
    args.push('wget', '-qO-', '-T', String(probe.timeoutSeconds));
    if (probe.caFile) args.push('--ca-certificate', probe.caFile);
    args.push(endpoint);
    return spawnSync(kubectl, args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  };
  const cleanup = name => spawnSync(kubectl, [
    ...kubectlContextArgs(context), 'delete', 'pod', name, '-n', spec.namespace,
    '--ignore-not-found=true', '--wait=false',
  ], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  try {
    const allowed = execute(allowedName, true);
    if (allowed.status !== 0) return { allowed: false, denied: false };
    const denied = execute(deniedName, false);
    return { allowed: true, denied: denied.status !== 0 };
  } finally {
    cleanup(allowedName);
    cleanup(deniedName);
  }
}

function selectorArgument(selector) {
  return Object.entries(selector).map(([key, value]) => `${key}=${value}`).join(',');
}

function collectSnapshot(contract, context = contract.spec.context) {
  const kubectl = resolveKubectl();
  const spec = contract.spec;
  const base = ['-n', spec.namespace];
  const json = args => runKubectl(kubectl, context, args, { json: true });
  const permissions = {};
  const identity = `system:serviceaccount:${spec.namespace}:${spec.workload.serviceAccount}`;
  for (const assertion of spec.permissionAssertions) {
    const key = `${assertion.verb}:${assertion.resource}:${assertion.namespace}`;
    const result = runKubectl(kubectl, context, ['auth', 'can-i', assertion.verb, assertion.resource, '--namespace', assertion.namespace, `--as=${identity}`], { allowedStatuses: [0, 1] });
    permissions[key] = result.toLowerCase() === 'yes';
  }
  return {
    deployment: json([...base, 'get', 'deployment', spec.workload.deployment, '-o', 'json']),
    service: json([...base, 'get', 'service', spec.workload.service, '-o', 'json']),
    serviceAccount: json([...base, 'get', 'serviceaccount', spec.workload.serviceAccount, '-o', 'json']),
    pods: json([...base, 'get', 'pods', '-l', selectorArgument(spec.workload.selector), '-o', 'json']),
    endpointSlices: json([...base, 'get', 'endpointslice', '-l', `kubernetes.io/service-name=${spec.workload.service}`, '-o', 'json']),
    networkPolicies: json([...base, 'get', 'networkpolicy', '-o', 'json']),
    clusterRoleBindings: json(['get', 'clusterrolebinding', '-o', 'json']),
    // ServiceAccount token Secrets are namespace-bound. Restricting this read
    // avoids granting an automated certifier access to Secrets cluster-wide.
    legacyTokenSecrets: json([...base, 'get', 'secret', '-o', 'json']),
    podIdentityAgent: spec.identity.cloud.mode === 'eks-pod-identity'
      ? json(['-n', 'kube-system', 'get', 'daemonset', 'eks-pod-identity-agent', '-o', 'json'])
      : undefined,
    networkPolicyProbe: spec.security.requireNetworkPolicyEnforcement
      ? runNetworkPolicyProbe(kubectl, spec, context)
      : undefined,
    cloudIdentity: collectCloudIdentity(spec, kubectl, context),
    permissions,
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--contract') options.contract = argv[++index];
    else if (argv[index] === '--report') options.report = argv[++index];
    else if (argv[index] === '--in-cluster') options.inCluster = true;
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!options.contract) throw new Error('--contract is required');
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const contractPath = isAbsolute(options.contract) ? options.contract : resolve(root, options.contract);
  const reportPath = options.report
    ? (isAbsolute(options.report) ? options.report : resolve(root, options.report))
    : resolve(root, 'test-results/kubernetes-connector-certification.json');
  const cleanupInClusterKubectl = options.inCluster
    ? await configureInClusterKubectl(reportPath)
    : null;
  try {
    const contractSource = await readFile(contractPath, 'utf8');
    const contract = JSON.parse(contractSource);
    const validationErrors = validateConnectorContract(contract);
    if (validationErrors.length > 0) throw new Error(`Invalid connector contract:\n- ${validationErrors.join('\n- ')}`);
    const report = {
      ...evaluateConnectorSnapshot(contract, collectSnapshot(contract, options.inCluster ? 'in-cluster' : contract.spec.context)),
      generatedAt: new Date().toISOString(),
      contract: options.contract,
      contractSha256: createHash('sha256').update(contractSource).digest('hex'),
    };
    const output = `${JSON.stringify(report, null, 2)}\n`;
    process.stdout.write(output);
    if (options.report) {
      await mkdir(dirname(reportPath), { recursive: true });
      await writeFile(reportPath, output, 'utf8');
    }
    if (report.overall !== 'passed') process.exitCode = 2;
  } finally {
    if (cleanupInClusterKubectl) await cleanupInClusterKubectl();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
