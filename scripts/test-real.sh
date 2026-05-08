#!/usr/bin/env bash
# SousMCP integration test suite
# Each step prints PASS or FAIL and at the end exits 0 (all pass) or 1 (any fail).
#
# Usage:  bash scripts/test-real.sh
#         npm run test:integration   (alias in root package.json)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="node $ROOT/packages/proxy/bin/sousmcp.js"
PROXY="node $ROOT/packages/proxy/dist/index.js"

FAKE_CFG="/tmp/sousmcp-test-claude-config.json"
DRYRUN_CFG="/tmp/sousmcp-test-dryrun-config.json"
EXPORT_FILE="/tmp/sousmcp-test-export.json"

PASS=0
FAIL=0

# ── Colour helpers ────────────────────────────────────────────────────────────
GREEN='\033[32m'; RED='\033[31m'; BOLD='\033[1m'; RESET='\033[0m'
pass() { printf "${GREEN}✓ PASS${RESET}: %s\n" "$1"; PASS=$((PASS+1)); }
fail() { printf "${RED}✗ FAIL${RESET}: %s\n" "$1"; FAIL=$((FAIL+1)); }
header() { printf "\n${BOLD}=== %s ===${RESET}\n" "$1"; }

# ── Cleanup on exit ───────────────────────────────────────────────────────────
cleanup() {
  rm -f "$FAKE_CFG" "$FAKE_CFG.sousmcp.bak"
  rm -f "$DRYRUN_CFG" "$DRYRUN_CFG.sousmcp.bak"
  rm -f "$EXPORT_FILE"
}
trap cleanup EXIT

# ─────────────────────────────────────────────────────────────────────────────
# 1. Build
# ─────────────────────────────────────────────────────────────────────────────
header "1. Build"
if npm --prefix "$ROOT" run build > /tmp/sousmcp-build.log 2>&1; then
  pass "npm run build"
else
  fail "npm run build"
  echo "--- build log ---"
  cat /tmp/sousmcp-build.log
  exit 1   # Can't continue without a build
fi

# ─────────────────────────────────────────────────────────────────────────────
# 2. Doctor
# ─────────────────────────────────────────────────────────────────────────────
header "2. sousmcp doctor"
DOCTOR_OUT=$($CLI doctor 2>&1) || true
printf "%s\n" "$DOCTOR_OUT"

if printf "%s" "$DOCTOR_OUT" | grep -q "Node.js"; then
  pass "doctor shows Node.js version check"
else
  fail "doctor shows Node.js version check"
fi

if printf "%s" "$DOCTOR_OUT" | grep -qE '✓|✗'; then
  pass "doctor outputs check results (✓/✗)"
else
  fail "doctor outputs check results"
fi

if printf "%s" "$DOCTOR_OUT" | grep -q "Database"; then
  pass "doctor checks database"
else
  fail "doctor checks database"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 3. Create fake Claude Desktop config
# ─────────────────────────────────────────────────────────────────────────────
header "3. Fake config"
cat > "$FAKE_CFG" <<'JSON'
{
  "mcpServers": {
    "test-server-alpha": {
      "command": "python3",
      "args": ["-m", "mcp.server"]
    },
    "test-server-beta": {
      "command": "node",
      "args": ["server.js"]
    }
  }
}
JSON
pass "Created fake Claude Desktop config with 2 servers"

# ─────────────────────────────────────────────────────────────────────────────
# 4. Install --dry-run (must not modify file)
# ─────────────────────────────────────────────────────────────────────────────
header "4. sousmcp install --dry-run"
cat > "$DRYRUN_CFG" <<'JSON'
{
  "mcpServers": {
    "dry-server": {
      "command": "python3",
      "args": ["server.py"]
    }
  }
}
JSON
DRYRUN_BEFORE=$(cat "$DRYRUN_CFG")

DRYRUN_OUT=$($CLI install --config "$DRYRUN_CFG" --dry-run 2>&1) || true
printf "%s\n" "$DRYRUN_OUT"

if printf "%s" "$DRYRUN_OUT" | grep -qi "dry run"; then
  pass "install --dry-run prints dry-run notice"
else
  fail "install --dry-run prints dry-run notice"
fi

if printf "%s" "$DRYRUN_OUT" | grep -q "Would wrap"; then
  pass "install --dry-run shows 'Would wrap'"
else
  fail "install --dry-run shows 'Would wrap'"
fi

DRYRUN_AFTER=$(cat "$DRYRUN_CFG")
if [ "$DRYRUN_BEFORE" = "$DRYRUN_AFTER" ]; then
  pass "install --dry-run did NOT modify the config file"
else
  fail "install --dry-run MODIFIED the config file (should be read-only)"
fi

if printf "%s" "$DRYRUN_OUT" | grep -q "\-.*command:.*python3"; then
  pass "install --dry-run shows before (- command: python3)"
else
  fail "install --dry-run shows before state"
fi

rm -f "$DRYRUN_CFG"

# ─────────────────────────────────────────────────────────────────────────────
# 5. Install --config
# ─────────────────────────────────────────────────────────────────────────────
header "5. sousmcp install --config"
INSTALL_OUT=$($CLI install --config "$FAKE_CFG" 2>&1) || true
printf "%s\n" "$INSTALL_OUT"

if printf "%s" "$INSTALL_OUT" | grep -q "Wrapped 2"; then
  pass "install --config wrapped 2 servers"
else
  fail "install --config wrapped 2 servers"
fi

if [ -f "$FAKE_CFG.sousmcp.bak" ]; then
  pass "install created backup at .sousmcp.bak"
else
  fail "install created backup at .sousmcp.bak"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 6. Verify servers got wrapped correctly
# ─────────────────────────────────────────────────────────────────────────────
header "6. Verify wrapping"
WRAP_CHECK=$(node -e "
  const d = JSON.parse(require('fs').readFileSync('$FAKE_CFG', 'utf8'));
  const s = Object.values(d.mcpServers || {});
  const wrapped = s.filter(v => (v.args || []).some(a => a.includes('dist/index.js'))).length;
  const allNode = s.every(v => v.command && v.command.includes('node'));
  const hasDb   = s.every(v => v.env && v.env.SOUSMCP_DB);
  console.log(JSON.stringify({ wrapped, allNode, hasDb, total: s.length }));
" 2>/dev/null)

WRAPPED_N=$(printf "%s" "$WRAP_CHECK" | node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).wrapped))")
TOTAL_N=$(printf "%s" "$WRAP_CHECK" | node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).total))")
ALL_NODE=$(printf "%s" "$WRAP_CHECK" | node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).allNode))")
HAS_DB=$(printf "%s" "$WRAP_CHECK" | node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).hasDb))")

if [ "$WRAPPED_N" = "$TOTAL_N" ] && [ "$TOTAL_N" = "2" ]; then
  pass "Both servers have dist/index.js in args ($WRAPPED_N/$TOTAL_N)"
else
  fail "Not all servers wrapped (found $WRAPPED_N of $TOTAL_N)"
fi

if [ "$ALL_NODE" = "true" ]; then
  pass "All servers use node binary as command"
else
  fail "All servers should use node binary as command"
fi

if [ "$HAS_DB" = "true" ]; then
  pass "All servers have SOUSMCP_DB env set"
else
  fail "All servers should have SOUSMCP_DB env set"
fi

# Original args preserved inside proxy args
ALPHA_ARGS=$(node -e "
  const d = JSON.parse(require('fs').readFileSync('$FAKE_CFG', 'utf8'));
  console.log(JSON.stringify(d.mcpServers['test-server-alpha'].args));
" 2>/dev/null)
if printf "%s" "$ALPHA_ARGS" | grep -q -- '-m'; then
  pass "Original args (-m mcp.server) preserved in wrapped config"
else
  fail "Original args should be preserved (got: $ALPHA_ARGS)"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 7. Pipe 10 JSON-RPC messages through the proxy (cat as MCP server)
# ─────────────────────────────────────────────────────────────────────────────
header "7. Proxy integration (stdin → cat → stdout)"
# Use only methods that log-all catches (no pause-triggering tool names).
MSGS='{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{}},"id":1}
{"jsonrpc":"2.0","method":"tools/list","id":2}
{"jsonrpc":"2.0","method":"resources/list","id":3}
{"jsonrpc":"2.0","method":"prompts/list","id":4}
{"jsonrpc":"2.0","method":"ping","id":5}
{"jsonrpc":"2.0","method":"tools/call","params":{"name":"read_file","arguments":{"path":"/tmp/test.txt"}},"id":6}
{"jsonrpc":"2.0","method":"tools/call","params":{"name":"write_file","arguments":{"path":"/tmp/out.txt","content":"hi"}},"id":7}
{"jsonrpc":"2.0","method":"tools/call","params":{"name":"execute_command","arguments":{"command":"echo hello"}},"id":8}
{"jsonrpc":"2.0","method":"notifications/initialized","id":9}
{"jsonrpc":"2.0","method":"tools/call","params":{"name":"get_info","arguments":{}},"id":10}'

# The proxy closes child stdin when host stdin reaches EOF (fixed in interceptor),
# so cat exits naturally and the proxy follows — no timeout needed.
PROXY_OUT=$(printf "%s\n" "$MSGS" | $PROXY cat 2>/dev/null) || true

OUTBOUND_COUNT=$(printf "%s\n" "$PROXY_OUT" | grep -c '"jsonrpc"' || echo 0)
if [ "$OUTBOUND_COUNT" -ge 8 ]; then
  pass "Proxy forwarded and echoed $OUTBOUND_COUNT messages (≥8 expected)"
else
  fail "Proxy forwarded messages: expected ≥8, got $OUTBOUND_COUNT"
fi

# Check a known method appears in outbound stream
if printf "%s\n" "$PROXY_OUT" | grep -q '"initialize"'; then
  pass "initialize message round-tripped through proxy"
else
  fail "initialize message should appear in proxy output"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 8. sousmcp log
# ─────────────────────────────────────────────────────────────────────────────
header "8. sousmcp log"
LOG_OUT=$($CLI log 2>&1) || true
printf "%s\n" "$LOG_OUT"

if printf "%s" "$LOG_OUT" | grep -qE "initialize|tools/list|tools/call"; then
  pass "log shows intercepted messages from proxy session"
else
  fail "log should show intercepted messages"
fi

if printf "%s" "$LOG_OUT" | grep -q "chain intact"; then
  pass "log shows 'chain intact'"
else
  fail "log should show 'chain intact'"
fi

if printf "%s" "$LOG_OUT" | grep -q "hash:"; then
  pass "log shows hash values"
else
  fail "log should show hash values"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 9. sousmcp digest
# ─────────────────────────────────────────────────────────────────────────────
header "9. sousmcp digest"
DIGEST_OUT=$($CLI digest 2>&1) || true
printf "%s\n" "$DIGEST_OUT"

if printf "%s" "$DIGEST_OUT" | grep -q "Weekly Digest"; then
  pass "digest produces weekly digest header"
else
  fail "digest should produce weekly digest header"
fi

if printf "%s" "$DIGEST_OUT" | grep -q "tool calls"; then
  pass "digest shows tool call count"
else
  fail "digest should show tool call count"
fi

if printf "%s" "$DIGEST_OUT" | grep -q "Generated by SousMCP"; then
  pass "digest has generation footer"
else
  fail "digest should have generation footer"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 10. sousmcp export
# ─────────────────────────────────────────────────────────────────────────────
header "10. sousmcp export"
TODAY=$(date +%Y-%m-%d)
EXPORT_OUT=$($CLI export --from 2020-01-01 --to "$TODAY" --out "$EXPORT_FILE" 2>&1) || true
printf "%s\n" "$EXPORT_OUT"

if [ -f "$EXPORT_FILE" ]; then
  pass "export created bundle file at $EXPORT_FILE"
else
  fail "export should create bundle file"
fi

if printf "%s" "$EXPORT_OUT" | grep -q "Exported"; then
  pass "export reports exported message count"
else
  fail "export should report exported message count"
fi

if node -e "JSON.parse(require('fs').readFileSync('$EXPORT_FILE','utf8'))" 2>/dev/null; then
  pass "export bundle is valid JSON"
else
  fail "export bundle should be valid JSON"
fi

SCHEMA_OK=$(node -e "
  const b = JSON.parse(require('fs').readFileSync('$EXPORT_FILE','utf8'));
  const ok = b.version === 1
    && typeof b.bundleHash === 'string' && b.bundleHash.length === 64
    && Array.isArray(b.messages)
    && Array.isArray(b.sessions)
    && typeof b.merkleRoots === 'object';
  console.log(ok ? 'yes' : 'no');
" 2>/dev/null)
if [ "$SCHEMA_OK" = "yes" ]; then
  pass "export bundle has correct schema (version, bundleHash, messages, sessions, merkleRoots)"
else
  fail "export bundle schema invalid"
fi

MSG_COUNT_IN_BUNDLE=$(node -e "
  const b = JSON.parse(require('fs').readFileSync('$EXPORT_FILE','utf8'));
  console.log(b.messages.length);
" 2>/dev/null)
if [ "$MSG_COUNT_IN_BUNDLE" -ge 8 ]; then
  pass "export bundle contains $MSG_COUNT_IN_BUNDLE messages (≥8 expected)"
else
  fail "export bundle should contain ≥8 messages (got $MSG_COUNT_IN_BUNDLE)"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 11. sousmcp verify
# ─────────────────────────────────────────────────────────────────────────────
header "11. sousmcp verify"
VERIFY_OUT=$($CLI verify "$EXPORT_FILE" 2>&1) || true
printf "%s\n" "$VERIFY_OUT"

if printf "%s" "$VERIFY_OUT" | grep -q "intact"; then
  pass "verify confirms bundle integrity"
else
  fail "verify should confirm bundle integrity"
fi

if printf "%s" "$VERIFY_OUT" | grep -q "SHA-256"; then
  pass "verify confirms SHA-256 hash"
else
  fail "verify should confirm SHA-256 hash"
fi

if printf "%s" "$VERIFY_OUT" | grep -q "Merkle"; then
  pass "verify confirms Merkle chain"
else
  fail "verify should confirm Merkle chain"
fi

# Tamper test: modify a byte and verify it catches the tamper
TAMPERED="/tmp/sousmcp-test-tampered.json"
node -e "
  const b = JSON.parse(require('fs').readFileSync('$EXPORT_FILE','utf8'));
  b.bundleHash = 'deadbeef' + b.bundleHash.slice(8);
  require('fs').writeFileSync('$TAMPERED', JSON.stringify(b));
" 2>/dev/null
TAMPER_OUT=$($CLI verify "$TAMPERED" 2>&1) || true
rm -f "$TAMPERED"
if printf "%s" "$TAMPER_OUT" | grep -qiE "FAILED|mismatch|tamper"; then
  pass "verify detects tampered bundle"
else
  fail "verify should detect tampered bundle"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 12. sousmcp uninstall --config
# ─────────────────────────────────────────────────────────────────────────────
header "12. sousmcp uninstall --config"
UNINSTALL_OUT=$($CLI uninstall --config "$FAKE_CFG" 2>&1) || true
printf "%s\n" "$UNINSTALL_OUT"

if printf "%s" "$UNINSTALL_OUT" | grep -q "Restored"; then
  pass "uninstall --config restored from backup"
else
  fail "uninstall --config should restore from backup"
fi

if [ ! -f "$FAKE_CFG.sousmcp.bak" ]; then
  pass "backup file removed after uninstall"
else
  fail "backup file should be removed after uninstall"
fi

STILL_WRAPPED=$(node -e "
  const d = JSON.parse(require('fs').readFileSync('$FAKE_CFG','utf8'));
  const n = Object.values(d.mcpServers||{}).filter(v=>(v.args||[]).some(a=>a.includes('dist/index.js'))).length;
  console.log(n);
" 2>/dev/null)
if [ "$STILL_WRAPPED" = "0" ]; then
  pass "After uninstall, no servers have dist/index.js in args"
else
  fail "After uninstall, $STILL_WRAPPED server(s) still wrapped"
fi

# Verify the original commands were restored
ORIG_ALPHA=$(node -e "
  const d = JSON.parse(require('fs').readFileSync('$FAKE_CFG','utf8'));
  console.log(d.mcpServers['test-server-alpha'].command);
" 2>/dev/null)
if [ "$ORIG_ALPHA" = "python3" ]; then
  pass "test-server-alpha command restored to python3"
else
  fail "test-server-alpha command should be python3 (got: $ORIG_ALPHA)"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 13. Graceful degradation (missing client config)
# ─────────────────────────────────────────────────────────────────────────────
header "13. Graceful degradation"
MISSING_CFG="/tmp/sousmcp-test-does-not-exist-$(date +%s).json"
DEGRADE_OUT=$($CLI install --config "$MISSING_CFG" 2>&1) || true
printf "%s\n" "$DEGRADE_OUT"

if printf "%s" "$DEGRADE_OUT" | grep -qiE "not found|cannot|Config file not found"; then
  pass "install with missing --config shows clear error"
else
  fail "install with missing --config should show clear error"
fi

# Test Claude Desktop not found path (simulate by passing a non-existent bare install path)
# We test this indirectly: doctor should list Claude config check
DOCTOR2_OUT=$($CLI doctor 2>&1) || true
if printf "%s" "$DOCTOR2_OUT" | grep -qi "Claude Desktop"; then
  pass "doctor reports Claude Desktop status"
else
  fail "doctor should report Claude Desktop status"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────────────────────
printf "\n${BOLD}=== Results ===${RESET}\n"
printf "${GREEN}%d passed${RESET}, ${RED}%d failed${RESET}\n" "$PASS" "$FAIL"

if [ "$FAIL" -eq 0 ]; then
  printf "\n${GREEN}${BOLD}✓ ALL %d TESTS PASSED${RESET}\n\n" "$PASS"
  exit 0
else
  printf "\n${RED}${BOLD}✗ %d TEST(S) FAILED${RESET}\n\n" "$FAIL"
  exit 1
fi
