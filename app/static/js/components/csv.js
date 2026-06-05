/**
 * csv.js — minimal delimited-text parsing shared by the files page preview
 * and the chat attachment preview.
 */

/**
 * Parse delimited text into rows, honouring "quoted" fields with embedded
 * delimiters, newlines and escaped ("") quotes — enough for real CSV/TSV files.
 */
export function parseDelimited(text, delim) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === delim) {
      row.push(field); field = "";
    } else if (c === "\n") {
      row.push(field); rows.push(row); row = []; field = "";
    } else if (c !== "\r") {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  // Drop a trailing empty row from a final newline.
  if (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === "") rows.pop();
  return rows;
}
