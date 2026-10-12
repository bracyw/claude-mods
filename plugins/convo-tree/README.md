# convo-tree

A map of where a Claude Code conversation has gone. You split the conversation into branches as you explore, and convo-tree shows them as cards, keeps a one-line summary of each, and can hand a subagent just one branch.

The conversation itself stays linear. Branches are a layer on top that groups turns: each turn belongs to the branch that was active when you sent it. Switching to an old branch changes where your next prompts go, and tells Claude you're back on that thread.

## What you get

- **Pane** (`/tree`): one bordered card per branch, indented by depth and joined by dotted guides. Each card has the branch's title, its summary and its turn count. Open a card to see its last turns and replies, with **Switch here**, **⑂ Split reply** and **⧉ Agent**.
- **Browser map** (`/tree-web`, or **↗ Map** in the pane): the same branches as a left-to-right map that updates live. Click a card to read it; double-click or **Switch here** to switch the session to it.
- **Branch subagents**: ask Claude for "an agent that only sees branch A". It spawns the `convo-tree:branch` agent, which gets that branch's turns (plus the turns leading up to it) and nothing else. `/branch-agent A <task>` does the same.
- **Titles and summaries**: Haiku titles a branch from its first prompt and keeps a one-sentence summary up to date after each turn.

## Commands

| Command | Does |
|---|---|
| `/tree` | Open the pane |
| `/tree-web` | Open the browser map |
| `/branch [label]` | Start a branch off the active one; your next prompt goes there |
| `/branches` | List branches as text |
| `/branch-agent <branch> <task>` | Run a subagent on one branch |

## Cost

Only Haiku calls cost tokens: a title (at most 20 output tokens) once per branch, a summary (at most 50) after each turn, and a split (at most 120) when you press **Split reply**. After you switch branches, your next prompt carries a short note of about 60 tokens saying which thread you're back on.

## Requirements and limits

- The browser map runs a small local server with [bun](https://bun.sh). It looks for `bun` on the PATH, then in `/opt/homebrew/bin` and `/usr/local/bin`. The pane works without it.
- The server listens on `127.0.0.1` only and refuses any request without the random token in its URL. It exits when the session does.
- `/tree-web` opens the page with macOS `open`. On other systems, open the URL it prints.
- The tree lives in the session. Each prompt and final reply is kept (cut at 2,000 and 4,000 characters); tool calls aren't.
- Branches can't be renamed, deleted or merged yet.

## Layout

| Path | What it is |
|---|---|
| `hooks/register.tsx` | Hooks, commands, the branch agent, the pane, the browser bridge |
| `hooks/tree.ts` | The tree's data functions, with no Claude Code API calls |
| `browser/server.ts` | The bun server: serves the page, streams the tree, relays clicks |
| `browser/index.html` | The browser map, plain JS |
| `hooks/convo-tree.test.tsx` | Tests: `claude plugin test plugins/convo-tree` |
