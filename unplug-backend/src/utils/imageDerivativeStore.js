// Making derivatives, storing them, and recording that they exist.
//
// imagePipeline.js does the encoding and knows nothing about storage or the
// database. This joins the three together, and is the only place that decides
// an image "has derivatives".
//
// THE WRITE ORDER MATTERS. Every derivative is uploaded BEFORE the manifest row
// is written, because the frontend treats that row as a promise that the files
// are there. A row written first, followed by a failed upload, would put a
// srcset entry on the page pointing at nothing — and a browser given a srcset
// URL that 404s shows a broken image rather than falling back to the original.
// Slow is fine here. Wrong is not.
//
// putObject IS INJECTED rather than imported. The uploader lives on the uploads
// route, which needs this module; importing it back would make a require cycle,
// and passing the one function in keeps this testable without a network or a
// Supabase key.

const pool = require('../db');
const { buildDerivatives } = require('./imagePipeline');

// Records that an image was looked at and deliberately left alone. Distinct
// from having no row at all, which means "not looked at yet" — without the
// difference, the backfill retries the same unreadable file on every run.
async function recordSkip(objectKey, reason, meta) {
  await pool.query(
    `INSERT INTO image_derivatives
       (object_key, widths, formats, skipped_reason, source_width, source_height, updated_at)
     VALUES ($1, '{}', '{}', $2, $3, $4, now())
     ON CONFLICT (object_key) DO UPDATE SET
       widths = '{}', formats = '{}', skipped_reason = EXCLUDED.skipped_reason,
       source_width = EXCLUDED.source_width, source_height = EXCLUDED.source_height,
       updated_at = now()`,
    [objectKey, reason, (meta && meta.width) || null, (meta && meta.height) || null]
  );
}

// Builds, uploads and records every derivative for one stored image.
//
// Returns a summary: { key, made, skipped, originalBytes, derivativeBytes,
// widths, formats }. Throwing is reserved for a genuine failure to store —
// an image that simply should not be processed comes back with `skipped` set.
async function storeDerivatives({ key, buffer, putObject }) {
  if (!key) throw new Error('storeDerivatives needs the original object key');
  if (!buffer || !buffer.length) throw new Error('storeDerivatives needs the original bytes');
  if (typeof putObject !== 'function') throw new Error('storeDerivatives needs a putObject function');

  let built;
  try {
    built = await buildDerivatives(buffer, key);
  } catch (err) {
    // Unreadable bytes are a fact about the file, not a fault in the run. It
    // is recorded so nothing tries again, and the original stays served.
    await recordSkip(key, `unreadable: ${err.message}`.slice(0, 300), null);
    return { key, made: 0, skipped: `unreadable: ${err.message}`, originalBytes: buffer.length, derivativeBytes: 0 };
  }

  const { meta, derivatives, skipped } = built;
  if (skipped || derivatives.length === 0) {
    await recordSkip(key, skipped || 'nothing to generate', meta);
    return { key, made: 0, skipped: skipped || 'nothing to generate', originalBytes: buffer.length, derivativeBytes: 0, meta };
  }

  // Uploaded one at a time. Firing a dozen requests at once from a 512 MB
  // instance is how an upload becomes a memory failure instead of a slow wait.
  let derivativeBytes = 0;
  for (const d of derivatives) {
    await putObject(d.key, d.buffer, d.mime);
    derivativeBytes += d.bytes;
  }

  const widths = [...new Set(derivatives.map((d) => d.width))].sort((a, b) => a - b);
  const formats = [...new Set(derivatives.map((d) => d.ext))];

  // What a reader on the widest screen downloads instead of the original: the
  // largest AVIF, on its own. Summing all eight derivatives would measure the
  // storage bill, not the page weight, and nobody downloads all eight.
  const delivered = derivatives
    .filter((d) => d.ext === 'avif')
    .sort((a, b) => b.width - a.width)[0];
  const deliveredBytes = delivered ? delivered.bytes : null;

  await pool.query(
    `INSERT INTO image_derivatives
       (object_key, widths, formats, original_bytes, derivative_bytes, delivered_bytes,
        source_width, source_height, skipped_reason, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, now())
     ON CONFLICT (object_key) DO UPDATE SET
       widths = EXCLUDED.widths, formats = EXCLUDED.formats,
       original_bytes = EXCLUDED.original_bytes,
       derivative_bytes = EXCLUDED.derivative_bytes,
       delivered_bytes = EXCLUDED.delivered_bytes,
       source_width = EXCLUDED.source_width, source_height = EXCLUDED.source_height,
       -- Clearing this matters: an image that failed once and succeeds on a
       -- retry must stop being reported as skipped.
       skipped_reason = NULL,
       updated_at = now()`,
    [key, widths, formats, buffer.length, derivativeBytes, deliveredBytes, meta.width, meta.height]
  );

  return {
    key, made: derivatives.length, skipped: null,
    originalBytes: buffer.length, derivativeBytes, deliveredBytes,
    widths, formats, meta,
  };
}

// The object key inside a Supabase public URL, or null if it is not one.
//
// Used to turn the URLs already stored in a dozen different content columns
// into manifest keys without touching any of those columns.
function keyFromPublicUrl(url) {
  const m = String(url || '').match(/\/storage\/v1\/object\/public\/[^/]+\/(.+)$/);
  if (!m) return null;
  // A query string on an image URL is a cache-buster, not part of the key.
  return decodeURIComponent(m[1].split('?')[0]);
}

module.exports = { storeDerivatives, recordSkip, keyFromPublicUrl };
