import { test } from "node:test";
import assert from "node:assert/strict";
import { startSessionRun, nextStep, recordResult, finishSessionRun } from "../src/session.ts";

const plan: any = { project: "p", phases: [{ id: "a", description: "d", steps: [
  { id: "s1", title: "one", description: "x", files: [], commands: [], acceptance: [] },
  { id: "s2", title: "two", description: "y", files: [], commands: [], acceptance: [] }] }] };
const cfg: any = { maxFixAttempts: 3 };

test("ordering, resume skip, record, finish", () => {
  const log: any[] = [];
  startSessionRun(plan, "k", cfg, { resume: true }, new Set(["a/s1"]));
  assert.equal(nextStep()!.step, "s2");
  recordResult((e) => log.push(e), { phase: "a", step: "s2", verdict: "FAIL", attempt: 1 });
  assert.equal(nextStep()!.step, "s2");
  recordResult((e) => log.push(e), { phase: "a", step: "s2", verdict: "PASS", attempt: 2 });
  assert.equal(nextStep(), null);
  assert.equal(finishSessionRun((e) => log.push(e))!.status, "complete");
  assert.equal(log.length, 3);
});
