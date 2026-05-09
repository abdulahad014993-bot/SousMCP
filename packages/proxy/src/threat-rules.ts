// OWASP MCP Top-10 inspired threat analysis for tool sets and arguments.

export interface ThreatFlag {
  severity: "low" | "medium" | "high";
  message: string;
}

export interface ThreatReport {
  trustScore: number;   // 0-100, higher = more trusted
  flags: ThreatFlag[];
  toxicPairs: string[];
}

// ── Capability sets ────────────────────────────────────────────────────────

const FILESYSTEM_TOOLS = new Set([
  "read_file", "read_text_file", "write_file", "create_file", "delete_file",
  "move_file", "copy_file", "list_directory", "list_allowed_directories",
  "get_file_info", "edit_file", "apply_diff",
]);

const NETWORK_TOOLS = new Set([
  "fetch", "http_get", "http_post", "http_request", "http_put", "http_delete",
  "web_fetch", "curl", "send_request", "make_request", "call_api", "get_url",
  "navigate", "browse",
]);

const EMAIL_TOOLS = new Set([
  "send_email", "create_email", "draft_email", "reply_email", "forward_email",
  "send_message", "compose_email", "send_mail",
]);

const CALENDAR_TOOLS = new Set([
  "create_event", "delete_event", "update_event", "invite_attendees",
]);

// ── Regex patterns ─────────────────────────────────────────────────────────

const SHELL_TOOL_RE = /exec|shell|eval|execute|bash|terminal|subprocess|popen|system|run_command|invoke|spawn/i;

const CREDENTIAL_ARG_RE = /\.env\b|\.aws[\\/]|\.ssh[\\/]|\.gnupg[\\/]|keychain|password|secret|token|credential/i;

const EXTERNAL_URL_RE = /https?:\/\/(?!localhost|127\.|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)([^"'\s\/]+)/;

const SQL_INJECTION_RE = /\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC|UNION|TRUNCATE|GRANT|REVOKE)\b/i;

const PROMPT_INJECTION_RE = /ignore\s+(previous|all|above)\s+instructions|you\s+are\s+now|forget\s+everything/i;

// ── Tool-set analysis ──────────────────────────────────────────────────────

export function analyzeToolSet(tools: string[]): ThreatReport {
  const flags: ThreatFlag[] = [];
  const toxicPairs: string[] = [];

  const hasFilesystem = tools.some(t => FILESYSTEM_TOOLS.has(t));
  const hasNetwork    = tools.some(t => NETWORK_TOOLS.has(t));
  const hasEmail      = tools.some(t => EMAIL_TOOLS.has(t));
  const hasCalendar   = tools.some(t => CALENDAR_TOOLS.has(t));

  // Toxic capability pairings
  if (hasFilesystem && hasNetwork) {
    toxicPairs.push("filesystem + network");
    flags.push({ severity: "high", message: "filesystem + network: can read local files and exfiltrate via HTTP" });
  }
  if (hasFilesystem && hasEmail) {
    toxicPairs.push("filesystem + email");
    flags.push({ severity: "high", message: "filesystem + email: can read files and send them via email" });
  }
  if (hasNetwork && hasEmail) {
    toxicPairs.push("network + email");
    flags.push({ severity: "medium", message: "network + email: can fetch remote content and forward it" });
  }
  if (hasFilesystem && hasCalendar) {
    toxicPairs.push("filesystem + calendar");
    flags.push({ severity: "low", message: "filesystem + calendar: can read files and embed in calendar invites" });
  }

  // Per-tool checks
  for (const tool of tools) {
    if (SHELL_TOOL_RE.test(tool)) {
      flags.push({ severity: "high", message: `'${tool}': shell/exec/eval name — arbitrary code execution risk` });
    }
  }

  // Credential-file reads (heuristic: tool name contains "credential"-adjacent words)
  const credentialToolRe = /credential|secret|keychain|vault|password|token/i;
  for (const tool of tools) {
    if (credentialToolRe.test(tool)) {
      flags.push({ severity: "medium", message: `'${tool}': name suggests credential access` });
    }
  }

  const deductions =
    flags.filter(f => f.severity === "high").length * 30 +
    flags.filter(f => f.severity === "medium").length * 15 +
    flags.filter(f => f.severity === "low").length * 5 +
    toxicPairs.length * 5;

  return {
    trustScore: Math.max(0, 100 - deductions),
    flags,
    toxicPairs,
  };
}

// ── Per-call argument analysis ─────────────────────────────────────────────

export interface ArgThreat {
  flagged: boolean;
  severity?: "low" | "medium" | "high";
  reason?: string;
}

export function analyzeArgs(toolName: string, args: unknown): ArgThreat {
  const argsStr = JSON.stringify(args ?? {});

  if (CREDENTIAL_ARG_RE.test(argsStr)) {
    return { flagged: true, severity: "high", reason: "arguments reference credential/secret file path" };
  }

  const urlMatch = EXTERNAL_URL_RE.exec(argsStr);
  if (urlMatch) {
    return { flagged: true, severity: "medium", reason: `arguments contain external URL: ${urlMatch[1]}` };
  }

  if (SQL_INJECTION_RE.test(argsStr)) {
    return { flagged: true, severity: "medium", reason: "arguments contain SQL keywords — possible injection" };
  }

  if (PROMPT_INJECTION_RE.test(argsStr)) {
    return { flagged: true, severity: "high", reason: "arguments contain prompt-injection phrase" };
  }

  return { flagged: false };
}

export function trustLabel(score: number): string {
  if (score >= 85) return "low risk";
  if (score >= 60) return "moderate risk";
  if (score >= 35) return "high risk";
  return "critical risk";
}
