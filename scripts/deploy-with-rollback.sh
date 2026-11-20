#!/usr/bin/env bash
# Deploy ItalyCheck with smoke tests and automatic rollback (delegation D4: all tests green, smoke on /, /mcp,
# /v1/pa 402 (+ /v1/counterparty 402), rollback if anything fails). Needs CLOUDFLARE_API_TOKEN in the environment
# (never printed). Usage:
#   scripts/deploy-with-rollback.sh <rollback-version-id> [expected-commit] [base-url]
#   DRY_RUN=1 scripts/deploy-with-rollback.sh ...   # preflight only, stops before deploying
# <rollback-version-id>: the version live right now (check: wrangler deployments status). The script refuses to
# deploy if the live version differs, so the rollback target is always the real previous version.
set -euo pipefail
ROLLBACK="${1:?usage: $0 <rollback-version-id> [expected-commit] [base-url]}"
EXPECT_COMMIT="${2:-}"
BASE="${3:-https://italycheck.italycheck.workers.dev}"
cd "$(dirname "$0")/.."
W() { npx -y -p node@22 node node_modules/.bin/wrangler "$@"; }
live_version() { W deployments status --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s.slice(s.indexOf("{")));const v=j.versions||[];console.log(v.length===1&&v[0].percentage===100?v[0].version_id:"split:"+JSON.stringify(v))})'; }

echo "== preflight"
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "ABORT: uncommitted changes"; exit 1; }
HEAD=$(git rev-parse --short HEAD)
[ -z "$EXPECT_COMMIT" ] || [ "$(git rev-parse "$EXPECT_COMMIT")" = "$(git rev-parse HEAD)" ] || { echo "ABORT: HEAD $HEAD is not $EXPECT_COMMIT"; exit 1; }
git diff --quiet origin/main -- wrangler.toml || { echo "ABORT: wrangler.toml differs from origin/main"; exit 1; }
npm test > /tmp/italycheck-deploy-tests.log 2>&1 || { echo "ABORT: tests failed (see /tmp/italycheck-deploy-tests.log)"; exit 1; }
echo "tests: $(grep -c '^PASS' /tmp/italycheck-deploy-tests.log) PASS, $(grep -c '^FAIL' /tmp/italycheck-deploy-tests.log) FAIL"
rm -rf /tmp/italycheck-dryrun && W deploy --dry-run --outdir /tmp/italycheck-dryrun > /dev/null || { echo "ABORT: bundle build failed"; exit 1; }
LIVE=$(live_version)
[ "$LIVE" = "$ROLLBACK" ] || { echo "ABORT: live version is $LIVE, not $ROLLBACK (pass the current live version)"; exit 1; }
node scripts/smoke.mjs "$BASE" > /dev/null || { echo "ABORT: smoke already failing on the live version $LIVE"; exit 1; }

[ "${DRY_RUN:-}" = 1 ] && { echo "DRY_RUN: preflight OK, live $LIVE, not deploying"; exit 0; }
echo "== deploy $HEAD (rollback target $ROLLBACK)"
OUT=$(W deploy --message "$HEAD: $(git log -1 --format=%s | cut -c1-80)" 2>&1) || { echo "$OUT" | tail -5; echo "deploy command failed"; exit 1; }
NEW=$(echo "$OUT" | grep -oE 'Current Version ID: [0-9a-f-]{36}' | awk '{print $4}')
echo "new version: ${NEW:-unknown}"

echo "== smoke (3 attempts, 15 s apart)"
okrun=0
for i in 1 2 3; do sleep 15; if node scripts/smoke.mjs "$BASE"; then okrun=1; break; fi; done
NOWLIVE=$(live_version)
if [ "$okrun" = 1 ] && [ -n "$NEW" ] && [ "$NOWLIVE" = "$NEW" ]; then
  echo "DEPLOY OK: version $NEW live (commit $HEAD), smoke green"; exit 0
fi
echo "== ROLLBACK to $ROLLBACK (smoke=$okrun new=${NEW:-?} live=$NOWLIVE)"
W rollback "$ROLLBACK" --message "auto-rollback: smoke failed for $HEAD" --yes
sleep 15
node scripts/smoke.mjs "$BASE" && echo "ROLLED BACK: $ROLLBACK live again, smoke green" || echo "ROLLED BACK but smoke still failing: check now"
exit 1
