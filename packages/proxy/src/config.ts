import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const SOUSMCP_DIR = path.join(os.homedir(), ".sousmcp");
export const CONFIG_FILE = path.join(SOUSMCP_DIR, "config.json");

export interface SousMCPConfig {
  learningMode: boolean;
  learningModeStarted: number | null;
  learningModeDays: number;
  dbPath: string;
  logPath: string;
  apiPort: number;
  lastDigest: number | null;
}

const DEFAULTS: SousMCPConfig = {
  learningMode: true,
  learningModeStarted: null,
  learningModeDays: 7,
  dbPath: path.join(SOUSMCP_DIR, "sousmcp.db"),
  logPath: path.join(SOUSMCP_DIR, "sousmcp.log"),
  apiPort: 8787,
  lastDigest: null,
};

export function loadConfig(): SousMCPConfig {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) };
    }
  } catch {
    // corrupted — fall back to defaults
  }
  return { ...DEFAULTS };
}

export function saveConfig(cfg: SousMCPConfig): void {
  fs.mkdirSync(SOUSMCP_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf8");
}

export function ensureDir(): void {
  fs.mkdirSync(SOUSMCP_DIR, { recursive: true });
}

export function isLearningMode(cfg: SousMCPConfig): boolean {
  if (!cfg.learningMode) return false;
  if (!cfg.learningModeStarted) return true;
  const elapsed = (Date.now() - cfg.learningModeStarted) / 86_400_000;
  return elapsed < cfg.learningModeDays;
}

export function daysRemainingInLearning(cfg: SousMCPConfig): number {
  if (!cfg.learningModeStarted) return cfg.learningModeDays;
  const elapsed = (Date.now() - cfg.learningModeStarted) / 86_400_000;
  return Math.max(0, cfg.learningModeDays - elapsed);
}
