# SousMCP

> A sousveillant transparency and security layer for MCP agents

[![CI](https://github.com/abdulahad014993-bot/SousMCP/actions/workflows/ci.yml/badge.svg)](https://github.com/abdulahad014993-bot/SousMCP/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.0.0-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue)](https://www.typescriptlang.org)

SousMCP sits transparently between any AI agent and an MCP (Model Context Protocol) server. It intercepts every tool call, enforces configurable policies, logs to a tamper-evident SQLite database, optionally pauses for human approval, and dramatically reduces token usage — all without the agent or server knowing it's there.

---

## Why SousMCP?

AI agents using MCP can silently read files, send emails, execute shell commands, or exfiltrate data through any tool the server exposes. SousMCP gives you:

- **Eyes on every action** — real-time interception with cryptographic audit trail
- **OWASP-aligned threat detection** — toxic capability pairs, prompt injection, credential exfiltration
- **Up to 95% token reduction** — 6-layer optimizer that strips full schemas, caches results, and compresses large responses
- **Tool quarantine** — new tools require explicit approval before they can run
- **Fine-grained ACL** — per-server, time-based, and rate-limit policies
- **SIEM integration** — Webhook, file (JSONL/Splunk), and syslog exporters

The name is a play on *sousveillance* — watching from below, by the person being acted upon.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         AI Agent (host)                             │
└────────────────────────────┬────────────────────────────────────────┘
                             │ stdin / stdout (JSON-RPC 2.0)
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        SousMCP Proxy                                │
│                                                                     │
│  Outbound Transform (server → host):                                │
│    Layer 1: Dynamic schema stripping     Layer 5: Schema minify     │
│    Layer 3: Response compression         Layer 6: Result filtering  │
│                                                                     │
│  Inbound Pipeline (host → server):                                  │
│    Virtual tools → Optimizer cache → Quarantine → Policy → Forward  │
│                                                                     │
│  ┌──────────────┐  ┌─────────────┐  ┌────────────┐  ┌──────────┐  │
│  │  Interceptor  │  │PolicyEngine │  │ QuarantineMgr│  │AgentMonitor│ │
│  │ (stdio proxy) │  │ (YAML/ACL)  │  │(known-tools)│  │(lsof+env) │ │
│  └──────────────┘  └─────────────┘  └────────────┘  └──────────┘  │
│                                                                     │
│  ┌──────────────┐  ┌─────────────┐  ┌────────────────────────────┐ │
│  │  LogStore    │  │ Optimizer   │  │    ExporterManager         │ │
│  │ (SQLite,     │  │ (6-layer    │  │  Webhook · File · Syslog   │ │
│  │  Merkle chain│  │  token opt) │  │                            │ │
│  └──────────────┘  └─────────────┘  └────────────────────────────┘ │
│                                                                     │
│  REST API :8787                                                     │
│  /api/sessions  /api/messages  /api/policies  /api/quarantine       │
│  /api/optimizer /api/activity  /api/debug     /api/health           │
└────────────────────────────┬────────────────────────────────────────┘
                             │ forwarded (or blocked / compressed)
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│                       MCP Server (target)                           │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Quick Start

**Requirements:** Node.js ≥ 22.0.0, npm ≥ 9

```bash
# 1. Install globally
npm install -g @sousmcp/proxy

# 2. Wrap your Claude Desktop MCP servers (one command)
sousmcp install

# 3. Restart Claude Desktop, then check status
sousmcp status
```

All your MCP traffic is now logged, policy-checked, quarantine-gated, and token-optimized.

**Development / manual wrapping:**

```bash
# Start all configured servers under the proxy
sousmcp start

# Or wrap a single server manually
node packages/proxy/dist/index.js python3 my_mcp_server.py

# Manage tool quarantine
sousmcp quarantine list
sousmcp quarantine approve filesystem read_file
sousmcp quarantine deny filesystem execute_command
```

---

## Token Optimization

SousMCP includes a **6-layer token optimization engine** that can reduce agent token usage by up to 95%.

### Layer 1: Dynamic Tool Schema Loading *(biggest win — 90%+ input reduction)*

When enabled (`optimization.dynamicToolsets: true`), SousMCP intercepts `tools/list` responses and strips the full `inputSchema` from every tool before the agent sees them. Instead of sending thousands of tokens of schema JSON upfront, agents receive minimal stubs.

Four virtual proxy tools are injected into the tool list:

| Tool | Purpose |
|---|---|
| `sousmcp_search_tools` | Find tools by keyword — returns names + one-line descriptions |
| `sousmcp_describe_tool` | Get the full `inputSchema` for a single tool |
| `sousmcp_execute_tool` | Run any tool by name; translated to a real `tools/call` |
| `sousmcp_get_full_response` | Retrieve a compressed response's full content by `ref_id` |

Progressive revelation: once the agent actually calls a tool, its full schema is included in future `tools/list` responses automatically.

### Layer 2: Semantic Response Caching

LRU in-memory cache (L1) backed by SQLite (L2). Cache keys are `SHA-256(toolName + JSON.stringify(args))`.

Default TTLs (configurable per tool name):

| Tool pattern | TTL |
|---|---|
| `read_file`, `list_directory` | 30 s |
| `search`, `web_search` | 60 s |
| `fetch`, `http_get` | 0 (never cache) |
| Write/create/delete | 0 (never cache) |
| Everything else | 10 s |

**Adaptive TTLs:** After 5+ consecutive cache hits on the same key, the TTL doubles (up to 10 min). This auto-tunes to stable resources like configuration files and directory structures.

### Layer 3: Response Compression

Large responses are truncated before reaching the agent, with the full content stored locally by `ref_id`:

- **Directory listings** > 20 entries → show first 20 + count + `ref_id`
- **File content** > 5000 chars → show first 1000 + last 500 + `ref_id`
- **JSON arrays** > 20 items → show first 10 + `ref_id`
- **Deeply nested JSON** (> 3 levels) → flatten to depth 2

Retrieve the full content: `{ "name": "sousmcp_get_full_response", "arguments": { "ref_id": "<id>" } }`

### Layer 4: Deduplication

Identical `tools/call` invocations within the same session and dedup window (default: 5 min) return the cached result immediately without hitting the MCP server. Write operations are never deduplicated.

### Layer 5: Tool Schema Minification *(always on)*

Even when dynamic tool loading is disabled, SousMCP strips noise from every `tools/list` response:
- Descriptions truncated to 100 characters
- `$schema`, `additionalProperties`, `examples` fields removed
- Property descriptions truncated to 80 characters

### Layer 6: Context-aware Result Filtering *(opt-in)*

Field-level stripping based on tool name patterns. Enable with `optimization.resultFiltering: true`:
- `read_file` → return `content` field only, strip metadata
- `search` / `list_*` → return names + 100-char snippets, strip full bodies

### Metrics

```bash
curl http://localhost:8787/api/optimizer
```

Returns per-layer stats including:
```json
{
  "dynamicToolsets": { "schemasStripped": 42, "inputTokensSaved": 18400 },
  "cache": { "hits": 156, "misses": 23, "hitRate": 87 },
  "compression": { "responsesCompressed": 12, "bytesSaved": 94200 },
  "deduplication": { "duplicatesCaught": 8, "tokensSaved": 3200 },
  "total": { "estimatedTokensSaved": 24600, "estimatedCostSaved": "$0.0246", "optimizationRate": 91 },
  "summary": "Token savings: ~24,600 tokens saved (87% cache hit rate) this session"
}
```

### Configuration

```json
{
  "optimization": {
    "enabled": true,
    "dynamicToolsets": false,
    "cacheTTL": { "read_file": 30, "search": 60, "default": 10, "fetch": 0 },
    "compressionThreshold": 2000,
    "dedupWindowSeconds": 300,
    "schemaMinification": true,
    "resultFiltering": false,
    "maxCacheEntries": 1000
  }
}
```

---

## Tool Quarantine

Every tool seen for the first time is quarantined until explicitly approved. This prevents new or unexpected capabilities from running silently.

**First encounter:** tool is auto-paused → macOS notification fires → you approve or deny.

**Registry:** persisted to `~/.sousmcp/known-tools.json` — survives restarts.

```bash
# List all tools and their status
sousmcp quarantine list

# Approve a tool for use
sousmcp quarantine approve filesystem read_file

# Block a tool permanently
sousmcp quarantine deny filesystem execute_command
```

Via the REST API:

```bash
curl http://localhost:8787/api/quarantine
curl -X POST http://localhost:8787/api/quarantine/filesystem/execute_command/deny
```

### OWASP Threat Analysis

When a new tool list is seen, SousMCP runs an automated threat analysis:

- **Toxic capability pairs** — filesystem + network access, filesystem + email (data exfiltration risk)
- **Shell/exec tool names** — tools named `bash`, `exec`, `shell`, `run_command`, etc.
- **Credential tool names** — tools named `get_secret`, `read_credentials`, etc.
- **Prompt injection patterns** — argument values containing `ignore previous instructions`, `act as`, etc.
- **SQL injection patterns** — `UNION SELECT`, `DROP TABLE`, etc.
- **Credential argument patterns** — arguments like `password`, `api_key`, `token` with literal values

Trust scores (0–100) and flags are logged and visible in `sousmcp status`.

---

## Policy Configuration

Policies live at `~/.sousmcp/policies.yaml`. Hot-reloaded on file change.

```yaml
rules:
  # Block access to SSH keys
  - name: block-ssh-reads
    matchMethod: "tools/call"
    matchToolName: "read_file"
    matchArgPattern: "\\.ssh"
    action: block

  # Pause before sending email, but only on weekdays 9-17
  - name: pause-send-email
    matchMethod: "tools/call"
    matchToolName: "send_email"
    timeWindow:
      start: "09:00"
      end: "17:00"
      days: ["Mon", "Tue", "Wed", "Thu", "Fri"]
    action: pause

  # Rate-limit web fetches to 10 per minute per session
  - name: rate-limit-fetch
    matchMethod: "tools/call"
    matchToolName: "fetch"
    rateLimit:
      maxCalls: 10
      windowSeconds: 60
    action: block

  # Restrict filesystem tools to the production server only
  - name: prod-filesystem-only
    matchMethod: "tools/call"
    matchToolName: "read_file"
    matchServer: "production"
    action: log

  # Allowlist: only allow reading files under /home
  - name: home-only-reads
    matchMethod: "tools/call"
    matchToolName: "read_file"
    matchArgAllow: "^/home/"
    action: block

  # Log everything else
  - name: log-all
    matchMethod: "*"
    action: log
```

### Policy Fields

| Field | Type | Description |
|---|---|---|
| `matchMethod` | string | JSON-RPC method (`*` = wildcard) |
| `matchToolName` | string | Tool name inside `tools/call` |
| `matchServer` | string | Substring match on the MCP server command |
| `matchArgPattern` | string | Regex — fires when args **match** |
| `matchArgAllow` | string | Regex — fires when args do **not** match (allowlist) |
| `timeWindow.start` | `HH:MM` | Only active after this time |
| `timeWindow.end` | `HH:MM` | Only active before this time |
| `timeWindow.days` | string[] | Days of week (`Mon`–`Sun`) |
| `rateLimit.maxCalls` | number | Max calls per window |
| `rateLimit.windowSeconds` | number | Rolling window length |
| `action` | string | `log` · `pause` · `block` |

---

## Multi-Server Mode

Run as a daemon that manages all configured MCP servers simultaneously:

```bash
sousmcp start    # start all servers from Claude Desktop config
sousmcp stop     # gracefully stop the daemon
sousmcp status   # show per-server stats, quarantine summary, token savings
```

Each server runs as a separate proxy process with its own session. The REST API at `:8787` aggregates data across all servers.

```bash
curl http://localhost:8787/api/servers
```

```json
{
  "servers": [
    { "sessionId": "...", "serverName": "filesystem", "startedAt": "...", "messageCount": 42 },
    { "sessionId": "...", "serverName": "github", "startedAt": "...", "messageCount": 18 }
  ],
  "total": 2
}
```

---

## Agent Observability

Beyond MCP stdio, SousMCP monitors the MCP server process for suspicious behavior:

- **TCP connections** — `lsof -p <pid>` polled every 5 s; new external connections logged
- **Environment variable secrets** — scans for `TOKEN`, `SECRET`, `API_KEY`, `PASSWORD`, etc. in the server's env
- **Subprocess spawning** — heuristically detected via stderr patterns

All events appear in the unified activity log:

```bash
curl http://localhost:8787/api/activity
```

---

## SIEM / External Log Export

Push every intercepted message to external security tools:

```json
{
  "exporters": [
    {
      "type": "webhook",
      "url": "https://hooks.slack.com/services/...",
      "filterMethods": ["tools/call"]
    },
    {
      "type": "file",
      "path": "/var/log/sousmcp/events.jsonl"
    },
    {
      "type": "syslog",
      "host": "127.0.0.1",
      "port": 514,
      "facility": 1
    }
  ]
}
```

**Webhook:** POSTs JSON to any endpoint. Slack/Discord webhooks automatically get `{ text: "```...```" }` wrapping.

**File:** Appends JSONL (one JSON object per line). Compatible with Splunk filebeat, Elastic Logstash, and any log aggregator that can tail files.

**Syslog:** UDP (RFC 3164). Set `facility` and `port` as needed.

All exporters are async (`setImmediate`) — they never block the proxy pipeline.

---

## Interactive Debugging

**Tool schema inspector** — see the exact schemas your agent receives:

```bash
curl http://localhost:8787/api/debug/schema
```

**Live tool call** — test any tool without running the full agent:

```bash
curl -X POST http://localhost:8787/api/debug/call \
  -H "Content-Type: application/json" \
  -d '{ "message": { "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "read_file", "arguments": { "path": "/tmp/test.txt" } } } }'
```

**Message replay** — look up and replay any logged message:

```bash
curl -X POST http://localhost:8787/api/debug/replay \
  -d '{ "messageId": "..." }'
```

---

## REST API Reference

| Endpoint | Method | Description |
|---|---|---|
| `/api/sessions` | GET | All proxy sessions |
| `/api/messages?sessionId=X` | GET | Messages for a session (or all) |
| `/api/policies` | GET | Current rules + file path |
| `/api/policies` | POST | Replace rules (`{ rules: [...] }`) |
| `/api/policies/reload` | POST | Reload from disk |
| `/api/policies/raw` | GET | Raw YAML content |
| `/api/stats` | GET | Message counts, sessions today, policies triggered |
| `/api/metrics` | GET | In-process counters: throughput, latency, rule hits |
| `/api/health` | GET | Status, uptime, per-server info |
| `/api/servers` | GET | All active server sessions |
| `/api/quarantine` | GET | Tool quarantine registry + stats |
| `/api/quarantine/:server/:name/approve` | POST | Approve a quarantined tool |
| `/api/quarantine/:server/:name/deny` | POST | Deny a quarantined tool |
| `/api/optimizer` | GET | Per-layer token optimization metrics |
| `/api/activity` | GET | Unified activity log (MCP + agent monitoring) |
| `/api/approvals` | GET | Pending human-approval requests |
| `/api/approvals/:id/approve` | POST | Approve a paused call |
| `/api/approvals/:id/deny` | POST | Deny a paused call |
| `/api/debug/schema` | GET | Live tool schemas from last `tools/list` |
| `/api/debug/call` | POST | Spawn ephemeral MCP session and call a tool |
| `/api/debug/replay` | POST | Look up a logged message with context |

---

## Audit Chain Verification

Every logged message is chained:

```
hash = SHA-256(prevHash | timestamp | direction | method | paramsJson)
```

The first message uses a 64-zero genesis hash. Verify the entire log is untampered:

```bash
node -e "
const { LogStore } = require('./packages/proxy/dist/store.js');
const db = new LogStore('./sousmcp.db');
console.log('Chain valid:', db.verifyChain());
db.close();
"
```

---

## Monorepo Structure

```
packages/
├── proxy/      @sousmcp/proxy   — MCP proxy daemon (Node.js, TypeScript)
│   └── src/
│       ├── index.ts            — bootstrap + message pipeline
│       ├── interceptor.ts      — stdio proxy with transform hooks
│       ├── policy.ts           — YAML rule engine + ACL
│       ├── optimizer.ts        — 6-layer token optimizer
│       ├── quarantine.ts       — tool quarantine registry
│       ├── threat-rules.ts     — OWASP threat analysis
│       ├── agent-monitor.ts    — process-level observability
│       ├── exporters.ts        — SIEM webhook/file/syslog
│       ├── store.ts            — SQLite log store (Merkle chain)
│       └── server.ts           — REST API
├── shared/     @sousmcp/shared  — shared TypeScript types
└── ui/         @sousmcp/ui      — React dashboard (Vite) [WIP]
```

---

## Development

```bash
npm run build           # compile all packages
npm run dev             # watch mode
npm run lint            # type-check without emitting
npm run test:filesystem # real-world integration test (29 checks)
```

---

## License

[MIT](LICENSE) © abdulahad014993-bot
