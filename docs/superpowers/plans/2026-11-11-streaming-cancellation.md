# Streaming and Cancellation Implementation Plan

**Goal:** Stream chat replies in the existing TUI and stop the actual current operation with Esc while keeping the session and draft usable.

**Architecture:** Keep the current Pi runtime and task contracts. Add optional per-send cumulative text callbacks and an AbortSignal. Propagate cancellation through existing model calls and task processes; keep final response validation and independent patch verification.

**Tech Stack:** Node.js, TypeScript, Pi SDK and Pi TUI 1.5.0, existing node:test suite.

## Global constraints

- No new dependencies, actual credentials, external model requests or automatic candidate approval during development.
- Preserve image support, bounded history, one tool per question, task snapshots and candidate hashes.
- Stream visible text only; never expose thinking, tool argument fragments, credential prefixes or raw provider errors.
- Cancelled or failed partial replies do not become completed conversation turns.
- Esc cancels the current operation; Ctrl+C and /exit also cancel before leaving. Preserve the busy draft and restore drafts temporarily held for review.

## Tasks and verification

- [x] Chat: add optional `send(text, image, { signal, onText })`; use `streamSimple`, validate accumulated safe text and terminal response. Test incremental visibility before completion, split credential filtering, pre-abort, connection closure, history and no follow-up after cancellation.
- [x] Task pipeline: append optional signals to existing execution entry points, terminate active process trees, and stop subsequent phases/model requests. Test pre-cancel and running subprocess/model cancellation with existing reporting conventions.
- [x] TUI: update one reply component from cumulative text, label unfinished output, wire Esc/exit to AbortController, resolve pending review safely, and keep the editor usable. Test streaming, cancellation, drafts and exit.
- [x] Integration: run relevant regression suites, type checks and build; verify the compiled TUI in a headless terminal; update README operation instructions and current task summary.

## Validation

- `npm.cmd test`: 199 passed, 0 failed; includes process-tree termination, model cancellation, repair and independent verification regressions.
- `npm.cmd run check` and `npm.cmd run build`: passed.
- Compiled TUI with real chat engine and a local synthetic SSE provider: progressive text visible before completion, Esc closes the unfinished HTTP connection, draft and partial text retained, next question works without the cancelled turn, and Ctrl+C restores the terminal. Only synthetic credentials and loopback requests were used.

No changes to task permissions, automatic review, model selection, session persistence or the plain `chat` interaction are required for this step. The plain chat entry remains compatible with the same chat engine.
