import { existsSync, readFileSync } from "node:fs";
import type { OrchestratorConfig } from "./config.ts";
import type { Change, Phase, Plan, Step } from "./plan.ts";
import { norm, toEdit } from "./changes.ts";
import { runPi, type Usage } from "./util.ts";

export interface WorkerResult { summary: string; usage: Usage }

export interface DispatchArgs {
  plan: Plan; phase: Phase; step: Step; cfg: OrchestratorConfig; cwd: string;
  fixInstructions?: string;
  signal?: AbortSignal;
  onProgress?: (msg: string) => void;
  /** Present only inside a tool execute(); enables the pi-subagents backend. */
  executeTool?: (name: string, args: unknown, opts?: { signal?: AbortSignal; onUpdate?: (r: any) => void }) => Promise<any>;
}

const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : "- (none)");

/** Fence `text` with enough backticks that it cannot terminate early. */
export function fence(text: string): string {
  let f = "```";
  while (text.includes(f)) f += "`";
  return `${f}\n${text}\n${f}`;
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function renderChange(c: Change, i: number, n: number): string {
  const head = `### Change ${i + 1}/${n}: ${c.action} \`${c.file}\`${c.description ? `\nPurpose: ${c.description}` : ""}`;
  if (c.action === "write")
    return `${head}\nCall the \`write\` tool with path \`${c.file}\` and EXACTLY this content (nothing added, nothing removed):\n${fence(norm(c.content ?? ""))}`;
  if (c.action === "delete_file")
    return `${head}\nRun with bash: \`rm -- ${q(c.file)}\``;
  const e = toEdit(c)!;
  return `${head}\nCall the \`edit\` tool on path \`${c.file}\` with ONE edit whose oldText is exactly the first block and newText is exactly the second block.\noldText:\n${fence(e.oldText)}\nnewText:\n${fence(e.newText)}`;
}

export function composeTask(a: Pick<DispatchArgs, "plan" | "phase" | "step" | "fixInstructions">): string {
  const { plan, phase, step, fixInstructions } = a;
  const changes = step.changes ?? [];
  const n = changes.length;
  const parts = [
    `# Project: ${plan.project}`,
    plan.context ? `## Shared context\n${plan.context}` : "",
    `## Phase: ${phase.id}\n${phase.description}`,
    `## Step: ${step.title}\n${step.description}`,
    step.notes ? `### Notes\n${step.notes}` : "",
    n ? `## Exact changes to apply (in this order)\n${changes.map((c, i) => renderChange(c, i, n)).join("\n\n")}` : "",
    `### Files you may modify\n${list(step.files)}`,
    `### Commands to run after the changes\n${list(step.commands)}`,
    `### Acceptance criteria\n${list(step.acceptance)}`,
    n
      ? `## How to work
1. Apply the changes above one by one, in order, exactly as written. Copy oldText/newText/content character for character. Do not reformat, rename, reorder or "improve" anything.
2. You do not need to read whole files first. Only if an edit fails because oldText is not found: run \`grep -n\` for one distinctive line of oldText, read ~30 lines around it, and apply the smallest equivalent edit. Report this in your summary.
3. Do not touch any file or code not listed above.
4. Run the listed commands. If one fails because of your edits, fix only that.
5. Stop and report: each change applied (yes/no), commands with exit codes, anything you could not do.`
      : "Implement this step exactly as described, touching only the listed files. Run the listed commands, then stop and report what you did.",
  ];
  if (fixInstructions?.trim())
    parts.push(`## PREVIOUS ATTEMPT FAILED VERIFICATION\nFix exactly these issues:\n${fixInstructions.trim()}\nRe-inspect the current files before changing anything.`);
  return parts.filter(Boolean).join("\n\n");
}

function workerPrompt(file: string): string {
  if (!existsSync(file)) return "You implement one plan step precisely, with minimal diffs, then stop and summarize.";
  return readFileSync(file, "utf8").replace(/^---\n[\s\S]*?\n---\n/, "").trim();
}

export async function dispatchStep(a: DispatchArgs): Promise<WorkerResult> {
  const task = composeTask(a);
  if (a.cfg.workerBackend === "subagents" && a.executeTool) {
    const out = await a.executeTool(
      "subagent",
      { agent: "worker", task, cwd: a.cwd, async: false },
      { signal: a.signal, onUpdate: (r: any) => { const t = r?.content?.[0]?.text; if (t) a.onProgress?.(String(t).split("\n").pop()!.slice(0, 120)); } },
    );
    if (a.signal?.aborted) throw new Error("Aborted");
    const text = (out.result?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
    if (out.isError) throw new Error(`subagent worker failed: ${text.slice(0, 500)}`);
    const u = out.result?.usage ?? out.result?.details?.usage ?? {};
    return { summary: text, usage: { inputTokens: u.input ?? u.inputTokens ?? 0, outputTokens: u.output ?? u.outputTokens ?? 0 } };
  }
  // child backend (also the fallback when no tool context is available, e.g. from a slash command)
  if (!a.cfg.workerModel) throw new Error("workerModel is not configured");
  const run = await runPi({
    cwd: a.cwd, model: a.cfg.workerModel, prompt: task, signal: a.signal, timeoutMs: a.cfg.workerTimeoutMs,
    extraArgs: ["--append-system-prompt", workerPrompt(a.cfg.workerPromptFile)],
    onProgress: a.onProgress,
  });
  if (run.code !== 0 && !run.text) throw new Error(`worker exited ${run.code}: ${run.stderr.slice(0, 500)}`);
  return { summary: run.text || `(worker produced no text; tools used: ${run.tools.join(", ")})`, usage: run.usage };
}
