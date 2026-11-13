export function truncateText(text, maxLength, suffix = "…") {
  if (typeof text !== "string" || typeof suffix !== "string") throw new TypeError("Text and suffix must be strings");
  if (!Number.isInteger(maxLength) || maxLength < 0) throw new RangeError("Length must be a nonnegative integer");
  if (text.length <= maxLength) return text;
  const suffixPoints = Array.from(suffix);
  if (suffixPoints.length >= maxLength) return suffixPoints.slice(0, maxLength).join("");
  return text.slice(0, maxLength - suffixPoints.length) + suffix;
}
