import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePlan, PlanError } from "../src/plan.ts";
import { checkPlan, checkChanges, snapshotFiles, mismatchInstructions } from "../src/changes.ts";
import { composeTask } from "../src/worker.ts";

const mk = (steps: any[]) => JSON.stringify({ project: "p", phases: [{ id: "a", description: "d", steps }] });
const repo = () => { const d = mkdtempSync(join(tmpdir(), "orch-test-")); mkdirSync(join(d, "src")); return d; };

test("validation: per-action requirements and change-less steps", () => {
  assert.throws(() => parsePlan(mk([{ title: "t", description: "x", changes: [{ file: "a", action: "replace", content: "y" }] }])), /changes\/0: action "replace" requires a non-empty "find"/);
  assert.throws(() => parsePlan(mk([{ title: "t", description: "x", changes: [{ file: "a", action: "write" }] }])), /requires "content"/);
  assert.throws(() => parsePlan(mk([{ title: "t", description: "x" }])), PlanError);
  // command-only step is fine; files derived from changes
  parsePlan(mk([{ title: "t", description: "x", commands: ["npm i"] }]));
  const p = parsePlan(mk([{ title: "t", description: "x", changes: [{ file: "src/a.js", action: "write", content: "x\n" }] }]));
  assert.deepEqual(p.phases[0].steps[0].files, ["src/a.js"]);
});

test("checkPlan simulates changes in order", () => {
  const d = repo();
  writeFileSync(join(d, "src/a.js"), "const a = 1;\nconst b = 1;\nconst b = 1;\n");
  const plan = parsePlan(mk([
    { id: "s1", title: "t", description: "x", acceptance: ["ok"], changes: [
      { file: "src/new.js", action: "write", content: "export const x = 1;\n" },
      { file: "src/a.js", action: "insert_after", find: "const a = 1;", content: "const c = 2;" },
    ] },
    { id: "s2", title: "t2", description: "y", acceptance: ["ok"], changes: [
      { file: "src/new.js", action: "replace", find: "export const x = 1;", content: "export const x = 2;" }, // depends on s1
      { file: "src/a.js", action: "replace", find: "const b = 1;", content: "" }, // ambiguous
      { file: "src/missing.js", action: "insert_after", find: "x", content: "y" }, // no file
      { file: "src/a.js", action: "replace", find: "const zzz", content: "// TODO" }, // not found + placeholder
    ] },
  ]));
  const issues = checkPlan(plan, d);
  const errs = issues.filter((i) => i.level === "error").map((i) => i.where + " " + i.message);
  assert.equal(errs.length, 3, errs.join("\n"));
  assert.match(errs.join("\n"), /occurs 2 times/);
  assert.match(errs.join("\n"), /file does not exist/);
  assert.match(errs.join("\n"), /not found/);
  assert.ok(issues.some((i) => i.level === "warning" && /placeholder/.test(i.message)));
  rmSync(d, { recursive: true, force: true });
});

test("composeTask renders literal edit operations", () => {
  const plan = parsePlan(mk([{ id: "s", title: "t", description: "x", changes: [
    { file: "src/a.js", action: "insert_after", find: "line1", content: "```\nnew" },
    { file: "src/b.js", action: "delete_file" },
  ] }]));
  const t = composeTask({ plan, phase: plan.phases[0], step: plan.phases[0].steps[0] });
  assert.match(t, /Change 1\/2: insert_after `src\/a.js`/);
  assert.match(t, /oldText:\n```\nline1\n```/);
  assert.match(t, /newText:\n````\nline1\n```\nnew\n````/); // fence grows past content backticks
  assert.match(t, /rm -- 'src\/b.js'/);
});

test("checkChanges compares planned vs actual", async () => {
  const d = repo();
  writeFileSync(join(d, "src/a.js"), "one\ntwo\n");
  const plan = parsePlan(mk([{ id: "s", title: "t", description: "x", changes: [
    { file: "src/a.js", action: "replace", find: "two", content: "TWO" },
    { file: "src/n.js", action: "write", content: "n\n" },
  ] }]));
  const step = plan.phases[0].steps[0];
  const snap = snapshotFiles(step, d);
  writeFileSync(join(d, "src/a.js"), "one\nTWO   \n"); // trailing ws ok
  let c = await checkChanges(step, d, snap);
  assert.deepEqual(c.map((x) => x.status), ["match", "mismatch"]);
  writeFileSync(join(d, "src/n.js"), "m\n");
  c = await checkChanges(step, d, snap);
  assert.equal(c[1].status, "mismatch");
  assert.match(c[1].diff!, /^-n$/m);
  assert.match(c[1].diff!, /^\+m$/m);
  assert.match(mismatchInstructions(c), /src\/n.js/);
  writeFileSync(join(d, "src/n.js"), "n\n");
  c = await checkChanges(step, d, snap);
  assert.ok(c.every((x) => x.status === "match"));
  assert.equal(readFileSync(join(d, "src/a.js"), "utf8"), "one\nTWO   \n");
  rmSync(d, { recursive: true, force: true });
});

test("blank-line-only differences match; autofix makes files exact", async () => {
  const { autofixFiles } = await import("../src/changes.ts");
  const d = repo();
  writeFileSync(join(d, "src/a.xml"), "<a>\n</a>\n");
  const plan = parsePlan(mk([{ id: "s", title: "t", description: "x", changes: [{ file: "src/a.xml", action: "insert_after", find: "<a>", content: "<b/>\n<c/>" }] }]));
  const step = plan.phases[0].steps[0];
  const snap = snapshotFiles(step, d);
  writeFileSync(join(d, "src/a.xml"), "<a>\n<b/>\n\n<c/>\n</a>\n");
  assert.equal((await checkChanges(step, d, snap))[0].status, "match");
  assert.equal((await checkChanges(step, d, snap, { strictBlankLines: true }))[0].status, "mismatch");
  writeFileSync(join(d, "src/a.xml"), "<a>\n<b/>\n</a>\n");
  assert.equal((await checkChanges(step, d, snap))[0].status, "mismatch");
  assert.equal(autofixFiles(step, d, snap)[0].action, "rewritten to planned content");
  assert.equal(readFileSync(join(d, "src/a.xml"), "utf8"), "<a>\n<b/>\n<c/>\n</a>\n");
  assert.equal((await checkChanges(step, d, snap, { strictBlankLines: true }))[0].status, "match");
  rmSync(d, { recursive: true, force: true });
});
