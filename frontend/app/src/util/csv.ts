/** Minimal RFC-4180 CSV builder + browser download (the one side effect). */

function cell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(rows: ReadonlyArray<ReadonlyArray<string>>): string {
  return rows.map((r) => r.map(cell).join(",")).join("\r\n");
}

export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
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
