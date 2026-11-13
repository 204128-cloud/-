# Local Run History and Reports

**Goal:** View existing task runs and test evidence inside chat with `/runs` and `/report <run-id>`, without model calls or rerunning tools.

**Design:** Read bounded regular JSON reports from the existing `.repopilot/runs` directories. Choose the most advanced report in a baseline run, or the repair/benchmark summary for those run types. Project only validated display fields, aggregate recorded test outcomes, and follow at most the relevant independent verification reference within the same runs root. Share formatting between TUI and plain chat.

## Constraints

- Read only; do not modify reports, create new runs, execute tests, replay tools or add report contents to model conversation history.
- Accept only actual generated run IDs, never arbitrary paths. Refuse linked directories, linked files, oversized or unsafe data and external report references.
- Preserve valid error and unresolved runs. Count unreadable records in lists rather than replacing them with older successful reports.
- Baseline ready, proposed, located and benchmark completed do not mean a verified repair. Missing or contradictory verification evidence must never become a passed result.
- Show historical records explicitly as records, not fresh verification. Keep missing test evidence distinct from zero failures.
- Preserve attachments, drafts, sessions, streaming and Esc cancellation; suppress late local read results after cancellation or exit.

## Work and validation

- [x] Add validated run summaries, details and safe report reference handling with fixture tests.
- [x] Share readable formatting of statuses, timestamps, test counts, reasons and artifact references.
- [x] Add commands to both chat entry points and test local-only behavior, preserved state, invalid input and cancellation.
- [x] Run regressions, type check and build; inspect compiled terminal rendering using synthetic reports; update current task summary.

## Validation

- `npm.cmd test`: 288 passed, 0 failed, 0 skipped, 0 cancelled. Includes 13 report-reader tests, 34 TUI tests and plain-chat command regressions.
- `npm.cmd run check` and `npm.cmd run build`: passed on the final source.
- Synthetic report fixtures cover pipeline priority, damaged reports, failure retention, bounded UTF-8 reads, unsafe content, linked files, cancellation, benchmark shared-call accounting and repair verification identity. Contradictory process results, replaced test identities and mismatched parent/child artifacts cannot become verification passes.
- Compiled TUI with the real chat engine and a loopback provider: viewing list/detail sends no model request, changes no report file and creates no run. It preserves the prior model conversation and pending image, excludes viewed history from model messages and session snapshots, and sends the pending image only with the next actual question.
- Five viewport sizes preserve draft text and editor focus; the historical report wraps inside the scrolling transcript. Esc and exit suppress late reads in regression tests.
- Local evidence: `.repopilot/step7-full-tests.txt`, `.repopilot/run-history-e2e.json`, `.repopilot/run-history-frame.json` and `.repopilot/run-history-preview.png`. No real provider, credential or clipboard access was required for validation.
