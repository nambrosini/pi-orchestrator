import type { OrchestratorConfig } from "./config.ts";
import type { Plan, Step } from "./plan.ts";
import { snapshotFiles, type Snapshot } from "./changes.ts";
import { selectSteps, type RunOptions } from "./orchestrator.ts";
import { composeTask } from "./worker.ts";
import { ENTRY_TYPE, passedSteps, stepKey, type ProgressEntry, type StepEntry } from "./state.ts";

export interface SessionRun {
  plan: Plan; planKey: string; cfg: OrchestratorConfig; opts: RunOptions;
  queue: ReturnType<typeof selectSteps>;
  done: Set<string>;
  prevModel?: unknown;
  aborted?: boolean;
  /** Pre-step file contents, taken the first time a step is handed out. */
  snapshots: Map<string, Snapshot>;
  /** Fix instructions (planned-vs-actual diffs) from the latest evidence per step. */
  lastFix: Map<string, string>;
}

let run: SessionRun | undefined;
export const getRun = () => run;

export function startSessionRun(
  plan: Plan, planKey: string, cfg: OrchestratorConfig, opts: RunOptions, doneSteps: Set<string>, prevModel?: unknown,
): SessionRun {
  run = { plan, planKey, cfg, opts, queue: selectSteps(plan, opts), done: new Set(opts.resume ? doneSteps : []), prevModel, snapshots: new Map(), lastFix: new Map() };
  return run;
}

export function findStep(phase: string, step: string, r: SessionRun | undefined = run): Step {
  if (!r) throw new Error("No active /execute-plan run.");
  const q = r.queue.find((x) => x.phase.id === phase && x.step.id === step);
  if (!q) throw new Error(`Unknown step ${phase}/${step}`);
  return q.step;
}

/** Snapshot once per step (retries keep the original pre-step state). */
export function ensureSnapshot(phase: string, step: string, cwd: string, r: SessionRun | undefined = run): Snapshot {
  if (!r) throw new Error("No active /execute-plan run.");
  const key = stepKey(phase, step);
  if (!r.snapshots.has(key)) r.snapshots.set(key, snapshotFiles(findStep(phase, step, r), cwd));
  return r.snapshots.get(key)!;
}

export function nextStep(r: SessionRun | undefined = run) {
  if (!r) throw new Error("No active /execute-plan run.");
  const item = r.queue.find((q) => !r.done.has(stepKey(q.phase.id, q.step.id)));
  if (!item) return null;
  const { phase, step, p, s } = item;
  return {
    phase: phase.id, step: step.id,
    label: `Phase ${p + 1}/${r.plan.phases.length}, Step ${s + 1}/${phase.steps.length}: ${step.title}`,
    task: composeTask({ plan: r.plan, phase, step }),
    workerTimeoutMs: r.cfg.workerTimeoutMs,
    commands: step.commands, acceptance: step.acceptance,
  };
}

export function remaining(r: SessionRun | undefined = run): number {
  return r ? r.queue.filter((q) => !r.done.has(stepKey(q.phase.id, q.step.id))).length : 0;
}

export function recordResult(
  append: (e: ProgressEntry) => void,
  a: { phase: string; step: string; verdict: "PASS" | "FAIL" | "ERROR"; attempt: number },
  r: SessionRun | undefined = run,
): StepEntry {
  if (!r) throw new Error("No active /execute-plan run.");
  if (!r.queue.some((q) => q.phase.id === a.phase && q.step.id === a.step)) throw new Error(`Unknown step ${a.phase}/${a.step}`);
  const e: StepEntry = {
    kind: "step", planKey: r.planKey, project: r.plan.project, phaseId: a.phase, stepId: a.step,
    attempt: a.attempt, verdict: a.verdict, status: a.verdict === "PASS" ? "passed" : "failed", at: Date.now(),
  };
  append(e);
  if (e.status === "passed") r.done.add(stepKey(a.phase, a.step));
  return e;
}

/** Terminal state of the run: complete when nothing remains. */
export function finishSessionRun(append: (e: ProgressEntry) => void): { status: "complete" | "aborted"; left: number; prevModel?: unknown } | undefined {
  const r = run;
  if (!r) return undefined;
  const left = remaining(r);
  const status = left === 0 ? "complete" : "aborted";
  append({ kind: "plan", planKey: r.planKey, project: r.plan.project, status, at: Date.now() });
  run = undefined;
  return { status, left, prevModel: r.prevModel };
}

export { ENTRY_TYPE, passedSteps };

/** The full worker task for a retry: original task + mechanically computed fix section. */
export function retryTask(phase: string, step: string, extra?: string, r: SessionRun | undefined = run): string {
  if (!r) throw new Error("No active /execute-plan run.");
  const st = findStep(phase, step, r);
  const ph = r.queue.find((q) => q.phase.id === phase && q.step.id === step)!.phase;
  const fix = [r.lastFix.get(stepKey(phase, step)), extra].filter((x) => x?.trim()).join("\n\n");
  return composeTask({ plan: r.plan, phase: ph, step: st, fixInstructions: fix || "Re-check the files against the step and fix any differences." });
}
