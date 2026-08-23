// Responsive image derivatives — the resizing and re-encoding, and nothing else.
//
// WHY THIS EXISTS. One photograph on the homepage was a 1,911 KB PNG, which was
// 64% of the entire mobile page weight. At the size it is actually displayed,
// in AVIF, the same picture is 49 KB. Nobody uploaded that file carelessly —
// it is simply what a camera and a "save as PNG" produce, and there was nothing
// in the way to fix it.
//
// WHY AT UPLOAD, NOT ON REQUEST. Supabase's image transformation endpoint
// returns 403 on this project's plan (tested), so there is no resize-on-the-fly
// to lean on, and a paid CDN is out. Derivatives are therefore made once, when
// the file arrives, and stored as ordinary objects next to the original.
//
// WHAT IT COSTS. Measured on the 1,911 KB PNG above, the full ladder is about
// two seconds of CPU. Render's free instance is slower, so budget four to six.
// That is paid once per upload, by an admin who is already waiting for a file
// to travel — not by a reader. Encoding runs one image at a time on purpose:
// the instance has 512 MB, and four parallel AVIF encodes is how you find out.
//
// THE ORIGINAL IS NEVER REPLACED. Every derivative is an addition. If anything
// here fails, the caller still has the file the person uploaded, and the site
// carries on serving exactly what it served before.

const sharp = require('sharp');

// The widths the site actually displays images at: a phone card, a phone
// full-bleed, a desktop card, and a desktop banner. Anything wider than the
// source is skipped rather than upscaled — enlarging a photo adds bytes and
// removes nothing.
const WIDTHS = [400, 800, 1200, 1600];

// AVIF first, WebP second, and the original as the last resort. AVIF is roughly
// 40% smaller again than WebP here (49 KB vs 82 KB at 1600px) but costs about
// six times the CPU, which is why both are made: every browser gets the best
// format it understands without anyone being served a fallback that is bigger
// than it needs to be.
const FORMATS = [
  { ext: 'avif', mime: 'image/avif', options: { quality: 50, effort: 4 } },
  { ext: 'webp', mime: 'image/webp', options: { quality: 78 } },
];

// A decompression bomb is a small file that claims enormous dimensions; sharp
// would dutifully allocate for it. 50 megapixels is far beyond any photograph
// this magazine publishes and far below what would exhaust the instance.
const MAX_INPUT_PIXELS = 50 * 1000 * 1000;

// Formats worth processing. GIF is deliberately absent: an animated one would
// need frame-by-frame handling, and a still one is rare enough that keeping the
// original is the honest trade.
const PROCESSABLE = ['jpeg', 'jpg', 'png', 'webp'];

function derivativeKey(originalKey, width, ext) {
  // Deterministic, so a URL can be turned into its derivatives by convention
  // with no lookup: "1785-abc.png" -> "derivatives/1785-abc-800.avif".
  const stem = String(originalKey).replace(/\.[^./]+$/, '');
  return `derivatives/${stem}-${width}.${ext}`;
}

// Reads what the file actually is, rather than what it was labelled.
//
// The declared MIME type on an upload comes from the browser and can say
// anything at all. sharp reads the container itself, so this doubles as the
// magic-byte check the upload path never had: a .png that is really something
// else fails here instead of being stored and served as an image.
async function inspect(buffer) {
  const meta = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  return {
    format: meta.format,
    width: meta.width,
    height: meta.height,
    // pages > 1 means animation. Resizing one frame of an animated image and
    // serving it as the whole picture would silently break the animation.
    animated: Number(meta.pages || 1) > 1,
  };
}

// Can this file usefully be given derivatives? Returns a reason when not, so
// the caller can record WHY an image was left alone instead of it looking like
// a failure nobody noticed.
function assessible(meta) {
  if (!meta.format || PROCESSABLE.indexOf(meta.format) === -1) {
    return { ok: false, reason: `format ${meta.format || 'unknown'} is not processed` };
  }
  if (meta.animated) return { ok: false, reason: 'animated image kept whole' };
  if (!meta.width || !meta.height) return { ok: false, reason: 'no readable dimensions' };
  return { ok: true };
}

// Builds every derivative for one image.
//
// Returns { meta, derivatives: [{ key, width, ext, mime, buffer, bytes }] }.
// An empty derivative list is a valid, non-exceptional answer: it means this
// file is better served as it is.
async function buildDerivatives(buffer, originalKey) {
  const meta = await inspect(buffer);
  const verdict = assessible(meta);
  if (!verdict.ok) return { meta, skipped: verdict.reason, derivatives: [] };

  const widths = WIDTHS.filter((w) => w <= meta.width);
  // A picture narrower than the smallest step still deserves re-encoding — a
  // 300px PNG avatar is often larger than a 400px AVIF of the same thing.
  if (widths.length === 0) widths.push(meta.width);

  const derivatives = [];
  for (const format of FORMATS) {
    for (const width of widths) {
      // Sequentially, and rebuilding the sharp instance each time: a single
      // pipeline cannot be reused across outputs, and holding four decoded
      // bitmaps at once is what would exhaust a 512 MB instance.
      const out = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS })
        // .rotate() with no argument applies the EXIF orientation and then
        // drops it. Without this, a photo taken on a phone held sideways is
        // stored rotated — the tag that said which way up it goes is exactly
        // the metadata being stripped.
        .rotate()
        .resize({ width, withoutEnlargement: true })
        [format.ext](format.options)
        .toBuffer();

      derivatives.push({
        key: derivativeKey(originalKey, width, format.ext),
        width, ext: format.ext, mime: format.mime,
        buffer: out, bytes: out.length,
      });
    }
  }
  return { meta, derivatives };
}

module.exports = {
  buildDerivatives, inspect, assessible, derivativeKey,
  WIDTHS, FORMATS, MAX_INPUT_PIXELS, PROCESSABLE,
};
