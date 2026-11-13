# Offline chat diagnostics

The next approved increment adds `/doctor` to both chat interfaces. It reads the current model configuration offline, checks the current process credential format against the credential loaded at chat startup, and verifies that the bound task file still matches the startup bytes. It returns only fixed diagnostic messages and actionable suggestions, never raw configuration, exceptions, credentials or task contents.

Configuration changes are reported without applying them to the running chat. A missing task is informational because ordinary chat is supported. A local pass does not establish remote authentication, model availability, repository readiness or test success. Network diagnostics and model switching remain later work.

- [x] Add regressions for unchanged/changed/invalid model configuration, credential state, bound task changes, cancellation and zero requests.
- [x] Implement a local `chat.doctor(signal)` using existing runtime and task checks; share fixed-message formatting between interfaces.
- [x] Integrate `/doctor` with help, argument validation and cancellation; preserve conversation, pending image and drafts, suppress late results after exit or Esc.
- [x] Run full regressions, type check, build and compiled TUI validation; update the current README summary.

Use synthetic configuration and keys in tests. No real provider request, clipboard read, credential persistence, new dependency or additional task execution is needed.

## Validation

- Seven added tests were observed failing before implementation and passing afterwards. They cover unchanged, changed, missing and malformed configuration; missing, invalid, plan-specific and changed credentials; changed/missing task files; pre-start and in-flight cancellation; preserved attachments and drafts; safe errors and late output suppression in both interfaces.
- `npm.cmd test`: 301 passed, 0 failed, skipped or cancelled. `npm.cmd run check` and `npm.cmd run build`: passed.
- Compiled TUI with the real chat engine and a loopback provider: `/doctor` creates no provider request, identifies a newly malformed configuration without changing it, preserves the loaded conversation and pending image, and stays absent from model messages and saved snapshots. Five viewport sizes preserve draft and focus.
- Local ignored evidence: `.repopilot/step8-doctor-full-tests.txt`, `.repopilot/chat-doctor-e2e.json`, `.repopilot/chat-doctor-frame.json`, `.repopilot/chat-doctor-preview.png`. No real provider, credential or clipboard access was used for validation.
