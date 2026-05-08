# SousMCP

> A sousveillant transparency layer for MCP agents

[![CI](https://github.com/abdulahad014993-bot/SousMCP/actions/workflows/ci.yml/badge.svg)](https://github.com/abdulahad014993-bot/SousMCP/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.0.0-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue)](https://www.typescriptlang.org)

SousMCP sits transparently between any AI agent and an MCP (Model Context Protocol) server. It intercepts every tool call, evaluates it against a configurable policy, logs it to a tamper-evident SQLite database, and optionally pauses for human approval — all without the agent or server knowing it's there.

---

## Why SousMCP?

AI agents using MCP can silently read files, send emails, execute shell commands, or call any other tool the server exposes. SousMCP gives you **eyes on every action** in real time, with a cryptographic audit trail you can verify after the fact.

The name is a play on *sousveillance* — watching from below, by the person being acted upon, rather than surveillance from above.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        AI Agent (host)                          │
└───────────────────────────┬──────────────────────────────────────┘
                            │ stdin / stdout (JSON-RPC 2.0)
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                       SousMCP Proxy                             │
│                                                                 │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────────┐   │
│  │  Interceptor  │→ │ PolicyEngine │→ │  LogStore (SQLite)│   │
│  │ (stdio proxy) │  │ (YAML rules) │  │  (Merkle chain)   │   │
│  └──────────────┘  └──────┬───────┘  └──────────────────┘   │
│                            │                                    │
│                    block / pause / log                          │
│                            │                                    │
│  ┌─────────────────────────▼──────────────────────────────┐   │
│  │              REST API  :8787                            │   │
│  │  /api/sessions  /api/messages  /api/policies  /api/stats│   │
│  └────────────────────────────────────────────────────────┘   │
└───────────────────────────┬──────────────────────────────────────┘
                            │ forwarded (or blocked)
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                      MCP Server (target)                        │
└─────────────────────────────────────────────────────────────────┘
```

---

## Features

- **Transparent proxy** — wraps any MCP server command; agent and server are unmodified
- **Policy engine** — YAML rules with `matchMethod`, `matchToolName`, `matchArgPattern` (regex), and `action: log | pause | block`
- **Human-in-the-loop** — `pause` action fires a macOS notification and prompts for approve/deny via `/dev/tty` without interfering with the stdio channel
- **Merkle-chained audit log** — every message is SHA-256 hashed against the previous entry; `verifyChain()` detects tampering
- **REST API** — live dashboard data: sessions, messages, policy stats, CRUD for rules
- **Zero dependencies on native addons** — uses Node's built-in `node:sqlite` (stable since Node 23.4)

---

## Monorepo Structure

```
packages/
├── proxy/      @sousmcp/proxy   — MCP transparent proxy daemon
├── shared/     @sousmcp/shared  — shared TypeScript types
└── ui/         @sousmcp/ui      — React dashboard (Vite) [WIP]
```

---

## How it works

1. **Install once** — `sousmcp install` reads your Claude Desktop config and wraps every MCP server with the proxy. You don't change anything else; Claude and your servers are unmodified.
2. **Forget about it** — the proxy runs silently in the background. Every tool call is logged to a tamper-evident SQLite database with a cryptographic chain you can verify later.
3. **Get notified when it matters** — risky actions (deleting files, sending emails, running destructive shell commands) pause and prompt you for approve/deny. Less critical actions show a macOS notification in learning mode so you can see what your agents actually do before locking anything down.

---

## Quick Start

**Requirements:** Node.js ≥ 22.0.0, npm ≥ 9

```bash
# 1. Install globally
npm install -g @sousmcp/proxy

# 2. Wrap your Claude Desktop MCP servers (one command, done)
sousmcp install

# 3. Restart Claude Desktop, then check everything is running
sousmcp status
```

That's it. All your MCP traffic is now logged and policy-checked.

**Try it without Claude Desktop** (development / testing):

```bash
# Start all configured servers under the proxy
sousmcp start

# Or wrap a single server manually
node packages/proxy/dist/index.js python3 my_mcp_server.py
```

**Useful follow-up commands:**

```bash
sousmcp log           # see recent intercepted tool calls
sousmcp policies      # view active rules
sousmcp digest        # weekly activity summary
sousmcp status        # installation + runtime status + update check
```

---

## Policy Configuration

Policies live at `~/.sousmcp/policies.yaml`. The file is created automatically on first run with sensible defaults.

```yaml
rules:
  - name: block-ssh-reads
    matchMethod: "tools/call"
    matchToolName: "read_file"
    matchArgPattern: "\\.ssh"
    action: block

  - name: pause-send-email
    matchMethod: "tools/call"
    matchToolName: "send_email"
    action: pause

  - name: log-all
    matchMethod: "*"
    action: log
```

| Field | Description |
|---|---|
| `matchMethod` | JSON-RPC method to match (`*` = wildcard) |
| `matchToolName` | MCP tool name inside `tools/call` params (optional) |
| `matchArgPattern` | Regex tested against the full params JSON string (optional) |
| `action` | `log` — forward and record; `pause` — prompt for approval; `block` — return JSON-RPC error |

Reload policies at runtime without restarting:

```bash
curl -X POST http://localhost:8787/api/policies/reload
```

---

## REST API

| Endpoint | Method | Description |
|---|---|---|
| `/api/sessions` | GET | All proxy sessions |
| `/api/messages?sessionId=X` | GET | Messages for a session (or all) |
| `/api/policies` | GET | Current rules + policy file path |
| `/api/policies` | POST | Replace rules (`{ rules: [...] }`) |
| `/api/policies/reload` | POST | Reload from disk (also triggered by file change) |
| `/api/policies/raw` | GET | Raw YAML file content |
| `/api/stats` | GET | Message counts by method, sessions today, policies triggered |
| `/api/metrics` | GET | In-process counters: throughput, latency, rule hits, errors |
| `/api/health` | GET | Status, uptime, and per-server connection info |

---

## Audit Chain Verification

Every logged message is chained:

```
hash = SHA-256(prevHash | timestamp | direction | method | paramsJson)
```

The first message in a session uses a 64-zero genesis hash. To verify the entire log is untampered:

```bash
node -e "
const { LogStore } = require('./packages/proxy/dist/store.js');
const db = new LogStore('./sousmcp.db');
console.log('Chain valid:', db.verifyChain());
db.close();
"
```

---

## Development

```bash
npm run build      # compile all packages (tsc --build)
npm run dev        # watch mode
npm run lint       # type-check without emitting
```

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## License

[MIT](LICENSE) © abdulahad014993-bot
