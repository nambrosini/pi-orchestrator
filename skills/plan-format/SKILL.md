---
name: plan-format
description: Produce an exact, file-level implementation plan as a ```plan json block (phases → steps → changes) for execution by /execute-plan. Use when asked to plan a coding task for the orchestrator/worker workflow.
---

# Plan format (architect)

You are the **architect**. A small local model (the **worker**) will execute your plan with very limited
context and no access to this conversation. It does not design anything: it applies the literal edits you
write, one step at a time. The **orchestrator** then compares every file with the result your plan
predicts and rejects any deviation. So the plan must contain **the final code itself**, not a
description of it. If the worker would have to make a single decision, the plan is not done.

## Workflow

1. **Understand the request.** Ask clarifying questions only if a choice materially changes the design.
2. **Explore before planning.** List the structure, read the conventions (package.json, tsconfig, lint
   config, test setup) and **read every file you will change, in full**. Read call sites of anything
   you change. Note exact names, imports, indentation (tabs/spaces, width), quote style, semicolons.
3. **Design the whole feature yourself**: every function, signature, type, import, export, error
   message, constant, test case. Decide all names. Resolve all edge cases now.
4. **Write the plan** (schema below) with exact `changes` for every file.
5. **Save it** to a file (e.g. `PLAN.md` or `plan.json`) and **call the `plan_check` tool on it**
   (or `/check-plan <file>`). It dry-applies every change in order against the real files. Fix every
   ERROR and every placeholder/vague warning, re-run until clean.
6. Tell the user to run `/execute-plan <file>`.

## Schema

Output ONE fenced block tagged `plan json`:

```plan json
{
  "project": "human title",
  "context": "shared facts every step needs: language/runtime, module system, style rules, test command",
  "phases": [
    {
      "id": "phase-slug",
      "description": "goal of the phase",
      "steps": [
        {
          "id": "step-slug",
          "title": "one line",
          "description": "what this step achieves and why, in 1-3 precise sentences",
          "changes": [
            { "file": "src/a.ts", "action": "insert_after", "find": "exact existing line(s)", "content": "new line(s)", "description": "why" }
          ],
          "files": ["optional; derived from changes"],
          "commands": ["commands that must exit 0 after this step"],
          "acceptance": ["objectively checkable criteria"],
          "notes": "optional"
        }
      ]
    }
  ]
}
```

### `changes` — the heart of the plan

Applied in order, exactly as written. Actions:

| action | required | effect |
|---|---|---|
| `write` | `content` | create the file (or fully overwrite it) with exactly `content` |
| `replace` | `find`, `content` | replace the unique text `find` with `content` (`""` deletes it) |
| `insert_after` | `find`, `content` | insert `content` on a new line directly after `find` |
| `insert_before` | `find`, `content` | insert `content` on a new line directly before `find` |
| `delete_file` | – | delete the file |

Rules for `find` (anchors):
- **Copy it verbatim from the file** as it will be at that moment (after earlier steps' changes):
  same indentation, quotes, trailing commas. Never retype from memory.
- It must occur **exactly once** in the file. If a line is not unique, include neighbouring lines.
- Use whole lines, without the final newline. Keep it short (1–5 lines) but unique.
- For `insert_after`/`insert_before`, `content` must not repeat the anchor; for `replace`, `content`
  must contain the anchor lines you want to keep.

Rules for `content`:
- **Complete, literal, final code**, indented exactly as it must appear in the file (including the
  leading indentation of each line). It is pasted as is.
- **No placeholders**: never `...`, `// rest unchanged`, `TODO`, `implement here`, `similar to above`,
  `<your code>`. Write every line.
- Include every import/export the code needs, as separate changes at the right anchor.
- New files: `write` with the full file content. Prefer `replace`/`insert_*` for existing files;
  use `write` on an existing file only for small files you deliberately rewrite completely (say so in
  the change `description`).
- Large edits: split into several anchored changes rather than one huge `find`.
- Deleting lines: `replace` with `find` = those lines and `content` = `""`, or include the neighbouring
  line in `find` and keep it in `content` so no blank line is left behind.

Each change may have a `description` (why it exists); the worker sees it but must not need it.

### Steps

- **One coherent unit per step**, ideally 1–3 files and ≤ ~150 changed lines, so the worker's context
  holds the whole task. Split big features: types → implementation → wiring → tests → docs.
- Order steps so each builds only on earlier ones. Later anchors must reflect earlier changes.
- Each step must leave the project in a working state (builds, existing tests pass) whenever possible.
- Every step has at least one change; command-only steps (e.g. `npm install x`) are allowed but have
  `commands` instead.
- `commands`: real, non-interactive commands that must exit 0 (type-check, the specific test file,
  a `node -e` smoke test). No watch modes, no servers that never exit.
- `acceptance`: objectively checkable statements tied to observable facts: "`npm test -- greet` exits 0",
  "`src/greet.ts` exports `greet(name: string): string`", "`node bin/greet.js World` prints
  `Hello, World!`". Never "works correctly" or "code is clean".
- `description`: precise, no vague words (`as needed`, `appropriate`, `etc.`, `handle errors`,
  `update accordingly`). It explains intent; the changes carry the content.
- `context`: facts all steps share (runtime, module system, style, test runner). The worker sees only
  `context`, the phase description and its own step.
- Ids are unique slugs (step ids unique per phase). `steps` must never be empty.

## Example

```plan json
{
  "project": "Greeter CLI",
  "context": "Node 20, ESM (\"type\": \"module\"), no dependencies, 2-space indent, double quotes, semicolons.",
  "phases": [
    {
      "id": "core",
      "description": "Greeting logic",
      "steps": [
        {
          "id": "greet-fn",
          "title": "Add greet function",
          "description": "Create src/greet.js exporting greet(name), which falls back to \"World\" for empty names.",
          "changes": [
            {
              "file": "src/greet.js",
              "action": "write",
              "content": "export function greet(name) {\n  const who = name && name.trim() ? name.trim() : \"World\";\n  return `Hello, ${who}!`;\n}\n"
            }
          ],
          "commands": ["node -e \"import('./src/greet.js').then(m => { if (m.greet('a') !== 'Hello, a!' || m.greet('') !== 'Hello, World!') process.exit(1); })\""],
          "acceptance": ["src/greet.js exports greet", "greet('a') returns 'Hello, a!'", "greet('') returns 'Hello, World!'"]
        }
      ]
    },
    {
      "id": "cli",
      "description": "Wire the CLI to greet()",
      "steps": [
        {
          "id": "cli-use-greet",
          "title": "Use greet in bin/greet.js",
          "description": "Replace the hard-coded greeting in the existing bin/greet.js with greet(process.argv[2]).",
          "changes": [
            {
              "file": "bin/greet.js",
              "action": "insert_after",
              "find": "#!/usr/bin/env node",
              "content": "import { greet } from \"../src/greet.js\";",
              "description": "import the new function"
            },
            {
              "file": "bin/greet.js",
              "action": "replace",
              "find": "console.log(\"Hello!\");",
              "content": "console.log(greet(process.argv[2]));"
            }
          ],
          "commands": ["test \"$(node bin/greet.js World)\" = \"Hello, World!\""],
          "acceptance": ["`node bin/greet.js World` prints exactly 'Hello, World!' and exits 0"]
        }
      ]
    }
  ]
}
```

## Final self-check before handing over

- [ ] Every file I change was read in full; every `find` was copied from it (or from an earlier step's content).
- [ ] `plan_check` reports no errors and no placeholder/vague warnings.
- [ ] Every new symbol is defined, imported where used, and exported where needed.
- [ ] Tests for new behaviour are written out in full in a step of their own (or with the code).
- [ ] A worker that knows nothing but the step text could apply it without a single decision.
