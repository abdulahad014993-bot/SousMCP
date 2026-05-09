import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as yaml from "js-yaml";

export type PolicyAction = "log" | "pause" | "block";

// ── Rule interface ─────────────────────────────────────────────────────────

export interface TimeWindow {
  start?: string;   // "HH:MM" 24-hour; rule is active from this time
  end?: string;     // "HH:MM" 24-hour; rule is active until this time
  days?: string[];  // ["mon","tue","wed","thu","fri","sat","sun"]; rule active on these days
}

export interface RateLimit {
  maxCalls: number;       // max calls allowed in the window
  windowSeconds: number;  // rolling window size in seconds
}

export interface PolicyRule {
  name: string;
  matchMethod: string;
  matchServer?: string;       // only match this server name (substring match)
  matchToolName?: string;
  matchArgPattern?: string;   // regex; rule fires if params JSON MATCHES
  matchArgAllow?: string;     // regex; rule fires if params JSON does NOT match (allowlist)
  timeWindow?: TimeWindow;    // rule only applies during this time window
  rateLimit?: RateLimit;      // rule fires when call rate EXCEEDS limit
  action: PolicyAction;
}

export interface EvalContext {
  serverName?: string;
  sessionId?: string;
}

export interface EvaluationResult {
  action: PolicyAction;
  rule?: PolicyRule;
  learningModeOverride: boolean;
}

interface PoliciesFile {
  rules: PolicyRule[];
}

// ── Default policies ───────────────────────────────────────────────────────

const DEFAULT_POLICIES = `# SousMCP policies — evaluated top-to-bottom, first match wins.
# action: log | pause | block
#
# New fields in this version:
#   matchServer: "github"       # only applies to servers whose name contains "github"
#   timeWindow:                 # only active Mon-Fri 9-17
#     start: "09:00"
#     end: "17:00"
#     days: [mon, tue, wed, thu, fri]
#   rateLimit:                  # fire rule after >N calls in window
#     maxCalls: 10
#     windowSeconds: 60
#   matchArgAllow: "~/projects/" # block if args do NOT match this pattern (allowlist)
#
# Learning mode: when enabled in ~/.sousmcp/config.json, all block/pause
# rules are downgraded to log+notify so you can see what your agents do
# before committing to strict enforcement.

rules:
  # ── Block sensitive credential stores ─────────────────────────────────────
  - name: block-ssh-reads
    matchMethod: "tools/call"
    matchArgPattern: "\\\\.ssh[\\\\/]"
    action: block

  - name: block-gnupg-reads
    matchMethod: "tools/call"
    matchArgPattern: "\\\\.gnupg[\\\\/]"
    action: block

  - name: block-aws-reads
    matchMethod: "tools/call"
    matchArgPattern: "\\\\.aws[\\\\/]"
    action: block

  - name: block-env-reads
    matchMethod: "tools/call"
    matchArgPattern: "\\\\.env\\\\b"
    action: block

  # ── Pause before destructive shell commands ────────────────────────────────
  - name: pause-rm-rf
    matchMethod: "tools/call"
    matchArgPattern: "rm\\\\s+-[rRfF]"
    action: pause

  - name: pause-force-push
    matchMethod: "tools/call"
    matchArgPattern: "git\\\\s+push.*--force"
    action: pause

  - name: pause-drop-table
    matchMethod: "tools/call"
    matchArgPattern: "(?i)drop\\\\s+table"
    action: pause

  - name: pause-curl-pipe-shell
    matchMethod: "tools/call"
    matchArgPattern: "curl[^|]*\\\\|\\\\s*(sh|bash|zsh)"
    action: pause

  # ── Pause before communication / external effects ──────────────────────────
  - name: pause-send-email
    matchMethod: "tools/call"
    matchToolName: "send_email"
    action: pause

  - name: pause-send-message
    matchMethod: "tools/call"
    matchToolName: "send_message"
    action: pause

  - name: pause-post-tweet
    matchMethod: "tools/call"
    matchToolName: "post_tweet"
    action: pause

  - name: pause-social-post
    matchMethod: "tools/call"
    matchArgPattern: "(?i)(post|tweet|publish).*social"
    action: pause

  - name: pause-delete-file
    matchMethod: "tools/call"
    matchToolName: "delete_file"
    action: pause

  - name: pause-purchase
    matchMethod: "tools/call"
    matchArgPattern: "(?i)(purchase|buy|checkout|payment)"
    action: pause

  # ── Rate-limit bash calls ──────────────────────────────────────────────────
  - name: ratelimit-bash
    matchMethod: "tools/call"
    matchToolName: "bash"
    rateLimit:
      maxCalls: 20
      windowSeconds: 60
    action: pause

  # ── Log everything else ────────────────────────────────────────────────────
  - name: log-all
    matchMethod: "*"
    action: log
`;

// ── Helpers ────────────────────────────────────────────────────────────────

function getMethod(parsed: unknown): string {
  if (parsed !== null && typeof parsed === "object") {
    const p = parsed as Record<string, unknown>;
    if (typeof p["method"] === "string") return p["method"];
  }
  return "";
}

function getToolName(parsed: unknown): string | undefined {
  if (parsed !== null && typeof parsed === "object") {
    const params = (parsed as Record<string, unknown>)["params"];
    if (params !== null && typeof params === "object") {
      const name = (params as Record<string, unknown>)["name"];
      if (typeof name === "string") return name;
    }
  }
  return undefined;
}

function getParamsJson(parsed: unknown): string {
  if (parsed !== null && typeof parsed === "object") {
    const params = (parsed as Record<string, unknown>)["params"];
    return JSON.stringify(params ?? null);
  }
  return "null";
}

// Convert "HH:MM" to minutes since midnight
function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function inTimeWindow(now: Date, tw: TimeWindow): boolean {
  // Check day of week
  if (tw.days && tw.days.length > 0) {
    const dayName = DAY_NAMES[now.getDay()];
    if (!tw.days.includes(dayName ?? "")) return false;
  }
  // Check time range
  if (tw.start || tw.end) {
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const startMin = tw.start ? toMinutes(tw.start) : 0;
    const endMin   = tw.end   ? toMinutes(tw.end)   : 24 * 60;

    if (startMin <= endMin) {
      // Same-day window (e.g., 09:00 – 17:00)
      if (currentMinutes < startMin || currentMinutes >= endMin) return false;
    } else {
      // Overnight window (e.g., 22:00 – 06:00)
      if (currentMinutes < startMin && currentMinutes >= endMin) return false;
    }
  }
  return true;
}

// ── PolicyEngine ───────────────────────────────────────────────────────────

interface RateLimitCounter {
  calls: number[];   // timestamps of calls in the window
}

export class PolicyEngine {
  private rules: PolicyRule[] = [];
  private learningMode: boolean;
  readonly filePath: string;

  // In-memory rate-limit state: ruleName → sessionId → counter
  private readonly rateLimitCounters = new Map<string, Map<string, RateLimitCounter>>();

  constructor(filePath?: string, learningMode = false) {
    this.filePath = filePath ?? path.join(os.homedir(), ".sousmcp", "policies.yaml");
    this.learningMode = learningMode;
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) this.writeDefaults();
    const raw = fs.readFileSync(this.filePath, "utf8");
    const doc = yaml.load(raw) as PoliciesFile | null;
    this.rules = doc?.rules ?? [];
  }

  reload(): void {
    try { this.load(); } catch { /* leave rules as-is if reload fails */ }
  }

  private writeDefaults(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, DEFAULT_POLICIES, "utf8");
  }

  setLearningMode(enabled: boolean): void {
    this.learningMode = enabled;
  }

  getRules(): PolicyRule[] { return this.rules; }

  setRules(rules: PolicyRule[]): void {
    this.rules = rules;
    fs.writeFileSync(this.filePath, yaml.dump({ rules } as PoliciesFile), "utf8");
  }

  // Check rate limit for a rule + session. Returns true if limit exceeded.
  private checkRateLimit(rule: PolicyRule, sessionId: string): boolean {
    if (!rule.rateLimit) return false;
    const { maxCalls, windowSeconds } = rule.rateLimit;
    const windowMs = windowSeconds * 1000;
    const now = Date.now();

    let sessionMap = this.rateLimitCounters.get(rule.name);
    if (!sessionMap) { sessionMap = new Map(); this.rateLimitCounters.set(rule.name, sessionMap); }

    let counter = sessionMap.get(sessionId);
    if (!counter) { counter = { calls: [] }; sessionMap.set(sessionId, counter); }

    // Evict old timestamps outside the window
    counter.calls = counter.calls.filter(t => now - t < windowMs);
    counter.calls.push(now);

    return counter.calls.length > maxCalls;
  }

  evaluate(parsed: unknown, context: EvalContext = {}): EvaluationResult {
    const method = getMethod(parsed);
    const toolName = getToolName(parsed);
    const paramsJson = getParamsJson(parsed);
    const now = new Date();

    for (const rule of this.rules) {
      // Method match
      if (rule.matchMethod !== "*" && rule.matchMethod !== method) continue;

      // Server match (substring)
      if (rule.matchServer && context.serverName) {
        if (!context.serverName.includes(rule.matchServer)) continue;
      } else if (rule.matchServer && !context.serverName) {
        continue; // server filter specified but no server in context
      }

      // Tool name match
      if (rule.matchToolName !== undefined && rule.matchToolName !== toolName) continue;

      // Arg pattern match (deny pattern — fires when args MATCH)
      if (rule.matchArgPattern !== undefined) {
        try {
          if (!new RegExp(rule.matchArgPattern).test(paramsJson)) continue;
        } catch { continue; }
      }

      // Arg allow match (allowlist — fires when args do NOT match)
      if (rule.matchArgAllow !== undefined) {
        try {
          if (new RegExp(rule.matchArgAllow).test(paramsJson)) continue; // allowed, skip rule
        } catch { continue; }
      }

      // Time window check
      if (rule.timeWindow && !inTimeWindow(now, rule.timeWindow)) continue;

      // Rate limit check
      if (rule.rateLimit) {
        const exceeded = this.checkRateLimit(rule, context.sessionId ?? "global");
        if (!exceeded) continue; // rate limit not exceeded — rule doesn't fire yet
      }

      const learningModeOverride = this.learningMode && rule.action !== "log";
      return {
        action: learningModeOverride ? "log" : rule.action,
        rule,
        learningModeOverride,
      };
    }

    return { action: "log", learningModeOverride: false };
  }
}
