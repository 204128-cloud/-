# Inline Review and Task Progress

**Goal:** Review the exact candidate diff inside the existing chat interface and show the current repair phase without changing task permissions or verification rules.

**Design:** Existing task entry points publish optional fixed stage events. Chat forwards them to the TUI status line. Before asking for approval, the TUI reads a bounded, regular UTF-8 patch file and verifies its SHA-256 against the candidate reviewed by the repair workflow. Only a complete, safe preview permits approval.

## Constraints

- Keep Pi TUI, streaming, Esc cancellation, busy drafts and independent verification.
- Preview the entire diff, reject oversized or unsafe content instead of approving a truncated preview.
- Never render credentials, source-provided terminal escapes or raw errors.
- Events carry only stage identifiers and optional attempt numbers; CLI JSON and existing reports remain compatible.
- The existing post-review hash check remains required before verification.

## Work and checks

- [x] Add optional stage callbacks to baseline, localization, proposal, repair and verifier; test order, review refusal and cancellation.
- [x] Add bounded patch reading and hash/UTF-8/control/credential checks; test the rejection paths.
- [x] Wire chat progress into TUI; show colored complete diff before yes/no, protect confirmation prompts and restore drafts.
- [x] Run integration tests, type checks and build; inspect real terminal rendering and update README's latest task summary.

## Validation

- `npm.cmd test`: 213 passed, 0 failed, including repair retries, independent verification, progress cancellation and late-preview cancellation.
- `npm.cmd run check` and `npm.cmd run build`: passed.
- Headless terminal checks: complete diff can be scrolled from start to end, verification waits for yes, draft restoration works after confirmation and Esc, and the editor remains usable at 54, 32 and 92 columns.
- Preview frame and image are local artifacts in `.repopilot/review-frame.json` and `.repopilot/review-preview.png`. Development used local fixtures and synthetic providers, without actual credentials or remote model requests.
