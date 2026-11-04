# Context compaction

A long conversation eventually fills the model's context window. Nacreframe keeps it working by summarising the older
part. Because a bad compaction can corrupt or silently truncate a conversation, the design is deliberately strict.

## The guarantees

1. **Always on.** There is no setting to disable it. `compaction.threshold` can lower the trigger (minimum 30%) but
   never raise it above **80%** of the context window.
2. **The chat is held, not raced.** When the next request would cross the threshold, nothing is sent to the model.
   The turn waits, the older conversation is summarised, and only then does the model call happen. Anything you type
   while it waits is queued (the footer shows the count) and delivered, in order, with that same request.
3. **Transactional.** The summary is produced from an immutable snapshot. The session file is written to only if the
   summary is valid (long enough, smaller than the text it replaces) and the conversation did not change meanwhile.
   A failure, an abort or a crash at any point leaves the session exactly as it was.
4. **No data loss.** Compaction appends one line to the session's append-only JSONL file; it never edits or deletes
   earlier lines. The full original history stays on disk, and resuming reproduces the same compacted view.
5. **Never an oversized request.** If compaction fails (after retries) or cannot free enough room, the turn **pauses**:
   the conversation is intact, nothing was sent, and the UI says why. Send a message to retry, or pick a larger model.
   A request above 95% of the window is never sent.
6. **Never a corrupt transcript.** Every tool call must be answered by a result right after it. Cuts are only made
   at boundaries that keep each call/result pair together, and a call left dangling by a crash or abort is closed
   with an "interrupted" result before the next request. The view sent to any provider is validated every time.

## How the size is measured

The window comes from the server (llama.cpp's `--ctx-size`, LM Studio, Ollama, `contextWindows` in config). The
current size is what the provider reported for the last response, plus an estimate for anything added since; with no
report, a conservative estimate of the whole request (system prompt, tool schemas and messages) is used. A reply
reserve is subtracted so a full prompt can never leave no room to answer. If a server turns out to have a smaller
window than it claimed, the first overflow error teaches the harness the real size, and it compacts and retries once.

Individual tool results are capped to a slice of the window (and parallel results share a budget), so a single huge
file or command output cannot jump the context past the limit in one step.

## What gets summarised

Everything before a cut point is replaced, _in the model's view only_, by a summary message; the newest
`compaction.keepRecent` messages (default 6) stay verbatim. The cut can fall anywhere that keeps tool call/result pairs
together, so compaction also works in the middle of a long tool loop. If the context is still too large, the harness
keeps fewer recent messages and tries again before giving up. Summaries of summaries fold the earlier summary into the
new one.

Long histories are summarised in chunks sized to the summariser's own window, so models with small contexts (16k,
36k) work. By default the same model summarises (this avoids swapping models on a single-GPU server); set
`smallModel` to use another. Reasoning models that spend their whole output budget thinking get one retry with a
larger budget.

## Swarms

Every swarm member is an ordinary agent with its own persisted session, so each compacts independently by exactly
these rules. Messages sent to a member that is compacting are queued like any others.

## Watching it

- Terminal: `⏸ Compacting context (83%) — chat paused, your input is queued`, then `Context compacted: 83% → 31%`.
- Dashboard: a banner above the composer, and the context meter shows the 80% tick.
- `/compact [focus]` runs it on demand, optionally steering what the summary should keep.
