"use strict";

const CACHE_NAME = "ghars-attendance-v14";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css?v=2.2.0",
  "./app.js?v=2.2.0",
  "./manifest.json?v=2.2.0",
  "./logo.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => Promise.all(APP_SHELL.map(async (path) => {
        const response = await fetch(path, { cache: "reload" });
        if (!response.ok) throw new Error(`تعذر تخزين ${path}`);
        await cache.put(path, response);
      })))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(cacheFirstWithRefresh(request, event));
});

async function networkFirst(request) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(request, { signal: controller.signal });
    const cache = await caches.open(CACHE_NAME);
    cache.put(request, response.clone());
    return response;
  } catch (error) {
    return (await caches.match(request)) || (await caches.match("./index.html"));
  } finally {
    clearTimeout(timeoutId);
  }
}

async function cacheFirstWithRefresh(request, event) {
  const cached = await caches.match(request);
  const refresh = fetch(request)
    .then(async (response) => {
      if (response.ok) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  event.waitUntil(refresh);

  return cached || (await refresh) || Response.error();
}

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
