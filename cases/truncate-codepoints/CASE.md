# Unicode code-point truncation

Self-authored synthetic defect for RepoPilot development, not an external project bug or a hidden evaluation task. Only `src/truncate-text.js` may be changed during repair.

`truncateText(text, maxLength, suffix = "…")` limits the final output, including the suffix, by Unicode code points. Fitting text is unchanged. Truncated text reserves space for the suffix; an oversized suffix is itself clipped. An empty suffix is valid. A zero limit returns empty text. Strings and suffixes must be strings; the limit must be a nonnegative integer. Combining marks count separately: this contract is not grapheme-cluster or display-width truncation.

The faulty version counts and slices the main text as UTF-16 code units, splitting some emoji and truncating text that already fits by code points. One reproduction test must assertion-fail; eight regressions protect ASCII behavior, suffix budgets, combining marks and argument checks. Tests and package files must remain unchanged. No model has repaired this snapshot as part of baseline preparation.
