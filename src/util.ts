import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Usage { inputTokens: number; outputTokens: number }

export function truncateHeadTail(s: string, max = 50_000): string {
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  return `${s.slice(0, half)}\n\n... [truncated ${s.length - max} chars] ...\n\n${s.slice(-half)}`;
}

export interface ShellResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }

export function sh(cmd: string, cwd: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<ShellResult> {
  return new Promise((resolve) => {
    const p = spawn("bash", ["-lc", cmd], { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stdout = "", stderr = "", timedOut = false;
    const killGroup = () => { try { process.kill(-p.pid!, "SIGKILL"); } catch { try { p.kill("SIGKILL"); } catch {} } };
    const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; killGroup(); }, opts.timeoutMs) : undefined;
    const onAbort = () => killGroup();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    p.stdout.on("data", (d) => { if (stdout.length < 2_000_000) stdout += d; });
    p.stderr.on("data", (d) => { if (stderr.length < 2_000_000) stderr += d; });
    p.on("error", (e) => { stderr += String(e); });
    p.on("close", (code) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

export async function gitStatus(cwd: string): Promise<string> {
  return (await sh("git status --porcelain", cwd)).stdout;
}

/** Staged + unstaged diff, limited to `files` when given (plus untracked files' content for those paths). */
export async function gitDiff(cwd: string, files: string[]): Promise<string> {
  const q = files.map((f) => `'${f.replace(/'/g, `'\\''`)}'`).join(" ");
  const spec = files.length ? ` -- ${q}` : "";
  const parts = [(await sh(`git diff HEAD${spec}`, cwd)).stdout];
  if (files.length) {
    const untracked = (await sh(`git ls-files --others --exclude-standard${spec}`, cwd)).stdout.split("\n").filter(Boolean);
    for (const f of untracked.slice(0, 20)) {
      const r = await sh(`git diff --no-index -- /dev/null '${f.replace(/'/g, `'\\''`)}'`, cwd);
      parts.push(r.stdout);
    }
  }
  return parts.join("\n");
}

export interface PiRun { text: string; usage: Usage; tools: string[]; code: number | null; stderr: string }

/**
 * Spawn `pi --mode json -p` and stream JSONL events. The prompt goes through a temp file (@file)
 * to avoid argv limits. Aborting kills the whole process group (no orphans).
 */
export function runPi(opts: {
  cwd: string; model: string; prompt: string; signal?: AbortSignal; timeoutMs?: number;
  extraArgs?: string[]; onProgress?: (line: string) => void;
}): Promise<PiRun> {
  const dir = mkdtempSync(join(tmpdir(), "pi-orch-"));
  const promptFile = join(dir, "prompt.md");
  writeFileSync(promptFile, opts.prompt);
  const args = ["--mode", "json", "-p", "--no-session", "--model", opts.model, ...(opts.extraArgs ?? []), `@${promptFile}`];
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) { rmSync(dir, { recursive: true, force: true }); return reject(new Error("Aborted")); }
    const p: ChildProcess = spawn("pi", args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const run: PiRun = { text: "", usage: { inputTokens: 0, outputTokens: 0 }, tools: [], code: null, stderr: "" };
    let buf = "", aborted = false, timedOut = false;
    const killGroup = (sig: NodeJS.Signals) => { try { process.kill(-p.pid!, sig); } catch { try { p.kill(sig); } catch {} } };
    const onAbort = () => { aborted = true; killGroup("SIGTERM"); setTimeout(() => killGroup("SIGKILL"), 3000).unref(); };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const exitHook = () => killGroup("SIGKILL");
    process.once("exit", exitHook);
    const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; onAbort(); }, opts.timeoutMs) : undefined;

    const handle = (line: string) => {
      if (!line.trim()) return;
      let ev: any;
      try { ev = JSON.parse(line); } catch { return; }
      if (ev.type === "message_end" && ev.message?.role === "assistant") {
        const m = ev.message;
        const text = Array.isArray(m.content) ? m.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n") : String(m.content ?? "");
        if (text.trim()) run.text = text;
        run.usage.inputTokens += m.usage?.input ?? 0;
        run.usage.outputTokens += m.usage?.output ?? 0;
      } else if (ev.type === "tool_execution_start") {
        run.tools.push(ev.toolName);
        opts.onProgress?.(`${ev.toolName} ${JSON.stringify(ev.args ?? {}).slice(0, 100)}`);
      }
    };
    p.stdout!.on("data", (d) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    p.stderr!.on("data", (d) => { if (run.stderr.length < 20_000) run.stderr += d; });
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      process.removeListener("exit", exitHook);
      rmSync(dir, { recursive: true, force: true });
    };
    p.on("error", (e) => { cleanup(); reject(e); });
    p.on("close", (code) => {
      handle(buf);
      cleanup();
      run.code = code;
      if (aborted && !timedOut) return reject(new Error("Aborted"));
      if (timedOut) return reject(new Error(`pi child timed out after ${opts.timeoutMs}ms`));
      resolve(run);
    });
  });
}

export function log(...a: unknown[]): void {
  if (process.env.PI_ORCH_DEBUG) console.error("[pi-orchestrator]", ...a);
}
