/* Asteroid Impact — offline helper. Keep this file next to index.html, named asteroid-impact-sw.js.
   It saves a copy of the game on your device so it opens with no
   internet. Online, the newest game is always loaded first. */

const CACHE = "asteroid-impact";

self.addEventListener("install", event => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE);
        for (const url of ["./", "index.html"]) {
            try {
                const res = await fetch(url, { cache: "reload" });
                if (res.ok) await cache.put(url, res);
            } catch (e) {}
        }
        await self.skipWaiting();
    })());
});

self.addEventListener("activate", event => {
    event.waitUntil(self.clients.claim());
});

/* the game tells us the exact address it was opened at */
self.addEventListener("message", event => {
    const d = event.data || {};
    if (d.type !== "keep" || !Array.isArray(d.urls)) return;
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE);
        for (const url of d.urls) {
            try {
                if (new URL(url).origin !== self.location.origin) continue;
                if (await cache.match(url, { ignoreSearch: true })) continue;
                const res = await fetch(url, { cache: "no-cache" });
                if (res.ok) await cache.put(url, res);
            } catch (e) {}
        }
    })());
});

async function savedCopy(request) {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(request, { ignoreSearch: true });
    if (hit || request.mode !== "navigate") return hit;
    for (const url of ["./", "index.html"]) {
        const page = await cache.match(url, { ignoreSearch: true });
        if (page) return page;
    }
    for (const key of await cache.keys()) {
        const page = await cache.match(key);
        if ((page.headers.get("content-type") || "").includes("text/html")) return page;
    }
    return null;
}

self.addEventListener("fetch", event => {
    const req = event.request;
    if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
    event.respondWith((async () => {
        const network = fetch(req).then(res => {
            if (res && res.ok) {
                const copy = res.clone();
                caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
            }
            return res;
        });
        const slow = new Promise((_, no) => setTimeout(() => no(new Error("slow")), 4000));
        try {
            return await Promise.race([network, slow]);
        } catch (e) {
            const copy = await savedCopy(req);
            if (copy) { network.catch(() => {}); return copy; }
            try { return await network; }
            catch (e2) {
                return new Response("Asteroid Impact hasn't been saved on this device yet — open it once with internet.",
                    { status: 503, headers: { "Content-Type": "text/plain;charset=utf-8" } });
            }
        }
    })());
});