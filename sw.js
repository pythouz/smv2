const CACHE_NAME = 'pulse-pwa-v4';

const urlsToCache = [
    './',
    './index.html',
    './app.js',
    './manifest.json'
];

self.addEventListener('install', event => {
    console.log('[SW] تثبيت النسخة الجديدة');
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(urlsToCache))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', event => {
    console.log('[SW] تفعيل النسخة الجديدة');
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames
                    .filter(name => name !== CACHE_NAME)
                    .map(name => caches.delete(name))
            );
        }).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);

    // Network-first للملفات الأساسية عشان التحديثات توصل فورًا
    if (
        url.pathname.endsWith('/app.js') ||
        url.pathname.endsWith('/index.html') ||
        url.pathname === '/' ||
        url.pathname.endsWith('/sw.js')
    ) {
        event.respondWith(
            fetch(event.request, { cache: 'no-store' })
                .then(response => {
                    if (response && response.ok) {
                        const copy = response.clone();
                        caches.open(CACHE_NAME).then(cache => {
                            cache.put(event.request, copy);
                        });
                    }
                    return response;
                })
                .catch(() => caches.match(event.request))
        );
        return;
    }

    // باقي الطلبات: Network ثم Cache
    event.respondWith(
        fetch(event.request).catch(() => caches.match(event.request))
    );
});
