/**
 * Koios JSON with every integer exact. `JSON.parse` rounds an integer above
 * 2^53 to the nearest double, and Koios serves such integers: lovelace amounts
 * (as JSON numbers from Koios v1.5) and transaction metadata.
 *
 * Needs the reviver's source text and `JSON.rawJSON` (Node 21, Chrome 114,
 * Firefox 135, Safari 18.4). Where they are missing, only a value above 2^53
 * fails, and it fails rather than come back rounded.
 *
 * @module
 */

interface ReviverContext {
  readonly source?: string;
}

/**
 * Parse Koios JSON. A safe integer stays a `number`; a larger one becomes the
 * exact `bigint`.
 */
export function parseKoiosJson(text: string): unknown {
  return JSON.parse(
    text,
    (_key, value: unknown, context?: ReviverContext): unknown => {
      if (
        typeof value !== "number" ||
        Number.isSafeInteger(value) ||
        !Number.isInteger(value)
      )
        return value;
      const source = context?.source;
      if (source === undefined || !/^-?\d+$/.test(source)) {
        throw new Error(
          `Koios JSON: ${source ?? value} cannot be read exactly`,
        );
      }
      return BigInt(source);
    },
  );
}

const { rawJSON } = JSON as unknown as {
  readonly rawJSON: (text: string) => unknown;
};

/** The inverse of {@link parseKoiosJson}: a `bigint` is written as a number. */
export function stringifyKoiosJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    typeof v === "bigint" ? rawJSON(v.toString()) : v,
  );
}

/**
 * A lovelace amount as Koios serves it: a decimal string, or a JSON number
 * from Koios v1.5 on. `field` names the endpoint and column for the error.
 */
export function lovelace(value: unknown, field: string): bigint {
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    return BigInt(value);
  if (typeof value === "bigint" && value >= 0n) return value;
  throw new Error(`Koios ${field}: ${String(value)} is not a lovelace amount`);
}
