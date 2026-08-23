#!/usr/bin/env node
//
// One-off: give every image already in the library its responsive derivatives.
//
//   node scripts/optimise-existing-images.js --dry-run     see what it would do
//   node scripts/optimise-existing-images.js               do it
//   node scripts/optimise-existing-images.js --limit 25    a batch at a time
//   node scripts/optimise-existing-images.js --retry       re-attempt skips
//
// HOW IT FINDS THE IMAGES. Not from a hard-coded list of columns. Image URLs
// live in eleven differently-named columns spread across the schema, and a
// list written out here would be wrong the first time somebody added a
// twelfth. It asks information_schema for every text column whose name looks
// like an image URL, and reads the distinct values. A new column is picked up
// automatically, and one that disappears cannot break the run.
//
// SAFE TO STOP AND SAFE TO REPEAT. Work is recorded per image as it completes,
// so interrupting it loses at most one picture, and running it again picks up
// where it left off rather than starting over. Nothing is ever deleted: the
// originals stay exactly where they are, and the site keeps serving them for
// anything this has not reached yet.
//
// WHY IT IS A SCRIPT AND NOT A JOB. It is a single sweep over history. Once
// it has run, every new upload gets its derivatives at upload time and there
// is nothing left for it to do.

const pool = require('../src/db');
const { storeDerivatives, keyFromPublicUrl } = require('../src/utils/imageDerivativeStore');
const uploads = require('../src/routes/uploads');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const RETRY_SKIPPED = args.includes('--retry');
const LIMIT = (() => {
  const i = args.indexOf('--limit');
  return i !== -1 && args[i + 1] ? parseInt(args[i + 1], 10) : Infinity;
})();

function kb(bytes) { return (bytes / 1024).toFixed(0) + ' KB'; }

// Every column in the database that holds an image URL, found by name.
async function imageColumns() {
  const r = await pool.query(`
    SELECT table_name, column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND data_type IN ('text', 'character varying')
       AND (column_name LIKE '%image_url%'
         OR column_name LIKE '%photo_url%'
         OR column_name LIKE '%cover_url%'
         OR column_name LIKE '%avatar%')
     ORDER BY table_name, column_name`);
  return r.rows;
}

// Every distinct image URL the site actually references.
//
// Deliberately driven by what is REFERENCED rather than by what is in the
// bucket: an abandoned upload nobody links to costs no page weight, and
// spending minutes of AVIF encoding on it would be work for nothing.
async function referencedUrls() {
  const columns = await imageColumns();
  const seen = new Set();
  for (const c of columns) {
    // Identifiers come from information_schema, not from user input, but they
    // are still quoted rather than interpolated bare — a table called "order"
    // would otherwise be a syntax error, and the habit is the point.
    const sql = `SELECT DISTINCT "${c.column_name}" AS url
                   FROM "${c.table_name}"
                  WHERE "${c.column_name}" IS NOT NULL AND "${c.column_name}" <> ''`;
    let rows;
    try {
      rows = (await pool.query(sql)).rows;
    } catch (err) {
      console.warn(`  ! could not read ${c.table_name}.${c.column_name}: ${err.message}`);
      continue;
    }
    for (const row of rows) if (row.url) seen.add(row.url);
  }
  return [...seen];
}

async function alreadyDone() {
  const r = await pool.query(
    RETRY_SKIPPED
      ? `SELECT object_key FROM image_derivatives WHERE skipped_reason IS NULL`
      : `SELECT object_key FROM image_derivatives`
  );
  return new Set(r.rows.map((x) => x.object_key));
}

async function main() {
  if (!uploads.supabaseConfigured) {
    console.error('Supabase Storage is not configured (SUPABASE_URL / SUPABASE_SERVICE_KEY / SUPABASE_BUCKET).');
    console.error('Without it there is nowhere to put the derivatives. Nothing was changed.');
    process.exit(1);
  }

  console.log(DRY_RUN ? 'DRY RUN — nothing will be written.\n' : 'Optimising the existing image library.\n');

  const urls = await referencedUrls();
  const done = await alreadyDone();

  // Only our own public storage. An image hosted elsewhere is not ours to
  // re-encode, and could not be given derivatives in our bucket anyway.
  const candidates = [];
  let external = 0;
  for (const url of urls) {
    const key = keyFromPublicUrl(url);
    if (!key) { external++; continue; }
    if (done.has(key)) continue;
    candidates.push({ url, key });
  }

  console.log(`${urls.length} image URLs referenced`);
  console.log(`  ${external} hosted elsewhere — left alone`);
  console.log(`  ${done.size} already processed`);
  console.log(`  ${candidates.length} to do${LIMIT !== Infinity ? ` (doing ${Math.min(LIMIT, candidates.length)})` : ''}\n`);

  if (DRY_RUN) {
    for (const c of candidates.slice(0, 20)) console.log('  would process', c.key);
    if (candidates.length > 20) console.log(`  ...and ${candidates.length - 20} more`);
    await pool.end();
    return;
  }

  let processed = 0; let skipped = 0; let failed = 0;
  let originalTotal = 0; let deliveredTotal = 0;

  for (const c of candidates.slice(0, LIMIT)) {
    try {
      const res = await fetch(c.url);
      if (!res.ok) {
        // A URL in the database with no file behind it is worth knowing about:
        // it is a broken image on the live site right now.
        console.log(`  ✗ ${c.key} — the file is not there (HTTP ${res.status})`);
        failed++;
        continue;
      }
      const buffer = Buffer.from(await res.arrayBuffer());

      const out = await storeDerivatives({
        key: c.key, buffer, putObject: uploads.putPublicObject,
      });

      if (out.skipped) {
        console.log(`  – ${c.key} — ${out.skipped}`);
        skipped++;
      } else {
        originalTotal += out.originalBytes;
        deliveredTotal += out.deliveredBytes || 0;
        const saved = out.originalBytes - (out.deliveredBytes || 0);
        const pct = Math.round((saved / out.originalBytes) * 100);
        console.log(`  ✓ ${c.key} — ${kb(out.originalBytes)} → ${kb(out.deliveredBytes || 0)} (${pct}% lighter)`);
        processed++;
      }
    } catch (err) {
      console.log(`  ✗ ${c.key} — ${err.message}`);
      failed++;
    }
  }

  console.log(`\n${processed} optimised, ${skipped} left as they are, ${failed} failed.`);
  if (processed > 0) {
    const saved = originalTotal - deliveredTotal;
    console.log(`A reader now downloads ${kb(deliveredTotal)} where they used to download ${kb(originalTotal)}`);
    console.log(`— ${kb(saved)} less, ${Math.round((saved / originalTotal) * 100)}% of the weight of these images.`);
  }
  if (failed > 0) {
    console.log(`\n${failed} failed. Re-running is safe and will retry only those.`);
  }

  // The Cache-Control actually observed on a derivative, checked rather than
  // assumed: Supabase serves uploads with "no-cache" unless told otherwise,
  // and getting that wrong silently undoes much of this work.
  if (processed > 0) {
    const sample = await pool.query(
      `SELECT object_key FROM image_derivatives WHERE skipped_reason IS NULL ORDER BY updated_at DESC LIMIT 1`);
    if (sample.rowCount) {
      const key = sample.rows[0].object_key;
      const probe = `${process.env.SUPABASE_URL}/storage/v1/object/public/${process.env.SUPABASE_BUCKET}/derivatives/${key.replace(/\.[^./]+$/, '')}-400.webp`;
      try {
        const head = await fetch(probe, { method: 'HEAD' });
        const cc = head.headers.get('cache-control');
        console.log(`\nCache-Control on a stored derivative: ${cc || '(none)'}`);
        if (!cc || /no-cache|max-age=0/.test(cc)) {
          console.log('WARNING: these are not being cached. Every visit will re-download them.');
          console.log('Check that the storage upload is sending the cache-control header.');
        }
      } catch (e) { /* the check is a courtesy, not the job */ }
    }
  }

  await pool.end();
}

main().catch((err) => {
  console.error('\nThe run stopped:', err.message);
  console.error('Nothing is half-done — each image is recorded only once its files are stored.');
  process.exit(1);
});
