/**
 * Small, dependency-free CSV writer for partner downloads.
 *
 * A spreadsheet cell is data, not code: anything that could be interpreted as a
 * formula is neutralised, and the file starts with a UTF-8 BOM so Excel opens
 * rupee labels correctly. Keeping this pure makes the escaping testable.
 */

const FORMULA_START = /^[=+\-@\t\r]/;
const SAFE_FILENAME = /[^A-Za-z0-9_-]+/g;

export type CsvValue = string | number | boolean | null | undefined;

export function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") return String(value);
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function csvRow(cells: CsvValue[]): string {
  return cells.map(csvCell).join(",");
}

/** CRLF rows with a trailing newline, as expected by spreadsheet importers. */
export function csvDocument(rows: CsvValue[][]): string {
  return `\uFEFF${rows.map(csvRow).join("\r\n")}\r\n`;
}

/** Paise to a plain decimal string; never uses locale grouping inside a data cell. */
export function paiseDecimal(value: number): string {
  return (Math.trunc(value) / 100).toFixed(2);
}

export function exportFilename(kind: "revenue" | "settlements", from: string | null, to: string | null, now = new Date()): string {
  const period = from && to ? `${from}-to-${to}` : now.toISOString().slice(0, 10);
  return `savour-${kind}-${period.replace(SAFE_FILENAME, "-")}.csv`;
}
