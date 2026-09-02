const CACHE_NAME = "ghars-app-original-ui-v10";
const ASSETS = [
    "./",
    "./index.html",
    "./manifest.json",
    "./logo.png",
    "./styles.css?v=1.0.0",
    "./tailwind.js"
];

self.addEventListener("install", (e) => {
    self.skipWaiting(); 
    e.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
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
    if (e.request.url.includes("script.google.com") || e.request.url.includes("googleusercontent.com") || e.request.method !== "GET") {
        return; 
    }
    e.respondWith(
        fetch(e.request).catch(() => {
            return caches.match(e.request);
        })
    );
});
