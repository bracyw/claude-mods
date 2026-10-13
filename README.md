# claude-mods

My Claude Code mods: maintained copies of upstream mods, and mods I wrote myself.

## Maintained copies

Each one is based on an upstream version that was read line by line before it was copied in. Upstream updates come in only after their diff has been reviewed.

| Plugin | Upstream | Pinned commit | License |
|---|---|---|---|
| `filetree` | [data-goblin/claude-code-filetree](https://github.com/data-goblin/claude-code-filetree) (Kurt Buhler) | `b0e4098` | MIT |
| `cache-tax` | [karanb192/cache-tax](https://github.com/karanb192/cache-tax) (Karan Bansal) | `06cac47` | MIT |

Each plugin keeps its upstream `LICENSE`. Runtime code (`hooks/`, `types/`, `tests/`) is identical to the pinned commit. Only `plugin.json` metadata and a note at the top of each README differ. Upstream's site, media, CI and dev tooling were left out.

## My own mods

| Plugin | What it does |
|---|---|
| [`convo-tree`](plugins/convo-tree) | Maps the conversation into branches: a pane of branch cards with Haiku summaries, a live browser map with click-to-switch, and subagents that see one branch |
| [`convo-tree-2`](plugins/convo-tree-2) | convo-tree with real forks: same pane and commands, but switching a branch swaps the live transcript, so your prompts and Claude's context are that fork alone. Not yet tried live |

## Install

```bash
claude plugin marketplace add bracyw/claude-mods   # or a local clone's path
claude plugin install filetree@bracyw-mods --scope user
claude plugin install cache-tax@bracyw-mods --scope user
claude plugin install convo-tree@bracyw-mods --scope user
claude plugin install convo-tree-2@bracyw-mods --scope user   # instead of convo-tree, not beside it
```

Run `/reload-plugins` in any open session, or restart it.

## Repository policy

Only the owner pushes here, and every commit must be GPG-signed (verified). Force pushes, branch deletion and history rewrites are blocked by repository rulesets. GitHub Actions is disabled. Outside pull requests aren't accepted.

## Taking an upstream update

1. Fetch upstream and diff it against the pinned commit, e.g. `git diff b0e4098 <new>` in a clone.
2. Review every changed line.
3. Copy the changed runtime files in, then bump the pinned commit here and the `-bracyw.N` version in `plugin.json`.
4. Run `claude plugin validate plugins/<name>`, then `claude plugin marketplace update bracyw-mods` and `claude plugin update <name>@bracyw-mods`.
