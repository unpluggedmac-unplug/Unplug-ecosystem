// The free-account gate.
//
// An article marked `requires_account` gives a signed-out reader a preview and
// nothing else. Signing in is free and unlocks it.
//
// THE ONE RULE THAT MATTERS: the truncation happens HERE, on the server,
// before the text is sent. A gate enforced in the browser is not a gate — it
// is a CSS overlay with the whole article sitting underneath it in the page
// source, readable by anyone who presses Ctrl+U. Every endpoint that returns
// an article body has to come through this file.

const pool = require('../db');

const DEFAULT_PREVIEW_WORDS = 120;
const MAX_PREVIEW_WORDS = 600;
const CACHE_TTL_MS = 60 * 1000;

let cachedWords = null;
let cachedAt = 0;

// The setting is read server-side only and never leaves the building. Cached
// for a minute because an article list asks for it once per request and the
// answer changes about once a year.
async function previewWords() {
  if (cachedWords !== null && Date.now() - cachedAt < CACHE_TTL_MS) return cachedWords;
  let words = DEFAULT_PREVIEW_WORDS;
  try {
    const r = await pool.query(`SELECT value FROM settings WHERE key = 'gate_preview_words'`);
    const n = Number(r.rows[0] && r.rows[0].value);
    if (Number.isFinite(n) && n > 0) words = Math.min(Math.trunc(n), MAX_PREVIEW_WORDS);
  } catch (err) {
    // A missing setting must not take the article endpoint down with it.
    words = DEFAULT_PREVIEW_WORDS;
  }
  cachedWords = words;
  cachedAt = Date.now();
  return cachedWords;
}

// Only for tests, which change the setting and need the next read to see it.
function resetCache() { cachedWords = null; cachedAt = 0; }

// The preview is PLAIN TEXT, always.
//
// Bodies are HTML by default. Cutting HTML at the 120th word lands in the
// middle of a tag as often as not, and "repair the markup afterwards" is a
// worse bug waiting to happen than simply not emitting markup. Stripping tags
// cannot leak and cannot break the page — and the reader already knows how to
// render a plain-text body, because body_format = 'text' has always been a
// supported value.
function previewOf(body, words) {
  const text = String(body || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  const parts = text.split(' ');
  if (parts.length <= words) return text;
  return parts.slice(0, words).join(' ') + '…';
}

// Mutates and returns the article row. `viewer` is req.user (or undefined).
//
// An admin reads everything — they have to be able to check what a gated piece
// actually says. Any signed-in account passes: the gate asks for an account,
// not for a payment.
function applyGate(article, viewer, words) {
  if (!article || !article.requires_account || viewer) {
    if (article) article.gated = false;
    return article;
  }
  article.body = previewOf(article.body, words);
  article.body_format = 'text';
  article.gated = true;

  // Everything else that carries the substance of the piece. Leaving any of
  // these behind would make the gate decorative.
  article.conclusion = null;
  article.key_takeaways = null;
  article.gallery_images = null;
  article.links = null;
  article.video_url = null;
  article.video_embed_url = null;
  article.cta_label = null;
  article.cta_url = null;

  // Deliberately KEPT: title, subtitle, meta_description, banner image,
  // category, byline and published date. Those are what a share card and a
  // search engine need, and withholding them would hide the article from the
  // people most likely to sign up to read it.
  return article;
}

module.exports = { applyGate, previewOf, previewWords, resetCache, DEFAULT_PREVIEW_WORDS };
