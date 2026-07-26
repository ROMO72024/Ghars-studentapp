const CACHE_NAME = "ghars-app-v6";
const ASSETS = [
    "./",
    "./index.html",
    "./manifest.json",
    "./logo.jpg"
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
    // الحل الجذري: إذا كانت العملية "إرسال بيانات" (POST)، اتركها تمر للإنترنت مباشرة ولا تتدخل أبداً
    if (e.request.method !== "GET") {
        return; 
    }

    // للطلبات الأخرى المتعلقة بالداتابيز، دعه يمر
    if (e.request.url.includes("script.google.com") || e.request.url.includes("googleusercontent.com")) {
        e.respondWith(fetch(e.request));
        return;
    }

    // لباقي ملفات التصميم، استخدم الإنترنت وإن فشل استخدم الذاكرة
    e.respondWith(
        fetch(e.request).catch(() => {
            return caches.match(e.request);
        })
    );
});
