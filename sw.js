const CACHE_NAME = "ghars-app-v11";
const ASSETS = [
    "./",
    "./index.html",
    "./manifest.json",
    "./logo.png",
    "./styles.css",
    "./tailwind.js"
];

self.addEventListener("install", (e) => {
    self.skipWaiting();
    e.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).catch(() => {})
    );
});

self.addEventListener("activate", (e) => {
    e.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)));
        })
    );
    return self.clients.claim();
});

self.addEventListener("fetch", (e) => {
    const url = e.request.url || "";
    // لا نخزن أبداً طلبات الشيت ولا POST
    if (e.request.method !== "GET" || url.includes("script.google.com") || url.includes("googleusercontent.com")) {
        return;
    }
    // التنقل بين الصفحات: الشبكة أولاً ثم الكاش
    if (e.request.mode === "navigate") {
        e.respondWith(
            fetch(e.request).then((res) => {
                const copy = res.clone();
                caches.open(CACHE_NAME).then((cache) => cache.put(e.request, copy)).catch(() => {});
                return res;
            }).catch(() => caches.match("./index.html"))
        );
        return;
    }
    // الملفات الثابتة: الكاش أولاً ثم الشبكة (سرعة فورية)
    e.respondWith(
        caches.match(e.request, { ignoreSearch: true }).then((cached) => {
            if (cached) return cached;
            return fetch(e.request).then((res) => {
                if (res && res.status === 200) {
                    const copy = res.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(e.request, copy)).catch(() => {});
                }
                return res;
            }).catch(() => caches.match(e.request));
        })
    );
});
