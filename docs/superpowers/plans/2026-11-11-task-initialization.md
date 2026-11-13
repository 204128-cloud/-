# Task Initialization Wizard

**Goal:** Create a valid fixed-commit task without manually writing JSON or providing a model credential.

**Design:** `task init [repoPath]` reads scripts and regular JS/TS sources from one committed Git HEAD. The user explicitly selects reproduction and regression scripts, enters the exact failed test name, and selects specific authorized files. Save only after confirmation, use exclusive creation, and offer an optional baseline run after saving.

## Constraints

- Do not change existing task fields, authorized path rules or independent verification.
- Ignore uncommitted changes when inspecting scripts and files; do not modify the source repository.
- No model requests, credential prompts, clipboard reads, dependency installation or tests during task creation.
- Optional baseline requires a separate explicit yes; explain that it runs dependency installation and tests and may access the package registry.
- Keep prompts on stderr and the final machine-readable result on stdout. Distinguish task creation from baseline readiness and repair success.
- Do not overwrite files or echo credentials, control characters or raw Git errors.

## Implementation and verification

- [x] Reuse shared task validation and add committed repository inspection, explicit selection validation and exclusive task saving.
- [x] Add the interactive wizard, cancellation handling and CLI dispatch before model setup.
- [x] Verify new task creation through the real CLI, optional baseline behavior, existing output refusal and cancellation.
- [x] Run regression checks, type checking and build; update the latest README summary and usage instructions.

## Validation

- Final `npm.cmd test`: 231 passed, 0 failed. The first full run exposed an added static CLI dependency in two proxy fixtures; loading task errors only in the task branch restored the original command boundary, and the final full run passed.
- `npm.cmd run check` and `npm.cmd run build`: passed.
- A real CLI dialogue created a task in a temporary directory and ran the explicitly requested baseline to `ready`, without a model key. The original repository remained clean.
- The compiled wizard generated a valid task from committed source selections and left the optional baseline unrun by default. Safe check artifacts are under `.repopilot/task-wizard-check*`.
- Existing file refusal, declined saves, invalid selections, cancelled prechecks and credential exclusion are covered. No real model request or clipboard access was required.
