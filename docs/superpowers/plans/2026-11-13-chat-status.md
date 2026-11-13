# In-chat configuration status

The approved next increment is `/status` in both chat interfaces. It reports the running chat's loaded model, sanitized endpoint, configured image capability, bound task and loaded credential state. It is synchronous and offline: no configuration reload, model request, authentication probe, task execution or file write. `/doctor` and model switching remain later work.

Read the loaded model through a small `chat.status()` projection and share its display between TUI and plain chat. Remove URL userinfo, query and fragment; hide unsafe metadata and known credentials. Do not return the API key or raw configuration through this projection. Describe capabilities as configuration declarations and credentials as loaded, not authenticated.

- [x] Add fixture tests for sanitization and the loaded-state contract; verify failing tests before implementation.
- [x] Implement the shared projection and chat status method; verify no provider request or snapshot change, including after a configuration file or process environment changes.
- [x] Add `/status` and help to both interfaces. Verify local-only output, argument handling and preserved attachments, conversation and busy drafts.
- [x] Run regressions, type check, build and compiled TUI verification; update the current README summary.

No new dependencies, persistence, remote probe or task authorization changes are needed.

## Validation

- Six added regression tests were observed failing before implementation and passing after implementation. They cover credential/control filtering, stripped URL userinfo/query/fragment, encoded credentials, invalid URLs, loaded-state accuracy, local-only UI behavior, argument handling, safe errors and draft/attachment preservation.
- `npm.cmd test`: 294 passed, 0 failed, skipped or cancelled. `npm.cmd run check` and `npm.cmd run build`: passed.
- Compiled TUI with the real chat engine and a loopback provider: `/status` makes no provider request, preserves the original conversation and pending image, stays accurate after the configuration file changes, and remains absent from model messages and saved snapshots. Five viewport sizes preserve draft and focus.
- Evidence is local and ignored: `.repopilot/step8-status-full-tests.txt`, `.repopilot/chat-status-e2e.json`, `.repopilot/chat-status-frame.json` and `.repopilot/chat-status-preview.png`. No real provider or clipboard access was used.
