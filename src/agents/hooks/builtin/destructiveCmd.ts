import type { ToolHook } from '../types.js';
import { getAgentHookConfig, compileExtraPatterns } from '../config.js';

// Patterns are matched case-insensitively against the trimmed `cmd` arg.
// Order is documentation-only — first match wins.
const DESTRUCTIVE_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  // FIX (commit 452b891 review): original plan used (?:\s|$) as terminator, which allowed
  // subpaths like `/etc/passwd` through because the character after `/etc` is `/`, not a
  // space or end-of-string. Changed to (?:\s|$|/) so that any path *under* a system dir
  // (e.g. `rm -rf /etc/passwd`, `rm -rf /var/log/critical`) is also blocked.
  { name: 'rm -rf root or near-root',     pattern: /\brm\s+(?:-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\s+(?:(?:--|)[^|&;]*\s+)?(?:\/|~|\$HOME|\/etc|\/var|\/usr|\/home|\/root|\/sys|\/proc|\/boot)(?:\s|$|\/)/i },
  { name: 'rm with --no-preserve-root',   pattern: /\brm\s+[^|&;]*--no-preserve-root/i },
  { name: 'dd to block device',           pattern: /\bdd\s+[^|&;]*of=\/dev\/(sd[a-z]|nvme|hd[a-z]|xvd[a-z])/i },
  { name: 'mkfs filesystem creation',     pattern: /\bmkfs(\.[a-z0-9]+)?\s+\/dev\//i },
  { name: 'kubectl delete namespace',     pattern: /\bkubectl\s+delete\s+(?:ns|namespace)s?\b/i },
  { name: 'kubectl delete --all',         pattern: /\bkubectl\s+delete\s+[^|&;]*--all\b/i },
  { name: 'docker volume rm --all',       pattern: /\bdocker\s+volume\s+rm\s+[^|&;]*\$\(/i },
  { name: 'helm delete / uninstall',      pattern: /\bhelm\s+(?:delete|uninstall)\s+[^|&;]*--all/i },
  { name: 'chmod 777 broad scope',        pattern: /\bchmod\s+(?:-[a-zA-Z]*R[a-zA-Z]*\s+)?777\s+(?:\/|\/home|\/etc|\/var|\/usr)\b/i },
  { name: 'shutdown / reboot / halt',     pattern: /\b(?:shutdown|reboot|halt|poweroff)\b/i },
  { name: 'fork bomb',                    pattern: /:\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:/ },
  { name: 'git push --force to main',     pattern: /\bgit\s+push\s+[^|&;]*--force\s+[^|&;]*\b(?:origin\s+)?(?:main|master|prod)\b/i },
  { name: 'git reset --hard HEAD~N',      pattern: /\bgit\s+reset\s+--hard\s+HEAD~\d+/i },
  // Phase-1 Sec-Härtung 2026-05-27 — Cluster-Move Patterns
  { name: 'helm uninstall (any release)', pattern: /\bhelm\s+(?:delete|uninstall)\s+(?!--all)[^\s|&;]+/i },
  { name: 'terraform destroy',            pattern: /\bterraform\s+destroy\b/i },
  { name: 'terraform apply -auto-approve',pattern: /\bterraform\s+apply\s+[^|&;]*-auto-approve\b/i },
  { name: 'kubectl scale to zero replicas',pattern: /\bkubectl\s+scale\s+[^|&;]*--replicas[= ]0\b/i },
  { name: 'kubectl drain --force',        pattern: /\bkubectl\s+drain\s+[^|&;]*--force\b/i },
  { name: 'kubectl cordon (mass)',        pattern: /\bkubectl\s+cordon\s+--all\b/i },
  { name: 'kubectl edit prod resource',   pattern: /\bkubectl\s+edit\s+[^|&;]+(?:--namespace[= ]|-n\s+)(?:prod|production)\b/i },
  { name: 'kubectl patch prod resource',  pattern: /\bkubectl\s+patch\s+[^|&;]+(?:--namespace[= ]|-n\s+)(?:prod|production)\b/i },
  // Lease-variant must come before bare --force so audit log shows the more specific name.
  { name: 'git push --force-with-lease',  pattern: /\bgit\s+push\s+[^|&;]*--force-with-lease\b/i },
  { name: 'git push --force (any branch)',pattern: /\bgit\s+push\s+[^|&;]*--force\b/i },
  { name: 'docker system prune --volumes',pattern: /\bdocker\s+system\s+prune\s+[^|&;]*--volumes\b/i },
  { name: 'crictl rm container',          pattern: /\bcrictl\s+rm\b/i },
  { name: 'az group delete',              pattern: /\baz\s+group\s+delete\b/i },
  { name: 'az aks delete',                pattern: /\baz\s+aks\s+delete\b/i },
  { name: 'kubectl delete pvc',           pattern: /\bkubectl\s+delete\s+pvc\b/i },
];

export const destructiveCmdGuard: ToolHook = {
  name: 'destructive-cmd-guard',
  priority: 100, // security checks run first
  description: 'Blocks workspace_exec commands matching known destructive patterns (rm -rf, dd of=, kubectl delete ns, etc.)',
  async preToolUse(ctx) {
    // Only inspect shell exec — file reads/writes have their own hooks.
    if (ctx.toolName !== 'workspace_exec') return null;
    const cmd = String(ctx.toolArgs?.['cmd'] ?? '');
    if (!cmd) return null;

    // Built-in floor — always applies, never removable by config.
    for (const p of DESTRUCTIVE_PATTERNS) {
      if (p.pattern.test(cmd)) {
        return {
          block: `Destructive command blocked: matched pattern "${p.name}". ` +
                 `If this is a legitimate operation, request human approval via the UI ` +
                 `or use a more specific command. Original cmd was: ${cmd.slice(0, 200)}`,
        };
      }
    }

    // Additive per-agent extra patterns (P1.3) — tighten-only; can only ADD blocks.
    const cfg = await getAgentHookConfig(ctx.agentId);
    if (cfg.extraDestructivePatterns.length > 0) {
      for (const re of compileExtraPatterns(cfg.extraDestructivePatterns)) {
        if (re.test(cmd)) {
          return {
            block: `Destructive command blocked: matched an agent-configured pattern. ` +
                   `If this is legitimate, request human approval via the UI. ` +
                   `Original cmd was: ${cmd.slice(0, 200)}`,
          };
        }
      }
    }
    return null;
  },
};
