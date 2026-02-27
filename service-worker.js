const CACHE_NAME = 'roguelike-v1';
const urlsToCache = [
    '/',
    '/index.html',
    '/game.js',
    '/manifest.json',
    'https://cdn.jsdelivr.net/npm/phaser@3.80.1/dist/phaser.min.js'
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(urlsToCache))
    );
});

self.addEventListener('fetch', event => {
    event.respondWith(
        caches.match(event.request)
            .then(response => response || fetch(event.request))
    );
});
