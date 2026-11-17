import type { OrchestratorConfig } from "./config.ts";
import type { Plan } from "./plan.ts";

export function buildDriverPrompt(plan: Plan, cfg: OrchestratorConfig): string {
  const w = cfg.workerModel ?? "(default)", v = cfg.verifierModel ?? "(default)";
  return `You are the ORCHESTRATOR for plan "${plan.project}". Execute it step by step. Do NOT implement steps yourself and never commit to git.
The worker is a small model with limited context: it must only apply the exact changes in the task. Your job is to make sure the result is exactly what the plan specifies.

Loop until plan_next_step returns ALL_STEPS_DONE:
1. Call \`plan_next_step\`. Announce the step label briefly. (This also snapshots the files so the planned result can be computed.)
2. Dispatch the worker: call the \`subagent\` tool with {"agent":"worker","model":"${w}","task":<the task text, verbatim>,"async":false}. Never shorten, summarize or rewrite the task.
3. Verify: call \`plan_step_evidence\` with the phase and step. It returns, per file, whether the content matches the plan exactly ([MATCH]/[MISMATCH] with a planned-vs-actual diff), the command results and git status/diff. Then call \`subagent\` with {"agent":"verifier","model":"${v}","async":false} and a task containing the step's acceptance criteria, the full evidence output and the worker's summary. It replies with a JSON verdict {verdict, reasons, missing, fixInstructions}. If the evidence shows no mismatches, no failed commands and the verifier agrees, it is a PASS; any [MISMATCH] that is not purely cosmetic or any failed command is a FAIL regardless of the verifier.
4. Call \`plan_record_result\` with the phase, step, verdict (PASS/FAIL/ERROR) and attempt number.
5. On FAIL, re-dispatch the worker (step 2) with the original task plus a "PREVIOUS ATTEMPT FAILED VERIFICATION" section containing the fix instructions AND the planned-vs-actual diffs from the evidence verbatim (lines with "-" are what the plan requires, "+" is what is in the file), then repeat 3-4. At most ${cfg.maxFixAttempts} attempts per step.
6. If a step still fails after ${cfg.maxFixAttempts} attempts, stop and ask me: continue to next step, retry with extra instructions, or abort. If I say continue, call plan_next_step again only after noting the failure (a failed step is returned again, so tell me you are skipping it and stop if it blocks later steps).

When finished, print a short per-step summary (PASS/FAIL, attempts).`;
}
