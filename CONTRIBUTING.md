# Contributing to claudemods

Thanks for helping! There are two ways to add something.

## 1. Use the form (easiest)

Open the [submission form](../../issues/new?template=submit.yml). A bot checks it right away and replies. When a maintainer adds the `approved` label, the bot opens a pull request for you.

## 2. Edit the data file

1. Add one line to `data/mods.json`:

   ```json
   {"id":"my-mod","name":"my-mod","type":"mod","url":"https://github.com/me/my-mod","author":"me","description":"One plain sentence about what it does.","tags":["pane","git"],"bundle":true,"added":"2026-10-04"}
   ```

2. If you set `"bundle": true`, pin it: `node scripts/sync.mjs my-mod`
3. Regenerate: `node scripts/build.mjs`
4. Open a pull request. Don't edit `README.md`, `.claude-plugin/marketplace.json` or `site/data.json` by hand; they're generated.

### Fields

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | lowercase, unique, `a-z 0-9 . _ -` |
| `name` | yes | display name |
| `type` | yes | `mod`, `plugin`, `skill`, `subagent`, `command`, `hook`, `statusline`, `mcp`, `claude-md`, `prompt`, `list` |
| `url` | yes | `https://` link, usually the GitHub repo |
| `author` | yes | GitHub handle or org |
| `description` | yes | one sentence, 140 chars max |
| `tags` | no | up to 6 lowercase tags |
| `bundle` | no | `true` = add to the claudemods marketplace. Repo must have `.claude-plugin/marketplace.json` or `plugin.json` at its root |
| `install` | no | install command, for things not in the marketplace |
| `rename` | no | map of upstream plugin name → name in our marketplace (Claude Code reserves names starting with `claude-`) |
| `featured` | no | maintainers only |

## What gets in

- It's public and works with Claude (Claude Code, the API, Claude apps).
- It does what the description says.
- Nothing hidden: no telemetry you didn't mention, no obfuscated code. Mods run with the user's full permissions, so we read them before they go into the marketplace.

## Maintainers

- `node scripts/sync.mjs` refreshes every pinned commit. The weekly **Sync pinned plugins** workflow does this and opens a PR. Compare each upstream change before merging.
- `./scripts/verify-installs.sh` installs every marketplace plugin into a throwaway config to make sure they all still install.
