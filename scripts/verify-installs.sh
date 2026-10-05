#!/usr/bin/env bash
# Installs every plugin in the claudemods marketplace into a throwaway Claude Code
# config dir and reports failures. Needs the `claude` CLI on PATH. Runs weekly in
# CI (.github/workflows/install-test.yml) and on pull requests that change data/.
set -uo pipefail
cd "$(dirname "$0")/.."
export CLAUDE_CONFIG_DIR="$(mktemp -d)"
trap 'rm -rf "$CLAUDE_CONFIG_DIR"' EXIT
# macOS has no `timeout` unless coreutils is installed (as `gtimeout`).
limit=() ; if command -v timeout >/dev/null; then limit=(timeout 180); elif command -v gtimeout >/dev/null; then limit=(gtimeout 180); fi
claude plugin validate . || exit 1
claude plugin marketplace add ./ >/dev/null
total=0; fail=0
for p in $(node -e 'for (const p of require("./.claude-plugin/marketplace.json").plugins) console.log(p.name)'); do
  total=$((total+1))
  if out=$(${limit[@]+"${limit[@]}"} claude plugin install "$p@claudemods" 2>&1) && grep -q "Successfully installed" <<<"$out"; then
    echo "ok    $p"
  else
    echo "FAIL  $p :: $(tail -1 <<<"$out")"; fail=$((fail+1))
  fi
done
echo "installed $((total-fail))/$total, failures: $fail"
exit $((fail > 0))
