// Unplug Magazine — service worker.
//
// This exists for two reasons: it is what makes the site INSTALLABLE (Android
// and Chrome/Edge both require a fetch handler before offering "Add to home
// screen"), and it lets the app open something useful when the phone has no
// signal.
//
// NETWORK FIRST, ALWAYS. Every request goes to the network first and the cache
// is only ever a fallback for when that fails. On a news site the opposite —
// serving the cached copy first for speed — means a reader can open the app
// and see yesterday's homepage, or a story that has since been corrected. A
// stale page on a live publication becomes a reader complaint, and it is the
// kind of bug that is invisible to whoever shipped it because their own cache
// is warm.
//
// The cost is that opening the app is exactly as fast as the site is. That is
// the right trade here.

const VERSION = 'unplug-v1';
const OFFLINE_URL = '/offline.html';

// The bare minimum needed to show something rather than a browser error page.
const PRECACHE = [OFFLINE_URL];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => cache.addAll(PRECACHE))
      // Take over immediately rather than waiting for every tab to close.
      // Without this a fix can sit unused for days on a phone that is never
      // fully closed.
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// Requests this worker must NEVER touch.
function shouldIgnore(request) {
  const url = new URL(request.url);

  // Only GET. A cached POST is meaningless, and replaying one would be worse.
  if (request.method !== 'GET') return true;

  // Only our own origin. The API lives on another host and must always be
  // live — a cached payment, vote or approval would be actively dangerous.
  if (url.origin !== self.location.origin) return true;

  // The admin and member dashboards are never cached. A stale admin screen
  // showing an approval queue that has already been dealt with is a genuinely
  // bad outcome, and neither screen is any use offline.
  if (url.pathname.includes('admin-dashboard') || url.pathname.includes('member-dashboard')) return true;

  return false;
}

self.addEventListener('fetch', (event) => {
  if (shouldIgnore(event.request)) return; // let the browser handle it normally

  event.respondWith((async () => {
    try {
      const fresh = await fetch(event.request);

      // Keep a copy for the next time there is no signal. Only successful,
      // ordinary responses — caching a 404 or a redirect would mean serving
      // it back later as though it were the page.
      if (fresh && fresh.status === 200 && fresh.type === 'basic') {
        const cache = await caches.open(VERSION);
        cache.put(event.request, fresh.clone());
      }
      return fresh;
    } catch (err) {
      // Offline, or the network failed.
      const cached = await caches.match(event.request);
      if (cached) return cached;

      // A page request with nothing cached: show the offline page rather than
      // the browser's dinosaur, so it still looks like Unplug.
      if (event.request.mode === 'navigate') {
        const offline = await caches.match(OFFLINE_URL);
        if (offline) return offline;
      }
      throw err;
    }
  })());
});
