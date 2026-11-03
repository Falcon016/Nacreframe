# Collaborative swarms

A swarm is a set of agents in one shared **channel**. You watch the channel in your terminal, and you can speak in it.

## Starting one

```text
/swarm duo      planner (lead) + builder
/swarm trio     architect (lead) + builder + reviewer
/swarm config   the agents defined under "swarm.agents" in your config
/swarm panes    toggle the split-pane view (one live pane per agent)
/swarm status   who is working
/swarm stop     back to a single agent
```

## Who hears what

- A message with `to="name"` or an `@name` mention **wakes** that agent.
- An unaddressed message from you goes to the **lead** (the first agent).
- Everyone else receives it as context, delivered with their next wake-up. Nothing makes an agent answer every
  message — agents are told to speak only for results, questions, blockers and hand-offs.
- A busy agent is **steered** (the message arrives before its next model call) rather than restarted.

## Who reports to whom

The **lead** (the first agent) is the only one that talks to you. Everyone else reports to the lead. The harness
enforces this, so it holds even with small models that lose track of their role:

- Only the lead has `ask_user`. A teammate's question goes to the lead, who decides whether you need to hear it.
- A teammate's `swarm_say` to you, or to nobody in particular, is delivered to the lead instead (the tool says so).
- A teammate that ends its turn without posting anything has its final text delivered as its **report** to whoever
  woke it (normally the lead), which wakes them so the work carries on. The channel shows "report delivered".
- If the lead starts a line with `@builder do X` in plain text instead of calling `swarm_say`, the builder still gets
  it. A passing mention ("thanks to @builder") is not treated as a hand-off.
- Every wake-up repeats the agent's role and who it answers to.
- If you address a teammate directly (`@builder ...`), it answers you, and the lead gets the answer as context
  without being woken.

Agents use these tools: `swarm_say`, `swarm_roster`, `swarm_note` / `swarm_notes` (shared scratchpad) and, if
`swarm.allowSpawn` is true, `swarm_spawn` to add a teammate.

## Staying safe

- **Message budget.** After `swarm.maxMessages` (default 60) agent-to-agent messages with no human input, delivery
  pauses and the channel says so. Only a message from you resets it.
- **Shared workspace.** Agents edit the same files. `write`/`edit` use per-file locks and atomic writes, and refuse to
  modify a file that changed since _that agent_ last read it, so concurrent edits fail loudly instead of clobbering.
- **One approval queue.** Every agent's approval requests appear in one prompt, labelled with the agent, in arrival order.
- **Per-agent tools.** Restrict an agent with `tools` (globs), e.g. a reviewer that can only read and run tests.
- **Cost.** Each agent is a separate conversation with its own model calls. `ctx` and token counters in the footer
  are summed across agents.

## Defining a team

```json
{
  "swarm": {
    "maxAgents": 6,
    "agents": [
      { "name": "architect", "role": "Lead. Plans the work and delegates.", "color": "magenta" },
      {
        "name": "builder",
        "role": "Implements changes and runs the tests.",
        "model": "anthropic/claude-sonnet-5-5"
      },
      {
        "name": "reviewer",
        "role": "Reviews diffs. Never edits.",
        "tools": ["read", "grep", "glob", "ls", "bash"]
      }
    ]
  }
}
```

Names are lowercase (`a-z`, digits, `-`, `_`). Different agents may use different models, including local ones.

## Persistence and resume

A swarm is stored like any session, in `<data>/swarms/<project>/<id>/`:

- `swarm.json` — roster (including agents spawned mid-run), shared notes, and channel lines each agent has seen but not
  yet been woken with
- `channel.jsonl` — every channel message, append-only
- `<agent>.jsonl` — each member's own conversation in the normal session format

So each member has ordinary context: it is compacted at 80% by the same engine as the main agent, survives restarts, and
a whole swarm resumes with `/swarm resume` (terminal) or the _Continue from_ list in the dashboard. A message that was
in flight to an agent at the moment of a crash is in the channel log but is not re-delivered.
