const CACHE_NAME = 'taskmanager-v10';
const STATIC_ASSETS = [
  '/',
  '/css/style.css',
  '/css/responsive.css',
  '/css/role-ui.css',
  '/css/toast.css',
  '/js/app.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon.svg',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.7.2/css/all.min.css',
  'https://cdn.jsdelivr.net/npm/chart.js'
];

// Install Event: Cache essential static shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch((err) => {
        console.warn('PWA SW: Pre-cache warning', err);
      });
    }).then(() => self.skipWaiting())
  );
});

// Activate Event: Cleanup old caches & claim clients
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

// Periodically keep session active in background
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'keep-session-alive') {
    event.waitUntil(
      fetch('/dashboard', { method: 'HEAD' }).catch(() => {})
    );
  }
});

// Fetch Event: Network-only for APIs/JSON, Network-first for HTML, Cache-first for static assets
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Bypass cache completely for API endpoints, AJAX, or JSON requests
  if (
    url.pathname.includes('/api/') ||
    url.pathname.includes('/tasks/api/') ||
    request.headers.get('accept')?.includes('application/json') ||
    request.headers.get('x-requested-with') === 'XMLHttpRequest'
  ) {
    return; // Standard network fetch
  }

  // Network-first strategy for navigation / EJS HTML pages
  if (request.mode === 'navigate' || request.headers.get('accept')?.includes('text/html')) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => {
          return caches.match(request).then((cachedResponse) => {
            if (cachedResponse) return cachedResponse;
            return caches.match('/');
          });
        })
    );
    return;
  }

  // Cache-first strategy for static resources only
  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      if (cachedResponse) {
        fetch(request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            caches.open(CACHE_NAME).then((cache) => cache.put(request, networkResponse));
          }
        }).catch(() => {});
        return cachedResponse;
      }
      return fetch(request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const copy = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return networkResponse;
      });
    })
  );
});
