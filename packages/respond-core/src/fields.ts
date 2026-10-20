/** A JSON object, as read from data that may not be one. */
export const isFields = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);
