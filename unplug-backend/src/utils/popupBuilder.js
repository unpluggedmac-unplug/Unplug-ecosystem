// WHAT AN ADMIN IS ALLOWED TO PUT IN A POPUP.
//
// A popup is the one thing on this site that appears over the page, unasked,
// in front of every reader. So this file is a whitelist in both directions:
// a block whose type is not listed is dropped, and a field that is not listed
// on that block is dropped with it. Anything that arrives unrecognised is
// discarded rather than stored, because the alternative is a row in the
// database that nobody can account for being rendered to everybody.
//
// The renderer (unplug-popups.js) draws blocks with createElement and
// textContent and never innerHTML, which is what makes rich popups safe to
// offer at all: there is no path from a stored string to markup. This file
// keeps its side of that bargain by never storing anything that would only be
// safe if the renderer escaped it.

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

const MAX_BLOCKS = 20;          // a popup, not a page
const MAX_TEXT = 2000;

// Video and audio are EMBEDS, not uploads. Nothing is stored on our side, so
// a popup with a five-minute video costs the same to serve as one without —
// which is the only reason video in a popup is affordable at all on a free
// tier. Each host below is one that gives a stable, documented embed URL.
//
// youtube-nocookie and Vimeo's dnt=1 are used deliberately: a popup fires
// before a reader has done anything, and loading a tracking frame at that
// moment is not something we can honestly describe as their choice.
const EMBED_HOSTS = {
  'youtube.com': youtube, 'www.youtube.com': youtube, 'm.youtube.com': youtube,
  'youtu.be': youtubeShort,
  'vimeo.com': vimeo, 'player.vimeo.com': vimeoPlayer,
  'soundcloud.com': soundcloud, 'w.soundcloud.com': soundcloud,
  'open.spotify.com': spotify,
};

function youtube(url) {
  const id = url.searchParams.get('v')
    || (url.pathname.startsWith('/embed/') ? url.pathname.slice(7) : '')
    || (url.pathname.startsWith('/shorts/') ? url.pathname.slice(8) : '');
  return /^[A-Za-z0-9_-]{6,20}$/.test(id)
    ? { kind: 'video', src: `https://www.youtube-nocookie.com/embed/${id}` } : null;
}
function youtubeShort(url) {
  const id = url.pathname.slice(1);
  return /^[A-Za-z0-9_-]{6,20}$/.test(id)
    ? { kind: 'video', src: `https://www.youtube-nocookie.com/embed/${id}` } : null;
}
function vimeo(url) {
  const id = (url.pathname.match(/\/(\d{6,12})/) || [])[1];
  return id ? { kind: 'video', src: `https://player.vimeo.com/video/${id}?dnt=1` } : null;
}
function vimeoPlayer(url) {
  const id = (url.pathname.match(/\/video\/(\d{6,12})/) || [])[1];
  return id ? { kind: 'video', src: `https://player.vimeo.com/video/${id}?dnt=1` } : null;
}
function soundcloud(url) {
  // SoundCloud's embed takes the track page URL as a parameter rather than an
  // id, so the whole (already validated) URL is passed through encoded.
  if (!/^\/[\w-]+\/[\w-]+/.test(url.pathname)) return null;
  return { kind: 'audio', src: 'https://w.soundcloud.com/player/?url=' + encodeURIComponent(url.toString()) };
}
function spotify(url) {
  const m = url.pathname.match(/^\/(track|episode|show|album|playlist)\/([A-Za-z0-9]{10,40})/);
  return m ? { kind: m[1] === 'track' || m[1] === 'episode' ? 'audio' : 'audio',
               src: `https://open.spotify.com/embed/${m[1]}/${m[2]}` } : null;
}

// Turn a link an admin pasted into an embed address, or null if it is not a
// host we support. Returning null rather than storing the raw link matters:
// an unrecognised URL in an iframe src is an arbitrary page rendered inside
// our popup.
function toEmbed(raw) {
  let url;
  try { url = new URL(String(raw || '').trim()); } catch (e) { return null; }
  if (url.protocol !== 'https:') return null;
  const build = EMBED_HOSTS[url.hostname.toLowerCase()];
  return build ? build(url) : null;
}

// An image or a link address. https or a path on this site — never a
// javascript:, data: or protocol-relative //host address.
function safeUrl(raw) {
  const v = String(raw == null ? '' : raw).trim();
  if (!v || v.length > 2000) return null;
  if (/^https:\/\/[^/\s]+/i.test(v)) return v;
  if (/^\/[^/\s]/.test(v) || /^[?#][^\s]/.test(v)) return v;   // /nominate, ?p=news
  if (/^mailto:[^\s@]+@[^\s@]+$/i.test(v)) return v;
  return null;
}

function text(raw, max) {
  const v = String(raw == null ? '' : raw).trim();
  return v ? v.slice(0, max || MAX_TEXT) : '';
}

// Each builder returns the stored shape of one block, or null to drop it.
// A block that would render as nothing — a heading with no words, an image
// with no address — is dropped rather than stored, so an admin never ends up
// with an invisible gap they cannot see to delete.
const BLOCKS = {
  heading: (b) => {
    const t = text(b.text, 200);
    return t ? { type: 'heading', text: t } : null;
  },
  text: (b) => {
    const t = text(b.text, MAX_TEXT);
    return t ? { type: 'text', text: t } : null;
  },
  image: (b) => {
    const url = safeUrl(b.url);
    // alt is what a screen reader says. Empty is a legitimate answer — it
    // means decorative — so it is stored as given rather than invented.
    return url ? { type: 'image', url, alt: text(b.alt, 300) } : null;
  },
  button: (b) => {
    const url = safeUrl(b.url);
    const label = text(b.label, 80);
    // A button with no words is a mystery, and one with no destination does
    // nothing. Both halves are required.
    return url && label ? { type: 'button', url, label } : null;
  },
  video: (b) => {
    const e = toEmbed(b.url);
    return e && e.kind === 'video'
      ? { type: 'video', src: e.src, title: text(b.title, 160) } : null;
  },
  audio: (b) => {
    const e = toEmbed(b.url);
    return e ? { type: 'audio', src: e.src, title: text(b.title, 160) } : null;
  },
  // A short written version of what is said in the video or audio above it.
  //
  // This is not decoration. A popup that speaks and does nothing else is one
  // that excludes every Deaf reader on a magazine that exists partly for
  // them, and it excludes anybody whose sound is off, which is most people
  // most of the time. The admin screen asks for it whenever a media block is
  // added.
  transcript: (b) => {
    const t = text(b.text, MAX_TEXT);
    return t ? { type: 'transcript', text: t } : null;
  },
  divider: () => ({ type: 'divider' }),
  spacer: (b) => ({ type: 'spacer', size: ['small', 'medium', 'large'].includes(b.size) ? b.size : 'medium' }),
  // The newsletter sign-up, as a block. It was previously the whole of what a
  // 'newsletter' popup was; as a block it can sit under an image and a
  // paragraph like anything else. It still posts through the same consent-
  // recording path — the popup does not get its own way of subscribing people.
  email: (b) => ({ type: 'email', label: text(b.label, 80) || 'Subscribe' }),
};

function cleanBlocks(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const b of raw) {
    if (!b || typeof b !== 'object') continue;
    const build = BLOCKS[b.type];
    if (!build) continue;                       // unknown type: dropped, not stored
    const block = build(b);
    if (block) out.push(block);
    if (out.length >= MAX_BLOCKS) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// How it looks
// ---------------------------------------------------------------------------

// THE SITE'S OWN FONTS, not an arbitrary list. Every one of these is already
// loaded by the magazine, so choosing one costs a reader nothing extra and a
// popup cannot end up in a typeface that belongs to nothing else on the page.
// It also keeps the popup off any third-party font host, which a popup — the
// first thing a reader meets — is the worst possible place to introduce.
const FONTS = ['body', 'display', 'accent'];
const WIDTHS = ['small', 'medium', 'large'];
const POSITIONS = ['center', 'top', 'bottom', 'top-left', 'top-right', 'bottom-left', 'bottom-right'];
const ANIMATIONS = ['none', 'fade', 'fade-up', 'slide-up', 'slide-down', 'slide-left', 'slide-right', 'zoom'];
const TRIGGERS = ['scroll', 'delay', 'exit'];

const HEX = /^#[0-9a-fA-F]{6}$/;
function colour(raw) {
  const v = String(raw == null ? '' : raw).trim();
  return HEX.test(v) ? v.toLowerCase() : null;
}

function cleanStyle(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  if (FONTS.includes(s.font)) out.font = s.font;
  if (WIDTHS.includes(s.width)) out.width = s.width;
  ['background', 'titleColor', 'textColor', 'buttonBg', 'buttonText'].forEach((k) => {
    const c = colour(s[k]);
    if (c) out[k] = c;
  });
  // Anything not set falls through to the site's tokens in the renderer, so a
  // half-filled style object is a valid one.
  return out;
}

function cleanMedia(raw) {
  const m = raw && typeof raw === 'object' ? raw : {};
  // AUTOPLAY IS ALWAYS MUTED, and not because of a preference. Browsers block
  // autoplaying sound outright, so an unmuted autoplay does not play at all —
  // storing it would be storing a setting that silently does nothing. Sound
  // starts when the reader presses play.
  return {
    autoplay: !!m.autoplay,
    loop: !!m.loop,
    controls: m.controls === undefined ? true : !!m.controls,
  };
}

// ---------------------------------------------------------------------------
// Readability
// ---------------------------------------------------------------------------
//
// Contrast is checked where the colours are chosen, so an admin is told before
// it goes live rather than after somebody cannot read it. This is the same
// arithmetic as WCAG 2.1: relative luminance, then (L1+.05)/(L2+.05).
//
// 4.5 is the AA threshold for normal text. It is reported, not enforced —
// refusing to save a colour would be a strange thing to do to somebody who
// can see their own screen — but it is reported plainly.

function luminance(hex) {
  const c = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function contrastRatio(a, b) {
  if (!HEX.test(a || '') || !HEX.test(b || '')) return null;
  const l1 = luminance(a);
  const l2 = luminance(b);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

// Every foreground/background pair a popup actually renders, with a verdict.
function contrastWarnings(style) {
  const s = style || {};
  const bg = s.background || '#fffdf8';          // the cream the popup uses by default
  const pairs = [
    ['Heading', s.titleColor || '#0f0e0e', bg],
    ['Body text', s.textColor || '#454545', bg],
    ['Button', s.buttonText || '#ffffff', s.buttonBg || '#d20709'],
  ];
  return pairs.map(([what, fg, back]) => {
    const ratio = contrastRatio(fg, back);
    return {
      what,
      ratio,
      passes: ratio === null ? null : ratio >= 4.5,
      message: ratio === null ? null
        : ratio >= 4.5
          ? `${what}: ${ratio}:1 — readable.`
          : `${what}: ${ratio}:1 — below the 4.5:1 needed to be readable. Some people will not be able to read this.`,
    };
  }).filter((r) => r.ratio !== null);
}

// ---------------------------------------------------------------------------
// Starting points
// ---------------------------------------------------------------------------
//
// A blank popup is a blank page, and the hardest part of a blank page is the
// first line. Each of these drops in the pieces that kind of popup nearly
// always needs, ready to fill in.
//
// THEY ARE STARTING POINTS, NOT TYPES. Every block can be changed, reordered or
// deleted straight after, and nothing anywhere keys off which one was chosen —
// the popup is whatever it ends up being. That is deliberate: a starter that
// quietly constrained what the popup could become would be the old fixed
// `kind` field again, with friendlier wording.
//
// Empty text is on purpose. A starter that arrived with wording already in it
// would end up live with the placeholder still on it — which is the failure
// this saves nobody from.
const STARTERS = [
  { key: 'newsletter', label: 'Newsletter sign-up', blocks: [
    { type: 'heading', text: '' },
    { type: 'text', text: '' },
    { type: 'email', label: 'Subscribe' },
  ] },
  { key: 'announcement', label: 'Announcement', blocks: [
    { type: 'heading', text: '' },
    { type: 'text', text: '' },
    { type: 'button', label: '', url: '' },
  ] },
  { key: 'competition', label: 'Competition', blocks: [
    { type: 'heading', text: '' },
    { type: 'image', url: '', alt: '' },
    { type: 'text', text: '' },
    { type: 'button', label: '', url: '' },
  ] },
  { key: 'event', label: 'Event', blocks: [
    { type: 'heading', text: '' },
    { type: 'image', url: '', alt: '' },
    { type: 'text', text: '' },
    { type: 'button', label: '', url: '' },
  ] },
  { key: 'advert', label: 'Advertisement', blocks: [
    { type: 'image', url: '', alt: '' },
    { type: 'heading', text: '' },
    { type: 'button', label: '', url: '' },
  ] },
  { key: 'video', label: 'Video message', blocks: [
    { type: 'heading', text: '' },
    { type: 'video', url: '', title: '' },
    // The written version comes WITH it, not as something to remember. A popup
    // that only speaks excludes every Deaf reader, on a magazine that exists
    // partly for them.
    { type: 'transcript', text: '' },
  ] },
  { key: 'nominate', label: 'Nominate prompt', blocks: [
    { type: 'heading', text: '' },
    { type: 'text', text: '' },
    { type: 'button', label: 'Nominate someone', url: '/nominate' },
  ] },
  { key: 'notice', label: 'Notice', blocks: [
    { type: 'heading', text: '' },
    { type: 'text', text: '' },
  ] },
];

// What an admin typed into "what it is for". Free text, because a fixed list
// cannot anticipate what a community magazine needs to announce.
function cleanPurpose(raw) {
  const v = String(raw == null ? '' : raw).trim().replace(/\s+/g, ' ');
  return v ? v.slice(0, 80) : null;
}

function pick(list, value, fallback) {
  return list.includes(value) ? value : fallback;
}

module.exports = {
  cleanBlocks, cleanStyle, cleanMedia, cleanPurpose,
  STARTERS,
  contrastRatio, contrastWarnings,
  toEmbed, safeUrl,
  BLOCK_TYPES: Object.keys(BLOCKS),
  FONTS, WIDTHS, POSITIONS, ANIMATIONS, TRIGGERS, MAX_BLOCKS,
  pick,
};
