/**
 * Error types for CIP-179 (de)coding.
 *
 * @module
 */

/** Thrown when a metadatum tree does not conform to the CIP-179 schema. */
export class Cip179DecodeError extends Error {
  /** Path to the offending node, e.g. `payload.definitions[0].questions[2]`. */
  readonly path: string;

  constructor(message: string, path = "") {
    super(path ? `${message} (at ${path})` : message);
    this.name = "Cip179DecodeError";
    this.path = path;
  }
}

/** Thrown when a domain value cannot be encoded to a CIP-179 metadatum. */
export class Cip179EncodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Cip179EncodeError";
  }
}
