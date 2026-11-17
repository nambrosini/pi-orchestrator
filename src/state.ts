import { resolve } from "node:path";

export const ENTRY_TYPE = "orchestrator-progress";

export interface StepEntry {
  kind: "step"; planKey: string; project: string; phaseId: string; stepId: string;
  attempt: number; verdict: "PASS" | "FAIL" | "ERROR"; status: "passed" | "failed" | "skipped"; at: number;
}
export interface PlanEntry {
  kind: "plan"; planKey: string; project: string; status: "started" | "complete" | "aborted"; at: number;
}
export type ProgressEntry = StepEntry | PlanEntry;

export const planKeyFor = (cwd: string, path: string) => resolve(cwd, path);
export const stepKey = (phaseId: string, stepId: string) => `${phaseId}/${stepId}`;

export function readProgress(ctx: { sessionManager: { getEntries(): any[] } }): ProgressEntry[] {
  return ctx.sessionManager.getEntries()
    .filter((e: any) => e.type === "custom" && e.customType === ENTRY_TYPE && e.data)
    .map((e: any) => e.data as ProgressEntry);
}

/** Steps whose latest recorded result is "passed" for this plan. */
export function passedSteps(entries: ProgressEntry[], planKey: string): Set<string> {
  const latest = new Map<string, StepEntry>();
  for (const e of entries) if (e.kind === "step" && e.planKey === planKey) latest.set(stepKey(e.phaseId, e.stepId), e);
  return new Set([...latest].filter(([, e]) => e.status === "passed").map(([k]) => k));
}

/** Plans whose most recent plan-level entry is not "complete". */
export function unfinishedPlans(entries: ProgressEntry[]): PlanEntry[] {
  const latest = new Map<string, PlanEntry>();
  for (const e of entries) if (e.kind === "plan") latest.set(e.planKey, e);
  return [...latest.values()].filter((e) => e.status !== "complete");
}
