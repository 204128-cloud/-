# Confirmed online authentication check

Add `/auth-check` to both chat interfaces while keeping `/doctor` offline. Every invocation describes the loaded model and sanitized endpoint, the fixed `Reply OK.` text, credential use for authentication and possible provider charges. Only explicit `yes` starts one request; refusal, Esc or exit makes no request. No conversation, attachment or task source is submitted.

Reuse the existing direct authentication transport. Extract the request so chat can use its already loaded model/key, avoiding reload or environment changes between confirmation and sending. Keep the standalone `auth-check` behavior and JSON fields, add cancellation and timeout handling, reject unsafe URL forms, and never follow redirects. Read a bounded response and require a valid non-streaming assistant response before labeling a 2xx reply accepted. Return only HTTP status and recognized codes; raw service errors and generated content stay private.

- [x] Add local-provider transport tests for fixed payload, rejection/invalid replies, redirect refusal, cancellation and safe errors.
- [x] Add the loaded-chat bridge and shared disclosure/result formatting with useful fixed suggestions.
- [x] Add commands with explicit confirmation to TUI and plain chat. Preserve conversation, attachment and drafts; suppress late results after cancellation or exit.
- [x] Run focused and full tests, type check and build; verify the compiled interface against a local provider and update README.

No real provider call, credential/clipboard access, new dependency, persistent diagnostic log or model switching is required in validation.

## Validation

- Added 11 transport, chat-engine and interface regressions. Core transport/bridge and main command tests were observed failing before implementation and passing afterwards; supplemental exit tests verify no late output or unintended request. The focused run passed 15 tests including existing authentication compatibility tests.
- `npm.cmd test`: 312 passed, 0 failed, skipped or cancelled. `npm.cmd run check` and `npm.cmd run build`: passed.
- Transport fixtures cover fixed payload, recognized codes and fixed suggestions for 401/403/404/429/5xx, malformed or oversized 2xx replies, manual redirects, unsafe endpoints, body cancellation, timeout and safe connection errors. Chat tests establish loaded endpoint/key binding after configuration and environment changes.
- Compiled TUI with the real chat engine and loopback provider: no request before confirmation or after refusal; fixed probes exclude conversation and images; 401 and valid 200 display only safe summaries; Esc aborts a live response body; original conversation and pending image survive checks. Probe results are absent from subsequent model messages and saved snapshots. Five viewport sizes retain draft and focus.
- Local ignored evidence: `.repopilot/step8-auth-full-tests.txt`, `.repopilot/chat-auth-e2e.json`, `.repopilot/chat-auth-frame.json`, `.repopilot/chat-auth-preview.png`. Validation used synthetic keys and local services, with no real provider or clipboard access.
