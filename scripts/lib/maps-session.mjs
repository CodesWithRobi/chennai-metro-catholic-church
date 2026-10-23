// A headless Chrome session that drives the Google Maps web app over the
// Chrome DevTools Protocol.
//
// No Maps API key is needed. The Maps web app loads the same place photos a
// user sees, and this session reads them out of the page.
//
// Shared by scripts/fetch_church_images.mjs and
// scripts/fetch_church_image_from_link.mjs.

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Place photos live on two CDNs. "gps-cs-s" is the place photo the Maps
// photo viewer loads. "grass-cs" is the thumbnail strip in the place panel.
// Both are real photos of the place.
export const isPlacePhoto = (url) =>
  !!url &&
  (url.includes("googleusercontent.com/gps-cs-s/") ||
    url.includes("googleusercontent.com/gps-photo/") ||
    url.includes("googleusercontent.com/grass-cs/"));

// Reads the JPEG frame header to confirm the payload is a real photo.
export function jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let off = 2;
  while (off + 9 < buf.length) {
    if (buf[off] !== 0xff) { off++; continue; }
    const marker = buf[off + 1];
    const len = buf.readUInt16BE(off + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: buf.readUInt16BE(off + 5), w: buf.readUInt16BE(off + 7) };
    }
    off += 2 + len;
  }
  return null;
}

export class MapsSession {
  constructor(port) {
    this.port = port;
    this.profile = mkdtempSync(join(tmpdir(), "church-photo-"));
    this.chrome = spawn("google-chrome", [
      "--headless=new", "--disable-gpu", "--no-sandbox",
      `--remote-debugging-port=${port}`, `--user-data-dir=${this.profile}`,
      "--window-size=1400,1000", "--lang=en-US", "--no-first-run", "about:blank",
    ], { stdio: "ignore" });
    // Set to a function to see every CDP event. The from-link script uses it
    // to catch the image responses the browser fetches.
    this.onEvent = null;
  }

  async connect() {
    let wsUrl;
    for (let i = 0; i < 100; i++) {
      try {
        const j = await (await fetch(`http://127.0.0.1:${this.port}/json/version`)).json();
        if (j.webSocketDebuggerUrl) { wsUrl = j.webSocketDebuggerUrl; break; }
      } catch {}
      await sleep(250);
    }
    if (!wsUrl) throw new Error("chrome did not start");
    this.ws = new WebSocket(wsUrl);
    await new Promise((r) => (this.ws.onopen = r));
    this.id = 0;
    this.pending = new Map();
    this.ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && this.pending.has(msg.id)) { this.pending.get(msg.id)(msg); this.pending.delete(msg.id); }
      else if (msg.method && this.onEvent) this.onEvent(msg);
    };
    const { result: { targetId } } = await this.send("Target.createTarget", { url: "about:blank" });
    const { result: { sessionId } } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    this.S = sessionId;
    await this.send("Network.enable", {}, this.S);
    await this.send("Page.enable", {}, this.S);
    await this.send("Runtime.enable", {}, this.S);
    for (const c of [["CONSENT", "YES+cb.20210328-17-p0.en+FX+999"], ["SOCS", "CAESHAgBEhIaAB"]]) {
      await this.send("Network.setCookie", { name: c[0], value: c[1], domain: ".google.com", path: "/" }, this.S);
    }
    return this;
  }

  // A CDP request can hang forever if the page dies. Give up instead.
  send(method, params = {}, sessionId) {
    return new Promise((res) => {
      const i = ++this.id;
      const timer = setTimeout(() => {
        this.pending.delete(i);
        res({ error: `timeout after 60s: ${method}` });
      }, 60000);
      this.pending.set(i, (msg) => {
        clearTimeout(timer);
        res(msg);
      });
      this.ws.send(JSON.stringify({ id: i, method, params, sessionId }));
    });
  }

  async evaluate(expression) {
    const res = await this.send("Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true }, this.S);
    if (res?.error) throw new Error(res.error);
    const { result } = res;
    if (result?.exceptionDetails) {
      const d = result.exceptionDetails;
      const why = d.exception?.description || d.text || JSON.stringify(d);
      throw new Error(`page error: ${why}`.slice(0, 400));
    }
    return result?.result?.value;
  }

  async goto(url, waitMs = 11000) {
    const nav = await this.send("Page.navigate", { url }, this.S);
    if (nav?.errorText || nav?.error) console.log(`   navigate failed: ${nav.errorText || nav.error}`);
    await sleep(waitMs);
    await this.waitReady();
  }

  // Maps keeps the document in "loading" for a while after a navigation, and
  // an early read sees no body at all. Wait for a usable document.
  async waitReady(maxMs = 25000) {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      const ok = await this.evaluate(
        "!!document.body && document.readyState !== 'loading' && document.body.innerText.length > 40"
      ).catch(() => false);
      if (ok) return true;
      await sleep(1000);
    }
    return false;
  }

  // Photo URLs show up in the resource list or in the DOM only once the place
  // panel has loaded them.
  async waitPhotos(maxMs = 20000) {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      const n = await this.evaluate(`(() => {
        const res = performance.getEntriesByType('resource').map(r => r.name);
        const dom = [...document.querySelectorAll('img')].map(i => i.currentSrc || i.src);
        return [...new Set([...res, ...dom].filter(n => n && (n.includes('googleusercontent.com/gps-cs-s/') || n.includes('googleusercontent.com/gps-photo/') || n.includes('googleusercontent.com/grass-cs/')))].length;
      })()`).catch(() => 0);
      if (n) return true;
      await sleep(1000);
    }
    return false;
  }

  async collect() {
    // A read can land while the page swaps documents, which kills the
    // execution context. Try again instead of returning an empty result.
    for (let attempt = 0; attempt < 3; attempt++) {
      const raw = await this.evaluate(`(() => {
        const res = performance.getEntriesByType('resource').map(r => r.name);
        // Some panels lazy-load their photo strip, so the resource list alone
        // misses pictures that are already in the DOM.
        const dom = [...document.querySelectorAll('img')].map(i => i.currentSrc || i.src);
        const bg = [...document.querySelectorAll('[style*="background-image"]')]
          .map(e => e.style.backgroundImage)
          .join(' ')
          .match(/https:[^"')]+/g) || [];
        const photos = [...new Set([...res, ...dom, ...bg].filter(n => n && (n.includes('googleusercontent.com/gps-cs-s/') || n.includes('googleusercontent.com/gps-photo/') || n.includes('googleusercontent.com/grass-cs/')))];
        const body = document.body;
        // The place card carries its own address. A results list does not.
        const address = [...document.querySelectorAll('[aria-label^="Address:"]')]
          .map(e => e.getAttribute('aria-label') || '')
          .join(' ');
        return JSON.stringify({
          title: (document.querySelector('h1') || {}).innerText || '',
          url: location.href,
          ready: document.readyState,
          photos,
          address,
          text: (body && body.innerText ? body.innerText : '').slice(0, 900)
        });
      })()`).catch(() => "{}");
      const info = JSON.parse(raw || "{}");
      if (info.url) return info;
      await sleep(1500);
    }
    return {};
  }

  // Search Maps, then make sure a single place panel is open. A results list
  // carries thumbnails of every hit, so a photo taken from a list can be the
  // wrong church. Only the place panel is trustworthy.
  //
  // `named` holds the distinctive words of the church name and `want` the
  // locality words. Together they decide which entry of a results list gets
  // opened: the first hit is often a church with the same saint, or the same
  // name, in a different part of the city.
  async openPlace(query, named = [], want = []) {
    await this.goto(`https://www.google.com/maps/search/${encodeURIComponent(query)}?hl=en&gl=in`);
    let info = await this.collect();

    if (isPlacePanel(info.url)) {
      // The right place is already open. Give the panel time to load its
      // photos instead of clicking, which would navigate away from it.
      await this.waitPhotos();
      return await this.collect();
    }

    // A results list. Open the entry that matches the church best.
    const opened = await this.evaluate(`(() => {
      const named = ${JSON.stringify(named)};
      const want = ${JSON.stringify(want)};
      const links = [...document.querySelectorAll('a[href*="/maps/place/"]')];
      const score = (a) => {
        const t = (a.innerText || '').toLowerCase();
        let s = 0;
        for (const w of named) if (t.includes(w)) s += 2;
        for (const w of want) if (t.includes(w)) s += 1;
        return s;
      };
      const usable = links.filter(a => a.innerText && a.innerText.trim().length > 3);
      const ranked = usable.map(a => [score(a), a]).sort((x, y) => y[0] - x[0]);
      const hit = (ranked[0] && ranked[0][0] > 0) ? ranked[0][1] : (usable[0] || links[0]);
      if (hit) { hit.click(); return hit.innerText.replace(/\\n/g, ' ').slice(0, 200); }
      return null;
    })()`);
    if (!opened) return { ...info, opened: null };
    await this.waitReady();
    await this.waitPhotos();
    return { ...(await this.collect()), opened };
  }

  // Click the first picture of the place panel. The photo viewer then loads a
  // full size copy, which is what the site should store.
  async openPhotoViewer() {
    const clicked = await this.evaluate(`(() => {
      const imgs = [...document.querySelectorAll('img')].filter((i) => {
        const s = i.currentSrc || i.src || '';
        return s.includes('googleusercontent') && !s.includes('streetviewpixels-pa');
      });
      if (!imgs.length) return 'no images';
      const target = imgs[0];
      (target.closest("button, a, [role='button']") || target).click();
      return 'clicked ' + (target.currentSrc || target.src || '').slice(0, 80);
    })()`).catch(() => "click failed");
    await sleep(8000);
    return clicked;
  }

  // The place card fills in after its picture is clicked. Wait for the
  // address, which the card prints as an aria-label.
  async waitCard(maxMs = 20000) {
    const t0 = Date.now();
    let info = {};
    while (Date.now() - t0 < maxMs) {
      info = await this.collect().catch(() => ({}));
      if (info.address) return info;
      await sleep(1500);
    }
    return info;
  }

  close() { try { this.ws.close(); } catch {} this.chrome.kill(); }
}

// Maps opens a single place panel on a /maps/place/ URL.
export const isPlacePanel = (url) => (url || "").includes("/maps/place/");
