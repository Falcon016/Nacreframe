import type { ApprovalMode, Rule } from '../config/schema.js';
import { escalationReason, hardDenyReason, isReadOnlyCommand } from '../tools/bash.js';
import type { AnyTool } from '../tools/types.js';
import { globMatch } from '../util/glob.js';

export interface Decision {
  action: 'allow' | 'ask' | 'deny';
  reason: string;
}

export interface PolicyOptions {
  mode: ApprovalMode;
  rules: Rule[];
}

/** Wildcard match where `*` spans anything (used for shell commands, which contain slashes). */
function wildcard(pattern: string, value: string): boolean {
  const re = new RegExp(
    '^' +
      pattern
        .split('*')
        .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*') +
      '$',
    's',
  );
  return re.test(value);
}

/**
 * Decides whether a tool call runs, needs a human, or is refused.
 *
 * Precedence (first hit wins): hard blocklist → deny rules → plan-mode read-only →
 * ask rules → escalations (sudo, push, curl|sh ...) → allow rules → session grants →
 * read-only shell commands → the mode's default.
 */
export class PolicyEngine {
  mode: ApprovalMode;
  private rules: Rule[];
  private grants = new Set<string>();

  constructor(opts: PolicyOptions) {
    this.mode = opts.mode;
    this.rules = opts.rules;
  }

  setMode(mode: ApprovalMode): void {
    this.mode = mode;
  }

  addRule(rule: Rule): void {
    this.rules.push(rule);
  }

  /** Remember "always allow" for the rest of the session. */
  grant(tool: AnyTool, input: unknown): string {
    const key = grantKey(tool, input);
    this.grants.add(key);
    return key;
  }

  clearGrants(): void {
    this.grants.clear();
  }

  decide(tool: AnyTool, input: unknown): Decision {
    const arg = tool.primaryArg?.(input as never);
    const isShell = tool.risk === 'exec' && tool.name === 'bash';

    if (isShell && arg) {
      const bad = hardDenyReason(arg);
      if (bad) return { action: 'deny', reason: `Blocked: ${bad}` };
    }

    const matching = this.rules.filter(
      (r) =>
        globMatch(r.tool, tool.name) &&
        (r.match === undefined ||
          (arg !== undefined &&
            (isShell || tool.risk === 'network' ? wildcard(r.match, arg) : globMatch(r.match, arg)))),
    );
    const deny = matching.find((r) => r.action === 'deny');
    if (deny) return { action: 'deny', reason: `Denied by rule ${ruleLabel(deny)}` };

    if (this.mode === 'plan' && tool.risk !== 'read' && tool.risk !== 'agent') {
      return {
        action: 'deny',
        reason: 'Plan mode is read-only. Present a plan; the user will switch modes to execute it.',
      };
    }

    const ask = matching.find((r) => r.action === 'ask');
    if (ask) return { action: 'ask', reason: `Rule ${ruleLabel(ask)} requires approval` };

    if (isShell && arg) {
      const esc = escalationReason(arg);
      if (esc) return { action: 'ask', reason: `Needs approval: ${esc}` };
    }

    const allow = matching.find((r) => r.action === 'allow');
    if (allow) return { action: 'allow', reason: `Allowed by rule ${ruleLabel(allow)}` };

    if (this.grants.has(grantKey(tool, input)))
      return { action: 'allow', reason: 'Allowed for this session' };

    if (isShell && arg && this.mode !== 'plan' && isReadOnlyCommand(arg)) {
      return { action: 'allow', reason: 'Read-only command' };
    }

    switch (this.mode) {
      case 'auto':
        return { action: 'allow', reason: 'Auto-approve mode' };
      case 'plan':
        return { action: 'allow', reason: 'Read-only tool' };
      case 'edits':
        return tool.risk === 'read' || tool.risk === 'edit' || tool.risk === 'agent'
          ? { action: 'allow', reason: 'File edits are auto-approved' }
          : { action: 'ask', reason: `${tool.risk} actions need approval` };
      case 'ask':
        return tool.risk === 'read' || tool.risk === 'agent'
          ? { action: 'allow', reason: 'Read-only tool' }
          : { action: 'ask', reason: `${tool.risk} actions need approval` };
    }
  }
}

function ruleLabel(r: Rule): string {
  return r.match ? `${r.tool}(${r.match})` : r.tool;
}

export function grantKey(tool: AnyTool, input: unknown): string {
  const arg = tool.primaryArg?.(input as never);
  if (tool.name === 'bash' && arg) return `bash:${arg.trim().split(/\s+/).slice(0, 2).join(' ')}`;
  if (tool.risk === 'network' || tool.name === 'browser_navigate') {
    try {
      return `${tool.name}:${new URL(arg ?? '').hostname}`;
    } catch {
      return tool.name;
    }
  }
  return tool.name;
}

export function describeGrant(key: string): string {
  const i = key.indexOf(':');
  if (i === -1) return `every ${key} call`;
  const [name, what] = [key.slice(0, i), key.slice(i + 1)];
  return name === 'bash' ? `commands starting with "${what}"` : `${name} on ${what}`;
}
