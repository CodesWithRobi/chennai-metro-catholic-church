#!/usr/bin/env node
// Save the Google Maps photo of one church, taken from a Maps place link.
//
// The link is the one you get from the browser: open the church on Google
// Maps, copy the address bar, and pass it here. The script opens that place,
// reads the photos the Maps web app loads, and stores the best one as
// assets/churches/<church-id>.jpg.
//
// Usage:
//   node scripts/fetch_church_image_from_link.mjs --church c_kumananchavadi_2 --link "<maps link>"
//   node scripts/fetch_church_image_from_link.mjs --church c_x --link "<maps link>" --force
//   node scripts/fetch_church_image_from_link.mjs --church c_x --link "<maps link>" --dry-run
//   node scripts/fetch_church_image_from_link.mjs --church c_x --photo "<lh3.googleusercontent.com URL>"
//
//   --force     replace a photo that is already on disk
//   --dry-run   print the place name, address and the photos found, write nothing
//   --photo     a photo URL instead of a place link. No browser is opened, so
//               nothing checks which place the photo belongs to. Use it when
//               Maps throttles the browser, or when the place is already known.
//
// Outputs:
//   assets/churches/<church-id>.jpg   the photo
//   assets/churches/manifest.json     updated with the source URL and size

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readChurches } from "./lib/church-list.mjs";
import { MapsSession, UA, jpegSize, sleep } from "./lib/maps-session.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const OUT_DIR = join(ROOT, "assets", "churches");
const MANIFEST = join(OUT_DIR, "manifest.json");

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const CHURCH = opt("--church");
const LINK = opt("--link");
const PHOTO = opt("--photo");
const FORCE = flag("--force");
const DRY_RUN = flag("--dry-run");
const LIST = flag("--list");

// ------------------------------------------------------------ the church

const churches = readChurches(ROOT);

if (LIST) {
  for (const c of churches) {
    const has = existsSync(join(OUT_DIR, `${c.id}.jpg`));
    console.log(`${c.id.padEnd(24)} ${has ? "photo  " : "MISSING"} ${c.name}  [${c.stationName}]`);
  }
  process.exit(0);
}

if (!CHURCH || (!LINK && !PHOTO)) {
  console.error("usage: node scripts/fetch_church_image_from_link.mjs --church <church-id> --link <maps link> [--force] [--dry-run]");
  console.error("       node scripts/fetch_church_image_from_link.mjs --church <church-id> --photo <photo URL>");
  console.error("       node scripts/fetch_church_image_from_link.mjs --list");
  process.exit(2);
}

const church = churches.find((c) => c.id === CHURCH);
if (!church) {
  console.error(`no church with id "${CHURCH}" in index.html`);
  console.error("run with --list to see the church ids");
  process.exit(2);
}

// A Maps place link carries the place id, the coordinates and, sometimes, the
// URL of one photo. Each is read separately so the script also accepts a
// bare place id or a share link.
function parseLink(link) {
  const hex = link.match(/1s(0x[0-9a-f]+:0x[0-9a-f]+)/i);
  const chij = link.match(/place_id:(ChIJ[\w-]+)/);
  const coords = [...link.matchAll(/!3d(-?[\d.]+)!4d(-?[\d.]+)/g)].pop();
  // The photo segment may percent-encode the URL ("6shttps:%2F%2F..."), with
  // only the scheme colon left literal.
  const embedded = link.match(/6s(https?[:%][^&!]+)/i);
  const named = link.match(/\/maps\/place\/([^/@?]+)/);

  const photo = embedded ? decodeURIComponent(embedded[1]) : "";
  const lat = coords ? Number(coords[1]) : null;
  const lng = coords ? Number(coords[2]) : null;
  const name = named ? decodeURIComponent(named[1].replace(/\+/g, " ")) : "";

  // A link copied from the address bar often points at a photo inside the
  // place. Maps then opens the photo viewer and no place panel loads. The
  // photo sits in its own segment of the data part. Drop it and keep the
  // place segment, which starts at "!4m".
  const dataAt = link.indexOf("/data=");
  const data = dataAt >= 0 ? link.slice(dataAt + 6) : "";
  const placeAt = data.indexOf("!4m");
  const placeSegment = placeAt >= 0 ? data.slice(placeAt).split(/[?#]/)[0] : "";
  const head = dataAt >= 0 ? link.slice(0, dataAt) : "";
  const stripped = head && placeSegment ? `${head}/data=${placeSegment}` : "";

  // The place id of the link, used to rebuild the URL when the link has no
  // data part. The 10 character feature id has to stay, or Maps loads the
  // place without its photo strip.
  const feature = link.match(/!16s%2Fg%2F([A-Za-z0-9_-]+)/);
  const tail = feature ? `!10e5!14m1!1BCgIgAQ!16s%2Fg%2F${feature[1]}` : "";

  const built = hex && lat !== null
    ? `https://www.google.com/maps/place/${encodeURIComponent(name)}/@${lat},${lng},3a,75y,90t` +
      `/data=!4m9!3m8!1s${hex[1]}!8m2!3d${lat}!4d${lng}${tail}`
    : "";

  const clean = stripped || built;

  return {
    hexId: hex ? hex[1] : "",
    placeId: chij ? chij[1] : "",
    name,
    lat,
    lng,
    photo,
    // The URL to open.
    url: link.startsWith("http")
      ? clean || link
      : chij
        ? `https://www.google.com/maps/place/?q=place_id:${chij[1]}`
        : clean,
  };
}

// Ask Google for a bigger copy of the same photo. The size parameters have to
// keep the photo's aspect ratio, or the CDN answers with HTTP 400.
const upscale = (url) => {
  const m = url.match(/=w(\d+)-h(\d+)/);
  if (!m) return url;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (Math.max(w, h) >= 1200) return url;
  const scale = 1200 / Math.max(w, h);
  return url.replace(/=w\d+-h\d+/, `=w${Math.round(w * scale)}-h${Math.round(h * scale)}`);
};

// The place's own uploaded photo has no "-pi-<lat>-ya<lon>" geo suffix. A
// geo-tagged user photo is a fallback, not the church's own picture.
const isOwnUpload = (url) => !url.includes("-pi-");

const link = parseLink(LINK || "");
const file = join(OUT_DIR, `${church.id}.jpg`);
const hasPhoto = existsSync(file);

console.log(`church : ${church.id} ${church.name}`);
console.log(`station: ${church.stationName}`);
console.log(`address: ${church.address}`);
if (link.lat !== null) console.log(`link   : ${link.lat}, ${link.lng}`);

if (hasPhoto && !FORCE && !DRY_RUN) {
  console.error(`\n${church.id}.jpg already exists. Use --force to replace it.`);
  process.exit(3);
}

// Write the photo and record where it came from.
function save(photo, place) {
  writeFileSync(file, photo.buf);
  const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, "utf8")) : {};
  manifest[church.id] = {
    url: photo.url,
    file: `${church.id}.jpg`,
    width: photo.w,
    height: photo.h,
    bytes: photo.buf.length,
    place,
    lat: link.lat,
    lng: link.lng,
    fetchedAt: new Date().toISOString().slice(0, 10),
  };
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`\nsaved ${photo.w}x${photo.h} to assets/churches/${church.id}.jpg`);
  console.log("reload the page to see it");
}

// A photo URL on its own. No browser, no place card, and nothing checks which
// place the photo shows: compare it with the church entry yourself.
if (PHOTO) {
  console.log(`photo  : ${PHOTO.slice(0, 120)}`);
  const photo = await fetchPhoto(upscale(PHOTO));
  if (!photo) {
    console.error("\ncould not download that photo URL");
    process.exit(4);
  }
  console.log(`size   : ${photo.w}x${photo.h}, ${photo.buf.length} bytes`);
  if (DRY_RUN) {
    console.log("dry run, nothing written.");
    process.exit(0);
  }
  save(photo, `${church.name} (photo URL, place not verified)`);
  process.exit(0);
}

// --------------------------------------------------------------- the browser

const port = 9500 + Math.floor(Math.random() * 400);
const maps = await new MapsSession(port).connect();

// Every image the browser fetches is kept, so the bytes can be read straight
// out of the network layer. Node cannot download the thumbnail URLs itself:
// the CDN answers them with HTTP 400 outside a browser.
const seen = new Map();
maps.onEvent = (msg) => {
  if (msg.method !== "Network.responseReceived") return;
  const res = msg.params?.response;
  if (!res || !/^image\//.test(res.mimeType || "")) return;
  if (!res.url.includes("googleusercontent.com")) return;
  seen.set(msg.params.requestId, res.url);
};

// The bodies of the images the browser loaded, as JPEG buffers.
async function readPhotos() {
  const out = [];
  for (const [requestId, url] of seen) {
    const body = await maps.send("Network.getResponseBody", { requestId }).catch(() => null);
    if (!body?.result?.body) continue;
    const buf = body.result.base64Encoded
      ? Buffer.from(body.result.body, "base64")
      : Buffer.from(body.result.body, "binary");
    const size = jpegSize(buf);
    if (!size || size.w < 120 || size.h < 120) continue;
    out.push({ url, buf, ...size });
  }
  return out;
}

// One photo from a URL, for the pictures the card lists but never loads.
// The photo CDN wants a browser-like request and answers 400 to a bare one,
// so send the Maps referer and retry: a quick burst of requests is refused
// even when the URL is good.
async function fetchPhoto(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Referer: "https://www.google.com/maps/",
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(20000),
    }).catch(() => null);
    if (res?.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      const size = jpegSize(buf);
      if (size && size.w >= 120 && size.h >= 120) return { url, buf, ...size };
    }
    await sleep(1500 * (attempt + 1));
  }
  return null;
}

// collect() can land while the page swaps documents and come back empty, so
// read until the page reports itself.
async function readInfo(attempts = 6) {
  for (let i = 0; i < attempts; i++) {
    const info = await maps.collect().catch(() => ({}));
    if (info.url) return info;
    await sleep(2000);
  }
  return {};
}

// The distance between two points, in km.
function gapKm(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

try {
  console.log("\nopening the place...");
  await maps.goto(link.url, 14000);
  await maps.waitPhotos(20000);

  // The place card fills in a few seconds after the tiles. Read it before
  // clicking anything: the click opens the photo viewer, which carries no
  // address and no photo strip of its own.
  let info = await readInfo();
  if (!info.address) {
    const waited = await maps.waitCard(15000);
    info = { ...info, ...waited, photos: (waited.photos || []).length ? waited.photos : info.photos };
  }

  // Still a limited view: click its picture to open the full card.
  if (!info.address || !(info.photos || []).length) {
    const clicked = await maps.openPhotoViewer();
    console.log(`viewer : ${clicked}`);
    const card = await maps.waitCard(12000);
    info = { ...info, ...card, photos: (card.photos || []).length ? card.photos : info.photos };
  }

  const candidates = await readPhotos();
  const opened = (info.url || "").match(/@(-?[\d.]+),(-?[\d.]+)/);

  // The card lists photos the page never loaded as images. The same photo
  // appears at several sizes, so keep one URL per photo.
  const baseId = (u) => u.split("=")[0];
  const listed = [];
  for (const url of info.photos || []) {
    if (!listed.some((u) => baseId(u) === baseId(url))) listed.push(url);
  }
  for (const url of listed) {
    if (candidates.some((c) => baseId(c.url) === baseId(url))) continue;
    const photo = await fetchPhoto(upscale(url));
    if (photo) candidates.push(photo);
  }

  // The place card sometimes never loads its photo strip at all. The link
  // points at one photo of the place, so open the link itself: Maps shows that
  // photo in the viewer, and the network layer catches it.
  if (!candidates.length && LINK.startsWith("http") && link.url !== LINK) {
    console.log("\nthe card listed no photo, opening the link's own photo viewer...");
    seen.clear();
    await maps.goto(LINK, 12000);
    await maps.waitPhotos();
    const viewer = await maps.collect().catch(() => ({}));
    if (!info.address && viewer.address) info = { ...info, ...viewer };
    if (!info.title && viewer.title) info = { ...info, title: viewer.title };
    candidates.push(...(await readPhotos()));
  }

  // The link itself carries one photo URL, which is the last resort.
  if (!candidates.length && link.photo) {
    const photo = await fetchPhoto(upscale(link.photo));
    if (photo) candidates.push(photo);
  }

  // The place that opened must sit where the link pointed.
  const gap = opened && link.lat !== null
    ? gapKm({ lat: link.lat, lng: link.lng }, { lat: Number(opened[1]), lng: Number(opened[2]) })
    : null;

  console.log(`\nplace  : ${info.title || link.name || "(not read)"}`);
  console.log(`address: ${info.address || "(not read)"}`);
  console.log(`opened : ${opened ? `${opened[1]}, ${opened[2]}` : "(unknown)"}` +
    (gap === null ? "" : `, ${gap.toFixed(2)} km from the link`));
  console.log(`photos : ${candidates.length}`);
  for (const c of candidates) {
    console.log(`   ${c.w}x${c.h} ${c.buf.length} bytes ${isOwnUpload(c.url) ? "own upload" : "user photo"} ${c.url.slice(0, 110)}`);
  }

  if (!candidates.length) {
    console.error("\nno photo found for this place");
    process.exit(4);
  }

  // The place's own picture first, then the biggest one.
  const own = candidates.filter((c) => isOwnUpload(c.url));
  const pool = own.length ? own : candidates;
  const best = pool.sort((a, b) => b.w * b.h - a.w * a.h)[0];

  if (gap !== null && gap > 0.4) {
    console.error(`\nwarning: the place that opened sits ${gap.toFixed(2)} km from the link`);
  }

  if (DRY_RUN) {
    console.log(`\ndry run, nothing written. Best: ${best.w}x${best.h}`);
    process.exit(0);
  }

  save(best, info.title || link.name);
} finally {
  maps.close();
}