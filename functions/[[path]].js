// Catch-all: security boundary, Agreement/Growth short links, static asset first,
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

function withGrowthIntegration(response, pathname) {
  const type = String(response.headers.get('content-type') || '').toLowerCase();
  if (!type.includes('text/html')) return response;
  const eligible = pathname === '/'
    || /\/(?:index|unplug-magazine|unplug-member-dashboard|unplug-admin-dashboard)\.html$/i.test(pathname);
  if (!eligible) return response;
  return new HTMLRewriter()
    .on('body', {
      element(element) {
        element.append('<script src="/growth-integration.js" defer></script>', { html: true });
      },
    })
    .transform(response);
}

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

  // Agreement Forms owns stable short codes. Resolve server-side so /a/CODE
  // behaves like a normal share link rather than displaying JSON.
  const agreementShort = /^\/a\/([A-Za-z0-9_-]{4,96})\/?$/.exec(url.pathname);
  if (request.method === 'GET' && agreementShort) {
    try {
      const lookup = await fetch(`${api}/a/${encodeURIComponent(agreementShort[1])}`, {
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

  // Growth Application short codes are persistent. The backend remains the
  // authority on whether a historical code exists; Cloudflare only turns a
  // valid code into a same-origin member-facing application URL.
  const growthShort = /^\/grow\/([A-Za-z0-9-]{4,40})\/?$/.exec(url.pathname);
  if (request.method === 'GET' && growthShort) {
    try {
      const code = growthShort[1].toUpperCase();
      const lookup = await fetch(`${api}/growth-application/entry-access?code=${encodeURIComponent(code)}`, {
        headers: { Accept: 'application/json' },
      });
      if (lookup.ok) {
        const data = await lookup.json();
        if (data && data.allowed) {
          const target = new URL('/unplug-growth-application.html', url.origin);
          target.searchParams.set('code', code);
          return Response.redirect(target.toString(), 302);
        }
      }
      return new Response(
        '<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><title>Growth link not found</title>'
        + '<p style="font:16px system-ui;padding:2rem">That Growth Application link is not valid. <a href="/">Go to Unplug Magazine</a>.</p>',
        { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
      );
    } catch (_) {
      return new Response(
        '<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><title>Growth link unavailable</title>'
        + '<p style="font:16px system-ui;padding:2rem">The Growth Application link cannot be checked right now. Please try again shortly.</p>',
        { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
      );
    }
  }

  const response = await next();
  if (response.status !== 404) {
    return request.method === 'GET' ? withGrowthIntegration(response, url.pathname) : response;
  }
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
