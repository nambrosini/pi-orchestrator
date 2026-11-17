# pi-orchestrator

Architect → Orchestrator → Worker workflow for pi.

- **Architect**: your current (large) session. Uses the `plan-format` skill to write a plan (phases → steps → exact `changes`): every file, every anchor, every line of code. It validates the plan with `plan_check` / `/check-plan`.
- **Orchestrator**: this extension. Dispatches each step to the worker, snapshots the files first, then checks every file against the result the plan predicts (exact planned-vs-actual diff), runs the commands, asks `verifierModel` for a verdict, and loops fix instructions (including the diffs) back up to `maxFixAttempts`.
- **Worker**: a small local model with limited context, via the `pi-subagents` `worker` agent or a spawned `pi` child. It makes no design decisions: each change is handed to it as a literal `edit` (oldText/newText) or `write` (content) tool call.

## Install

```
pi install /path/to/pi-orchestrator      # local path
pi install git:github.com/you/pi-orchestrator
```
Then `/reload`. For the `subagents` backend, also `pi install npm:pi-subagents` and set the `worker` model (e.g. in `settings.json` → `subagents.agentOverrides.worker.model`). `agents/worker.md` can be copied to `~/.pi/agent/agents/`.

## Configuration

`~/.pi/agent/settings.json` and/or `<project>/.pi/settings.json` (project wins), under `orchestrator`:

```json
{
  "orchestrator": {
    "orchestratorModel": "provider/big-model",
    "workerModel": "provider/local-small-model",
    "verifierModel": "provider/mid-model",
    "workerBackend": "subagents",
    "maxFixAttempts": 3,
    "verifyCommandTimeoutMs": 120000
  }
}
```
`orchestratorModel` (optional): `/execute-plan` switches the current session to it and restores the previous model afterwards. `workerModel`/`verifierModel` fall back to the session model only as a last resort. `workerBackend`: `subagents` or `child`. Extra: `workerTimeoutMs` (default 30 min), `workerPromptFile`.

**In-session mode (interactive):** `/execute-plan` switches the session to `orchestratorModel` and sends a driver prompt, so the orchestrator's output streams in your session. It calls the tools `plan_next_step` / `plan_step_evidence` / `plan_record_result` (step order, planned-vs-actual check + commands, resume, progress) and the native `subagent` tool for the worker (`workerModel`) and verifier (`verifierModel`); expand those tool calls with **Ctrl+o** to watch the subagents. When the run settles, is aborted (Esc) or the session closes, the previous model is restored; continue with `--resume`. Needs `pi-subagents` and the `worker`/`verifier` agents (`agents/`).

**Non-interactive (`pi -p`) and `--dry-run`:** the previous code path (`runPlan`, `child` backend) is used. The `run_plan_step` tool is unchanged.

## Usage

```
/check-plan plan.json
/execute-plan plan.json [--phase id] [--step id] [--dry-run] [--resume] [--force]
```
- `/check-plan` (and the `plan_check` tool) simulates every change in order against the current files: errors for anchors (`find`) that are missing or not unique and for edits to files that will not exist; warnings for placeholders (`...`, `TODO`), vague wording and missing acceptance criteria.
- A fresh full `/execute-plan` run refuses to start while `/check-plan` has errors (`--force` overrides; skipped with `--resume`/`--phase`/`--step`).
- `--dry-run` prints dispatch order only.
- `--resume` skips steps already passed (progress is stored in the session via `appendEntry`; start pi with `-c` to continue the session). On startup pi notifies about unfinished plans.
- Unresolved failure (after `maxFixAttempts`): interactive → choose continue / retry manually / abort. Non-interactive (`pi -p`) → abort; a JSON summary is printed on stdout, stderr gets progress, exit code 1.
- Cancellation (Ctrl-C, SIGTERM, session shutdown) kills worker/verifier child process groups.
- The extension only reads diffs; it never commits.

The LLM can also call `run_plan_step {planPath, step, phase?}`.

## Plan schema

A `.json` file, or a ```` ```plan json ```` block inside markdown (first valid block wins). Missing ids are generated from titles; `files`/`commands`/`acceptance`/`changes` default to `[]`, and `files` is extended with every file in `changes`; empty `steps` are rejected. Every step needs at least one change (command-only steps need a command). Validation errors name the field path. Full authoring rules: `skills/plan-format/SKILL.md`.

Change actions (applied in order):

| action | fields | effect |
|---|---|---|
| `write` | `content` | create/overwrite the file with exactly `content` |
| `replace` | `find`, `content` | replace the unique text `find` (`""` deletes) |
| `insert_after` / `insert_before` | `find`, `content` | insert `content` on a new line after/before the unique `find` |
| `delete_file` | – | delete the file |

```json
{
  "project": "Greeter CLI",
  "context": "Node 20, ESM, no dependencies, 2-space indent, double quotes.",
  "phases": [
    {
      "id": "core",
      "description": "Implement greeting logic",
      "steps": [
        {
          "id": "greet-fn",
          "title": "Add greet function",
          "description": "Create src/greet.js exporting greet(name).",
          "changes": [
            { "file": "src/greet.js", "action": "write", "content": "export function greet(name) {\n  return `Hello, ${name}!`;\n}\n" }
          ],
          "commands": ["node -e \"import('./src/greet.js').then(m=>process.exit(m.greet('a')==='Hello, a!'?0:1))\""],
          "acceptance": ["greet('a') returns 'Hello, a!'"]
        },
        {
          "id": "cli-use-greet",
          "title": "Use greet in the CLI",
          "description": "Replace the hard-coded greeting in bin/greet.js with greet(process.argv[2]).",
          "changes": [
            { "file": "bin/greet.js", "action": "insert_after", "find": "#!/usr/bin/env node", "content": "import { greet } from \"../src/greet.js\";" },
            { "file": "bin/greet.js", "action": "replace", "find": "console.log(\"Hello!\");", "content": "console.log(greet(process.argv[2]));" }
          ],
          "commands": ["test \"$(node bin/greet.js World)\" = \"Hello, World!\""],
          "acceptance": ["`node bin/greet.js World` prints 'Hello, World!' and exits 0"]
        }
      ]
    }
  ]
}
```
