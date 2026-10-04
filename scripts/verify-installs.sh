#!/usr/bin/env bash
# Installs every plugin in the claudemods marketplace into a throwaway Claude Code
# config dir and reports failures. Needs the `claude` CLI on PATH.
set -uo pipefail
cd "$(dirname "$0")/.."
export CLAUDE_CONFIG_DIR="$(mktemp -d)"
claude plugin validate . || exit 1
claude plugin marketplace add ./ >/dev/null
fail=0
for p in $(node -e 'for (const p of require("./.claude-plugin/marketplace.json").plugins) console.log(p.name)'); do
  if out=$(timeout 180 claude plugin install "$p@claudemods" 2>&1) && ! grep -qiE "error|failed" <<<"$out"; then
    echo "ok    $p"
  else
    echo "FAIL  $p :: $(tail -1 <<<"$out")"; fail=$((fail+1))
  fi
done
echo "failures: $fail"
exit $((fail > 0))
