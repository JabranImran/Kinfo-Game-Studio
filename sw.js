// Local Gemma offline cache.
// Caches the app page and the AI runtime (from jsDelivr) so the app opens without internet.
// Model weights are NOT handled here: Transformers.js caches those itself.
const CACHE = "local-gemma-app-v2";

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(["./", "./index.html"])).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(k => k.startsWith("local-gemma-app-") && k !== CACHE).map(k => caches.delete(k))
  )));
  self.clients.claim();
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;

  // The page itself: try the network first (so updates show up), fall back to cache when offline.
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

  // Runtime JS/WASM from jsDelivr: cache first (these files never change for a given version).
  if (url.hostname === "cdn.jsdelivr.net") {
    e.respondWith(
      caches.match(e.request).then(hit => hit || fetch(e.request).then(r => {
        if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
        return r;
      }))
    );
  }
  // Everything else (incl. Hugging Face model files) goes straight to the network.
});
