import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const CHANGE_ACTIONS = ["write", "replace", "insert_after", "insert_before", "delete_file"] as const;
export type ChangeAction = (typeof CHANGE_ACTIONS)[number];

/**
 * One exact, mechanical file operation. The worker applies these literally:
 * - write:         create/overwrite `file` with `content` (full file).
 * - replace:       replace the unique text `find` with `content` ("" deletes it).
 * - insert_after:  insert `content` on a new line right after the unique text `find`.
 * - insert_before: insert `content` on a new line right before the unique text `find`.
 * - delete_file:   delete `file`.
 */
export const ChangeSchema = Type.Object({
  file: Type.String({ minLength: 1 }),
  action: Type.Union(CHANGE_ACTIONS.map((a) => Type.Literal(a))),
  find: Type.Optional(Type.String()),
  content: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
});

export const StepSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  title: Type.String({ minLength: 1 }),
  description: Type.String({ minLength: 1 }),
  files: Type.Array(Type.String()),
  changes: Type.Array(ChangeSchema),
  commands: Type.Array(Type.String()),
  acceptance: Type.Array(Type.String()),
  notes: Type.Optional(Type.String()),
});
export const PhaseSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  description: Type.String(),
  steps: Type.Array(StepSchema, { minItems: 1 }),
});
export const PlanSchema = Type.Object({
  project: Type.String({ minLength: 1 }),
  context: Type.Optional(Type.String()),
  phases: Type.Array(PhaseSchema, { minItems: 1 }),
});
export type Change = Static<typeof ChangeSchema>;
export type Step = Static<typeof StepSchema>;
export type Phase = Static<typeof PhaseSchema>;
export type Plan = Static<typeof PlanSchema>;

export class PlanError extends Error {}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "item";
}

function uniqueId(base: string, used: Set<string>): string {
  let id = base, n = 2;
  while (used.has(id)) id = `${base}-${n++}`;
  used.add(id);
  return id;
}

const isObj = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Fill missing optional fields and generate ids; leaves structurally invalid data for the validator. */
export function normalize(raw: unknown): unknown {
  if (!isObj(raw)) return raw;
  const out: Record<string, any> = { ...raw };
  if (Array.isArray(out.phases)) {
    const phaseIds = new Set<string>();
    out.phases = out.phases.map((p: any, pi: number) => {
      if (!isObj(p)) return p;
      const ph: Record<string, any> = { ...p };
      if (ph.description === undefined) ph.description = "";
      if (!ph.id) ph.id = uniqueId(slug(String(ph.description || `phase-${pi + 1}`)), phaseIds);
      else phaseIds.add(ph.id);
      if (Array.isArray(ph.steps)) {
        const stepIds = new Set<string>();
        ph.steps = ph.steps.map((s: any, si: number) => {
          if (!isObj(s)) return s;
          const st: Record<string, any> = { ...s };
          st.files ??= [];
          st.commands ??= [];
          st.acceptance ??= [];
          st.changes ??= [];
          // `files` always covers every file touched by `changes`.
          if (Array.isArray(st.files) && Array.isArray(st.changes)) {
            const fs = new Set<string>(st.files);
            for (const c of st.changes) if (isObj(c) && typeof c.file === "string" && !fs.has(c.file)) { fs.add(c.file); st.files = [...st.files, c.file]; }
          }
          if (!st.id) st.id = uniqueId(slug(String(st.title ?? `step-${si + 1}`)), stepIds);
          else stepIds.add(st.id);
          return st;
        });
      }
      return ph;
    });
  }
  return out;
}

export function validate(raw: unknown): Plan {
  const data = normalize(raw);
  const errors = [...Value.Errors(PlanSchema, data)];
  if (errors.length) {
    const msg = errors.slice(0, 10).map((e: any) => `  ${e.instancePath || "/"}: ${e.message}`).join("\n");
    throw new PlanError(`Invalid plan:\n${msg}`);
  }
  const plan = data as Plan;
  const seen = new Set<string>();
  plan.phases.forEach((ph, i) => {
    if (seen.has(ph.id)) throw new PlanError(`Invalid plan: /phases/${i}/id: duplicate phase id "${ph.id}"`);
    seen.add(ph.id);
    const s = new Set<string>();
    ph.steps.forEach((st, j) => {
      if (s.has(st.id)) throw new PlanError(`Invalid plan: /phases/${i}/steps/${j}/id: duplicate step id "${st.id}"`);
      s.add(st.id);
      const at = `/phases/${i}/steps/${j}`;
      if (!st.changes.length && !st.commands.length)
        throw new PlanError(`Invalid plan: ${at}/changes: a step needs at least one exact change (or, for command-only steps, a command)`);
      st.changes.forEach((c, k) => {
        const e = changeError(c);
        if (e) throw new PlanError(`Invalid plan: ${at}/changes/${k}: ${e}`);
      });
    });
  });
  return plan;
}

/** Per-action field requirements; returns an error message or undefined. */
export function changeError(c: Change): string | undefined {
  const needFind = c.action === "replace" || c.action === "insert_after" || c.action === "insert_before";
  if (needFind && !c.find) return `action "${c.action}" requires a non-empty "find" (exact existing text copied verbatim from the file)`;
  if (c.action === "write" && typeof c.content !== "string") return `action "write" requires "content" (the complete file content)`;
  if (c.action === "replace" && typeof c.content !== "string") return `action "replace" requires "content" (the replacement text; "" to delete)`;
  if ((c.action === "insert_after" || c.action === "insert_before") && !c.content) return `action "${c.action}" requires non-empty "content"`;
  return undefined;
}

/** Extract candidate JSON strings from markdown: ```plan json blocks first, then ```json blocks. */
function extractBlocks(text: string): string[] {
  const re = /```([^\n`]*)\n([\s\S]*?)```/g;
  const planBlocks: string[] = [], jsonBlocks: string[] = [];
  for (let m; (m = re.exec(text)); ) {
    const info = m[1].trim().toLowerCase();
    if (/^plan(\s+json)?$/.test(info)) planBlocks.push(m[2]);
    else if (info === "json") jsonBlocks.push(m[2]);
  }
  return [...planBlocks, ...jsonBlocks];
}

export function parsePlan(text: string): Plan {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try { return validate(JSON.parse(trimmed)); }
    catch (e) { if (e instanceof PlanError) throw e; /* maybe markdown; fall through */ }
  }
  const blocks = extractBlocks(text);
  if (!blocks.length) throw new PlanError("No plan found: expected a JSON file or a fenced ```plan json block.");
  let firstErr: Error | undefined;
  for (const b of blocks) {
    try { return validate(JSON.parse(b)); } catch (e) { firstErr ??= e as Error; }
  }
  throw firstErr instanceof PlanError ? firstErr : new PlanError(`Plan block is not valid JSON: ${firstErr?.message}`);
}

export function loadPlan(path: string, cwd: string): Plan {
  const abs = resolve(cwd, path);
  let text: string;
  try { text = readFileSync(abs, "utf8"); } catch (e: any) { throw new PlanError(`Cannot read ${abs}: ${e.message}`); }
  return parsePlan(text);
}
