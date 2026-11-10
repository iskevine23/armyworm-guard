// Network-first service worker: always tries the network so new deployments show up at once,
// and falls back to the last cached copy when the phone is offline (shell + advisor directory).
// API calls (and therefore every logged-in data request) are never cached.
const CACHE = 'armywormguard-v3';
const SHELL = [
  './', 'index.html', 'login.html', 'farmer.html', 'css/style.css',
  'js/i18n.js', 'js/ui.js', 'js/store.js', 'js/scanner.js', 'js/result.js', 'js/home.js',
  'js/districts.js', 'js/nearby.js', 'js/threads.js', 'js/farmer.js',
  'data/directory.json', 'manifest.webmanifest', 'icons/icon-192.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('index.html') : Response.error())))
  );
});
