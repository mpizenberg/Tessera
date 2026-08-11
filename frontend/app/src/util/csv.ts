/** Minimal RFC-4180 CSV builder + browser download (the one side effect). */

/**
 * Spreadsheets execute a cell starting with `=`, `+`, `-`, `@`, tab or CR as a
 * formula, and exported cells carry attacker-controlled on-chain strings. The
 * leading `'` (OWASP) forces the cell to text. It also lands on legitimate
 * negative numbers — the accepted cost of exporting untrusted data.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

function cell(value: string): string {
  const text = FORMULA_LEAD.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: ReadonlyArray<ReadonlyArray<string>>): string {
  return rows.map((r) => r.map(cell).join(",")).join("\r\n");
}

/** Trigger a browser download of `content` as `filename` (the one side effect). */
function downloadText(
  filename: string,
  content: string,
  type = "text/plain;charset=utf-8",
): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  try {
    a.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function downloadCsv(filename: string, csv: string): void {
  downloadText(filename, csv, "text/csv;charset=utf-8");
}

export function downloadJson(filename: string, json: string): void {
  downloadText(filename, json, "application/json;charset=utf-8");
}
