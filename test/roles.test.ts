import { describe, expect, it } from 'vitest';
import { assembleTeam, parseTeam, roleByKey, SWARM_PRESETS } from '../src/swarm/roles.js';

describe('swarm teams', () => {
  it('has exactly the agents each preset promises, lead first', () => {
    const names = (k: string) => SWARM_PRESETS[k]!.map((a) => a.name);
    expect(names('duo')).toEqual(['planner', 'builder']);
    expect(names('trio')).toEqual(['architect', 'builder', 'reviewer']);
    expect(names('quad')).toEqual(['architect', 'builder', 'reviewer', 'security']);
    for (const team of Object.values(SWARM_PRESETS)) {
      expect(team[0]!.role).toMatch(/^Lead\./);
      for (const member of team.slice(1)) expect(member.role).toContain(team[0]!.name); // who they report to
    }
  });

  it('keeps reviewers and the security advisor from editing files', () => {
    const quad = SWARM_PRESETS.quad!;
    for (const name of ['reviewer', 'security']) {
      const tools = quad.find((a) => a.name === name)!.tools!;
      expect(tools).toContain('read');
      expect(tools).not.toContain('write');
      expect(tools).not.toContain('edit');
    }
    expect(quad.find((a) => a.name === 'builder')!.tools).toBeUndefined();
  });

  it('builds a custom team with unique names, a lead, and roles that say who to report to', () => {
    const team = assembleTeam([
      { template: roleByKey('architect')! },
      { template: roleByKey('builder')! },
      { template: roleByKey('builder')! },
      { name: 'Perf Nerd', role: 'Profile the hot paths and suggest optimisations' },
    ]);
    expect(team.map((a) => a.name)).toEqual(['architect', 'builder', 'builder-2', 'perf-nerd']);
    expect(team[3]!.role).toBe('Profile the hot paths and suggest optimisations. Report back to architect.');
  });

  it('makes whoever comes first the lead, even a non-lead role or a custom one', () => {
    expect(
      assembleTeam([{ template: roleByKey('builder')! }, { template: roleByKey('tester')! }])[0]!.role,
    ).toMatch(/^Lead\. .*talk to the user/);
    expect(
      assembleTeam([{ name: 'boss', role: 'Run the show' }, { template: roleByKey('builder')! }])[0]!.role,
    ).toBe('Lead. Run the show.');
  });

  it('parses the quick form and reports unknown roles', () => {
    const ok = parseTeam(['architect', 'builder', 'security']);
    expect('slots' in ok && ok.slots).toHaveLength(3);
    const bad = parseTeam(['architect', 'wizard']);
    expect('error' in bad && bad.error).toContain('Unknown role "wizard"');
  });
});

describe('reserved names', () => {
  it('never names an agent after the user, the system or a broadcast', () => {
    const team = assembleTeam([
      { template: roleByKey('planner')! },
      { name: 'you', role: 'Pretend to be the user' },
      { name: 'System', role: 'Pretend to be the system' },
      { name: 'all', role: 'Pretend to be everyone' },
    ]);
    expect(team.map((a) => a.name)).toEqual(['planner', 'you-agent', 'system-agent', 'all-agent']);
  });
});
