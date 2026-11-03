import { load as loadYaml } from 'js-yaml';
import { z } from 'zod';

const identifier = z.string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/, 'must be a stable lowercase identifier');

const semver = z.string()
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/, 'must be a semantic version');

const coreVersionRange = z.string()
  .min(1)
  .max(128)
  .regex(/^(?:>=)?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'must be an exact or minimum semantic version');

const relativeServicePath = z.string()
  .min(1)
  .max(256)
  .refine(value => value.startsWith('/'), 'must start with /')
  .refine(value => !value.startsWith('//'), 'must not be protocol-relative')
  .refine(value => !value.includes('://'), 'must be relative to the configured pack endpoint')
  .refine(value => !value.split('/').some(segment => segment === '.' || segment === '..'), 'must not contain path traversal')
  // Runtime/agent paths are appended to an already allow-listed Pack endpoint.
  // Keep them strictly as paths: query/fragment values, backslashes and encoded
  // separators/dot segments make URL normalization depend on the HTTP client.
  .refine(value => !/[?#\\]/.test(value), 'must not contain a query, fragment or backslash')
  .refine(value => !/%(?:2e|2f|5c)/i.test(value), 'must not contain encoded traversal or separators');

const stringList = z.array(identifier).max(256);

const credentialRequirementSchema = z.object({
  id: identifier,
  accepts: z.array(identifier).min(1).max(32),
  optional: z.boolean().default(false),
}).strict();

const packAgentSchema = z.object({
  id: identifier,
  runtime: identifier,
  skills: stringList.default([]),
  bundles: stringList.default([]),
  credentials: stringList.default([]),
  coreAgents: stringList.default([]),
  a2aAgentCardPath: relativeServicePath.optional(),
}).strict().superRefine((agent, ctx) => {
  if (agent.runtime === 'a2a' && !agent.a2aAgentCardPath) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['a2aAgentCardPath'],
      message: 'is required when runtime is a2a',
    });
  }
  if (agent.runtime !== 'a2a' && agent.a2aAgentCardPath) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['a2aAgentCardPath'],
      message: 'is only allowed when runtime is a2a',
    });
  }
});

/**
 * A runtime adapter is a Pack-owned bridge to an agent execution environment.
 *
 * It is deliberately distinct from an MCP bundle: bundles describe the tools an
 * agent may use, whereas an adapter describes where the agent's execution loop
 * runs. Core validates and inventories the declaration but never executes code
 * from the manifest itself.
 */
const runtimeAdapterSchema = z.object({
  id: identifier,
  runtime: identifier,
  protocol: z.literal('argus-runtime-v1alpha1'),
  endpoint: relativeServicePath,
  modes: z.array(z.enum(['attached', 'managed'])).min(1).max(8),
  capabilities: stringList.default([]),
}).strict().superRefine((adapter, ctx) => {
  const modes = new Set<string>();
  adapter.modes.forEach((mode, index) => {
    if (modes.has(mode)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['modes', index],
        message: `contains duplicate mode '${mode}'`,
      });
    }
    modes.add(mode);
  });

  const capabilities = new Set<string>();
  adapter.capabilities.forEach((capability, index) => {
    if (capabilities.has(capability)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['capabilities', index],
        message: `contains duplicate capability '${capability}'`,
      });
    }
    capabilities.add(capability);
  });
});

export const solutionPackManifestSchema = z.object({
  apiVersion: z.literal('argus.eu/v1alpha1'),
  kind: z.literal('SolutionPack'),
  metadata: z.object({
    id: identifier,
    version: semver,
    displayName: z.string().trim().min(1).max(120),
    description: z.string().trim().max(1_000).optional(),
  }).strict(),
  spec: z.object({
    delivery: z.object({
      type: z.literal('container'),
      protocol: z.literal('argus-pack-v1alpha1'),
      healthPath: relativeServicePath.default('/healthz'),
      readinessPath: relativeServicePath.default('/readyz'),
    }).strict(),
    requires: z.object({
      core: coreVersionRange,
      capabilities: stringList.default([]),
      credentials: z.array(credentialRequirementSchema).max(64).default([]),
    }).strict(),
    components: z.object({
      agents: z.array(packAgentSchema).max(128).default([]),
      runtimeAdapters: z.array(runtimeAdapterSchema).max(64).default([]),
      skills: stringList.default([]),
      bundles: stringList.default([]),
      workflows: stringList.default([]),
      knowledgeSources: stringList.default([]),
      dashboards: stringList.default([]),
      policies: stringList.default([]),
    }).strict(),
    readiness: z.object({
      smokeTests: stringList.min(1).max(128),
    }).strict(),
  }).strict(),
}).strict().superRefine((manifest, ctx) => {
  const duplicateChecks: Array<[string, string[]]> = [
    ['spec.requires.capabilities', manifest.spec.requires.capabilities],
    ['spec.requires.credentials', manifest.spec.requires.credentials.map(item => item.id)],
    ['spec.components.agents', manifest.spec.components.agents.map(item => item.id)],
    ['spec.components.runtimeAdapters', manifest.spec.components.runtimeAdapters.map(adapter => adapter.id)],
    ['spec.components.skills', manifest.spec.components.skills],
    ['spec.components.bundles', manifest.spec.components.bundles],
    ['spec.components.workflows', manifest.spec.components.workflows],
    ['spec.components.knowledgeSources', manifest.spec.components.knowledgeSources],
    ['spec.components.dashboards', manifest.spec.components.dashboards],
    ['spec.components.policies', manifest.spec.components.policies],
    ['spec.readiness.smokeTests', manifest.spec.readiness.smokeTests],
  ];

  for (const [path, values] of duplicateChecks) {
    const seen = new Set<string>();
    for (const value of values) {
      if (seen.has(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: path.split('.'),
          message: `contains duplicate identifier '${value}'`,
        });
      }
      seen.add(value);
    }
  }

  const declaredSkills = new Set(manifest.spec.components.skills);
  const declaredBundles = new Set(manifest.spec.components.bundles);
  const declaredCredentials = new Set(manifest.spec.requires.credentials.map(item => item.id));

  manifest.spec.components.agents.forEach((agent, index) => {
    for (const skill of agent.skills) {
      if (!declaredSkills.has(skill)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['spec', 'components', 'agents', index, 'skills'],
          message: `references undeclared skill '${skill}'`,
        });
      }
    }
    for (const bundle of agent.bundles) {
      if (!declaredBundles.has(bundle)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['spec', 'components', 'agents', index, 'bundles'],
          message: `references undeclared bundle '${bundle}'`,
        });
      }
    }
    for (const credential of agent.credentials) {
      if (!declaredCredentials.has(credential)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['spec', 'components', 'agents', index, 'credentials'],
          message: `references undeclared credential requirement '${credential}'`,
        });
      }
    }
  });
});

export type SolutionPackManifest = z.infer<typeof solutionPackManifestSchema>;

export class SolutionPackManifestError extends Error {
  constructor(readonly issues: z.ZodIssue[]) {
    super(issues.map(issue => `${issue.path.join('.') || 'manifest'}: ${issue.message}`).join('; '));
    this.name = 'SolutionPackManifestError';
  }
}

export function validateSolutionPackManifest(input: unknown): SolutionPackManifest {
  const result = solutionPackManifestSchema.safeParse(input);
  if (!result.success) throw new SolutionPackManifestError(result.error.issues);
  return result.data;
}

export function parseSolutionPackManifestDocument(document: string): SolutionPackManifest {
  if (Buffer.byteLength(document, 'utf8') > 512 * 1024) {
    throw new SolutionPackManifestError([{
      code: z.ZodIssueCode.custom,
      path: [],
      message: 'document exceeds the 512 KiB limit',
    }]);
  }

  let parsed: unknown;
  try {
    parsed = loadYaml(document, { json: true });
  } catch (cause) {
    throw new SolutionPackManifestError([{
      code: z.ZodIssueCode.custom,
      path: [],
      message: `is not valid YAML or JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    }]);
  }
  return validateSolutionPackManifest(parsed);
}
