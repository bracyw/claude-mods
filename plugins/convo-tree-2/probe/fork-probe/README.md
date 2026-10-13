# fork-probe

A live probe for convo-tree-2's mid-turn hand-off: can a plugin start a background fork, what does the agent start with, and can its hand-back be kept off the main conversation. It registers two tools the model calls itself, `mcp__fork-probe__run` (`nonce`, `dropNotice`, `subagentType`) and `mcp__fork-probe__report`.

Load it into a session as a dev mod, or with `claude --plugin-dir plugins/convo-tree-2/probe/fork-probe`, and ask Claude to run it.

## Results (2026-10-13, cloud session, Opus 5.5)

| Question | Result |
|---|---|
| Can a plugin spawn `subagentType: 'fork'`? | **No.** Denied: `Agent type 'fork' not found`. Forks aren't offered in this session. |
| Does a regular background agent (`general-purpose`) see the conversation? | **No.** It answered `NO-CONTEXT`. Its first request carried 11 messages of its own. About 41.5k tokens of system prompt and tools, cached from the second run on. |
| Does the agent's hand-back reach the main conversation? | **Yes**, as a queued `<agent-message>` delivered into the running turn. |
| Which hook sees the hand-back? | `session.append` with `door: 'delivery'`. `prompt.submit`, `session.send` and `session.receive` don't fire for it. |
| Does rewriting `turn.complete`'s text change the hand-back? | **No.** The hand-back carries the agent's own final text. |
| Can a plugin keep the hand-back off the main conversation? | **Yes.** Rewriting the `delivery` row's content in `session.append` replaced it: only the stub line reached the model. |
| Can a plugin read the agent's transcript afterwards? | **Yes**, `$.session.messages({ agentId })`. |
