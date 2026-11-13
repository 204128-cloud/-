export function parsePort(value) {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new TypeError("Port must be a string or number");
  }
  const port = typeof value === "string" ? Number.parseInt(value, 10) : value;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RangeError("Port must be between 1 and 65535");
  }
  return port;
}
