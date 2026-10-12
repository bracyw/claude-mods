# claude-mods

My own maintained copies of Claude Code mods. Each one is based on an upstream version that was read line by line before it was copied in. Upstream updates come in only after their diff has been reviewed.

| Plugin | Upstream | Pinned commit | License |
|---|---|---|---|
| `filetree` | [data-goblin/claude-code-filetree](https://github.com/data-goblin/claude-code-filetree) (Kurt Buhler) | `b0e4098` | MIT |
| `cache-tax` | [karanb192/cache-tax](https://github.com/karanb192/cache-tax) (Karan Bansal) | `06cac47` | MIT |

Each plugin keeps its upstream `LICENSE`. Runtime code (`hooks/`, `types/`, `tests/`) is identical to the pinned commit. Only `plugin.json` metadata and a note at the top of each README differ. Upstream's site, media, CI and dev tooling were left out.

## Install

```bash
claude plugin marketplace add ~/Desktop/Projects/personal/claude-mods
claude plugin install filetree@bracyw-mods --scope user
claude plugin install cache-tax@bracyw-mods --scope user
```

Run `/reload-plugins` in any open session, or restart it.

## Taking an upstream update

1. Fetch upstream and diff it against the pinned commit, e.g. `git diff b0e4098 <new>` in a clone.
2. Review every changed line.
3. Copy the changed runtime files in, then bump the pinned commit here and the `-bracyw.N` version in `plugin.json`.
4. Run `claude plugin validate plugins/<name>`, then `claude plugin marketplace update bracyw-mods` and `claude plugin update <name>@bracyw-mods`.
