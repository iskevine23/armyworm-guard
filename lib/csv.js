export function csvCell(v) {
  let s = v === undefined || v === null ? "" : v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stops spreadsheet formula injection
  return '"' + s.replace(/"/g, '""') + '"';
}

export function toCsv(headers, rows) {
  return "﻿" + headers.map(csvCell).join(",") + "\n" + rows.map((r) => r.map(csvCell).join(",")).join("\n");
}

export function csvResponse(filename, headers, rows) {
  return { __raw: true, contentType: "text/csv; charset=utf-8", filename, body: toCsv(headers, rows) };
}
