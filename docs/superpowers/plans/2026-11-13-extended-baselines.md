# Three additional constructed repair baselines

Add port-validation, stable-priority-sort and truncate-codepoints as self-authored synthetic cases. Each has one expected assertion failure, eight passing regressions, a single authorized JS source file, package metadata and a dependency-free lockfile. Cases are development fixtures, not external bugs, a hidden holdout set or measured model repairs.

- [x] Create and verify the intentionally faulty snapshots, documenting contracts and provenance.
- [x] Freeze normalized source hashes in a manifest; prepare isolated local Git repositories and generated native-path tasks/suite without overwriting existing files.
- [x] Run all three through the real offline baseline pipeline. Require unique target assertion failures, passing regressions, stable base commits and unchanged source repositories.
- [x] Record safe evidence, migration/use instructions and the latest project summary.

Preparation fixes Git identity, dates, line endings and SHA-1 object format for reproducible commits. Generated repositories and native-path task/suite files stay under `.repopilot/extended-v1/`. No main-repository commit, model request, candidate generation, baseline repair, dependency addition or equal-budget comparison is included in this increment.

## Validation

- Direct case tests: each reproduce script exits 1 with one assertion failure; each regression script exits 0 with eight passes.
- Actual baseline pipeline: all three tasks ready, matching fixed commits and unique assertion evidence; 24 total passing regressions, empty changedPaths and no patch artifact. Original case repositories remain clean.
- Preparation was repeated and reconstructed under a different temporary root: commit hashes match, generated task paths are native to the new root, and suite validation succeeds. Frozen snapshot changes, differing existing task files and dirty repositories are refused without overwriting.
- `npm.cmd run check` and `node --check scripts/prepare-extended-cases.mjs`: passed. Core source was unchanged; this increment used targeted fixture and pipeline validation rather than rerunning the previous full regression suite.
- Local ignored evidence: `.repopilot/extended-preparation.json`, `.repopilot/extended-preparation-check.json`, `.repopilot/extended-v1/baseline-summary.json`, and baseline runs dP9AfM, OVhTt6, LnjeAE. No real or synthetic model request was made.
