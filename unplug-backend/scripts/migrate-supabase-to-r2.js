#!/usr/bin/env node
//
// One-off: move every image currently hosted on Supabase Storage to
// Cloudflare R2, and repoint the database row that references it.
//
//   node scripts/migrate-supabase-to-r2.js --dry-run     see what it would do
//   node scripts/migrate-supabase-to-r2.js               do it
//   node scripts/migrate-supabase-to-r2.js --limit 25    a batch at a time
//
// WHY THIS EXISTS. R2 has no egress fees; Supabase's does, and exceeding it
// is exactly what took image previews down site-wide — the free-tier
// project actually serving these files (a SEPARATE, mostly-empty Supabase
// project from the real production database — confirmed 2026-09-06) hit
// exceed_cached_egress_quota and now refuses every single Storage request,
// public or authenticated. New uploads already prefer R2 when it's
// configured (see src/routes/uploads.js's putPublicObject) — this is the
// one-time sweep for everything uploaded before R2 was live in production.
//
// HOW IT FINDS THE IMAGES. Not a hard-coded column list — same
// information_schema approach scripts/optimise-existing-images.js already
// uses, so a column added later is picked up automatically rather than
// silently skipped.
//
// SAFE TO STOP AND SAFE TO REPEAT. Each row is updated to its new R2 URL the
// moment its own upload succeeds, so a row already migrated no longer
// matches the Supabase pattern and is simply skipped on the next run.
// NOTHING IS EVER DELETED FROM SUPABASE — this only copies bytes to R2 and
// repoints the one column that referenced them; the original files are left
// exactly where they are.
//
// WILL DO NOTHING WHILE THE SOURCE IS QUOTA-BLOCKED. If Supabase is refusing
// reads (exceed_cached_egress_quota or similar), every download attempt
// fails and every row is left exactly as it is — that is a Supabase billing
// problem (project owner must upgrade the plan or remove spend caps), not
// something this script can route around. Run --dry-run any time to see
// what's still pending with no risk; the real run only does anything useful
// once that restriction is lifted.

const pool = require('../src/db');
const uploads = require('../src/routes/uploads');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const LIMIT = (() => {
  const i = args.indexOf('--limit');
  return i !== -1 && args[i + 1] ? parseInt(args[i + 1], 10) : Infinity;
})();

function kb(bytes) { return (bytes / 1024).toFixed(0) + ' KB'; }

// Every column in the database that holds an image URL, found by name —
// identical discovery method to optimise-existing-images.js, so the two
// scripts can never quietly disagree about what counts as an image column.
async function imageColumns() {
  const r = await pool.query(`
    SELECT table_name, column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND data_type IN ('text', 'character varying')
       AND (column_name LIKE '%image_url%'
         OR column_name LIKE '%photo_url%'
         OR column_name LIKE '%cover_url%'
         OR column_name LIKE '%avatar%'
         OR column_name LIKE '%pdf_url%')
     ORDER BY table_name, column_name`);
  return r.rows;
}

// Keeps the original filename Supabase stored it under (the part after the
// bucket name), so a migrated file is still recognisable by its key on R2 —
// inventing a fresh name here would make a broken image harder to trace
// back to what it used to be.
function keyFromSupabaseUrl(url) {
  const m = /\/storage\/v1\/object\/public\/[^/]+\/(.+)$/.exec(url);
  return m ? m[1] : null;
}

async function main() {
  if (!uploads.r2Configured) {
    console.error('R2 is not configured on THIS process (R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET / R2_PUBLIC_URL).');
    console.error('There is nowhere to migrate TO. Set these first (the same five variables new uploads already prefer), then re-run.');
    process.exit(1);
  }

  console.log(DRY_RUN ? 'DRY RUN — nothing will be written.\n' : 'Migrating Supabase-hosted images to R2.\n');

  const columns = await imageColumns();
  const candidates = [];
  for (const c of columns) {
    // Identifiers come from information_schema, not user input, but are
    // still quoted rather than interpolated bare — the habit is the point.
    const sql = `SELECT id, "${c.column_name}" AS url FROM "${c.table_name}"
                  WHERE "${c.column_name}" LIKE '%.supabase.co/storage/%'`;
    let rows;
    try {
      rows = (await pool.query(sql)).rows;
    } catch (err) {
      console.warn(`  ! could not read ${c.table_name}.${c.column_name}: ${err.message}`);
      continue;
    }
    for (const row of rows) {
      candidates.push({ table: c.table_name, column: c.column_name, id: row.id, url: row.url });
    }
  }

  console.log(`${candidates.length} row(s) still point at Supabase Storage${LIMIT !== Infinity ? ` (doing up to ${Math.min(LIMIT, candidates.length)})` : ''}\n`);

  if (DRY_RUN) {
    for (const c of candidates.slice(0, 30)) console.log(`  would migrate ${c.table}.${c.column} #${c.id} — ${c.url}`);
    if (candidates.length > 30) console.log(`  ...and ${candidates.length - 30} more`);
    await pool.end();
    return;
  }

  let migrated = 0, failed = 0;
  for (const c of candidates.slice(0, LIMIT)) {
    const key = keyFromSupabaseUrl(c.url) || `migrated/${Date.now()}-${c.table}-${c.id}`;
    try {
      const res = await fetch(c.url);
      if (!res.ok) {
        // Exactly the failure mode this script exists to survive: Supabase
        // refusing the request (quota block, or the file genuinely gone).
        // Recorded and moved past, not fatal to the whole run.
        console.log(`  ✗ ${c.table}.${c.column} #${c.id} — source unavailable (HTTP ${res.status}): ${c.url}`);
        failed++;
        continue;
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      const contentType = res.headers.get('content-type') || 'application/octet-stream';
      const newUrl = await uploads.putPublicObject(key, buffer, contentType);

      // The row is only repointed AFTER the R2 upload has already succeeded —
      // never the other way around, so an interrupted run can never leave a
      // database row pointing at bytes that don't actually exist on R2.
      await pool.query(`UPDATE "${c.table}" SET "${c.column}" = $1 WHERE id = $2`, [newUrl, c.id]);
      console.log(`  ✓ ${c.table}.${c.column} #${c.id} — ${kb(buffer.length)} → R2`);
      migrated++;
    } catch (err) {
      console.log(`  ✗ ${c.table}.${c.column} #${c.id} — ${err.message}`);
      failed++;
    }
  }

  console.log(`\n${migrated} migrated, ${failed} failed.`);
  if (failed > 0) {
    console.log('Re-running is safe — only rows still pointing at Supabase will be attempted again.');
    console.log('A wall of HTTP 402/403 failures here means Supabase is still quota-blocked; nothing else to fix on this end until that clears.');
  }

  await pool.end();
}

main().catch((err) => {
  console.error('\nThe run stopped:', err.message);
  console.error('Rows already migrated keep their new R2 URL — nothing already done is undone by an error partway through.');
  process.exit(1);
});
