import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface OrchestratorConfig {
  orchestratorModel?: string;
  workerModel?: string;
  verifierModel?: string;
  workerBackend: "subagents" | "child";
  maxFixAttempts: number;
  verifyCommandTimeoutMs: number;
  workerTimeoutMs: number;
  workerPromptFile: string;
  /** Treat blank-line-only differences as mismatches. */
  strictBlankLines: boolean;
  /** Let the orchestrator write the planned content itself via plan_autofix_step after failed attempts. */
  autofix: boolean;
}

const PKG_ROOT = join(import.meta.dirname ?? __dirname, "..");

function readJson(path: string): any {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {}; } catch { return {}; }
}

/** Defaults < ~/.pi/agent/settings.json `orchestrator` < <project>/.pi/settings.json `orchestrator`. */
export function loadConfig(cwd: string, sessionModel?: { provider: string; id: string }): OrchestratorConfig {
  const user = readJson(join(homedir(), ".pi", "agent", "settings.json")).orchestrator ?? {};
  const project = readJson(join(cwd, ".pi", "settings.json")).orchestrator ?? {};
  const merged = { ...user, ...project };
  const fallback = sessionModel ? `${sessionModel.provider}/${sessionModel.id}` : undefined; // last resort only
  const cfg: OrchestratorConfig = {
    orchestratorModel: merged.orchestratorModel,
    workerModel: merged.workerModel ?? fallback,
    verifierModel: merged.verifierModel ?? fallback,
    workerBackend: merged.workerBackend === "child" ? "child" : "subagents",
    maxFixAttempts: Number.isInteger(merged.maxFixAttempts) && merged.maxFixAttempts > 0 ? merged.maxFixAttempts : 3,
    verifyCommandTimeoutMs: Number(merged.verifyCommandTimeoutMs) > 0 ? Number(merged.verifyCommandTimeoutMs) : 120000,
    workerTimeoutMs: Number(merged.workerTimeoutMs) > 0 ? Number(merged.workerTimeoutMs) : 10 * 60_000,
    workerPromptFile: merged.workerPromptFile ?? join(PKG_ROOT, "agents", "worker.md"),
    strictBlankLines: merged.strictBlankLines === true,
    autofix: merged.autofix !== false,
  };
  return cfg;
}

export function requireModels(cfg: OrchestratorConfig): void {
  const missing = [!cfg.workerModel && "workerModel", !cfg.verifierModel && "verifierModel"].filter(Boolean);
  if (missing.length) throw new Error(`Missing config: ${missing.join(", ")}. Set them under "orchestrator" in .pi/settings.json.`);
}
