# Equal-budget feedback comparison

Add a separate `bench-equal` command. Keep the existing shared-first `bench` report and behavior unchanged. For each pinned task, independently run no-feedback and feedback repair with the same maximum of three model attempts. Alternate arm order by task index; do not share candidate generation or verification. Actual attempts are summed across both arms, at most six per task (18 for the three extended cases).

Both arms reuse the existing repair pipeline, review hashes, independent verifier and safety stop rules, including duplicate-candidate stopping. Success may stop an arm early; equal budgets are equal ceilings, not guaranteed equal consumption. The sole algorithm difference is whether the next prompt includes previous candidate/test feedback. No-feedback prompts must match the original base prompt exactly; both arms must use the same original sources and base context. Every candidate still requires manual review.

- [x] Add a no-feedback repair strategy without changing the default feedback strategy; verify prompts and three-attempt limits.
- [x] Add the independent benchmark, pinned input checks, actual-call accounting, alternating order, safe JSON/Markdown reports and cancellation.
- [x] Add CLI/launcher entry and historical report compatibility, with regressions for safe argument handling and correct counts.
- [x] Validate using synthetic requests with real worktrees, original tests and independent replay; run complete tests, type check/build and update current documentation.

Refused reviews, invalid inputs, unreproduced baselines, infrastructure errors and cancellation stop further arms/tasks and remain distinct from unresolved repairs. Input drift invalidates the comparison. Results are exploratory per-task samples, not evidence of a general repair rate or a statistical causal effect. No real provider request is authorized in this implementation step.

## Validation

- The no-feedback repair regression first failed because round two contained feedback; after implementation it completes three distinct failing candidates with byte-identical prompts, three reviewed independent verifications and no fourth request.
- New independent benchmark tests first failed before the module/CLI existed. Offline integration checks two tasks with alternating arm order, original source and base-context equality, separate verification reports, seven synthetic request callbacks counted as 4 no-feedback + 3 feedback, fixed denominators, refusal, cancellation and task drift.
- Historical report tests verify actual total attempts and both arm references, while existing shared-first counting remains unchanged. CLI tests cover argument errors before credentials and labeled strategy review. PowerShell launcher syntax passed without execution or clipboard access.
- `npm.cmd test`: 320 passed, 0 failed, skipped or cancelled. `npm.cmd run check` and `npm.cmd run build`: passed.
- Compiled independent runner with a private fixture: two reviewed synthetic callbacks produce two separate successful verification reports; total and historical references agree, original repository remains unchanged. This is a transport-free fixture check, not a real provider score.
- Local ignored evidence: `.repopilot/equal-focused.txt`, `.repopilot/equal-repair-green.txt`, `.repopilot/equal-full-tests.txt`, `.repopilot/equal-compiled-check.json`. Frozen constructed cases, old real scores and legacy benchmark reports were not modified.
