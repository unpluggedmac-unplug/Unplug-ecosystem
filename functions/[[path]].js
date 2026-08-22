// Catch-all: static asset first, then a redirect, then log the miss.
//
// ORDER IS THE WHOLE DESIGN. Every request for a page that exists is answered
// by the static asset exactly as before — same speed, no backend involved. The
// backend is asked only when the asset was a genuine 404, which is rare and is
// already an error path, so the cost lands where nobody is being served well
// anyway.
//
// If the backend is asleep or unreachable, the reader still gets the normal
// 404 page. A redirect manager that can take the site down when it fails is
// not worth having.

import { apiOrigin } from './_shared.js';

// Requests that must never reach the backend or be logged as misses. Asset
// 404s are noise — a missing favicon is not a page somebody was looking for.
const IGNORED = /\.(?:png|jpe?g|gif|webp|svg|ico|css|js|map|woff2?|ttf|eot|txt|xml|json|pdf|mp4|webm)$/i;

export async function onRequest(context) {
  const { request, next, env, waitUntil } = context;
  const url = new URL(request.url);

  // Let the static site answer first.
  const response = await next();
  if (response.status !== 404) return response;

  // Only GETs for page-shaped paths are worth a lookup.
  if (request.method !== 'GET' || IGNORED.test(url.pathname)) return response;

  const path = url.pathname;
  const api = apiOrigin(env);

  try {
    const lookup = await fetch(`${api}/redirect?path=${encodeURIComponent(path)}`, {
      headers: { Accept: 'application/json' },
    });

    if (lookup.ok) {
      const data = await lookup.json();
      if (data && data.redirect && data.redirect.to) {
        const to = data.redirect.to;
        // Only a path on this site or an https address is followed. The
        // backend validates this on write; checked again here because this is
        // the point where a value becomes a Location header a browser obeys,
        // and a redirector that trusts its input is an open redirect.
        const safe = (to.startsWith('/') && !to.startsWith('//')) || /^https:\/\/[^/\s]+/i.test(to);
        if (safe) {
          const target = to.startsWith('/') ? url.origin + to : to;
          return Response.redirect(target, data.redirect.status === 302 ? 302 : 301);
        }
      }
    }

    // No rule: record that somebody asked for this. waitUntil so the reader
    // gets their 404 immediately and the logging finishes after.
    if (waitUntil) {
      waitUntil(fetch(`${api}/not-found`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, referrer: request.headers.get('referer') || null }),
      }).catch(() => {}));
    }
  } catch (err) {
    // The backend is asleep or down. Fall through to the 404 the site would
    // have shown anyway.
  }

  return response;
}
