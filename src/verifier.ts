import type { OrchestratorConfig } from "./config.ts";
import type { Step } from "./plan.ts";
import { gitDiff, gitStatus, runPi, sh, truncateHeadTail, type Usage } from "./util.ts";
import { checkChanges, formatChecks, type ChangeCheck, type Snapshot } from "./changes.ts";

export interface Verdict { verdict: "PASS" | "FAIL"; reasons: string[]; missing: string[]; fixInstructions: string }
export interface CommandResult { command: string; exitCode: number | null; timedOut: boolean; output: string }
export interface Evidence { status: string; diff: string; commands: CommandResult[]; checks: ChangeCheck[] }

export async function collectEvidence(step: Step, cwd: string, cfg: OrchestratorConfig, signal?: AbortSignal, snapshot?: Snapshot): Promise<Evidence> {
  const checks = await checkChanges(step, cwd, snapshot);
  const status = await gitStatus(cwd);
  const diff = truncateHeadTail(await gitDiff(cwd, step.files));
  const commands: CommandResult[] = [];
  for (const command of step.commands) {
    const r = await sh(command, cwd, { timeoutMs: cfg.verifyCommandTimeoutMs, signal });
    commands.push({ command, exitCode: r.code, timedOut: r.timedOut, output: truncateHeadTail(`${r.stdout}\n${r.stderr}`.trim(), 6000) });
  }
  return { status, diff, commands, checks };
}

export function formatEvidence(ev: Evidence): string {
  return `## Planned vs actual file content (mechanical check)
${formatChecks(ev.checks)}

## git status --porcelain
${ev.status || "(clean)"}

## git diff (staged + unstaged, declared files)
${ev.diff || "(no diff)"}

## Command results
${ev.commands.length ? ev.commands.map((c) => `$ ${c.command}\nexit=${c.exitCode}${c.timedOut ? " (TIMED OUT)" : ""}\n${c.output}`).join("\n\n") : "(no commands)"}`;
}

export const VERDICT_RULES = `Rules:
- Every acceptance criterion must be met. Any failing command is a FAIL unless the criteria say otherwise.
- Every planned change must be present. A [MISMATCH] in the mechanical check is a FAIL unless the difference is purely cosmetic (formatting/whitespace) and all criteria still hold. A file missing or not deleted is always a FAIL.
- Changes to files outside the step's files, or extra code not in the plan, are a FAIL.
- An [UNKNOWN] check means the plan's anchor did not match the pre-step file; judge from the diff whether the step's intent was implemented exactly.
- fixInstructions must name the file and give the exact text to add/remove/replace, so a small model can apply them literally.`;

export function buildPrompt(step: Step, ev: Evidence, workerSummary: string): string {
  return `You are a strict code reviewer verifying that ONE implementation step was completed exactly as planned.

## Step (verbatim)
${JSON.stringify(step, null, 2)}

${formatEvidence(ev)}

## Worker's summary
${truncateHeadTail(workerSummary, 6000)}

${VERDICT_RULES}

Respond with ONLY a JSON object, no prose, in this shape:
{"verdict":"PASS"|"FAIL","reasons":["..."],"missing":["unmet acceptance items"],"fixInstructions":"concrete imperative instructions for the worker; empty if PASS"}`;
}

export function parseVerdict(text: string): Verdict | null {
  const cands: string[] = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/g;
  for (let m; (m = fence.exec(text)); ) cands.push(m[1]);
  cands.push(text);
  const first = text.indexOf("{"), last = text.lastIndexOf("}");
  if (first >= 0 && last > first) cands.push(text.slice(first, last + 1));
  for (const c of cands) {
    try {
      const o = JSON.parse(c.trim());
      const v = String(o.verdict ?? "").toUpperCase();
      if (v !== "PASS" && v !== "FAIL") continue;
      const arr = (x: unknown) => (Array.isArray(x) ? x.map(String) : []);
      return { verdict: v, reasons: arr(o.reasons), missing: arr(o.missing), fixInstructions: String(o.fixInstructions ?? "") };
    } catch {}
  }
  return null;
}

export async function verify(step: Step, workerSummary: string, cwd: string, cfg: OrchestratorConfig, signal?: AbortSignal, snapshot?: Snapshot):
  Promise<{ verdict: Verdict; evidence: Evidence; usage: Usage }> {
  if (!cfg.verifierModel) throw new Error("verifierModel is not configured");
  const evidence = await collectEvidence(step, cwd, cfg, signal, snapshot);
  const base = buildPrompt(step, evidence, workerSummary);
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = attempt ? `${base}\n\nRespond with ONLY the JSON object.` : base;
    const run = await runPi({ cwd, model: cfg.verifierModel, prompt, signal, extraArgs: ["--no-tools", "--no-extensions", "--no-skills", "--no-context-files"], timeoutMs: 10 * 60_000 });
    usage.inputTokens += run.usage.inputTokens; usage.outputTokens += run.usage.outputTokens;
    const v = parseVerdict(run.text);
    if (v) {
      if (v.verdict === "FAIL" && !v.fixInstructions.trim()) v.fixInstructions = [...v.reasons, ...v.missing].join("\n") || "Re-check acceptance criteria.";
      return { verdict: v, evidence, usage };
    }
  }
  return { verdict: { verdict: "FAIL", reasons: ["Verifier returned unparseable output"], missing: [], fixInstructions: "Re-check that all acceptance criteria are met and the listed commands pass." }, evidence, usage };
}
