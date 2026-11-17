import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Change, Plan, Step } from "./plan.ts";
import { sh, truncateHeadTail } from "./util.ts";

/** File contents keyed by plan path; null = file does not exist. */
export type Snapshot = Record<string, string | null>;

export const norm = (s: string) => s.replace(/\r\n/g, "\n");

export function countOccurrences(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

/** The exact edit-tool operation for find-based changes. */
export function toEdit(c: Change): { oldText: string; newText: string } | undefined {
  const find = norm(c.find ?? ""), content = norm(c.content ?? "");
  if (c.action === "replace") return { oldText: find, newText: content };
  if (c.action === "insert_after") return { oldText: find, newText: `${find}\n${content}` };
  if (c.action === "insert_before") return { oldText: find, newText: `${content}\n${find}` };
  return undefined;
}

/** Apply one change to in-memory content. */
export function applyChange(cur: string | null, c: Change): { content: string | null } | { error: string } {
  if (c.action === "write") return { content: norm(c.content ?? "") };
  if (c.action === "delete_file") return cur === null ? { error: `file does not exist` } : { content: null };
  if (cur === null) return { error: `file does not exist (create it with a "write" change in this or an earlier step)` };
  const e = toEdit(c)!;
  const n = countOccurrences(cur, e.oldText);
  if (n === 0) return { error: `"find" text not found in the file as it will be at this point: ${JSON.stringify(e.oldText.slice(0, 120))}` };
  if (n > 1) return { error: `"find" text occurs ${n} times; extend it with surrounding lines so it is unique: ${JSON.stringify(e.oldText.slice(0, 120))}` };
  return { content: cur.replace(e.oldText, () => e.newText) };
}

function readOrNull(cwd: string, file: string): string | null {
  const p = resolve(cwd, file);
  try { return existsSync(p) ? norm(readFileSync(p, "utf8")) : null; } catch { return null; }
}

/** Current on-disk content of every file the step changes. */
export function snapshotFiles(step: Step, cwd: string): Snapshot {
  const snap: Snapshot = {};
  for (const c of step.changes ?? []) if (!(c.file in snap)) snap[c.file] = readOrNull(cwd, c.file);
  return snap;
}

/** Expected content per file after applying the step's changes to `snap`. */
export function expectedFiles(step: Step, snap: Snapshot): Record<string, { content: string | null } | { error: string }> {
  const out: Record<string, { content: string | null } | { error: string }> = {};
  for (const c of step.changes) {
    const prev = out[c.file] ?? { content: c.file in snap ? snap[c.file] : null };
    if ("error" in prev) continue;
    const r = applyChange(prev.content, c);
    out[c.file] = "error" in r ? { error: `planned ${c.action} could not be applied to the pre-step file: ${r.error}` } : r;
  }
  return out;
}

export interface PlanIssue { level: "error" | "warning"; where: string; message: string }

const PLACEHOLDER = /(\.\.\.\s*(rest|existing|unchanged|same|other|more)\b|\/\/\s*\.\.\.|#\s*\.\.\.|\/\*\s*\.\.\.\s*\*\/|\bTODO\b|\bimplement (this|here|me)\b|\bsimilar(ly)? to (the )?above\b|<[a-z ]*(here|code|implementation)>)/i;
const VAGUE = /\b(as needed|if needed|appropriate(ly)?|etc\.?|and so on|something like|similar|handle (errors|edge cases)|update accordingly|wire (it|this) up)\b/i;

/**
 * Lint a validated plan by simulating every change in order against the files on disk.
 * Errors: anchors that will not match (or not uniquely), edits to files that will not exist.
 * Warnings: placeholder/vague text, steps without acceptance criteria, files listed without changes.
 */
export function checkPlan(plan: Plan, cwd: string): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const files = new Map<string, string | null>();
  const get = (f: string) => { if (!files.has(f)) files.set(f, readOrNull(cwd, f)); return files.get(f)!; };
  for (const ph of plan.phases) for (const st of ph.steps) {
    const where = `${ph.id}/${st.id}`;
    const changed = new Set(st.changes.map((c) => c.file));
    if (!st.acceptance.length) issues.push({ level: "warning", where, message: "no acceptance criteria" });
    for (const f of st.files) if (!changed.has(f)) issues.push({ level: "warning", where, message: `"${f}" is listed in files but has no change` });
    if (VAGUE.test(st.description)) issues.push({ level: "warning", where, message: `description contains vague wording (${st.description.match(VAGUE)![0]}); say exactly what to do` });
    st.changes.forEach((c, k) => {
      const w = `${where} change ${k + 1} (${c.action} ${c.file})`;
      const m = (c.content ?? "").match(PLACEHOLDER);
      if (m) issues.push({ level: "warning", where: w, message: `content looks like a placeholder (${m[0]}); give the complete literal code` });
      if (c.action === "write" && get(c.file) !== null && !c.description)
        issues.push({ level: "warning", where: w, message: "overwrites an existing file; prefer replace/insert changes, or add a description confirming the full rewrite" });
      const r = applyChange(get(c.file), c);
      if ("error" in r) issues.push({ level: "error", where: w, message: r.error });
      else files.set(c.file, r.content);
    });
  }
  return issues;
}

export function formatIssues(issues: PlanIssue[]): string {
  if (!issues.length) return "Plan check: OK (all changes apply cleanly in order).";
  const e = issues.filter((i) => i.level === "error"), w = issues.filter((i) => i.level === "warning");
  return [`Plan check: ${e.length} error(s), ${w.length} warning(s)`, ...issues.map((i) => `  ${i.level.toUpperCase()} ${i.where}: ${i.message}`)].join("\n");
}

export interface ChangeCheck { file: string; status: "match" | "mismatch" | "unknown"; detail: string; diff?: string }

const canon = (s: string) => norm(s).split("\n").map((l) => l.trimEnd()).join("\n").replace(/\n+$/, "");

/** Compare the files on disk with what the plan says they should be after this step. */
export async function checkChanges(step: Step, cwd: string, snap: Snapshot | undefined): Promise<ChangeCheck[]> {
  if (!step.changes?.length) return [];
  if (!snap) return [{ file: "*", status: "unknown", detail: "no pre-step snapshot; cannot compute expected content" }];
  const out: ChangeCheck[] = [];
  for (const [file, exp] of Object.entries(expectedFiles(step, snap))) {
    const actual = readOrNull(cwd, file);
    if ("error" in exp) { out.push({ file, status: "unknown", detail: exp.error }); continue; }
    if (exp.content === null) {
      out.push(actual === null ? { file, status: "match", detail: "deleted as planned" } : { file, status: "mismatch", detail: "file should have been deleted but still exists" });
      continue;
    }
    if (actual === null) { out.push({ file, status: "mismatch", detail: "file should exist but is missing" }); continue; }
    if (canon(actual) === canon(exp.content)) { out.push({ file, status: "match", detail: "content matches the plan exactly (ignoring trailing whitespace)" }); continue; }
    out.push({ file, status: "mismatch", detail: "content differs from the planned result", diff: await diffText(exp.content, actual, file) });
  }
  return out;
}

async function diffText(expected: string, actual: string, file: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "pi-orch-diff-"));
  try {
    writeFileSync(join(dir, "expected"), expected);
    writeFileSync(join(dir, "actual"), actual);
    const r = await sh("git diff --no-index --no-color -U2 -- expected actual", dir);
    const body = r.stdout.split("\n").filter((l) => !/^(diff --git|index |--- |\+\+\+ )/.test(l)).join("\n");
    return truncateHeadTail(`--- planned ${file}\n+++ actual ${file}\n${body}`, 6000);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export function formatChecks(checks: ChangeCheck[]): string {
  if (!checks.length) return "(step has no planned file changes)";
  return checks.map((c) => `[${c.status.toUpperCase()}] ${c.file}: ${c.detail}${c.diff ? `\n${c.diff}` : ""}`).join("\n\n");
}

/** Mismatches rendered as concrete fix instructions for the worker. */
export function mismatchInstructions(checks: ChangeCheck[]): string {
  const bad = checks.filter((c) => c.status === "mismatch");
  if (!bad.length) return "";
  return `The files do not match the planned result. Lines starting with "-" are what the plan requires, "+" is what is currently in the file. Make the file match the plan:\n\n${bad.map((c) => `${c.file}: ${c.detail}${c.diff ? `\n${c.diff}` : ""}`).join("\n\n")}`;
}
