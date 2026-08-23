// Which stored images have responsive versions — the list the frontend needs
// before it can offer one.
//
// WHY THE FRONTEND CANNOT JUST GUESS. Derivative names are deterministic, so
// "does this image have an 800px AVIF?" looks answerable without asking. It is
// not: a browser handed a srcset entry that 404s shows a BROKEN IMAGE. It does
// not quietly fall back to the original. So a derivative may only be offered
// when it is known to exist, and this endpoint is that knowledge.
//
// WHY ONE LIST RATHER THAN A LOOKUP PER IMAGE. A page shows dozens of pictures.
// Dozens of round trips to ask about each would cost far more than the bytes
// this saves. The whole set is a few kilobytes gzipped, fetched once, cached.
//
// The frontend treats a missing or late answer as "no derivatives", which is
// precisely how the site behaved before any of this existed — so a failure
// here is slow, never broken.

const express = require('express');
const pool = require('../db');
const { requireRole } = require('../middleware/auth');
const { WIDTHS, FORMATS } = require('../utils/imagePipeline');

const router = express.Router();

// Long enough that a crawl or a burst of readers cannot turn this into load,
// short enough that a freshly uploaded picture becomes responsive within
// minutes. ETag does the real work: an unchanged manifest costs a 304.
const MANIFEST_CACHE_SECONDS = 300;

// GET /images/manifest — public. Every image key that has derivatives.
router.get('/manifest', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT object_key, widths, source_width, source_height
         FROM image_derivatives
        WHERE skipped_reason IS NULL AND array_length(widths, 1) > 0
        ORDER BY object_key`
    );

    // Keys carry their own widths only when they differ from the standard
    // ladder, which is the uncommon case (a picture narrower than 400px). The
    // common case is just the key, which keeps the payload small.
    const standard = WIDTHS.join(',');
    const images = {};
    for (const row of result.rows) {
      const widths = (row.widths || []).join(',');
      images[row.object_key] = {
        // null means "the standard ladder", spelled out once below.
        w: widths === standard ? null : (row.widths || []),
        // Intrinsic size, so the page can reserve the right space before the
        // picture arrives. The live site loses 0.343 CLS on mobile to images
        // with no dimensions; this is what fixes it.
        d: row.source_width && row.source_height ? [row.source_width, row.source_height] : null,
      };
    }

    res.set('Cache-Control', `public, max-age=${MANIFEST_CACHE_SECONDS}`);
    res.json({
      widths: WIDTHS,
      // In preference order: the frontend offers these as <source> elements in
      // the order given, and the browser takes the first it understands.
      formats: FORMATS.map((f) => ({ ext: f.ext, mime: f.mime })),
      prefix: 'derivatives/',
      images,
    });
  } catch (err) { next(err); }
});

// GET /images/stats — admin. What the pipeline has actually achieved, in bytes.
// The one honest answer to "was this worth doing", and the backfill's progress
// report between runs.
router.get('/stats', requireRole('admin'), async (req, res, next) => {
  try {
    const r = await pool.query(
      `SELECT
         count(*) FILTER (WHERE skipped_reason IS NULL)                AS processed,
         count(*) FILTER (WHERE skipped_reason IS NOT NULL)            AS skipped,
         COALESCE(sum(original_bytes)   FILTER (WHERE skipped_reason IS NULL), 0) AS original_bytes,
         COALESCE(sum(derivative_bytes) FILTER (WHERE skipped_reason IS NULL), 0) AS derivative_bytes,
         COALESCE(sum(delivered_bytes)  FILTER (WHERE skipped_reason IS NULL), 0) AS delivered_bytes
       FROM image_derivatives`
    );
    const row = r.rows[0];
    const skippedList = await pool.query(
      `SELECT object_key, skipped_reason FROM image_derivatives
        WHERE skipped_reason IS NOT NULL ORDER BY updated_at DESC LIMIT 50`
    );
    res.json({
      processed: Number(row.processed),
      skipped: Number(row.skipped),
      originalBytes: Number(row.original_bytes),
      // TWO DIFFERENT NUMBERS, and conflating them would flatter the result.
      // storedBytes is every derivative added up: one picture becomes eight
      // files, so this can exceed the originals and that is fine — storage is
      // cheap and nobody downloads eight files.
      // deliveredBytes is what a reader on the widest screen actually receives
      // instead of the original, which is the only figure that says whether
      // the page got lighter.
      storedBytes: Number(row.derivative_bytes),
      deliveredBytes: Number(row.delivered_bytes),
      skippedItems: skippedList.rows,
    });
  } catch (err) { next(err); }
});

module.exports = router;
