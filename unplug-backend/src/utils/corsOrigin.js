'use strict';

// Cloudflare gives every Pages deployment an immutable URL such as
// https://41688b56.unplug-staging.pages.dev. Release certification deliberately
// uses that URL so the frontend being tested cannot change underneath us.
//
// Production remains exact-origin only. The narrow preview allowance is active
// solely when this backend identifies itself as staging/preview, and only for
// the eight-hex-character immutable deployment host used by the unplug-staging
// Pages project.
function isImmutableStagingPreview(origin) {
  try {
    const url = new URL(String(origin || ''));
    return url.protocol === 'https:'
      && url.port === ''
      && /^[a-f0-9]{8}\.unplug-staging\.pages\.dev$/i.test(url.hostname)
      && url.pathname === '/'
      && url.search === ''
      && url.hash === '';
  } catch (_) {
    return false;
  }
}

function buildCorsOrigin(rawOrigins, options = {}) {
  const allowed = String(rawOrigins || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (!allowed.length) return options.nodeEnv === 'production' ? false : true;

  const exact = new Set(allowed);
  const staging = ['staging', 'preview'].includes(String(options.unplugEnv || '').toLowerCase());

  return function checkOrigin(origin, callback) {
    const permitted = !origin || exact.has(origin) || (staging && isImmutableStagingPreview(origin));
    callback(null, permitted);
  };
}

module.exports = { buildCorsOrigin, isImmutableStagingPreview };
