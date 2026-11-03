import { destructiveCmdGuard } from '../../builtin/destructiveCmd.js';
import type { HookContext } from '../../types.js';

const ctxFor = (toolName: string, args: Record<string, unknown>): HookContext => ({
  agentId: 1, agentName: 'coder', sessionId: 's',
  toolName, toolArgs: args, iteration: 1, agentDepth: 0,
});

describe('destructiveCmdGuard', () => {
  it('blocks rm -rf /', async () => {
    const r = await destructiveCmdGuard.preToolUse!(ctxFor('workspace_exec', { cmd: 'rm -rf /' }));
    expect(r).toHaveProperty('block');
    expect((r as {block:string}).block.toLowerCase()).toContain('destructive');
  });

  it('blocks rm -rf with --no-preserve-root', async () => {
    const r = await destructiveCmdGuard.preToolUse!(ctxFor('workspace_exec', { cmd: 'rm -rf --no-preserve-root /home' }));
    expect(r).toHaveProperty('block');
  });

  it('blocks dd if= of=/dev/sda', async () => {
    const r = await destructiveCmdGuard.preToolUse!(ctxFor('workspace_exec', { cmd: 'dd if=/dev/zero of=/dev/sda' }));
    expect(r).toHaveProperty('block');
  });

  it('blocks mkfs', async () => {
    const r = await destructiveCmdGuard.preToolUse!(ctxFor('workspace_exec', { cmd: 'mkfs.ext4 /dev/sda1' }));
    expect(r).toHaveProperty('block');
  });

  it('blocks kubectl delete namespace', async () => {
    const r = await destructiveCmdGuard.preToolUse!(ctxFor('workspace_exec', { cmd: 'kubectl delete namespace production' }));
    expect(r).toHaveProperty('block');
  });

  it('allows safe rm of a single file', async () => {
    const r = await destructiveCmdGuard.preToolUse!(ctxFor('workspace_exec', { cmd: 'rm /tmp/foo.txt' }));
    expect(r ?? null).toBeNull();
  });

  it('allows ls', async () => {
    const r = await destructiveCmdGuard.preToolUse!(ctxFor('workspace_exec', { cmd: 'ls /workspace' }));
    expect(r ?? null).toBeNull();
  });

  it('skips when not workspace_exec', async () => {
    const r = await destructiveCmdGuard.preToolUse!(ctxFor('workspace_read', { path: '/etc/passwd' }));
    expect(r ?? null).toBeNull();
  });

  it('blocks rm -rf /etc/passwd (subpath of system dir)', async () => {
    const r = await destructiveCmdGuard.preToolUse!(ctxFor('workspace_exec', { cmd: 'rm -rf /etc/passwd' }));
    expect(r).toHaveProperty('block');
  });

  it('blocks rm -rf /var/log/critical', async () => {
    const r = await destructiveCmdGuard.preToolUse!(ctxFor('workspace_exec', { cmd: 'rm -rf /var/log/critical' }));
    expect(r).toHaveProperty('block');
  });

  it('blocks rm -rf /home/user/.ssh', async () => {
    const r = await destructiveCmdGuard.preToolUse!(ctxFor('workspace_exec', { cmd: 'rm -rf /home/user/.ssh' }));
    expect(r).toHaveProperty('block');
  });

  it('still allows rm -rf /tmp/cache', async () => {
    const r = await destructiveCmdGuard.preToolUse!(ctxFor('workspace_exec', { cmd: 'rm -rf /tmp/cache' }));
    expect(r ?? null).toBeNull();
  });

  it('still allows rm -rf /workspace/build', async () => {
    const r = await destructiveCmdGuard.preToolUse!(ctxFor('workspace_exec', { cmd: 'rm -rf /workspace/build' }));
    expect(r ?? null).toBeNull();
  });
});

describe('destructive-cmd-guard — Phase 1 sec-härtung patterns', () => {
  const blocked = [
    'helm uninstall my-prod-release',
    'terraform destroy',
    'terraform apply -auto-approve',
    'kubectl scale deployment foo --replicas=0',
    'kubectl drain node1 --force',
    'kubectl edit deployment app --namespace=prod',
    'kubectl edit deployment app -n prod',
    'kubectl patch deployment app --namespace=production --type=merge',
    'kubectl patch deployment app -n production --type=merge',
    'git push origin feature-x --force',
    'git push --force-with-lease origin feature',
    'docker system prune --volumes -f',
    'az group delete --name rg-prod',
    'az aks delete --resource-group rg --name cluster',
    'kubectl delete pvc data-pvc',
  ];

  for (const cmd of blocked) {
    it(`blocks: ${cmd}`, async () => {
      const res = await destructiveCmdGuard.preToolUse!(ctxFor('workspace_exec', { cmd }));
      expect(res).toHaveProperty('block');
      expect((res as { block: string }).block).toMatch(/Destructive command blocked/);
    });
  }

  const allowed = [
    'helm list',
    'terraform plan',
    'kubectl get pods',
    'git push origin feature-x',
    'docker system prune',  // ohne --volumes ist OK
  ];

  for (const cmd of allowed) {
    it(`allows: ${cmd}`, async () => {
      const res = await destructiveCmdGuard.preToolUse!(ctxFor('workspace_exec', { cmd }));
      expect(res ?? null).toBeNull();
    });
  }
});
