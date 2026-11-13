# Stable priority sorting

Self-authored synthetic defect for RepoPilot development, not an external project bug or a hidden evaluation task. Only `src/sort-by-priority.js` may be changed during repair.

For items with a string ID and finite numeric priority, `sortByPriority` returns a new array ordered by descending priority. Equal priorities must retain input order. Objects retain their identities and the original array and object fields must not be mutated. Negative and fractional priorities and duplicate IDs are valid. Validation of other input types is outside this case's contract.

The faulty version orders ties by ID. One reproduction test must assertion-fail; eight regressions protect ordering, identity and nonmutation. Tests and package files must remain unchanged. No model has repaired this snapshot as part of baseline preparation.
