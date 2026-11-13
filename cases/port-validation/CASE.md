# Port validation

Self-authored synthetic defect for RepoPilot development, not an external project bug or a hidden evaluation task. Only `src/parse-port.js` may be changed during repair.

`parsePort` accepts integer numbers or trimmed strings containing only decimal digits. Leading zeros are allowed; valid ports are 1 through 65535 inclusive. Unsupported types raise TypeError; malformed strings, empty strings and invalid numeric values raise RangeError. Decimal points, signs, exponent and hexadecimal syntax are not accepted in strings.

The faulty version accepts numeric prefixes such as `3000ms`. One reproduction test must assertion-fail; eight regressions protect valid conversions, bounds and error behavior. Tests and package files must remain unchanged. No model has repaired this snapshot as part of baseline preparation.
