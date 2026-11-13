# Image Attachment Display and Removal

**Goal:** Make the pending local image visible by filename, detected format and actual byte size, and allow removal before sending.

**Design:** Keep the single-image model interface. A validated attachment wraps existing ImageContent with display metadata, while model calls receive only ImageContent. `/image <path>` attaches, `/image` shows the pending attachment and `/image clear` removes it. A separate bounded TUI row stays above the editor while the image is pending.

## Constraints

- Preserve the 5 MiB local regular-file limit and PNG/JPEG/WebP signature detection; read each attachment once.
- Display only a safe basename, format and actual byte size. Never display full paths, credentials, terminal controls or base64 image content.
- Removal affects only the pending attachment. Previously sent images remain in bounded model history until reset or replacement under the existing chat rules.
- Successful send, reset, successful restore and exit clear the pending attachment. Request failure or cancellation keeps it for retry. A failed replacement clears the old pending image to avoid sending it accidentally.
- Save/list/help do not consume or send the pending image; session files continue to omit image bytes.
- Loading is local I/O. Esc or exit during loading must prevent late results from attaching an image to a cancelled operation.
- Preserve editor focus, busy drafts, confirmations, streaming and small-window usability. No new dependency, automatic image upload or file picker in this step.

## Implementation and verification

- [x] Add attachment metadata, safe command parsing and shared formatting; keep loadChatImage compatible.
- [x] Add persistent pending-attachment display and show/clear to TUI, with cancellation-safe loading.
- [x] Add corresponding commands and metadata to plain chat.
- [x] Run focused and full regressions, type checks and build; verify compiled TUI against a local synthetic provider and update README.

## Validation

- `npm.cmd test`: 267 passed, 0 failed; includes 10 image-layer tests and 29 TUI tests plus the plain-chat attachment workflow.
- `npm.cmd run check` and `npm.cmd run build`: passed.
- Compiled TUI with a real chat engine and loopback synthetic provider: metadata appears before sending, show/clear make no request, a cleared attachment is absent from the next request, and the image request contains only the normal text/image payload. Session files omit image bytes.
- Headless rendering checked five viewport sizes, preserved draft and editor focus, retained metadata during generation and removed the pending bar after success or clear.
- A regression checks that local session loading with an attachment does not claim an image is being uploaded.
- Safe local artifacts: `.repopilot/attachment-e2e.json`, `.repopilot/attachment-ui-check.json`, and `.repopilot/attachment-preview.png`. Only synthetic image fixtures and local providers were used; no real model, credential or clipboard access was needed.
