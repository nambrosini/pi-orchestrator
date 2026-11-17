import type { OrchestratorConfig } from "./config.ts";
import type { Phase, Plan, Step } from "./plan.ts";
import { ENTRY_TYPE, passedSteps, readProgress, stepKey, type ProgressEntry } from "./state.ts";
import { dispatchStep, type DispatchArgs } from "./worker.ts";
import { verify, type Verdict } from "./verifier.ts";
import { truncateHeadTail, type Usage } from "./util.ts";
import { mismatchInstructions, snapshotFiles } from "./changes.ts";

export interface RunOptions { phase?: string; step?: string; dryRun?: boolean; resume?: boolean; force?: boolean }

export interface StepOutcome {
  phase: string; step: string; status: "passed" | "failed" | "skipped"; attempts: number;
  verdict?: Verdict; workerSummary?: string; error?: string;
}
export interface RunSummary {
  project: string; status: "complete" | "failed" | "aborted" | "dry-run"; steps: StepOutcome[];
  usage: { worker: Usage; verifier: Usage }; order?: string[];
}

export interface RunDeps {
  pi: { appendEntry(type: string, data?: unknown): void };
  ctx: { cwd: string; hasUI: boolean; ui: any; sessionManager: any };
  cfg: OrchestratorConfig;
  planKey: string;
  signal?: AbortSignal;
  onUpdate?: (text: string) => void;
  executeTool?: DispatchArgs["executeTool"];
}

export function selectSteps(plan: Plan, o: RunOptions): { phase: Phase; step: Step; p: number; s: number }[] {
  const out: { phase: Phase; step: Step; p: number; s: number }[] = [];
  plan.phases.forEach((phase, p) => {
    if (o.phase && phase.id !== o.phase) return;
    phase.steps.forEach((step, s) => { if (!o.step || step.id === o.step) out.push({ phase, step, p, s }); });
  });
  return out;
}

export async function runPlan(plan: Plan, opts: RunOptions, d: RunDeps): Promise<RunSummary> {
  const { ctx, cfg, pi } = d;
  const selected = selectSteps(plan, opts);
  const summary: RunSummary = {
    project: plan.project, status: "complete", steps: [],
    usage: { worker: { inputTokens: 0, outputTokens: 0 }, verifier: { inputTokens: 0, outputTokens: 0 } },
  };
  if (!selected.length) throw new Error(`No steps match --phase ${opts.phase ?? "*"} --step ${opts.step ?? "*"}`);

  const say = (text: string, level: "info" | "warning" | "error" = "info") => {
    d.onUpdate?.(text);
    if (ctx.hasUI) { ctx.ui.notify(text, level); }
  };
  const status = (t?: string) => { if (ctx.hasUI) ctx.ui.setStatus("orchestrator", t); };
  const record = (e: ProgressEntry) => pi.appendEntry(ENTRY_TYPE, e);
  const base = { planKey: d.planKey, project: plan.project };

  if (opts.dryRun) {
    summary.status = "dry-run";
    summary.order = selected.map(({ phase, step, p, s }) => `Phase ${p + 1}/${plan.phases.length} [${phase.id}], Step ${s + 1}/${phase.steps.length} [${step.id}]: ${step.title}`);
    say(`Dry run — dispatch order:\n${summary.order.join("\n")}`);
    return summary;
  }

  const done = opts.resume ? passedSteps(readProgress(ctx), d.planKey) : new Set<string>();
  record({ kind: "plan", ...base, status: "started", at: Date.now() });
  let finalStatus: "complete" | "aborted" | "failed" = "complete";

  outer: for (const { phase, step, p, s } of selected) {
    const label = `Phase ${p + 1}/${plan.phases.length}, Step ${s + 1}/${phase.steps.length}: ${step.title}`;
    if (done.has(stepKey(phase.id, step.id))) {
      say(`${label} → already passed, skipping (resume)`);
      summary.steps.push({ phase: phase.id, step: step.id, status: "skipped", attempts: 0 });
      continue;
    }
    let extra = "";
    const snapshot = snapshotFiles(step, ctx.cwd); // pre-step state, used to compute the planned result
    for (;;) { // manual-retry loop
      let fix: string | undefined = extra || undefined;
      let last: { verdict?: Verdict; summary?: string; error?: string } = {};
      let attempt = 0, passed = false;
      while (attempt < cfg.maxFixAttempts) {
        if (d.signal?.aborted) { finalStatus = "aborted"; break outer; }
        attempt++;
        status(`${label} (attempt ${attempt}/${cfg.maxFixAttempts})`);
        say(`${label} → dispatching worker${attempt > 1 ? ` (fix attempt ${attempt})` : ""}`);
        try {
          const w = await dispatchStep({ plan, phase, step, cfg, cwd: ctx.cwd, fixInstructions: fix, signal: d.signal, executeTool: d.executeTool, onProgress: (m) => d.onUpdate?.(`  worker: ${m}`) });
          summary.usage.worker.inputTokens += w.usage.inputTokens; summary.usage.worker.outputTokens += w.usage.outputTokens;
          last.summary = w.summary; last.error = undefined;
          say(`${label} → verifying`);
          const v = await verify(step, w.summary, ctx.cwd, cfg, d.signal, snapshot);
          summary.usage.verifier.inputTokens += v.usage.inputTokens; summary.usage.verifier.outputTokens += v.usage.outputTokens;
          last.verdict = v.verdict;
          record({ kind: "step", ...base, phaseId: phase.id, stepId: step.id, attempt, verdict: v.verdict.verdict, status: v.verdict.verdict === "PASS" ? "passed" : "failed", at: Date.now() });
          if (v.verdict.verdict === "PASS") { passed = true; break; }
          fix = [v.verdict.fixInstructions, mismatchInstructions(v.evidence.checks)].filter((x) => x.trim()).join("\n\n");
          say(`${label} → FAIL (attempt ${attempt}): ${v.verdict.reasons.join("; ")}`, "warning");
        } catch (e: any) {
          if (d.signal?.aborted || e?.message === "Aborted") { finalStatus = "aborted"; break outer; }
          last.error = String(e?.message ?? e);
          record({ kind: "step", ...base, phaseId: phase.id, stepId: step.id, attempt, verdict: "ERROR", status: "failed", at: Date.now() });
          say(`${label} → error (attempt ${attempt}): ${last.error}`, "error");
          fix = `The previous attempt crashed: ${last.error}`;
        }
      }
      if (passed) {
        say(`${label} → PASS`);
        summary.steps.push({ phase: phase.id, step: step.id, status: "passed", attempts: attempt, verdict: last.verdict, workerSummary: last.summary });
        break;
      }
      // unresolved failure
      const report = [
        `Step failed after ${attempt} attempt(s): ${phase.id}/${step.id} — ${step.title}`,
        `Reasons: ${(last.verdict?.reasons ?? [last.error ?? "unknown"]).join("; ")}`,
        last.verdict?.missing.length ? `Missing: ${last.verdict.missing.join("; ")}` : "",
        `Worker summary: ${truncateHeadTail(last.summary ?? "(none)", 2000)}`,
      ].filter(Boolean).join("\n");
      const outcome: StepOutcome = { phase: phase.id, step: step.id, status: "failed", attempts: attempt, verdict: last.verdict, workerSummary: last.summary, error: last.error };
      d.onUpdate?.(report);
      if (!ctx.hasUI) { summary.steps.push(outcome); finalStatus = "failed"; break outer; }
      const choice: string | undefined = await ctx.ui.select(`${report}\n\nWhat now?`, ["Continue to next step", "Retry manually", "Abort"]);
      if (choice === "Continue to next step") { summary.steps.push(outcome); finalStatus = "failed"; break; }
      if (choice === "Retry manually") {
        extra = (await ctx.ui.input("Extra instructions for the worker (optional):", "")) ?? "";
        extra = [last.verdict?.fixInstructions, extra].filter(Boolean).join("\n");
        continue;
      }
      summary.steps.push(outcome); finalStatus = "failed"; break outer; // abort
    }
  }
  status(undefined);
  summary.status = finalStatus;
  record({ kind: "plan", ...base, status: finalStatus === "complete" ? "complete" : "aborted", at: Date.now() });
  return summary;
}
