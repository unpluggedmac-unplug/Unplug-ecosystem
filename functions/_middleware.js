// Security headers for the whole Cloudflare Pages application.
//
// Why CSP lives here instead of _headers:
// - staging and production use different API origins;
// - a static _headers policy cannot safely express that without allowing every
//   *.onrender.com host;
// - root Pages middleware runs in front of static files too, so every HTML
//   response receives one environment-aware policy.
//
// IMPORTANT: production is built with `npm run build`. The build extracts all
// executable inline <script> blocks into hashed /assets/*.js files. The legacy
// inline onclick/onchange attributes still exist, so script-src-attr must
// temporarily allow unsafe-inline. script-src-elem does NOT allow inline code.

const PRODUCTION_API = 'https://unplug-ecosystem.onrender.com';

function cleanOrigin(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return '';
    return url.origin;
  } catch (_) {
    return '';
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function configuredMediaOrigins(env) {
  const raw = String((env && (env.UNPLUG_MEDIA_ORIGINS || env.UNPLUG_MEDIA_ORIGIN)) || '');
  return raw.split(',').map(cleanOrigin).filter(Boolean);
}

function apiOrigin(env) {
  const environment = String((env && env.UNPLUG_ENV) || 'production').toLowerCase();
  const staging = environment === 'staging' || environment === 'preview';
  const configured = cleanOrigin(env && env.UNPLUG_API);
  if (staging) {
    // Fail closed. A staging frontend with no isolated API must never receive
    // production API permission through CSP.
    return configured && configured !== PRODUCTION_API ? configured : '';
  }
  return configured || PRODUCTION_API;
}

function csp(env, reportOnly = false) {
  const api = apiOrigin(env);
  const media = configuredMediaOrigins(env);

  const scriptHosts = [
    "'self'",
    'https://cdn.jsdelivr.net',
    'https://unpkg.com',
    'https://www.googletagmanager.com',
    'https://www.instagram.com',
    'https://www.youtube.com',
  ];

  const imageHosts = unique([
    "'self'", 'data:', 'blob:',
    'https://*.supabase.co',
    'https://*.r2.dev',
    'https://*.r2.cloudflarestorage.com',
    'https://*.unplugnews.com',
    'https://ui-avatars.com',
    'https://tile.openstreetmap.org',
    'https://*.tile.openstreetmap.org',
    'https://www.googletagmanager.com',
    'https://i.ytimg.com',
    ...media,
  ]);

  const connectHosts = unique([
    "'self'",
    api,
    'https://*.supabase.co',
    'https://www.google-analytics.com',
    'https://*.google-analytics.com',
    'https://region1.google-analytics.com',
    'https://tile.openstreetmap.org',
    'https://*.tile.openstreetmap.org',
  ]);

  const directives = [
    "default-src 'self'",
    `script-src ${scriptHosts.join(' ')}`,
    `script-src-elem ${scriptHosts.join(' ')}`,
    // Legacy markup still contains onclick/onchange handlers. This is the one
    // remaining inline-script exception. Removing those handlers is the next
    // hardening step; inline <script> elements are already blocked.
    `script-src-attr ${reportOnly ? "'none'" : "'unsafe-inline'"}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    `img-src ${imageHosts.join(' ')}`,
    `connect-src ${connectHosts.join(' ')}`,
    "frame-src https://www.youtube.com https://youtube.com https://www.youtube-nocookie.com https://www.instagram.com https://www.tiktok.com https://drive.google.com https://w.soundcloud.com",
    "media-src 'self' blob: https://*.supabase.co https://*.r2.dev https://*.r2.cloudflarestorage.com https://*.unplugnews.com",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];

  // Browsers ignore this directive in Report-Only policies and log a console
  // warning. Keep it in the enforced policy where it has an effect, without
  // polluting the strict-policy diagnostic signal.
  if (!reportOnly) directives.push('upgrade-insecure-requests');
  if (reportOnly && api) directives.push(`report-uri ${api}/security/csp-report`);
  return directives.join('; ');
}

function withSecurityHeaders(response, env) {
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  headers.set('Content-Security-Policy', csp(env, false));
  headers.set('Content-Security-Policy-Report-Only', csp(env, true));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function onRequest(context) {
  const response = await context.next();
  return withSecurityHeaders(response, context.env || {});
}

export const __test = { cleanOrigin, apiOrigin, csp, configuredMediaOrigins };
