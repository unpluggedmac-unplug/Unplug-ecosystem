// Turning a raw request into the three things every report needs: where the
// visit came from, what it is being read on, and which country it is in.
//
// Deliberately dependency-free. A user-agent parsing library is a large,
// frequently-updated third-party package sitting on the hottest path in the
// application, and the questions being asked of it here are coarse — phone or
// computer, which browser, which system. That is a lookup table, not a
// library.

// ---------------------------------------------------------------------------
// WHERE THE VISIT CAME FROM
// ---------------------------------------------------------------------------

// Referrer host -> the channel a person would recognise. Ordered specific
// first: l.instagram.com must be read as Instagram, not as "some other site".
//
// Several of these look redundant and are not. Instagram, Facebook and TikTok
// all send outbound clicks through link-wrapper hosts (l.instagram.com,
// l.facebook.com, lm.facebook.com), and a shortener (lnkd.in, fb.me, t.co) is
// what actually appears when someone shares a link. Matching only the obvious
// domain silently files most social traffic under "other websites", which is
// the specific mistake that makes a social strategy look like it is failing.
const REFERRER_CHANNELS = [
  [/(^|\.)l\.instagram\.com$/i, 'Instagram'],
  [/(^|\.)instagram\.com$/i, 'Instagram'],
  [/(^|\.)(l|lm|m|web)\.facebook\.com$/i, 'Facebook'],
  [/(^|\.)facebook\.com$/i, 'Facebook'],
  [/(^|\.)fb\.me$/i, 'Facebook'],
  [/(^|\.)tiktok\.com$/i, 'TikTok'],
  [/(^|\.)linkedin\.com$/i, 'LinkedIn'],
  [/(^|\.)lnkd\.in$/i, 'LinkedIn'],
  [/(^|\.)(twitter|x)\.com$/i, 'X'],
  [/(^|\.)t\.co$/i, 'X'],
  [/(^|\.)youtube\.com$/i, 'YouTube'],
  [/(^|\.)youtu\.be$/i, 'YouTube'],
  [/(^|\.)pinterest\.[a-z.]+$/i, 'Pinterest'],
  [/(^|\.)reddit\.com$/i, 'Reddit'],
  [/(^|\.)(wa\.me|whatsapp\.com)$/i, 'WhatsApp'],
  [/(^|\.)t\.me$/i, 'Telegram'],
  [/(^|\.)google\.[a-z.]+$/i, 'Organic Search'],
  [/(^|\.)bing\.com$/i, 'Organic Search'],
  [/(^|\.)duckduckgo\.com$/i, 'Organic Search'],
  [/(^|\.)yahoo\.com$/i, 'Organic Search'],
  [/(^|\.)ecosia\.org$/i, 'Organic Search'],
];

// utm_medium -> channel, for links we tag ourselves. A campaign link is the
// only thing that can distinguish an email click from a paid click, because
// both can arrive with no referrer at all.
const MEDIUM_CHANNELS = [
  [/^(email|newsletter|e-mail)$/i, 'Email'],
  [/^(cpc|ppc|paid|paidsocial|paid_social|display|banner|ads?)$/i, 'Advertising'],
  [/^(social|social_media)$/i, 'Social'],
  [/^(referral)$/i, 'Referral'],
  [/^(organic)$/i, 'Organic Search'],
];

function hostOf(url) {
  if (!url) return null;
  try {
    return new URL(String(url)).hostname.replace(/^www\./i, '').toLowerCase();
  } catch (e) {
    return null;
  }
}

// A referrer from our own site is not a source — it is the reader moving
// around inside the publication. Treating it as one would make Unplug appear
// as its own biggest traffic source, drowning out every real channel.
function isSelfReferral(host, selfHosts) {
  if (!host) return false;
  return selfHosts.some((h) => host === h || host.endsWith('.' + h));
}

const SELF_HOSTS = ['unplugnews.com', 'unplug-magazine.pages.dev', 'localhost'];

// UTM tags win over the referrer, always. If we tagged the link ourselves we
// know more about it than the browser is telling us — an email click may carry
// no referrer at all, and a paid click looks identical to an organic one.
function classifySource({ referrer, utmSource, utmMedium, utmCampaign }) {
  const host = hostOf(referrer);
  const medium = (utmMedium || '').trim() || null;
  const campaign = (utmCampaign || '').trim() || null;

  if ((utmSource || '').trim()) {
    const explicit = String(utmSource).trim();
    const byMedium = medium && MEDIUM_CHANNELS.find(([re]) => re.test(medium));
    return {
      // A tagged link names its own source; the medium only decides how it is
      // grouped when the source is one we do not recognise.
      source: explicit.charAt(0).toUpperCase() + explicit.slice(1),
      medium: byMedium ? byMedium[1] : medium,
      campaign,
      referrerHost: host,
    };
  }

  if (medium) {
    const byMedium = MEDIUM_CHANNELS.find(([re]) => re.test(medium));
    if (byMedium) return { source: byMedium[1], medium, campaign, referrerHost: host };
  }

  if (isSelfReferral(host, SELF_HOSTS)) {
    return { source: 'Direct', medium: null, campaign, referrerHost: null };
  }

  if (!host) return { source: 'Direct', medium: null, campaign, referrerHost: null };

  const known = REFERRER_CHANNELS.find(([re]) => re.test(host));
  if (known) {
    return {
      source: known[1],
      medium: known[1] === 'Organic Search' ? 'organic' : 'referral',
      campaign,
      referrerHost: host,
    };
  }

  // Another website. The host is kept so the report can name it rather than
  // lumping everything unrecognised into one meaningless bucket.
  return { source: 'Referral', medium: 'referral', campaign, referrerHost: host };
}

// ---------------------------------------------------------------------------
// WHAT IT IS BEING READ ON
// ---------------------------------------------------------------------------

// Order matters throughout: iPad reports itself as Macintosh-like, Edge's
// user-agent contains "Chrome", and Chrome's contains "Safari". Each list is
// most-specific first so the general case cannot swallow the specific one.
function parseUserAgent(ua) {
  const s = String(ua || '');
  if (!s) return { deviceType: null, browser: null, os: null };

  const isTablet = /iPad/i.test(s) || (/Android/i.test(s) && !/Mobile/i.test(s)) || /Tablet/i.test(s);
  const isMobile = !isTablet && /Mobi|iPhone|iPod|Android.*Mobile|Windows Phone|BlackBerry/i.test(s);
  const deviceType = isTablet ? 'tablet' : (isMobile ? 'mobile' : 'desktop');

  const browsers = [
    [/Edg[A-Z]?\//i, 'Edge'],
    [/OPR\/|Opera/i, 'Opera'],
    [/SamsungBrowser/i, 'Samsung Internet'],
    [/UCBrowser/i, 'UC Browser'],
    [/FxiOS|Firefox/i, 'Firefox'],
    [/CriOS/i, 'Chrome'],
    [/Chrome\//i, 'Chrome'],
    [/Safari\//i, 'Safari'],
  ];
  const os = [
    [/Windows NT/i, 'Windows'],
    [/iPhone|iPad|iPod|iOS/i, 'iOS'],
    [/Android/i, 'Android'],
    [/Mac OS X|Macintosh/i, 'macOS'],
    [/CrOS/i, 'ChromeOS'],
    [/Linux/i, 'Linux'],
  ];

  const found = (list) => { const hit = list.find(([re]) => re.test(s)); return hit ? hit[1] : null; };
  return { deviceType, browser: found(browsers), os: found(os) };
}

// ---------------------------------------------------------------------------
// WHICH COUNTRY
// ---------------------------------------------------------------------------

// Resolved from the edge, never from an IP lookup we perform ourselves — the
// address is not stored anywhere. Cloudflare fronts both the site and the API,
// so cf-ipcountry is the one that should arrive; the rest are cheap fallbacks
// in case that changes.
//
// Returns null rather than guessing when no header is present, and the reports
// show that honestly as "Unknown". A country column that quietly defaults to
// ZA would make the audience look local whatever the truth is.
const COUNTRY_HEADERS = [
  'cf-ipcountry', 'x-vercel-ip-country', 'x-country-code', 'x-geo-country', 'x-appengine-country',
];

function countryFrom(req) {
  for (const header of COUNTRY_HEADERS) {
    const value = req.headers[header];
    if (value && /^[A-Za-z]{2}$/.test(String(value))) {
      const code = String(value).toUpperCase();
      // Cloudflare sends XX for anonymising proxies and T1 for Tor.
      if (code === 'XX' || code === 'T1') return null;
      return code;
    }
  }
  return null;
}

// Everything a single request can tell us, in one call.
function contextFrom(req, body = {}) {
  const { source, medium, campaign, referrerHost } = classifySource({
    referrer: body.referrer,
    utmSource: body.utmSource,
    utmMedium: body.utmMedium,
    utmCampaign: body.utmCampaign,
  });
  const { deviceType, browser, os } = parseUserAgent(req.headers['user-agent']);
  return {
    source, medium, campaign, referrerHost,
    deviceType, browser, os,
    country: countryFrom(req),
  };
}

module.exports = {
  classifySource, parseUserAgent, countryFrom, contextFrom, hostOf,
  REFERRER_CHANNELS, COUNTRY_HEADERS, SELF_HOSTS,
};
