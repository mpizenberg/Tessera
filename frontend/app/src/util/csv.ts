/** Minimal RFC-4180 CSV builder + browser download (the one side effect). */

function cell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(rows: ReadonlyArray<ReadonlyArray<string>>): string {
  return rows.map((r) => r.map(cell).join(",")).join("\r\n");
}

/** Trigger a browser download of `content` as `filename` (the one side effect). */
export function downloadText(
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
