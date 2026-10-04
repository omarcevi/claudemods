# claudemods.chat

Community directory of Claude extensions (mods, plugins, skills, subagents, slash commands, hooks, status lines, MCP servers, CLAUDE.md guides, prompts), in the style of prompts.chat. It is three things built from one data file:

1. **A Claude Code plugin marketplace.** `/plugin marketplace add <owner>/claudemods` installs any bundled mod with `/plugin install <name>@claudemods`.
2. **A generated README** (an awesome-list).
3. **A static site** at https://claudemods.chat (GitHub Pages, served from `site/`).

## Layout

- `data/mods.json` holds one entry per line. It is the ONLY hand-edited data file.
- `data/resolved.json` is written by `scripts/sync.mjs`. It holds the upstream plugins for each `bundle: true` entry, pinned to a commit sha.
- `scripts/build.mjs` generates `README.md`, `.claude-plugin/marketplace.json` and the site: `site/index.html` (from `scripts/index.template.html`, with every entry rendered into the HTML for search engines), `site/data.json`, `site/robots.txt` and `site/sitemap.xml`. Never edit these by hand; change the template or `build.mjs`.
- `scripts/sync.mjs [ids…]` fetches each upstream `.claude-plugin/marketplace.json` (or `plugin.json`) and pins it with `git ls-remote`. It needs network access.
- `scripts/find-mods.mjs` searches GitHub for mods we don't list (topics `claude-code-mods`/`claude-mods`, and `hooks/hooks.json` files with a `modules` list, i.e. function hooks) and prints a candidates issue. It skips listed repos and any repo named in an earlier `mod-candidates` issue.
- `scripts/issue-to-entry.mjs` turns a submission issue (`.github/ISSUE_TEMPLATE/submit.yml`) into an entry. `--dry-run` only validates.
- `scripts/verify-installs.sh` installs every marketplace plugin into a throwaway `CLAUDE_CONFIG_DIR`. The last run passed 67/67.
- `config.json` holds the repo slug, site URL and marketplace name.
- Workflows:
  - `ci.yml` runs `build --check` and `claude plugin validate`.
  - `submission.yml` checks submission issues; the `approved` label makes it open a PR.
  - `sync.yml` runs weekly and opens a PR that bumps pinned commits.
  - `find-mods.yml` runs weekly and opens one `mod-candidates` issue with new mods to review. Code search may need a `MODS_SEARCH_TOKEN` secret; the issue says so if it was skipped.
  - `pages.yml` deploys `site/`.

## Commands

```bash
npm run build     # regenerate outputs
npm run check     # fail if outputs are stale or data is invalid
npm run sync      # re-pin every bundled entry (then build)
npm run verify    # install-test all marketplace plugins
claude plugin validate .
```

## Rules

- After any change to `data/` or `config.json`, run `npm run build` and commit the generated files too. CI fails otherwise.
- Claude Code reserves third-party plugin names that start with `claude-` / `anthropic-`, and the name `claude-mods`. `build.mjs` strips the prefix automatically. Use an entry's `rename` map for a nicer name. Never name the marketplace anything that looks official.
- Every bundled plugin must stay pinned to a `sha`. Mods run with the user's full permissions, so a sha bump is a code review, not a formality.
- Only add entries you have actually opened and verified. Never invent repos or star counts.
- The site footer says the project is not affiliated with Anthropic. Keep it.
- Node 20+, no dependencies. Keep it that way unless there's a strong reason.

## Status (2026-10-04)

Built and tested: 91 entries, 35 bundled sources and 67 installable plugins. All 67 install cleanly, and `claude plugin validate` passes.

Not done yet: the repo isn't on GitHub, Pages and DNS aren't set up, and `config.json` still has `OWNER/claudemods`.
Setup leftovers: a broken `.git/` folder (delete it) and `_github/` (rename to `.github/`). Both come from the sandbox the files were created in.

## Launch checklist

1. `rm -rf .git && mv _github .github`
2. Put the real GitHub login into `config.json` (`repo`), then `npm run build && npm run check`.
3. `git init -b main`, commit everything, `gh repo create claudemods --public --source . --push`. Add the description "Community Claude mods, plugins & skills, installable from one marketplace" and the topics `claude-code`, `claude-code-mods`, `claude-mods`, `claude-code-plugins`, `awesome-list`, `mcp`.
4. Create the labels: `gh label create submission`, and `gh label create approved --color 2f6f4f`.
5. Let Actions open PRs: `gh api -X PUT repos/{owner}/claudemods/actions/permissions/workflow -f default_workflow_permissions=write -F can_approve_pull_request_reviews=true`
6. Turn on Pages with Actions as the source: `gh api -X POST repos/{owner}/claudemods/pages -f build_type=workflow`. Set the custom domain: `gh api -X PUT repos/{owner}/claudemods/pages -f cname=claudemods.chat`. Then trigger `pages.yml` with `gh workflow run "Deploy site"`.
7. DNS at the registrar is a job for Omar. Apex A records: 185.199.108.153, 185.199.109.153, 185.199.110.153, 185.199.111.153. Apex AAAA records: 2606:50c0:8000::153, 2606:50c0:8001::153, 2606:50c0:8002::153, 2606:50c0:8003::153. Add `www` as a CNAME to `{owner}.github.io`. Once the cert is issued, turn on "Enforce HTTPS".
8. Smoke test:
   - In a fresh Claude Code session, run `/plugin marketplace add {owner}/claudemods`, then `/plugin install cc-arcade@claudemods`.
   - Open a test issue with the submission form. Check the bot comments. Add `approved` and check that a PR is opened. Close it without merging.
   - Run the Sync workflow once by hand.

## Backlog (after launch)

- A per-mod "reach" badge: scan the source for the `$` calls and hooked events, like karanb192/awesome-claude-code-mods. That list is our closest competitor.
- A weekly star-count refresh with `GITHUB_TOKEN`, written to `data/stats.json`, so the site can sort by popularity.
- Add mods that were verified but cut: wandercom/kindex, kbrdn1/claude-crosstalk (installed with make).
- A short demo GIF in the README. (The OG image, `site/og.png`, is a static file rendered once from HTML with headless Chrome.)
- A launch post (LinkedIn, X, r/ClaudeAI, Hacker News "Show HN").
