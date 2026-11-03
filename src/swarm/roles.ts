import type { SwarmAgentConfig } from '../config/schema.js';

/**
 * The roles a team can be built from, for the presets and for `/swarm custom`. A lead role talks to the user
 * and hands out work; every other role reports to whoever leads. Role text names the lead, so it is written
 * when the team is assembled.
 */
export interface RoleTemplate {
  /** Also the agent's default name. */
  key: string;
  label: string;
  /** One line for pickers. */
  summary: string;
  lead: boolean;
  color: string;
  /** Tool globs this role is limited to (all tools when absent). */
  tools?: string[];
  role(lead: string): string;
}

/** Tools for roles that look but do not touch: they can read and run checks, not edit files. */
const REVIEW_TOOLS = ['read', 'grep', 'glob', 'ls', 'bash', 'web_fetch', 'skill', 'todo_write'];

export const ROLES: RoleTemplate[] = [
  {
    key: 'planner',
    label: 'Planner',
    summary: 'leads: splits the task into steps and hands them out',
    lead: true,
    color: 'magenta',
    role: () =>
      'Lead. Break the task into small steps, hand each one to a teammate, review what comes back, and report the result to the user.',
  },
  {
    key: 'architect',
    label: 'Architect',
    summary: 'leads: designs the approach and interfaces, then hands out the work',
    lead: true,
    color: 'magenta',
    role: () =>
      'Lead. Design the approach and the interfaces, split the work between your teammates, review what comes back, and report the result to the user.',
  },
  {
    key: 'builder',
    label: 'Builder',
    summary: 'writes the code and runs the tests',
    lead: false,
    color: 'cyan',
    role: (lead) =>
      `Implementer. Carry out the steps ${lead} gives you, keep changes small, run the tests, and report back to ${lead} concisely.`,
  },
  {
    key: 'reviewer',
    label: 'Reviewer',
    summary: 'reads the changes and runs checks; does not edit',
    lead: false,
    color: 'yellow',
    tools: REVIEW_TOOLS,
    role: (lead) =>
      `Reviewer. Read what the builder changes, run the checks, and report bugs, risks and missing tests to ${lead}. You do not edit files.`,
  },
  {
    key: 'security',
    label: 'Security advisor',
    summary: 'reviews changes and commands for security problems; does not edit',
    lead: false,
    color: 'red',
    tools: REVIEW_TOOLS,
    role: (lead) =>
      `Security advisor. Review changes and commands for injection, unsafe input handling, secrets in code or logs, weak authentication, unsafe file and shell use, and risky dependencies. Report each finding to ${lead} with its severity, where it is, and a concrete fix. You do not edit files.`,
  },
  {
    key: 'tester',
    label: 'Tester',
    summary: 'writes and runs tests for what changed',
    lead: false,
    color: 'green',
    role: (lead) =>
      `Tester. Write and run tests for what the builder changes, including edge cases, and report failures to ${lead} with the exact output.`,
  },
  {
    key: 'researcher',
    label: 'Researcher',
    summary: 'looks things up in docs, APIs and the codebase',
    lead: false,
    color: 'blue',
    tools: REVIEW_TOOLS,
    role: (lead) =>
      `Researcher. Look things up (documentation, APIs, the existing codebase) and report concise findings with sources to ${lead}. You do not edit files.`,
  },
  {
    key: 'writer',
    label: 'Docs writer',
    summary: 'keeps the README, docs and comments in step with the changes',
    lead: false,
    color: 'green',
    role: (lead) =>
      `Writer. Keep the README, docs and code comments in step with the team's changes, and report what you updated to ${lead}.`,
  },
];

export const roleByKey = (key: string): RoleTemplate | undefined =>
  ROLES.find((r) => r.key === key.toLowerCase());

/** A teammate's slot in a team being put together: a role from the list, or one the user wrote. */
export type TeamSlot = { template: RoleTemplate } | { name: string; role: string };

/**
 * Turn slots into agent configs. The first slot leads. Names are unique (`builder`, `builder-2`, ...), and
 * custom roles get a sentence saying who they report to.
 */
export function assembleTeam(slots: TeamSlot[]): SwarmAgentConfig[] {
  const used = new Map<string, number>();
  const unique = (base: string) => {
    const clean =
      base
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^[^a-z]+/, '')
        .slice(0, 20) || 'agent';
    const n = (used.get(clean) ?? 0) + 1;
    used.set(clean, n);
    return n === 1 ? clean : `${clean}-${n}`;
  };
  const names = slots.map((s) => unique('template' in s ? s.template.key : s.name));
  const lead = names[0]!;
  return slots.map((s, i) => {
    const name = names[i]!;
    if ('template' in s) {
      const t = s.template;
      return {
        name,
        role: i === 0 && !t.lead ? `Lead. ${t.role(lead)} You also talk to the user.` : t.role(lead),
        color: t.color,
        ...(t.tools ? { tools: t.tools } : {}),
      };
    }
    const role = s.role.trim().replace(/\.?$/, '.');
    return { name, role: i === 0 ? `Lead. ${role}` : `${role} Report back to ${lead}.` };
  });
}

/** `/swarm custom architect builder builder security` → slots. Unknown words are reported, not guessed. */
export function parseTeam(words: string[]): { slots: TeamSlot[] } | { error: string } {
  const slots: TeamSlot[] = [];
  for (const w of words) {
    const t = roleByKey(w);
    if (!t) return { error: `Unknown role "${w}". Roles: ${ROLES.map((r) => r.key).join(', ')}` };
    slots.push({ template: t });
  }
  return { slots };
}

const team = (...keys: string[]) => assembleTeam(keys.map((k) => ({ template: roleByKey(k)! })));

/** Ready-made teams. The first agent leads. */
export const SWARM_PRESETS: Record<string, SwarmAgentConfig[]> = {
  duo: team('planner', 'builder'),
  trio: team('architect', 'builder', 'reviewer'),
  quad: team('architect', 'builder', 'reviewer', 'security'),
};

export const PRESET_SUMMARY: Record<string, string> = {
  duo: 'planner (lead) and builder',
  trio: 'architect (lead), builder and reviewer',
  quad: 'architect (lead), builder, reviewer and security advisor',
};
