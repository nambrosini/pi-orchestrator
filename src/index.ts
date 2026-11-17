import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig, requireModels } from "./config.ts";
import { loadPlan, type Plan } from "./plan.ts";
import { autofixFiles, checkPlan, formatIssues, mismatchInstructions } from "./changes.ts";
import { collectEvidence, formatEvidence, VERDICT_RULES } from "./verifier.ts";
import { runPlan, type RunOptions, type RunSummary } from "./orchestrator.ts";
import { ENTRY_TYPE, passedSteps, planKeyFor, readProgress, unfinishedPlans, type ProgressEntry } from "./state.ts";
import { ensureSnapshot, findStep, finishSessionRun, getRun, nextStep, recordResult, remaining, retryTask, startSessionRun } from "./session.ts";
import { stepKey } from "./state.ts";
import { buildDriverPrompt } from "./driver-prompt.ts";

function tokenize(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

export function parseArgs(args: string): { path?: string; opts: RunOptions } {
  const t = tokenize(args), opts: RunOptions = {};
  let path: string | undefined;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "--phase") opts.phase = t[++i];
    else if (t[i] === "--step") opts.step = t[++i];
    else if (t[i] === "--dry-run") opts.dryRun = true;
    else if (t[i] === "--resume") opts.resume = true;
    else if (t[i] === "--force") opts.force = true;
    else if (!path) path = t[i];
  }
  return { path, opts };
}

function render(s: RunSummary): string {
  const lines = [`Plan "${s.project}": ${s.status}`];
  for (const o of s.steps) lines.push(`  ${o.status.toUpperCase().padEnd(7)} ${o.phase}/${o.step} (attempts: ${o.attempts})${o.status === "failed" ? ` — ${(o.verdict?.reasons ?? [o.error ?? ""]).join("; ")}` : ""}`);
  return lines.join("\n");
}

/** Simulate the whole plan against the files on disk. Only meaningful for a fresh, full run. */
function gate(plan: Plan, cwd: string, opts: RunOptions): string | undefined {
  if (opts.force || opts.resume || opts.phase || opts.step) return undefined;
  const issues = checkPlan(plan, cwd);
  if (!issues.some((i) => i.level === "error")) return undefined;
  return `${formatIssues(issues)}\nFix the plan (the architect must re-read the files and copy anchors verbatim) or pass --force.`;
}

export default function (pi: ExtensionAPI) {
  let active: AbortController | undefined;
  const append = (e: ProgressEntry) => pi.appendEntry(ENTRY_TYPE, e);
  const endSessionRun = async (ctx: any) => {
    const r = finishSessionRun(append);
    if (!r) return;
    if (r.prevModel) { try { await pi.setModel(r.prevModel as any); } catch { /* ignore */ } }
    if (ctx?.hasUI) {
      ctx.ui.setStatus("orchestrator", undefined);
      ctx.ui.notify(r.status === "complete" ? "Plan complete. Model restored." : `Plan stopped with ${r.left} step(s) left. Continue with /execute-plan <path> --resume. Model restored.`, r.status === "complete" ? "info" : "warning");
    }
  };
  pi.on("session_shutdown", async (_e, ctx) => { active?.abort(); await endSessionRun(ctx); });
  pi.on("agent_settled", async (_e, ctx) => { if (getRun()) await endSessionRun(ctx); });

  pi.on("session_start", async (_e, ctx) => {
    const open = unfinishedPlans(readProgress(ctx));
    if (open.length && ctx.hasUI)
      ctx.ui.notify(`Unfinished plan(s): ${open.map((p) => p.project).join(", ")}. Continue with /execute-plan <path> --resume`, "info");
  });

  pi.registerCommand("execute-plan", {
    description: "Execute a plan: /execute-plan <path> [--phase id] [--step id] [--dry-run] [--resume] [--force]",
    handler: async (args, ctx) => {
      const { path, opts } = parseArgs(args);
      const say = (m: string, l: "info" | "error" = "info") => (ctx.hasUI ? ctx.ui.notify(m, l) : console.error(m));
      if (!path) return say("Usage: /execute-plan <path> [--phase id] [--step id] [--dry-run] [--resume]", "error");
      // In-session mode: the current session (switched to orchestratorModel) drives the plan.
      if (ctx.hasUI && !opts.dryRun) {
        try {
          const plan = loadPlan(path, ctx.cwd);
          const cfg = loadConfig(ctx.cwd, ctx.model as any);
          requireModels(cfg);
          const blocked = gate(plan, ctx.cwd, opts);
          if (blocked) return say(blocked, "error");
          if (getRun()) return say("A plan run is already active in this session.", "error");
          let prev: unknown;
          if (cfg.orchestratorModel) {
            const [prov, ...rest] = cfg.orchestratorModel.split("/");
            const m = (ctx as any).modelRegistry.find(prov, rest.join("/"));
            if (!m) return say(`orchestratorModel not found: ${cfg.orchestratorModel}`, "error");
            prev = ctx.model;
            if (!(await pi.setModel(m))) return say(`No API key for ${cfg.orchestratorModel}`, "error");
          }
          const planKey = planKeyFor(ctx.cwd, path);
          startSessionRun(plan, planKey, cfg, opts, passedSteps(readProgress(ctx as any), planKey), prev);
          append({ kind: "plan", planKey, project: plan.project, status: "started", at: Date.now() });
          ctx.ui.setStatus("orchestrator", `orchestrating: ${plan.project}`);
          pi.sendUserMessage(buildDriverPrompt(plan, cfg));
        } catch (e: any) {
          await endSessionRun(ctx);
          say(`execute-plan: ${e.message}`, "error");
        }
        return;
      }
      const ac = new AbortController();
      active = ac;
      const onSig = () => ac.abort();
      process.once("SIGINT", onSig); process.once("SIGTERM", onSig);
      try {
        const plan = loadPlan(path, ctx.cwd);
        const cfg = loadConfig(ctx.cwd, ctx.model as any);
        if (!opts.dryRun) requireModels(cfg);
        const blocked = opts.dryRun ? undefined : gate(plan, ctx.cwd, opts);
        if (blocked) throw new Error(blocked);
        const summary = await runPlan(plan, opts, {
          pi, ctx: ctx as any, cfg, planKey: planKeyFor(ctx.cwd, path), signal: ac.signal,
          onUpdate: (t) => { if (!ctx.hasUI) console.error(t); },
        });
        if (ctx.hasUI) ctx.ui.notify(render(summary), summary.status === "failed" || summary.status === "aborted" ? "error" : "info");
        else console.log(JSON.stringify(summary));
        if (!ctx.hasUI && (summary.status === "failed" || summary.status === "aborted")) process.exitCode = 1;
      } catch (e: any) {
        say(`execute-plan: ${e.message}`, "error");
        if (!ctx.hasUI) process.exitCode = 1;
      } finally {
        process.removeListener("SIGINT", onSig); process.removeListener("SIGTERM", onSig);
        active = undefined;
      }
    },
  });

  pi.registerTool({
    name: "plan_next_step",
    label: "Next plan step",
    description: "Return the next pending step of the active /execute-plan run (task text, models, commands, acceptance) or ALL_STEPS_DONE.",
    promptSnippet: "Get next step of the active /execute-plan run",
    promptGuidelines: ["plan_next_step and plan_record_result are only for an active /execute-plan run."],
    parameters: Type.Object({}),
    async execute(_id, _p, _signal, _u, ctx) {
      const n = nextStep();
      const r = getRun()!;
      if (n) ensureSnapshot(n.phase, n.step, ctx.cwd);
      if (ctx.hasUI) ctx.ui.setStatus("orchestrator", n ? `orchestrating: ${n.label}` : "orchestrating: finishing");
      const text = n ? JSON.stringify({ ...n, workerModel: r.cfg.workerModel, verifierModel: r.cfg.verifierModel, maxFixAttempts: r.cfg.maxFixAttempts, remaining: remaining() }, null, 2) : "ALL_STEPS_DONE";
      return { content: [{ type: "text", text }], details: {} };
    },
  });

  pi.registerTool({
    name: "plan_step_evidence",
    label: "Step evidence",
    description: "For the active /execute-plan run: compare the files with the planned result of a step (exact expected-vs-actual diff), run the step's commands, and return git status/diff. Pass the output to the verifier.",
    promptSnippet: "Collect verification evidence for a plan step",
    parameters: Type.Object({ phase: Type.String(), step: Type.String() }),
    async execute(_id, p, signal, _u, ctx) {
      const r = getRun();
      if (!r) throw new Error("No active /execute-plan run.");
      const step = findStep(p.phase, p.step);
      const ev = await collectEvidence(step, ctx.cwd, r.cfg, signal, ensureSnapshot(p.phase, p.step, ctx.cwd));
      r.lastFix.set(stepKey(p.phase, p.step), [mismatchInstructions(ev.checks), ...ev.commands.filter((c) => c.exitCode !== 0).map((c) => `Command failed: ${c.command} (exit ${c.exitCode})\n${c.output.slice(-1500)}`)].filter(Boolean).join("\n\n"));
      const mism = ev.checks.filter((c) => c.status === "mismatch").length;
      const failed = ev.commands.filter((c) => c.exitCode !== 0).length;
      const text = `Summary: ${mism} file(s) differ from the plan, ${failed} command(s) failed.\n\n${formatEvidence(ev)}\n\n## Verifier rules\n${VERDICT_RULES}`;
      return { content: [{ type: "text", text }], details: { mismatches: mism, failedCommands: failed } };
    },
  });

  pi.registerTool({
    name: "plan_retry_task",
    label: "Retry task",
    description: "For the active /execute-plan run: the complete worker task for a retry (original task + PREVIOUS ATTEMPT FAILED section built from the latest plan_step_evidence). Pass it verbatim to the worker; never write retry tasks yourself.",
    promptSnippet: "Get the verbatim worker task for a retry of a failed step",
    parameters: Type.Object({ phase: Type.String(), step: Type.String(), extra: Type.Optional(Type.String({ description: "Extra verifier fix instructions to append" })) }),
    async execute(_id, p) {
      return { content: [{ type: "text", text: retryTask(p.phase, p.step, p.extra) }], details: {} };
    },
  });

  pi.registerTool({
    name: "plan_autofix_step",
    label: "Autofix step",
    description: "For the active /execute-plan run: deterministically write the PLANNED file content for the step's files that differ from the plan (no model involved, exactly what the plan specifies). Use as escalation when the worker failed or hung twice, or truncated its output. Then call plan_step_evidence again.",
    promptSnippet: "Mechanically apply the planned content of a step (escalation)",
    parameters: Type.Object({ phase: Type.String(), step: Type.String() }),
    async execute(_id, p, _s, _u, ctx) {
      const r = getRun();
      if (!r) throw new Error("No active /execute-plan run.");
      if (!r.cfg.autofix) throw new Error("autofix is disabled (orchestrator.autofix=false).");
      const res = autofixFiles(findStep(p.phase, p.step), ctx.cwd, ensureSnapshot(p.phase, p.step, ctx.cwd));
      const text = res.length ? res.map((x) => `${x.file}: ${x.action}`).join("\n") : "Nothing to fix: all files already equal the planned content.";
      return { content: [{ type: "text", text: `${text}\nNow call plan_step_evidence again.` }], details: { res } };
    },
  });

  pi.registerCommand("check-plan", {
    description: "Validate a plan and simulate all its changes against the current files: /check-plan <path>",
    handler: async (args, ctx) => {
      const { path } = parseArgs(args);
      const say = (m: string, l: "info" | "warning" | "error") => (ctx.hasUI ? ctx.ui.notify(m, l) : console.error(m));
      if (!path) return say("Usage: /check-plan <path>", "error");
      try {
        const issues = checkPlan(loadPlan(path, ctx.cwd), ctx.cwd);
        say(formatIssues(issues), issues.some((i) => i.level === "error") ? "error" : issues.length ? "warning" : "info");
        if (!ctx.hasUI && issues.some((i) => i.level === "error")) process.exitCode = 1;
      } catch (e: any) { say(`check-plan: ${e.message}`, "error"); if (!ctx.hasUI) process.exitCode = 1; }
    },
  });

  pi.registerTool({
    name: "plan_check",
    label: "Check plan",
    description: "Validate a plan file and simulate every change in order against the current files: reports anchors (find) that do not match or are not unique, edits to missing files, placeholder/vague content. Run after writing or editing a plan.",
    promptSnippet: "Validate a plan file and dry-apply its exact changes",
    promptGuidelines: ["After writing a plan for /execute-plan, call plan_check on it and fix every ERROR (and placeholder warnings) before handing it over."],
    parameters: Type.Object({ planPath: Type.String({ description: "Path to the plan file" }) }),
    async execute(_id, p, _s, _u, ctx) {
      const issues = checkPlan(loadPlan(p.planPath, ctx.cwd), ctx.cwd);
      return { content: [{ type: "text", text: formatIssues(issues) }], details: { issues } };
    },
  });

  pi.registerTool({
    name: "plan_record_result",
    label: "Record step result",
    description: "Record the verification result of a plan step attempt.",
    promptSnippet: "Record plan step result",
    parameters: Type.Object({
      phase: Type.String(), step: Type.String(),
      verdict: Type.Union([Type.Literal("PASS"), Type.Literal("FAIL"), Type.Literal("ERROR")]),
      attempt: Type.Number(),
    }),
    async execute(_id, p) {
      const e = recordResult(append, p as any);
      return { content: [{ type: "text", text: `Recorded ${p.phase}/${p.step}: ${e.status}. Remaining: ${remaining()}` }], details: e };
    },
  });

  pi.registerTool({
    name: "run_plan_step",
    label: "Run plan step",
    description: "Execute ONE step of a plan file through the worker + verifier loop (dispatch, verify, fix retries) and return the result.",
    promptSnippet: "Run a single plan step via worker/verifier loop",
    promptGuidelines: [
      "Use run_plan_step when a plan file already exists and you want one specific step implemented and verified by the worker model, instead of editing the code yourself.",
      "Prefer the /execute-plan command for whole plans; use run_plan_step only for targeted single steps or retries.",
    ],
    parameters: Type.Object({
      planPath: Type.String({ description: "Path to the plan file (.json or .md with a ```plan json block)" }),
      step: Type.String({ description: "Step id" }),
      phase: Type.Optional(Type.String({ description: "Phase id, required if the step id is not unique across phases" })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const plan = loadPlan(params.planPath, ctx.cwd);
      const cfg = loadConfig(ctx.cwd, ctx.model as any);
      requireModels(cfg);
      const summary = await runPlan(plan, { step: params.step, phase: params.phase }, {
        pi, ctx: ctx as any, cfg, planKey: planKeyFor(ctx.cwd, params.planPath), signal,
        executeTool: (n, a, o) => ctx.executeTool(n, a, o),
        onUpdate: (t) => onUpdate?.({ content: [{ type: "text", text: t }], details: {} }),
      });
      if (summary.status !== "complete") throw new Error(`${render(summary)}\n${JSON.stringify(summary.steps)}`);
      return { content: [{ type: "text", text: render(summary) }], details: summary };
    },
  });
}
