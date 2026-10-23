#!/usr/bin/env node
// Fetch a Google Maps place photo for every church in index.html and store it
// locally under assets/churches/<church-id>.jpg.
//
// Why local files: the page must render offline, must not hotlink Google CDN
// URLs (they expire and rate-limit), and the user needs a predictable folder
// where manually sourced images can be dropped in.
//
// No Google Maps API key is needed. Place photos are read from the same
// resource list the Maps web app itself loads, by driving a headless Chrome
// instance over the Chrome DevTools Protocol.
//
// Usage:
//   node scripts/fetch_church_images.mjs            # fetch everything
//   node scripts/fetch_church_images.mjs --only c_pmbypass_1
//   node scripts/fetch_church_images.mjs --limit 5   # smoke test
//   node scripts/fetch_church_images.mjs --retry-missing
//
// Outputs:
//   assets/churches/<church-id>.jpg        downloaded photo
//   assets/churches/manifest.json          source URL + size per church
//   assets/churches/missing-photos.md      report for churches with no photo

import { mkdirSync, writeFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseChurches } from "./lib/church-list.mjs";
import { MapsSession, UA, isPlacePanel, jpegSize, sleep } from "./lib/maps-session.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const INDEX = join(ROOT, "index.html");
const OUT_DIR = join(ROOT, "assets", "churches");
const MANIFEST = join(OUT_DIR, "manifest.json");
const REPORT = join(OUT_DIR, "missing-photos.md");

// ---------------------------------------------------------------- arguments

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const ONLY = opt("--only");
const LIMIT = Number(opt("--limit", "0")) || 0;
const DELAY = Number(opt("--delay", "1200")) || 0;
const RETRY_MISSING = flag("--retry-missing");
const FORCE = flag("--force");
// Rewrites manifest.json and missing-photos.md from what is on disk. No
// browser, no network.
const REPORT_ONLY = flag("--report-only");

// ---------------------------------------------------- churches without a place

// Google Maps has no place for these churches, checked on 2026-10-22. The
// place finder matches on the church name, so a name only search finds a
// church with the same name in another locality and stores the wrong photo.
// These ids are skipped on purpose and listed in missing-photos.md instead.
// Drop an id from this list once Google knows the place.
const NO_GOOGLE_PLACE = new Set([
  "c_annanagartower_1",    // Our Lady of Lourdes church, ICF / Villivakkam
  "c_ekkattuthangal_1",    // Our Lady of Good Health church, Jafferkhanpet
  "c_kumananchavadi_2",    // Our Lady of Miracles church, Mangadu
  "c_saligramam_1",        // St. Antony's chapel, Dasarathapuram
  "c_thelliyaragaram_1",   // St. Luke's hospital chapel, Porur
]);

// ------------------------------------------------------- parse index.html

const churches = parseChurches(readFileSync(INDEX, "utf8"));
if (!churches.length) throw new Error("no churches parsed from index.html");

// ------------------------------------------------------------ place lookup

// Words that carry no identifying weight when matching a Maps place title.
const STOPWORDS = new Set([
  "church", "catholic", "st", "saint", "saints", "our", "lady", "of", "the",
  "basilica", "shrine", "chapel", "cathedral", "convent", "mission", "parish",
  "holy", "cross", "christ", "jesus", "infant", "mary", "joseph", "anthony",
  "theresa", "teresa", "john", "baptist", "assumption", "velankanni", "good",
  "health", "family", "piety", "immaculate", "conception", "heart", "mother",
  "lord", "jesus", "tamil", "chennai", "tamilnadu",
]);

const tokens = (s) => s.toLowerCase()
  .replace(/[^a-z0-9\s]/g, " ")
  .split(/\s+/)
  .filter((t) => t.length >= 4 && !STOPWORDS.has(t));

// Structural words that say nothing about which church a place is. They are
// dropped when the place title is compared with the church name.
const GENERIC_WORDS = new Set([
  "church", "catholic", "st", "saint", "saints", "our", "lady", "of", "the",
  "holy", "basilica", "shrine", "chapel", "cathedral", "parish", "mission",
  "convent", "society", "centre", "center", "hospital", "religious",
  "archdiocesan", "diocesan", "temple", "kovil", "mandapam", "grotto",
  "apostle", "nulla", "kemp", "vicar", "priest", "pastor",
]);

// The distinctive words of a church name. Two or more of them in a place
// title mean the place is this church even when the addresses disagree.
const nameWordsOf = (name) => [...new Set(rawTokens(name).filter((t) => !GENERIC_WORDS.has(t)))];

function strongNameMatch(church, placeText) {
  const have = placeText.toLowerCase();
  const words = nameWordsOf(church.name);
  const hits = words.filter((w) => have.includes(w)).length;
  return hits >= 2;
}

// Every word, for a loose sanity check on the Maps place title.
const rawTokens = (s) => s.toLowerCase()
  .replace(/[^a-z0-9\s]/g, " ")
  .split(/\s+/)
  .filter((t) => t.length >= 4);

// The place name is part of the /maps/place/<Name>/ path.
function placeNameFromUrl(url) {
  const m = (url || "").match(/\/maps\/place\/([^/@]+)/);
  return m ? decodeURIComponent(m[1].replace(/\+/g, " ")) : "";
}

// The place coordinates, when the URL carries them.
function placeCoords(url) {
  const all = [...(url || "").matchAll(/!3d(-?[\d.]+)!4d(-?[\d.]+)/g)];
  const m = all[all.length - 1];
  return m ? { lat: Number(m[1]), lng: Number(m[2]) } : null;
}

// The church name carries the locality ("... , Porur"), the Maps title
// usually repeats it. The address is the fallback signal.
function nameMatches(church, placeText) {
  const have = new Set(tokens(placeText));
  const primary = tokens(church.name);
  const secondary = tokens(church.address);
  const hits = (list) => list.filter((t) => have.has(t)).length;

  if (primary.length && hits(primary)) return true;
  if (!primary.length && secondary.length && hits(secondary)) return true;

  // The name did not match on its own: accept only when the address matches
  // and the Maps title still names the same saint.
  if (secondary.length && hits(secondary)) {
    const titleWords = new Set(rawTokens(church.name));
    const title = [...rawTokens(placeText)];
    return title.some((t) => titleWords.has(t));
  }
  return false;
}

// ------------------------------------------------------------ photo choice

// "=w529-h298-k-no" -> width/height of the served thumbnail.
function sizeOf(url) {
  const m = url.match(/=w(\d+)-h(\d+)/);
  return m ? { w: Number(m[1]), h: Number(m[2]) } : { w: 0, h: 0 };
}

// The place's own uploaded photo has no "-pi-<lat>-ya<lon>" geo suffix.
// A geo-tagged user photo is a fallback, not the church's picture.
function pickPhoto(photos) {
  if (!photos.length) return null;
  const own = photos.filter((p) => !p.includes("-pi-"));
  const pool = own.length ? own : photos;
  return pool.sort((a, b) => {
    const sa = sizeOf(a), sb = sizeOf(b);
    return sb.w * sb.h - sa.w * sa.h;
  })[0];
}

// Ask Google for a bigger copy of the same photo.
function upscale(url) {
  return url.replace(/=w\d+-h\d+-k-no/, "=w1200-h800-k-no");
}

// ----------------------------------------------------------- image helpers

async function download(url) {
  // Google occasionally stalls the connection. Retry a few times before
  // giving up on a church, and never let a failed request kill the run.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      const size = jpegSize(buf);
      if (!size || size.w < 120 || size.h < 120) continue;
      return { buf, ...size };
    } catch {
      await sleep(1500 * attempt);
    }
  }
  return null;
}

// ------------------------------------------------------------------- main

mkdirSync(OUT_DIR, { recursive: true });

const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, "utf8")) : {};

// A church counts as done when its file is on disk, not when it is in the
// manifest. A run that dies part way still leaves usable photos behind.
const onDisk = (id) => {
  const file = join(OUT_DIR, `${id}.jpg`);
  return existsSync(file) && statSync(file).size > 4000;
};

let queue = churches;
if (ONLY) queue = queue.filter((c) => c.id === ONLY);
if (LIMIT) queue = queue.slice(0, LIMIT);
if (RETRY_MISSING) queue = queue.filter((c) => !onDisk(c.id));
if (REPORT_ONLY) queue = [];

const results = [];
const port = 9500 + Math.floor(Math.random() * 400);
const maps = REPORT_ONLY ? null : await new MapsSession(port).connect();
console.log(`Fetched ${churches.length} churches from index.html. Processing ${queue.length}.`);

const writeManifest = () => writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");

// One church. Returns a result row. Never throws: a broken place or a stalled
// download must not end the run.
async function processChurch(church, index, total) {
  const file = join(OUT_DIR, `${church.id}.jpg`);
  const label = `${church.id} ${church.name.slice(0, 44)}`;

  if (!FORCE && onDisk(church.id)) {
    console.log(`[${index + 1}/${total}] skip  ${label} (already on disk)`);
    return { ...church, status: "existing", file: `${church.id}.jpg` };
  }

  if (NO_GOOGLE_PLACE.has(church.id)) {
    console.log(`[${index + 1}/${total}] skip  ${label} (no place on Google Maps)`);
    return { ...church, status: "missing" };
  }

  // The church name already carries its locality ("... , Porur"), so it is
  // the best query. The fallbacks drop the generic words and rebuild the
  // query from the address, which is what disambiguates small chapels.
  const clean = (s) => s.replace(/[()]/g, " ").replace(/\s+/g, " ").trim();
  const saintPart = clean(church.name.split(",")[0]).replace(/\s+Catholic\b/gi, "");
  const nameArea = clean(church.name.split(",")[1] || "");
  const addressParts = church.address.split(",").map(clean).filter(Boolean);
  const placeParts = addressParts.filter(
    (p) => !/^(chennai|bangalore|puducherry|ponicherry|tamil nadu|tamilnadu)\b/i.test(p) && !/^\d{6}$/.test(p)
  );

  // "St." and "Saint" are the same church but Google treats them as
  // different search text, and one spelling opens the place panel while the
  // other opens a list.
  const spelled = saintPart.replace(/\bSt\.?/gi, "Saint");
  // The first word of the name's locality and the last word of the address
  // are the two most disambiguating terms.
  const areaWord = (nameArea.split(" ")[0] || "").replace(/[^A-Za-z]/g, "");
  const addrWord = (placeParts.filter((p) => !/^near\b/i.test(p)).slice(-1)[0] || "").split(" ")[0];

  const queries = [
    `${church.name}, Chennai`,
    `${saintPart}, ${nameArea}, Chennai`,
    `${saintPart}, ${placeParts.join(", ")}, Chennai`,
    `${spelled} ${areaWord} ${addrWord}, Chennai`.replace(/\s+/g, " ").replace(/ ,/, ","),
  ].map((q) => q.replace(/\s+/g, " ").trim())
    .filter((q, i, all) => q.length > 8 && all.indexOf(q) === i);

  // Locality words, used to pick the right entry when a list opens.
  const nameWords = nameWordsOf(church.name);
  const want = [...new Set(tokens(church.address).filter((w) => !nameWords.includes(w)))].slice(0, 6);

  let photo = null;
  let placeText = "";
  let sourceUrl = "";
  let placeCoordsFound = null;
  for (const query of queries) {
    const info = await maps.openPlace(query, nameWords, want);
    const placeName = placeNameFromUrl(info.url);
    const coords = placeCoords(info.url);
    if (process.env.DEBUG) {
      console.log(`   q=${query}\n     place="${placeName || info.title}" photos=${info.photos.length} coords=${coords ? `${coords.lat},${coords.lng}` : "-"} addr="${(info.address || "").slice(0, 80)}"`);
    }
    const candidate = pickPhoto(info.photos);
    if (!candidate) continue;
    if (!isPlacePanel(info.url)) {
      console.log(`[${index + 1}/${total}] skip  ${label} (no place panel opened)`);
      continue;
    }
    // The place's own text: its name, its card address and the result row it
    // came from. A results list stays in the page body after a click, so the
    // body text is only trustworthy when the place panel was opened directly.
    const specific = `${placeName} ${info.address || ""} ${info.opened || ""}`;
    const haystack = info.opened ? specific : `${specific} ${info.text}`;
    if (!nameMatches(church, haystack) && !strongNameMatch(church, specific)) {
      console.log(`[${index + 1}/${total}] skip  ${label} (matched a different place)`);
      continue;
    }
    photo = candidate;
    placeText = placeName || info.title;
    sourceUrl = candidate;
    placeCoordsFound = coords;
    break;
  }

  if (!photo) {
    console.log(`[${index + 1}/${total}] MISS  ${label}`);
    return { ...church, status: "missing" };
  }

  let img = await download(upscale(photo));
  if (!img) img = await download(photo);
  if (!img) {
    console.log(`[${index + 1}/${total}] MISS  ${label} (photo URL would not download)`);
    return { ...church, status: "missing" };
  }

  writeFileSync(file, img.buf);
  manifest[church.id] = {
    url: sourceUrl,
    file: `${church.id}.jpg`,
    width: img.w,
    height: img.h,
    bytes: img.buf.length,
    place: placeText,
    lat: placeCoordsFound?.lat ?? null,
    lng: placeCoordsFound?.lng ?? null,
    fetchedAt: new Date().toISOString().slice(0, 10),
  };
  writeManifest();
  console.log(`[${index + 1}/${total}] ok    ${label} -> ${img.w}x${img.h}`);
  return { ...church, status: "saved", file: `${church.id}.jpg`, width: img.w, height: img.h };
}

try {
  for (const [index, church] of queue.entries()) {
    try {
      results.push(await processChurch(church, index, queue.length));
    } catch (err) {
      console.log(`[${index + 1}/${queue.length}] ERROR ${church.id} — ${err.message}`);
      results.push({ ...church, status: "missing" });
    }
    if (DELAY) await sleep(DELAY);
  }
} finally {
  if (maps) maps.close();
}

writeManifest();

// --------------------------------------------------------------- reporting

const saved = results.filter((r) => r.status === "saved");

// The report covers every church that still has no file, not just the ones
// this run happened to touch.
const missing = churches.filter((c) => !onDisk(c.id));

const lines = [
  "# Churches with no Google Maps photo",
  "",
  `Generated by \`scripts/fetch_church_images.mjs\` on ${new Date().toISOString().slice(0, 10)}.`,
  "",
  `Churches with a photo: ${churches.length - missing.length} of ${churches.length}. Still missing: ${missing.length}.`,
  "",
  "For each church below, Google Maps has no usable place photo. Save a picture as",
  "`assets/churches/<church-id>.jpg` and the site will use it on the next load.",
  "The page falls back to a neutral placeholder until then.",
  "",
  "Serve the project root, not the single file. A server that answers every path",
  "with `index.html` returns HTML for the photo URLs and every church shows the",
  "placeholder. `live-server .` and `python3 -m http.server` from the project root",
  "both work.",
  "",
];

if (!missing.length) {
  lines.push("Every church has a photo.", "");
} else {
  lines.push("| Church | Station | Save the picture as | Address | Search |", "|---|---|---|---|---|");
  for (const c of missing) {
    const q = encodeURIComponent(`${c.name}, ${c.address}`);
    lines.push(
      `| **${c.name}** | ${c.stationName} | \`assets/churches/${c.id}.jpg\` | ${c.address} | [Maps](https://www.google.com/maps/search/?api=1&query=${q}) |`
    );
  }
  lines.push("");
  lines.push("## Church ids");
  lines.push("");
  for (const c of missing) lines.push(`- \`${c.id}\` -> \`assets/churches/${c.id}.jpg\``);
  lines.push("");
}

writeFileSync(REPORT, lines.join("\n"));

console.log(`\nDone. ${saved.length} saved in this run. ${missing.length} churches still have no photo.`);
console.log(`Manifest: ${MANIFEST}`);
console.log(`Report:   ${REPORT}`);
process.exit(0);
