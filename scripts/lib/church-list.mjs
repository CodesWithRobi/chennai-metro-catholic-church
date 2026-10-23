// Reads the church list out of index.html.
//
// The church data lives in one JS array inside index.html, so the scripts
// that work with photos parse it straight from the source. Each church object
// is read field by field, so a missing or reordered field costs one value
// instead of the whole church.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export function parseChurches(source) {
  const start = source.indexOf("const STATIONS = [");
  const end = source.indexOf("const LINE_SEQUENCES");
  if (start < 0 || end < 0) throw new Error("could not find the STATIONS array in index.html");
  const block = source.slice(start, end);

  const field = (text, key) => {
    const m = text.match(new RegExp(`\\b${key}:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
    return m ? m[1].replace(/\\"/g, '"') : "";
  };
  const num = (text, key) => {
    const m = text.match(new RegExp(`\\b${key}:\\s*([\\d.]+)`));
    return m ? Number(m[1]) : null;
  };

  // Station name lookup by scanning backwards for the enclosing station id.
  const stationRe = /id:\s*"(yl_[a-z0-9_]+|bl_[a-z0-9_]+|gl_[a-z0-9_]+)"\s*,\s*\n\s*name:\s*"((?:[^"\\]|\\.)*)"/g;
  const stationMarks = [];
  let m;
  while ((m = stationRe.exec(block))) stationMarks.push({ id: m[1], name: m[2].replace(/\\"/g, '"'), at: m.index });

  const churchRe = /id:\s*"(c_[a-z0-9_]+)"/g;
  const marks = [];
  while ((m = churchRe.exec(block))) marks.push({ id: m[1], at: m.index });

  const churches = [];
  for (const [i, mark] of marks.entries()) {
    const text = block.slice(mark.at, marks[i + 1] ? marks[i + 1].at : Math.min(block.length, mark.at + 2500));
    let owner = null;
    for (const s of stationMarks) if (s.at < mark.at) owner = s; else break;

    churches.push({
      id: mark.id,
      name: field(text, "name"),
      rite: field(text, "rite"),
      diocese: field(text, "diocese"),
      address: field(text, "address"),
      distKm: num(text, "distKm"),
      walkMin: num(text, "walkMin"),
      autoMin: num(text, "autoMin"),
      autoFare: num(text, "autoFare"),
      alsoNear: field(text, "alsoNear"),
      massInfo: field(text, "massInfo"),
      notes: field(text, "notes"),
      stationId: owner?.id ?? "",
      stationName: owner?.name ?? "",
    });
  }
  return churches;
}

// The churches of one index.html, read from the given project root.
export function readChurches(root) {
  return parseChurches(readFileSync(join(root, "index.html"), "utf8"));
}
