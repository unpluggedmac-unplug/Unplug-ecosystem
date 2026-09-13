// WHAT SHAPE AN AD SLOT RENDERS AT, AND WHO DECIDES IT.
//
// AD_SLOT_SIZES in imageSpecs.js is the standard format each slot sells —
// 728 x 90 for a leaderboard, 300 x 250 for a sponsor block. Those are the
// sizes the public placeholder advertises ("Advertisement — 728x90
// Leaderboard"), the sizes the buy form recommends, and now the sizes the
// filled slot actually renders at. Before, every filled slot was one
// `aspect-ratio:16/9` box, so a sold leaderboard came out as a thin strip
// floating in a tall empty box: the empty slot promised one shape and the
// filled slot drew another.
//
// This file adds the admin's say over that. A slot's format is no longer fixed
// in source: an admin can set a different size for any slot, and everything
// that states a size follows in step — the public render, the upload hint in
// both dashboards, and the buy form's placement dropdown all resolve through
// here, so there is still exactly ONE answer per slot at any moment. That is
// the point of routing it through one resolver rather than letting each caller
// read the setting: ad sizes are the value that has drifted most often in this
// codebase (three different answers across two files, none of them a real slot
// size), and the fix for that is not a better number, it is one place to ask.
//
// Stored as JSON in settings.ad_slot_formats, holding ONLY the slots an admin
// has actually changed. Everything else falls through to AD_SLOT_SIZES, so the
// defaults stay readable in source and an override is visibly an override.

const { AD_SLOT_SIZES, IMAGE_SPECS } = require('./imageSpecs');

const SETTING_KEY = 'ad_slot_formats';

// Generous but finite. A banner is a picture on a page, not a poster: these
// bounds exist so a typo (7280 x 9) cannot produce a slot thousands of pixels
// tall, which on a phone is an unscrollable wall.
const MIN_PX = 20;
const MAX_PX = 4000;

const isPx = (n) => Number.isInteger(n) && n >= MIN_PX && n <= MAX_PX;

// Every slot that exists on the public page. An override for anything else is
// meaningless — nothing would read it — so it is rejected rather than stored.
function knownSlotKeys() {
  return Object.keys(AD_SLOT_SIZES);
}

// Parse whatever is in the settings row into a clean object. Anything
// malformed is DROPPED rather than thrown on: this is read on every public
// page load, and a bad row must not take the magazine down. Validation that
// rejects belongs on the way in (validateFormats), not here.
function parseFormats(raw) {
  if (!raw) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out = {};
  knownSlotKeys().forEach((k) => {
    const v = parsed[k];
    if (!v || typeof v !== 'object') return;
    const entry = {};
    if (isPx(v.w) && isPx(v.h)) { entry.w = v.w; entry.h = v.h; }
    if (isPx(v.mobileW) && isPx(v.mobileH)) { entry.mobileW = v.mobileW; entry.mobileH = v.mobileH; }
    if (typeof v.fit === 'boolean') entry.fit = v.fit;
    if (Object.keys(entry).length) out[k] = entry;
  });
  return out;
}

// The answer for every slot, defaults merged with the admin's overrides.
//
// `fit` is whether the slot may be drawn WIDER than the format it sells.
// Default true — a 300 x 250 stretched across a 1240px column is a 1033px-tall
// slab of upscaled artwork, which is the right ratio at an absurd scale and
// no more honest than the 16:9 box it replaced. An admin who wants a banner to
// span the column edge-to-edge turns it off for that slot.
function resolveAdSlotSizes(raw) {
  const overrides = parseFormats(raw);
  const mobile = IMAGE_SPECS.ad_banner_mobile;
  const out = {};
  Object.entries(AD_SLOT_SIZES).forEach(([k, base]) => {
    const o = overrides[k] || {};
    const w = o.w || base.w;
    const h = o.h || base.h;
    out[k] = {
      w,
      h,
      // The label describes the DEFAULT format ("Leaderboard"). Once an admin
      // sets their own numbers it would be a lie, so it is dropped rather than
      // carried over onto a size it no longer describes.
      label: (o.w && (o.w !== base.w || o.h !== base.h)) ? null : base.label,
      mobileW: o.mobileW || mobile.w,
      mobileH: o.mobileH || mobile.h,
      fit: o.fit === undefined ? true : o.fit,
      customised: Boolean(o.w || o.mobileW || o.fit !== undefined),
    };
  });
  return out;
}

// A readable sentence, worded the same everywhere a size is shown.
function describeSlot(s) {
  if (!s) return null;
  return `${s.w} × ${s.h}px` + (s.label ? ` (${s.label})` : '');
}

// Validation for the way IN. Unlike parseFormats this REFUSES bad input with a
// reason, because an admin who mistypes a size should be told, not silently
// ignored and left wondering why the page did not change.
//
// Returns { error } or { value } — `value` being the JSON string to store.
function validateFormats(input) {
  let obj = input;
  if (typeof input === 'string') {
    try { obj = JSON.parse(input); } catch (_) { return { error: 'Ad slot formats must be valid JSON.' }; }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { error: 'Ad slot formats must be an object keyed by slot.' };
  }
  const known = knownSlotKeys();
  const clean = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!known.includes(k)) {
      return { error: `"${k}" is not a slot on the site. Known slots: ${known.join(', ')}` };
    }
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      return { error: `${k}: each slot must be an object.` };
    }
    const entry = {};
    const hasW = v.w !== undefined && v.w !== null && v.w !== '';
    const hasH = v.h !== undefined && v.h !== null && v.h !== '';
    if (hasW !== hasH) return { error: `${k}: give both a width and a height, or neither.` };
    if (hasW) {
      const w = Number(v.w);
      const h = Number(v.h);
      if (!isPx(w) || !isPx(h)) {
        return { error: `${k}: width and height must be whole numbers between ${MIN_PX} and ${MAX_PX}.` };
      }
      entry.w = w; entry.h = h;
    }
    const hasMW = v.mobileW !== undefined && v.mobileW !== null && v.mobileW !== '';
    const hasMH = v.mobileH !== undefined && v.mobileH !== null && v.mobileH !== '';
    if (hasMW !== hasMH) return { error: `${k}: give both a mobile width and height, or neither.` };
    if (hasMW) {
      const mw = Number(v.mobileW);
      const mh = Number(v.mobileH);
      if (!isPx(mw) || !isPx(mh)) {
        return { error: `${k}: mobile width and height must be whole numbers between ${MIN_PX} and ${MAX_PX}.` };
      }
      entry.mobileW = mw; entry.mobileH = mh;
    }
    if (v.fit !== undefined) {
      if (typeof v.fit !== 'boolean') return { error: `${k}: "fit" must be true or false.` };
      entry.fit = v.fit;
    }
    // A slot with nothing set is not an error, it is a slot back on its
    // default — so it is simply not stored.
    if (Object.keys(entry).length) clean[k] = entry;
  }
  return { value: JSON.stringify(clean) };
}

// One query, so callers don't each write their own.
//
// NEVER THROWS. All three callers are read-only and every one of them has a
// correct answer without the database: the standard formats in AD_SLOT_SIZES,
// which is what every slot used before an admin could override anything. A
// failed lookup here must degrade to those rather than take down the endpoint —
// this feeds the public magazine's CMS payload, the upload hint on both
// dashboards, and the buy form, and none of them is worth a 500 because one
// settings row could not be read. The dashboards already take this line with
// the specs themselves ("guidance going missing must never stop somebody
// submitting"), and the backend sleeps on Render's free tier, so a query
// failing now and then is ordinary rather than exceptional.
async function loadAdSlotSizes(pool) {
  try {
    const r = await pool.query(`SELECT value FROM settings WHERE key = $1`, [SETTING_KEY]);
    return resolveAdSlotSizes(r.rows[0] && r.rows[0].value);
  } catch (_) {
    return resolveAdSlotSizes(null);
  }
}

module.exports = {
  SETTING_KEY, MIN_PX, MAX_PX,
  knownSlotKeys, parseFormats, resolveAdSlotSizes, describeSlot, validateFormats, loadAdSlotSizes,
};
