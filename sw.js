// Local Gemma offline helper (V0.4.0)
// 1) Caches the app page and the AI runtime so the app opens without internet.
// 2) When the AI runtime asks Hugging Face for a model file that the app has already
//    saved on this phone, answers from on-device storage instead of the network.
const CACHE = "local-gemma-app-v4";
let served = 0;

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(["./", "./index.html"])).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", e => {
  e.waitUntil(Promise.all([
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k.startsWith("local-gemma-app-") && k !== CACHE).map(k => caches.delete(k)))),
    self.clients.claim(),
  ]));
});

self.addEventListener("message", e => {
  if (e.data?.type === "ping") e.ports[0]?.postMessage({ servesModels: true, served });
});

// ---------- on-device model storage (same database the page writes to) ----------
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("local-gemma-store", 1);
    r.onupgradeneeded = () => { const d = r.result; d.createObjectStore("chunks"); d.createObjectStore("meta"); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function storedFile(url) {
  const db = await openDB();
  try {
    return await new Promise((res, rej) => {
      const t = db.transaction(["meta", "chunks"], "readonly");
      let meta, pieces;
      t.objectStore("meta").get(url).onsuccess = e => { meta = e.target.result; };
      t.objectStore("chunks").getAll(IDBKeyRange.bound([url, 0], [url, Infinity])).onsuccess = e => { pieces = e.target.result; };
      t.oncomplete = () => {
        if (!meta?.done || !pieces?.length) return res(null);
        const blob = new Blob(pieces);                 // disk-backed, not loaded into memory
        res(meta.total && blob.size !== meta.total ? null : blob);
      };
      t.onerror = () => rej(t.error);
    });
  } finally { db.close(); }
}

function contentType(url) {
  return /\.json$/.test(url) ? "application/json" : /\.jinja$/.test(url) ? "text/plain" : "application/octet-stream";
}

async function serveModelFile(request) {
  let blob = null;
  try { blob = await storedFile(request.url); } catch {}
  if (!blob) return fetch(request);                    // not saved yet: normal download
  served++;
  const headers = { "Content-Type": contentType(request.url), "Accept-Ranges": "bytes" };
  const range = request.headers.get("range");
  const m = range && /bytes=(\d*)-(\d*)/.exec(range);
  if (m) {                                             // partial request
    const size = blob.size;
    const start = m[1] === "" ? Math.max(0, size - (+m[2])) : +m[1];
    const end = m[1] !== "" && m[2] !== "" ? Math.min(+m[2], size - 1) : size - 1;
    return new Response(blob.slice(start, end + 1), { status: 206, headers: {
      ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) } });
  }
  return new Response(blob, { status: 200, headers: { ...headers, "Content-Length": String(blob.size) } });
}

self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);

  // Model files from Hugging Face → on-device storage when available.
  if (url.hostname === "huggingface.co" && url.pathname.includes("/resolve/")) {
    e.respondWith(serveModelFile(e.request));
    return;
  }

  // The app page: network first (so updates show up), cached copy when offline.
  if (url.origin === location.origin) {
    e.respondWith(
      fetch(e.request).then(r => {
        const copy = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return r;
      }).catch(() => caches.match(e.request).then(r => r || caches.match("./index.html")))
    );
    return;
  }

  // AI runtime JS/WASM from jsDelivr: cache first.
  if (url.hostname === "cdn.jsdelivr.net") {
    e.respondWith(
      caches.match(e.request).then(hit => hit || fetch(e.request).then(r => {
        if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
        return r;
      }))
    );
  }
});
