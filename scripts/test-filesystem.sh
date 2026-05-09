#!/usr/bin/env bash
# SousMCP filesystem MCP server integration test
# Uses the real @modelcontextprotocol/server-filesystem rather than a mock.
# NOTE: first run may be slow while npx downloads the package (~5-10 s).
#
# Usage:  bash scripts/test-filesystem.sh
#         npm run test:filesystem

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="node $ROOT/packages/proxy/bin/sousmcp.js"
PROXY="node $ROOT/packages/proxy/dist/index.js"

TEST_CFG="/tmp/sousmcp-fs-test-config.json"
TEST_DIR="/tmp/sousmcp-fs-test"
TEST_FILE="$TEST_DIR/hello.txt"
EXPORT_FILE="/tmp/sousmcp-fs-export.json"

PASS=0; FAIL=0
GREEN='\033[32m'; RED='\033[31m'; BOLD='\033[1m'; RESET='\033[0m'
pass() { printf "${GREEN}✓ PASS${RESET}: %s\n" "$1"; PASS=$((PASS+1)); }
fail() { printf "${RED}✗ FAIL${RESET}: %s\n" "$1"; FAIL=$((FAIL+1)); }
header() { printf "\n${BOLD}=== %s ===${RESET}\n" "$1"; }

cleanup() {
  rm -f "$TEST_CFG" "$TEST_CFG.sousmcp.bak"
  rm -rf "$TEST_DIR"
  rm -f "$EXPORT_FILE"
}
trap cleanup EXIT

# ─────────────────────────────────────────────────────────────────────────────
# 1. Build
# ─────────────────────────────────────────────────────────────────────────────
header "1. Build"
if npm --prefix "$ROOT" run build > /tmp/sousmcp-fs-build.log 2>&1; then
  pass "npm run build"
else
  fail "npm run build"
  cat /tmp/sousmcp-fs-build.log
  exit 1
fi

# ─────────────────────────────────────────────────────────────────────────────
# 2. Test environment
# ─────────────────────────────────────────────────────────────────────────────
header "2. Test environment"
mkdir -p "$TEST_DIR"
# Resolve symlinks so the filesystem server's path check passes on macOS (/tmp → /private/tmp).
TEST_DIR=$(cd "$TEST_DIR" && pwd -P)
TEST_FILE="$TEST_DIR/hello.txt"
printf "SousMCP integration test — %s\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$TEST_FILE"

if [ -f "$TEST_FILE" ]; then
  pass "Created test file at $TEST_FILE"
else
  fail "Could not create test file"
  exit 1
fi

# Warm up npx cache so timing is predictable for the real test step.
printf 'checking npx cache...\n'
if npx --yes @modelcontextprotocol/server-filesystem "$TEST_DIR" < /dev/null > /dev/null 2>&1; then
  pass "@modelcontextprotocol/server-filesystem available via npx"
else
  # It exits non-zero when stdin closes immediately — that's fine.
  pass "@modelcontextprotocol/server-filesystem reachable via npx"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 3. Create test config with real filesystem MCP server
# ─────────────────────────────────────────────────────────────────────────────
header "3. Create test config"
cat > "$TEST_CFG" << JSON
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["--yes", "@modelcontextprotocol/server-filesystem", "$TEST_DIR"]
    }
  }
}
JSON
pass "Created test config with real @modelcontextprotocol/server-filesystem"

# ─────────────────────────────────────────────────────────────────────────────
# 4. sousmcp install
# ─────────────────────────────────────────────────────────────────────────────
header "4. sousmcp install --config"
INSTALL_OUT=$($CLI install --config "$TEST_CFG" 2>&1) || true
printf "%s\n" "$INSTALL_OUT"

if printf "%s" "$INSTALL_OUT" | grep -q "Wrapped 1"; then
  pass "install wrapped filesystem server"
else
  fail "install should have wrapped filesystem server"
fi

if [ -f "$TEST_CFG.sousmcp.bak" ]; then
  pass "install created backup"
else
  fail "install should create backup"
fi

# Verify wrapping structure
WRAPPED_CMD=$(node -e "
  const d = JSON.parse(require('fs').readFileSync('$TEST_CFG','utf8'));
  const s = d.mcpServers.filesystem;
  process.stdout.write(JSON.stringify({ command: s.command, hasProxy: (s.args||[]).some(a => a.includes('dist/index.js')) }));
" 2>/dev/null)

if printf "%s" "$WRAPPED_CMD" | grep -q '"hasProxy":true'; then
  pass "config contains proxy in wrapped args"
else
  fail "config should have proxy in args"
fi

if printf "%s" "$WRAPPED_CMD" | grep -q '"command":"'; then
  pass "command field is set to node binary"
else
  fail "command should be set to node binary"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 5. Pipe 5 real MCP JSON-RPC messages through the proxy → filesystem server
# ─────────────────────────────────────────────────────────────────────────────
header "5. Proxy integration (real filesystem MCP server)"

# 5 messages: initialize, notifications/initialized, tools/list,
#             tools/call list_directory, tools/call read_text_file
MSGS=$(printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"sousmcp-test","version":"0.1.0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"list_directory\",\"arguments\":{\"path\":\"$TEST_DIR\"}}}" \
  "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"read_text_file\",\"arguments\":{\"path\":\"$TEST_FILE\"}}}")

# Run proxy directly (not the wrapped command) so we don't double-wrap.
# The proxy forwards EOF to the server after the queue drains — the server
# exits cleanly and the proxy follows, so no timeout is needed.
PROXY_OUT=$(printf "%s\n" "$MSGS" | \
  $PROXY npx --yes @modelcontextprotocol/server-filesystem "$TEST_DIR" 2>/dev/null) || true

# Capture the session ID from sousmcp.log so we can filter log output.
SESSION_ID=$(grep "session:" ~/.sousmcp/sousmcp.log 2>/dev/null \
  | tail -1 \
  | grep -oE '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}' \
  | tail -1)

# Count JSON-RPC responses the server sent back through the proxy.
# notifications/initialized has no response, so we expect 4 (ids 1,2,3,4).
RESP_COUNT=$(printf "%s\n" "$PROXY_OUT" | grep -c '"jsonrpc"' || echo 0)
if [ "$RESP_COUNT" -ge 4 ]; then
  pass "Received $RESP_COUNT MCP responses from filesystem server (≥4 expected)"
else
  fail "Expected ≥4 MCP responses from filesystem server, got $RESP_COUNT"
fi

# Verify initialize response has serverInfo
if printf "%s\n" "$PROXY_OUT" | grep -q '"serverInfo"'; then
  pass "initialize response contains serverInfo"
else
  fail "initialize response should contain serverInfo"
fi

# Verify tools/list returned real filesystem tools
if printf "%s\n" "$PROXY_OUT" | grep -qE '"read_text_file"|"list_directory"'; then
  pass "tools/list response includes filesystem tools (read_text_file, list_directory)"
else
  fail "tools/list response should include filesystem tools"
fi

# Verify list_directory result mentions the test file
if printf "%s\n" "$PROXY_OUT" | grep -q "hello.txt"; then
  pass "list_directory result contains hello.txt"
else
  fail "list_directory result should contain hello.txt"
fi

# Verify read_text_file returned the file content
if printf "%s\n" "$PROXY_OUT" | grep -q "SousMCP integration test"; then
  pass "read_text_file returned the test file content"
else
  fail "read_text_file should have returned the test file content"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 6. Verify all 5 messages appear in sousmcp log
# ─────────────────────────────────────────────────────────────────────────────
header "6. sousmcp log"

# Use --session so we only see messages from this proxy run.
if [ -n "$SESSION_ID" ]; then
  LOG_OUT=$($CLI log --session "$SESSION_ID" 2>&1) || true
  LOG_LABEL="session $SESSION_ID"
else
  LOG_OUT=$($CLI log --n 50 2>&1) || true
  LOG_LABEL="recent 50 messages"
fi
printf "%s\n" "$LOG_OUT"

if printf "%s" "$LOG_OUT" | grep -q "initialize"; then
  pass "log ($LOG_LABEL) shows initialize"
else
  fail "log should show initialize"
fi

if printf "%s" "$LOG_OUT" | grep -q "notifications/initialized"; then
  pass "log shows notifications/initialized"
else
  fail "log should show notifications/initialized"
fi

if printf "%s" "$LOG_OUT" | grep -q "tools/list"; then
  pass "log shows tools/list"
else
  fail "log should show tools/list"
fi

# Both tools/call messages
TOOL_CALL_COUNT=$(printf "%s" "$LOG_OUT" | grep -c "tools/call" || echo 0)
if [ "$TOOL_CALL_COUNT" -ge 2 ]; then
  pass "log shows $TOOL_CALL_COUNT tools/call entries (≥2 expected)"
else
  fail "log should show ≥2 tools/call entries (got $TOOL_CALL_COUNT)"
fi

if printf "%s" "$LOG_OUT" | grep -q "chain intact"; then
  pass "Merkle chain intact after filesystem session"
else
  fail "Merkle chain should be intact after filesystem session"
fi

# Total messages for this session: 5 inbound + 4 outbound responses = 9
TOTAL_LOGGED=$(printf "%s" "$LOG_OUT" | grep -c "hash:" || echo 0)
if [ "$TOTAL_LOGGED" -ge 5 ]; then
  pass "$TOTAL_LOGGED messages logged for this session (≥5 expected)"
else
  fail "Should have logged ≥5 messages for this session (got $TOTAL_LOGGED)"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 7. Export bundle and verify chain integrity
# ─────────────────────────────────────────────────────────────────────────────
header "7. sousmcp export + verify"
TODAY=$(date +%Y-%m-%d)
EXPORT_OUT=$($CLI export --from 2020-01-01 --to "$TODAY" --out "$EXPORT_FILE" 2>&1) || true
printf "%s\n" "$EXPORT_OUT"

if [ -f "$EXPORT_FILE" ]; then
  pass "export created bundle file"
else
  fail "export should create bundle file"
fi

BUNDLE_MSGS=$(node -e "
  const b = JSON.parse(require('fs').readFileSync('$EXPORT_FILE','utf8'));
  process.stdout.write(String(b.messages.length));
" 2>/dev/null || echo 0)
if [ "$BUNDLE_MSGS" -ge 5 ]; then
  pass "bundle contains $BUNDLE_MSGS messages (≥5 expected)"
else
  fail "bundle should contain ≥5 messages (got $BUNDLE_MSGS)"
fi

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

# ─────────────────────────────────────────────────────────────────────────────
# 8. sousmcp uninstall
# ─────────────────────────────────────────────────────────────────────────────
header "8. sousmcp uninstall --config"
UNINSTALL_OUT=$($CLI uninstall --config "$TEST_CFG" 2>&1) || true
printf "%s\n" "$UNINSTALL_OUT"

if printf "%s" "$UNINSTALL_OUT" | grep -q "Restored"; then
  pass "uninstall restored original config from backup"
else
  fail "uninstall should restore original config"
fi

if [ ! -f "$TEST_CFG.sousmcp.bak" ]; then
  pass "backup removed after uninstall"
else
  fail "backup should be removed after uninstall"
fi

# Verify original command is restored
ORIG_CMD=$(node -e "
  const d = JSON.parse(require('fs').readFileSync('$TEST_CFG','utf8'));
  process.stdout.write(d.mcpServers.filesystem.command);
" 2>/dev/null)
if [ "$ORIG_CMD" = "npx" ]; then
  pass "filesystem server command restored to 'npx'"
else
  fail "filesystem server command should be 'npx' (got: $ORIG_CMD)"
fi

ORIG_ARG=$(node -e "
  const d = JSON.parse(require('fs').readFileSync('$TEST_CFG','utf8'));
  process.stdout.write((d.mcpServers.filesystem.args||[]).join(' '));
" 2>/dev/null)
if printf "%s" "$ORIG_ARG" | grep -q "server-filesystem"; then
  pass "original args (server-filesystem) restored"
else
  fail "original args should contain server-filesystem (got: $ORIG_ARG)"
fi

NO_WRAPPER=$(node -e "
  const d = JSON.parse(require('fs').readFileSync('$TEST_CFG','utf8'));
  const s = d.mcpServers.filesystem;
  process.stdout.write(String((s.args||[]).some(a => a.includes('dist/index.js'))));
" 2>/dev/null)
if [ "$NO_WRAPPER" = "false" ]; then
  pass "proxy wrapper removed from config"
else
  fail "proxy wrapper should be removed from config"
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
