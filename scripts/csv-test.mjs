import assert from "node:assert/strict";
import { csvCell, csvDocument, csvRow, exportFilename, paiseDecimal } from "../src/lib/csv.ts";

assert.equal(csvCell("plain"), "plain");
assert.equal(csvCell("Rs 1,200"), '"Rs 1,200"');
assert.equal(csvCell('He said "hi"'), '"He said ""hi"""');
assert.equal(csvCell("=SUM(A1:A2)"), "'=SUM(A1:A2)");
assert.equal(csvCell("@cmd"), "'@cmd");
assert.equal(csvCell(2), "2");
assert.equal(csvCell(-2), "-2");
assert.equal(csvCell(null), "");
assert.equal(csvRow([1, null, "a,b"]), '1,,"a,b"');
assert.equal(csvDocument([["a", "b"], [1, 2]]), "\uFEFFa,b\r\n1,2\r\n");
assert.equal(paiseDecimal(123456), "1234.56");
assert.equal(paiseDecimal(5), "0.05");
assert.equal(
  exportFilename("revenue", "2026-11-01", "2026-11-07"),
  "savour-revenue-2026-11-01-to-2026-11-07.csv",
);
assert.equal(
  exportFilename("settlements", null, null, new Date("2026-11-19T00:00:00.000Z")),
  "savour-settlements-2026-11-19.csv",
);

console.log("PASS: CSV escaping, money formatting and export filenames");
