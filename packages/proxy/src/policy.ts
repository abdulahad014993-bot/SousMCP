import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as yaml from "js-yaml";

export type PolicyAction = "log" | "pause" | "block";

export interface PolicyRule {
  name: string;
  matchMethod: string;
  matchToolName?: string;
  matchArgPattern?: string;
  action: PolicyAction;
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

// ── PolicyEngine ───────────────────────────────────────────────────────────

export class PolicyEngine {
  private rules: PolicyRule[] = [];
  private learningMode: boolean;
  readonly filePath: string;

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

  evaluate(parsed: unknown): EvaluationResult {
    const method = getMethod(parsed);
    const toolName = getToolName(parsed);
    const paramsJson = getParamsJson(parsed);

    for (const rule of this.rules) {
      if (rule.matchMethod !== "*" && rule.matchMethod !== method) continue;
      if (rule.matchToolName !== undefined && rule.matchToolName !== toolName) continue;
      if (rule.matchArgPattern !== undefined) {
        try {
          if (!new RegExp(rule.matchArgPattern).test(paramsJson)) continue;
        } catch {
          continue; // bad regex — skip rule
        }
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
