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
}

interface PoliciesFile {
  rules: PolicyRule[];
}

// ── Default policy document ────────────────────────────────────────────────

const DEFAULT_POLICIES = `# SousMCP default policies
# Evaluated top-to-bottom; first match wins.
# action: log | pause | block
rules:
  - name: block-ssh-reads
    matchMethod: "tools/call"
    matchToolName: "read_file"
    matchArgPattern: "\\\\.ssh"
    action: block

  - name: block-env-reads
    matchMethod: "tools/call"
    matchToolName: "read_file"
    matchArgPattern: "\\\\.env"
    action: block

  - name: pause-send-email
    matchMethod: "tools/call"
    matchToolName: "send_email"
    action: pause

  - name: pause-send-message
    matchMethod: "tools/call"
    matchToolName: "send_message"
    action: pause

  - name: pause-write-file
    matchMethod: "tools/call"
    matchToolName: "write_file"
    action: pause

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
  readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? path.join(os.homedir(), ".sousmcp", "policies.yaml");
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) {
      this.writeDefaults();
    }
    const raw = fs.readFileSync(this.filePath, "utf8");
    const doc = yaml.load(raw) as PoliciesFile | null;
    this.rules = doc?.rules ?? [];
  }

  reload(): void {
    this.load();
  }

  private writeDefaults(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, DEFAULT_POLICIES, "utf8");
  }

  getRules(): PolicyRule[] {
    return this.rules;
  }

  setRules(rules: PolicyRule[]): void {
    this.rules = rules;
    fs.writeFileSync(this.filePath, yaml.dump({ rules } as PoliciesFile), "utf8");
  }

  evaluate(parsed: unknown): EvaluationResult {
    const method = getMethod(parsed);
    const toolName = getToolName(parsed);
    const paramsJson = getParamsJson(parsed);

    for (const rule of this.rules) {
      // matchMethod: "*" is a wildcard; otherwise exact match
      if (rule.matchMethod !== "*" && rule.matchMethod !== method) continue;
      if (rule.matchToolName !== undefined && rule.matchToolName !== toolName) continue;
      if (rule.matchArgPattern !== undefined) {
        if (!new RegExp(rule.matchArgPattern).test(paramsJson)) continue;
      }
      return { action: rule.action, rule };
    }

    return { action: "log" };
  }
}
