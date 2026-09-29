/**
 * localStorage, best-effort. The browser may refuse it (private mode, blocked
 * site data, a full quota), and every caller reads a refusal as "nothing
 * kept". An empty value is never stored: writing one removes the key.
 */

/** The text under `key`, or undefined when absent, empty or refused. */
export function readText(key: string): string | undefined {
  try {
    return localStorage.getItem(key) || undefined;
  } catch {
    return undefined;
  }
}

/** Keep `value` under `key`, or remove the key when it is empty or undefined. */
export function writeText(key: string, value: string | undefined): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // refused or full: the value just won't survive a reload
  }
}

/** The JSON value under `key`, or undefined when absent, refused or not JSON. */
export function readJson(key: string): unknown {
  const text = readText(key);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Keep `value` as JSON under `key`, or remove the key when it is undefined. */
export function writeJson(key: string, value: unknown): void {
  writeText(key, value === undefined ? undefined : JSON.stringify(value));
}
