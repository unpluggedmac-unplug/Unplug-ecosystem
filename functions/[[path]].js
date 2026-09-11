// Catch-all: security boundary, Agreement short links, static asset first,
// then redirect-manager lookup for genuine page misses.
import { apiOrigin } from './_shared.js';

const IGNORED = /\.(?:png|jpe?g|gif|webp|svg|ico|css|js|map|woff2?|ttf|eot|txt|xml|json|pdf|mp4|webm)$/i;
const NOT_THE_SITE = [
  /^\/docs\//i,
  /^\/unplug-backend\//i,
  /^\/functions\//i,
  /^\/node_modules\//i,
  /^\/\.github\//i,
  /^\/\.claude\//i,
  /\.md$/i,
  /^\/package(-lock)?\.json$/i,
  /^\/unplug-components-demo\.html$/i,
];
function isNotTheSite(pathname) { return NOT_THE_SITE.some((rule) => rule.test(pathname)); }

export async function onRequest(context) {
  const { request, next, env, waitUntil } = context;
  const url = new URL(request.url);

  if (isNotTheSite(url.pathname)) {
    return new Response(
      '<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><title>Not found</title>'
      + '<p style="font:16px system-ui;padding:2rem">That page isn\'t here. <a href="/">Go to Unplug Magazine</a>.</p>',
      { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }

  const api = apiOrigin(env);

  // Agreement Forms owns stable 10-character short codes. Resolve server-side
  // so /a/CODE behaves like a normal share link rather than displaying JSON.
  // The API remains authoritative and no open redirect is possible because the
  // only browser destination is our own dedicated Agreement signer page.
  const short = /^\/a\/([A-Za-z0-9_-]{4,96})\/?$/.exec(url.pathname);
  if (request.method === 'GET' && short) {
    try {
      const lookup = await fetch(`${api}/a/${encodeURIComponent(short[1])}`, {
        headers: { Accept: 'application/json' },
      });
      if (lookup.ok) {
        const data = await lookup.json();
        if (data && data.slug) {
          const target = new URL('/unplug-agreement.html', url.origin);
          target.searchParams.set('slug', data.slug);
          return Response.redirect(target.toString(), 302);
        }
      }
    } catch (_) { /* return the site's normal fallback below */ }
  }

  const response = await next();
  if (response.status !== 404) return response;
  if (request.method !== 'GET' || IGNORED.test(url.pathname)) return response;

  const path = url.pathname;
  try {
    const lookup = await fetch(`${api}/redirect?path=${encodeURIComponent(path)}`, {
      headers: { Accept: 'application/json' },
    });
    if (lookup.ok) {
      const data = await lookup.json();
      if (data && data.redirect && data.redirect.to) {
        const to = data.redirect.to;
        const safe = (to.startsWith('/') && !to.startsWith('//')) || /^https:\/\/[^/\s]+/i.test(to);
        if (safe) {
          const target = to.startsWith('/') ? url.origin + to : to;
          return Response.redirect(target, data.redirect.status === 302 ? 302 : 301);
        }
      }
    }
    if (waitUntil) {
      waitUntil(fetch(`${api}/not-found`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, referrer: request.headers.get('referer') || null }),
      }).catch(() => {}));
    }
  } catch (_) { /* backend unavailable: retain original site 404 */ }
  return response;
}
