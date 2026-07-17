// One-time import of real content from the old WordPress site
// (unplugnews.com) into the live database. Reads final_import.json
// (produced by the WXR-export extraction script) and inserts Directory
// profiles + articles, skipping anything already imported (safe to re-run).
//
// Usage: node scripts/import-legacy-content.js /path/to/final_import.json
require('dotenv').config();
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function slugify(name) {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

async function getOrCreateLegacyUser(client, email) {
  const existing = await client.query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rows.length > 0) return existing.rows[0].id;
  const passwordHash = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10);
  const result = await client.query(
    `INSERT INTO users (email, password_hash, role, email_verified) VALUES ($1, $2, 'member', true) RETURNING id`,
    [email, passwordHash]
  );
  return result.rows[0].id;
}

async function main() {
  const jsonPath = process.argv[2];
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));

  const client = await pool.connect();
  try {
    const catRows = await client.query(`SELECT id, name, type FROM categories`);
    const dirCatByName = {};
    const newsCatByName = {};
    for (const r of catRows.rows) {
      if (r.type === 'directory') dirCatByName[r.name] = r.id;
      if (r.type === 'news') newsCatByName[r.name] = r.id;
    }

    let profilesImported = 0, profilesSkipped = 0;
    let galleryImagesImported = 0, socialsImported = 0;

    for (const p of data.profiles) {
      const slug = slugify(p.display_name);
      const existing = await client.query('SELECT id FROM profiles WHERE slug = $1', [slug]);
      if (existing.rows.length > 0) { profilesSkipped++; continue; }

      const email = `legacy-${slug}@import.unplugnews.com`;
      const userId = await getOrCreateLegacyUser(client, email);
      const categoryId = dirCatByName[p.mapped_category] || null;

      let bio = p.bio_html_rewritten || '';
      if (p.featured_image_local && !bio.includes(p.featured_image_local)) {
        bio = `<img src="/${p.featured_image_local}" alt="${p.display_name}">` + bio;
      }

      const profileResult = await client.query(
        `INSERT INTO profiles (user_id, type, category_id, package_tier, slug, display_name, bio, status, verification_note)
         VALUES ($1, 'individual', $2, 'premium', $3, $4, $5, 'approved', $6)
         RETURNING id`,
        [userId, categoryId, slug, p.display_name, bio, `Imported from the original unplugnews.com — ${p.source_url}`]
      );
      const profileId = profileResult.rows[0].id;
      profilesImported++;

      for (const [platform, url] of Object.entries(p.social_links || {})) {
        await client.query(
          `INSERT INTO social_links (owner_type, owner_id, platform, url) VALUES ('profile', $1, $2, $3)
           ON CONFLICT (owner_type, owner_id, platform) DO NOTHING`,
          [profileId, platform, url]
        );
        socialsImported++;
      }

      // Real inline images (beyond the featured one) become the profile's
      // Collaboration/project Gallery — precomputed + capped at 6 by the
      // Python extraction step, so it's a curated set, not every
      // icon/decoration found in the article body.
      for (const localPath of p.gallery_images_local || []) {
        await client.query(
          `INSERT INTO gallery_images (owner_type, owner_id, image_url, status) VALUES ('profile', $1, $2, 'approved')`,
          [profileId, '/' + localPath]
        );
        galleryImagesImported++;
      }
    }

    let articlesImported = 0, articlesSkipped = 0;
    const legacyAuthorEmail = 'legacy-import@unplugnews.com';
    const legacyAuthorId = await getOrCreateLegacyUser(client, legacyAuthorEmail);

    for (const a of data.articles) {
      const existing = await client.query('SELECT id FROM articles WHERE title = $1', [a.title]);
      if (existing.rows.length > 0) { articlesSkipped++; continue; }

      const publishedAt = a.published_at || null;
      await client.query(
        `INSERT INTO articles (author_user_id, category_id, title, body, status, published_at, banner_image_url)
         VALUES ($1, NULL, $2, $3, 'approved', $4, $5)`,
        [legacyAuthorId, a.title, a.body_html_rewritten, publishedAt, a.featured_image_local ? '/' + a.featured_image_local : null]
      );
      articlesImported++;
    }

    console.log(`Profiles imported: ${profilesImported}, skipped (already existed): ${profilesSkipped}`);
    console.log(`Social links imported: ${socialsImported}`);
    console.log(`Articles imported: ${articlesImported}, skipped (already existed): ${articlesSkipped}`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
