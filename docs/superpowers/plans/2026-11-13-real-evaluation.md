# Real Qwen equal-budget evaluation

Run the frozen three-case `extended-v1` suite through `bench-equal` with up to three attempts per independent arm, at most 18 total. The user supplies the credential only in their own terminal and manually approves each candidate after review. Keep core source, task bytes, model configuration, schemas and dependencies unchanged while running.

- [x] Verify frozen source snapshots, prepared repositories, task hashes and suite before starting; record a local preflight checkpoint.
- [x] User starts the real process; inspect each of six candidate patches and hashes, then await their terminal approval before independent verification.
- [x] Validate the completed benchmark and every child verification, review audit, patch hash, fixed input and original repository state.
- [x] Record portable result metadata, preserve three distinct delivered patches and update current project documentation.

## Observed result

- Source run: `bench-ahKZof`; status completed; model `dashscope/qwen3.7-plus`; suite `extended-v1`.
- Both arms resolved all three tasks on their first attempt: three no-feedback calls plus three feedback-configured calls, six total real request attempts.
- Every independent verification passed one target and eight regressions after fixing; replay verified and delivery hashes match. Six unique verification reports; original repositories clean and snapshot hashes unchanged.
- All attempts have `feedbackIncluded: false`. No candidate failed, so this run does not test failure-feedback effectiveness. Results are limited to three constructed development cases.
- Active totals after review callback deduction: no feedback 73.8206074 seconds, feedback configuration 77.4771611 seconds. Times include all pipeline work and are one sample, not model-only latency or a general speed comparison.
- Review records in `.repopilot/real-equal-reviews/` match each candidate, task, strategy and repair run and precede that arm's verification start.

## Evidence and limits

The ignored local verification helper passed all arithmetic, identity, timing, test, replay, snapshot and original-repository checks. Summary: `.repopilot/real-equal-final-check.json`. Full run: `.repopilot/runs/bench-ahKZof/`. No second model run was used to validate the result.

Portable metadata: `benchmarks/results/extended-v1-qwen-2026-11-13.json`. Delivered model patches: `patches/extended-v1/*.qwen.diff`. The snapshot excludes absolute local paths, endpoint/configuration contents, raw responses and credentials. Full local run references are not automatically portable history.

Implementation regression evidence remains the prior 320 passing tests. This result-recording step changes only documentation and artifact data. The final material and delivery phase is recorded in [delivery checks](2026-11-13-delivery.md); it adds no feature scope or model requests.
