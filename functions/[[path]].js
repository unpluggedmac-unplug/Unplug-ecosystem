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

  const cleanPath = pathname === '/' ? '/' : pathname.replace(/\/+$/, '');
  const isAdminDashboard = /^\/unplug-admin-dashboard(?:\.html)?$/i.test(cleanPath);
  const eligible = cleanPath === '/'
    || /^\/(?:index|unplug-magazine|unplug-member-dashboard|unplug-admin-dashboard|unplug-growth-application)(?:\.html)?$/i.test(cleanPath);
  if (!eligible) return response;

  const rewriter = new HTMLRewriter()
    .on('a', {
      element(element) {
        if (!isAdminDashboard) return;
        const href = String(element.getAttribute('href') || '');
        if (/^\/unplug-growth-applications-admin(?:\.html)?(?:[?#].*)?$/i.test(href)) {
          element.remove();
          return;
        }
        if (/^\/unplug-growth-applications-admin-v2(?:\.html)?(?:[?#].*)?$/i.test(href)) {
          element.setAttribute('href', '/unplug-growth-applications-admin-v2');
          element.setAttribute('data-unplug-growth-admin-link', 'true');
          element.setInnerContent('Growth Applications');
        }
      },
    })
    .on('body', {
      element(element) {
        element.append('<script src="/growth-integration.js" defer></script>', { html: true });
      },
    });

  return rewriter.transform(response);
}

// --- Per-article social previews (edge meta injection) ---------------------
// Social crawlers (WhatsApp, Facebook, X, LinkedIn, Slack, …) read a link
// card's meta from the served HTML and never run the page's JavaScript, so the
// client-side per-article meta updates in unplug-magazine.html never reach
// them — a shared story would otherwise preview with the generic site card.
// For a crawler requesting a deep-linked article, rewrite the card's
// title / description / image at the edge from the same public /articles/:id
// the reader uses, falling back to the untouched site-level meta on any miss.
// Real visitors are not matched (their own JS sets the meta), so a normal page
// view gains no latency.
const SOCIAL_CRAWLER = /facebookexternalhit|Facebot|Twitterbot|WhatsApp|LinkedInBot|Slackbot|TelegramBot|Discordbot|Pinterest|redditbot|Googlebot|Google-InspectionTool|bingbot|Applebot|SkypeUriPreview|vkShare|Embedly|Iframely/i;
const META_PAGES = /^\/(?:index|unplug-magazine)?(?:\.html)?$/i;

function absoluteImage(u) {
  const s = String(u || '');
  if (!s) return '';
  return /^https?:\/\//i.test(s) ? s : 'https://www.unplugnews.com' + (s.startsWith('/') ? '' : '/') + s;
}
function firstText(html, max) {
  return String(html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
async function articleMeta(api, id) {
  const res = await fetch(`${api}/articles/${encodeURIComponent(id)}`, {
    headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) return null;
  const a = await res.json();
  if (!a || (!a.title && !a.seo_title)) return null;
  return {
    title: a.seo_title || a.title,
    description: (a.meta_description && String(a.meta_description).trim()) || firstText(a.body, 200),
    image: absoluteImage(a.banner_image_url) || 'https://www.unplugnews.com/social-banner.jpg',
  };
}
async function withSocialMeta(response, request, url, api) {
  if (!SOCIAL_CRAWLER.test(request.headers.get('user-agent') || '')) return response;
  if (!META_PAGES.test(url.pathname)) return response;
  const type = String(response.headers.get('content-type') || '').toLowerCase();
  if (!type.includes('text/html')) return response;

  let meta = null;
  try {
    if (url.searchParams.get('p') === 'article' && url.searchParams.get('id')) {
      meta = await articleMeta(api, url.searchParams.get('id'));
    }
  } catch (_) { meta = null; }
  if (!meta) return response;

  const fullTitle = /unplug\s*magazine\s*$/i.test(meta.title) ? meta.title : meta.title + ' — Unplug Magazine';
  const pageUrl = 'https://www.unplugnews.com' + url.pathname + (url.search || '');
  const setC = (val) => ({ element(el) { el.setAttribute('content', val); } });

  return new HTMLRewriter()
    .on('title', { element(el) { el.setInnerContent(fullTitle); } })
    .on('link[rel="canonical"]', { element(el) { el.setAttribute('href', pageUrl); } })
    .on('meta[name="description"]', setC(meta.description))
    .on('meta[property="og:title"]', setC(meta.title))
    .on('meta[property="og:description"]', setC(meta.description))
    .on('meta[property="og:image"]', setC(meta.image))
    .on('meta[property="og:url"]', setC(pageUrl))
    .on('meta[name="twitter:title"]', setC(meta.title))
    .on('meta[name="twitter:description"]', setC(meta.description))
    .on('meta[name="twitter:image"]', setC(meta.image))
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
    if (request.method !== 'GET') return response;
    const withMeta = await withSocialMeta(response, request, url, api);
    return withGrowthIntegration(withMeta, url.pathname);
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
