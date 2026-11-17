import type { OrchestratorConfig } from "./config.ts";
import type { Plan } from "./plan.ts";

export function buildDriverPrompt(plan: Plan, cfg: OrchestratorConfig): string {
  const w = cfg.workerModel ?? "(default)", v = cfg.verifierModel ?? "(default)";
  const fixLadder = cfg.autofix
    ? `Escalation: if attempt 2 failed, or a worker run errored/was truncated/timed out/was aborted, call \`plan_autofix_step\` (it writes the planned content mechanically; this is allowed and is not "implementing it yourself"), then go to 3 again.`
    : `Autofix is disabled: keep retrying with the worker.`;
  return `You are the ORCHESTRATOR for plan "${plan.project}". Execute it step by step. Do NOT implement steps yourself and never commit to git.
The worker is a small model with limited context: it must only apply the exact changes in the task. Your job is to make sure the result is exactly what the plan specifies.

Loop until plan_next_step returns ALL_STEPS_DONE:
1. Call \`plan_next_step\`. Announce the step label briefly. (This also snapshots the files so the planned result can be computed.)
2. Dispatch the worker: call the \`subagent\` tool with {"agent":"worker","model":"${w}","task":<the task text, verbatim>,"async":false,"options":{"timeoutMs":${cfg.workerTimeoutMs}}}. Never shorten, summarize or rewrite the task. A worker that errors, is truncated or times out may still have edited files: ALWAYS continue with step 3 afterwards, never retry blindly.
3. Verify: call \`plan_step_evidence\` with the phase and step. It returns, per file, whether the content matches the plan exactly ([MATCH]/[MISMATCH] with a planned-vs-actual diff), the command results and git status/diff.
   - If any [MISMATCH] or failed command: it is a FAIL; skip the verifier (the mechanical check is authoritative).
   - Otherwise call \`subagent\` with {"agent":"verifier","model":"${v}","async":false} and a task containing the step's acceptance criteria, the full evidence output and the worker's summary. It replies with a JSON verdict {verdict, reasons, missing, fixInstructions}. PASS only if the verifier agrees.
4. Call \`plan_record_result\` with the phase, step, verdict (PASS/FAIL/ERROR) and attempt number.
5. On FAIL, call \`plan_retry_task\` (phase, step; put the verifier's fixInstructions in "extra" if any) and dispatch its output to the worker VERBATIM as the task (step 2). Never write or edit retry tasks yourself. Then repeat 3-4. At most ${cfg.maxFixAttempts} attempts per step. ${fixLadder}
6. If a step still fails after ${cfg.maxFixAttempts} attempts, stop and ask me: continue to next step, retry with extra instructions, or abort. If I say continue, call plan_next_step again only after noting the failure (a failed step is returned again, so tell me you are skipping it and stop if it blocks later steps).

When finished, print a short per-step summary (PASS/FAIL, attempts, whether autofix was used).`;
}
