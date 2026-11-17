# pi-orchestrator

**Architect → Orchestrator → Worker plan execution for [pi](https://github.com/earendil-works/pi).**

A structured, multi-agent workflow where an architect writes a plan, an orchestrator dispatches steps to a worker, and a verifier checks correctness — all within the pi coding agent harness.

---

## Quick Reference

| Command / Tool | Purpose |
|---|---|
| `/check-plan <path>` | Validate a plan file against current source (dry-run). |
| `/execute-plan <path> [--phase id] [--step id] [--dry-run] [--resume] [--force]` | Execute a plan: dispatch steps, verify, retry. |
| `plan_next_step` | Return the next pending step (task text, models, commands). |
| `plan_step_evidence` | Compare files against planned result; run commands; return diffs. |
| `plan_retry_task` | Build a retry task (original task + failure info) for the worker. |
| `plan_autofix_step` | Deterministically write planned content (escalation, no model). |
| `plan_record_result` | Record a step's verification result (PASS / FAIL / ERROR). |
| `plan_check` | Validate a plan file and simulate every change in order. |
| `run_plan_step` | Execute one step through the full worker + verifier loop. |

---

## Project Structure

```
pi-orchestrator/
├── src/                          # Core TypeScript source
│   ├── index.ts                  # Extension entry: registers commands & tools
│   ├── orchestrator.ts           # Step dispatch, retry loop, summary
│   ├── plan.ts                   # Plan schema, validation, normalization
│   ├── changes.ts                # Change application, diffing, autofix
│   ├── config.ts                 # Config loading (user + project settings)
│   ├── verifier.ts               # Step verification & verdict logic
│   ├── worker.ts                 # Worker dispatch (subagents / child)
│   ├── session.ts                # Session state management
│   ├── state.ts                  # Progress tracking & persistence
│   ├── driver-prompt.ts          # Driver prompt builder for in-session mode
│   └── util.ts                   # Shared utilities (sh, truncation)
├── agents/                       # Agent prompt templates
│   ├── worker.md                 # Worker agent instructions
│   └── verifier.md               # Verifier agent instructions
├── skills/                       # Skills
│   └── plan-format/              # Plan authoring skill (SKILL.md)
├── test/                         # Tests
│   ├── changes.test.ts
│   └── session.test.ts
├── .github/workflows/            # CI
│   ├── code-check.yml
│   └── release.yml
├── package.json                  # Package manifest
├── tsconfig.json                 # TypeScript config (ES2022, ESM)
├── README.md                     # User-facing documentation
├── docs/                         # Documentation
│   └── plans/                    # Plan files (NNN-slug.json)
│       └── 001-install.json      # Installation plan
```

---

## Architecture

### Three-Role Workflow

```
Architect (you)  →  writes a plan (phases → steps → changes)
                    ↓
Orchestrator  →  dispatches each step to the worker
                    ↓
Worker  →  applies exact file changes (edit/write)
                    ↓
Verifier  →  checks planned-vs-actual + commands
                    ↓
  (loop fix instructions back to worker, up to maxFixAttempts)
```

| Role | Model | Context |
|---|---|---|
| **Architect** | Large session model | Full repo, writes the plan |
| **Orchestrator** | This extension | Dispatches steps, collects evidence, manages retries |
| **Worker** | Small local model | One step at a time, literal edits only |
| **Verifier** | Mid-range model | Checks diffs + commands, returns PASS/FAIL |

### Change Actions

| Action | Fields | Effect |
|---|---|---|
| `write` | `content` | Create/overwrite the entire file |
| `replace` | `find`, `content` | Replace unique text `find` (empty string = delete) |
| `insert_after` | `find`, `content` | Insert `content` on a new line after `find` |
| `insert_before` | `find`, `content` | Insert `content` on a new line before `find` |
| `delete_file` | — | Delete the file |

### Plan Schema

```jsonc
{
  "project": "Project name",
  "context": "Tech stack, conventions",
  "phases": [
    {
      "id": "phase-id",
      "description": "What this phase does",
      "steps": [
        {
          "id": "step-id",
          "title": "Short title",
          "description": "What to do",
          "files": ["src/a.ts"],           // optional, auto-populated
          "changes": [                    // at least one required
            { "file": "src/a.ts", "action": "write", "content": "..." }
          ],
          "commands": ["test ..."],       // optional
          "acceptance": ["..."]           // optional but recommended
        }
      ]
    }
  ]
}
```

---

## Configuration

Settings under `orchestrator` in `~/.pi/agent/settings.json` and/or `<project>/.pi/settings.json` (project wins):

```jsonc
{
  "orchestrator": {
    "orchestratorModel": "provider/big-model",    // optional: session switch model
    "workerModel": "provider/local-small-model",   // required
    "verifierModel": "provider/mid-model",         // required
    "workerBackend": "subagents",                  // "subagents" | "child"
    "maxFixAttempts": 3,                           // retries per step
    "verifyCommandTimeoutMs": 120000,              // command timeout (ms)
    "workerTimeoutMs": 600000,                     // worker timeout (ms)
    "workerPromptFile": "./agents/worker.md",      // worker prompt path
    "strictBlankLines": false,                     // treat blank diffs as mismatch
    "autofix": true                                // enable plan_autofix_step
  }
}
```

---

## Tooling

| Tool | Version |
|---|---|
| TypeScript | ^5.0.0 |
| Node.js | ES2022 / ESM |
| typebox | Peer dependency (schema validation) |
| tsx | ^4.0.0 (test runner) |

### Running Tests

```bash
npm test
# or
npx tsx --test test/*.test.ts
```

---

## Installation

```bash
pi install /path/to/pi-orchestrator   # local path
# or
pi install git:github.com/you/pi-orchestrator
```

Then run `/reload` in your Pi session.

For the `subagents` backend, also install:

```bash
pi install npm:pi-subagents
```

And set the `worker` model (e.g. in `settings.json` → `subagents.agentOverrides.worker.model`).

The `agents/worker.md` and `agents/verifier.md` files can be copied to `~/.pi/agent/agents/` if needed.

---

## Key Source Files

| File | Responsibility |
|---|---|
| `src/index.ts` | Extension entry: registers `/execute-plan`, `/check-plan`, and all tools |
| `src/orchestrator.ts` | Step selection, dispatch loop, retry logic, summary |
| `src/plan.ts` | Plan schema (TypeBox), validation, normalization, parsing |
| `src/changes.ts` | Change application, snapshotting, diffing, autofix, plan checking |
| `src/config.ts` | Config loading from user + project settings |
| `src/verifier.ts` | Step verification, verdict collection |
| `src/worker.ts` | Worker dispatch (subagents or child process) |
| `src/session.ts` | Session state, snapshots, progress tracking |
| `src/state.ts` | Progress persistence, unfinished plan detection |
| `src/driver-prompt.ts` | Builds the driver prompt sent to the orchestrator model |

---

## Agent Prompts

### Worker (`agents/worker.md`)
- Applies exact file changes from one plan step
- Tools: `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`
- No redesign, no extra features — literal edits only

### Verifier (`agents/verifier.md`)
- Strictly verifies a plan step against planned changes + acceptance criteria
- Tools: `read`, `bash`, `grep`, `find`, `ls`
- Returns JSON verdict: `PASS`, `FAIL`, or `ERROR`

---

## Skills

### `plan-format` (`skills/plan-format/SKILL.md`)
Full authoring rules for plan files: phases, steps, changes, acceptance criteria, and validation.

---

## CI

- **`.github/workflows/code-check.yml`** — Lint and test on push/PR
- **`.github/workflows/release.yml`** — Release workflow

---

## Important Notes

- The orchestrator **only reads diffs**; it never commits.
- Cancellation (Ctrl-C, SIGTERM, session shutdown) kills worker/verifier child process groups.
- On unresolved failure after `maxFixAttempts`: interactive → manual choice; non-interactive → abort with JSON summary.
- Progress is stored in the session via `appendEntry`; use `--resume` to continue unfinished plans.
- A fresh full `/execute-plan` refuses to start while `/check-plan` has errors (`--force` overrides).
