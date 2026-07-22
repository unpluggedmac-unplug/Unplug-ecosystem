const express = require('express');
const pool = require('../db');
const { requireAuth, requireOwnerOrAdmin, requireRole } = require('../middleware/auth');
const { getPagination, paginationMeta } = require('../utils/pagination');
const { deriveMetadata, slugify } = require('../utils/articleMeta');

const router = express.Router();

// Slugs are URLs, so they have to be unique. If the natural slug is taken we
// suffix it rather than refusing the article — two pieces can legitimately
// share a headline, and an editor shouldn't have to rename one to publish.
async function uniqueSlug(base, excludeId) {
  const root = (base || 'article').slice(0, 80);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = attempt === 0 ? root : `${root}-${attempt + 1}`;
    const clash = await pool.query(
      'SELECT 1 FROM articles WHERE slug = $1 AND ($2::int IS NULL OR id <> $2)',
      [candidate, excludeId || null]
    );
    if (clash.rowCount === 0) return candidate;
  }
  return `${root}-${Date.now()}`;
}

// Replaces an article's sections wholesale. Simpler and safer than diffing:
// the editor sends the sections as they should end up, and blank ones are
// dropped so an empty row never renders as a gap on the live page.
async function replaceSections(client, articleId, sections) {
  await client.query('DELETE FROM article_sections WHERE article_id = $1', [articleId]);
  const clean = (sections || []).filter(
    (s) => (s.subHeading || '').trim() || (s.paragraph || '').trim() || (s.imageUrl || '').trim()
  );
  for (let i = 0; i < clean.length; i += 1) {
    const s = clean[i];
    await client.query(
      `INSERT INTO article_sections (article_id, position, sub_heading, paragraph, image_url, image_note)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [articleId, i, (s.subHeading || '').trim() || null, (s.paragraph || '').trim() || null,
        (s.imageUrl || '').trim() || null, (s.imageNote || '').trim() || null]
    );
  }
  return clean.length;
}

async function loadSections(articleId) {
  const result = await pool.query(
    `SELECT id, position, sub_heading, paragraph, image_url, image_note
       FROM article_sections WHERE article_id = $1 ORDER BY position, id`,
    [articleId]
  );
  return result.rows;
}

const ALLOWED_EMOTIONS = ['inspiring', 'business', 'community', 'breaking', 'celebration'];

async function getArticleOwnerId(req) {
  const result = await pool.query('SELECT author_user_id FROM articles WHERE id = $1', [req.params.id]);
  if (result.rows.length === 0) return null;
  return result.rows[0].author_user_id;
}

// GET /articles?category= — public, published only.
router.get('/', async (req, res, next) => {
  try {
    const { category } = req.query;
    const conditions = [`a.status = 'approved'`];
    const values = [];
    if (category) {
      values.push(category);
      conditions.push(`c.name = $${values.length}`);
    }

    const { page, limit, offset } = getPagination(req);

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM articles a
       LEFT JOIN categories c ON c.id = a.category_id
       WHERE ${conditions.join(' AND ')}`,
      values
    );

    const result = await pool.query(
      `SELECT a.id, a.title, a.body, a.kicker_supplied_by, a.emotion, a.published_at, c.name AS category
       FROM articles a
       LEFT JOIN categories c ON c.id = a.category_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY a.published_at DESC NULLS LAST, a.created_at DESC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset]
    );
    res.json({
      articles: result.rows,
      pagination: paginationMeta(page, limit, parseInt(countResult.rows[0].count, 10)),
    });
  } catch (err) {
    next(err);
  }
});

// GET /articles/mine — the authenticated member's own articles, at any
// status (draft/pending/approved/rejected) — not just published ones.
router.get('/mine', requireAuth, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT a.*, c.name AS category
       FROM articles a
       LEFT JOIN categories c ON c.id = a.category_id
       WHERE a.author_user_id = $1
       ORDER BY a.created_at DESC`,
      [req.user.id]
    );
    res.json({ articles: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /articles/:id — public, published only.
router.get('/:id', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT a.*, c.name AS category
       FROM articles a
       LEFT JOIN categories c ON c.id = a.category_id
       WHERE a.id = $1 AND a.status = 'approved'`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Article not found.' });
    }
    res.json({
      article: result.rows[0],
      sections: await loadSections(result.rows[0].id),
    });
  } catch (err) {
    next(err);
  }
});

// POST /articles — member submits (enters as 'pending').
// kickerSuppliedBy is the "Supplied by [Name Surname]" byline confirmed
// earlier for the Latest News page.
router.post('/', requireAuth, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const {
      title, body, categoryId, kickerSuppliedBy, bannerImageUrl, emotion,
      seoTitle, subtitle, metaDescription, conclusion, ctaLabel, ctaUrl, sections,
    } = req.body;
    if (!title || !body) {
      return res.status(400).json({ error: 'title and body are required.' });
    }
    if (emotion && !ALLOWED_EMOTIONS.includes(emotion)) {
      return res.status(400).json({ error: 'emotion must be one of: ' + ALLOWED_EMOTIONS.join(', ') + '.' });
    }

    // Derive the metadata from what was actually submitted, sections
    // included, so takeaways and keywords reflect the whole piece.
    const categories = await client.query("SELECT id, name FROM categories WHERE type = 'news'");
    const derived = deriveMetadata({ title, body, sections, categories: categories.rows });
    const slug = await uniqueSlug(derived.slug);

    const isAdmin = req.user.role === 'admin';
    let status = 'awaiting_payment';
    let profileId = null;

    if (isAdmin) {
      // Editorial staff publish straight to the site: no payment step, no
      // credit spent, and no approval queue — an admin approving their own
      // submission would just be a formality.
      status = 'approved';
    } else {
      const profileResult = await client.query(
        'SELECT id, free_article_credits FROM profiles WHERE user_id = $1',
        [req.user.id]
      );
      if (profileResult.rows.length > 0 && profileResult.rows[0].free_article_credits > 0) {
        status = 'pending';
        profileId = profileResult.rows[0].id;
      }
    }

    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO articles
        (author_user_id, category_id, title, body, kicker_supplied_by, banner_image_url, emotion,
         status, published_at, seo_title, subtitle, meta_description, conclusion, cta_label, cta_url,
         slug, key_takeaways, keywords, tags, suggested_category_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       RETURNING *`,
      [
        req.user.id, categoryId || null, title, body, kickerSuppliedBy || null,
        bannerImageUrl || null, emotion || null,
        status, status === 'approved' ? new Date() : null,
        (seoTitle || '').trim() || title,
        (subtitle || '').trim() || null,
        // Author's own meta description wins; the derived one is a fallback
        // so a social share is never left with no summary at all.
        (metaDescription || '').trim() || derived.metaDescription,
        (conclusion || '').trim() || null,
        (ctaLabel || '').trim() || null,
        (ctaUrl || '').trim() || null,
        slug, derived.keyTakeaways, derived.keywords, derived.tags,
        categoryId ? null : derived.suggestedCategoryId,
      ]
    );
    const article = result.rows[0];
    const sectionCount = await replaceSections(client, article.id, sections);

    if (profileId) {
      await client.query('UPDATE profiles SET free_article_credits = free_article_credits - 1 WHERE id = $1', [profileId]);
    }
    await client.query('COMMIT');

    const messages = {
      approved: 'Published — this article is live on the site now.',
      pending: 'Article created using your free Article credit — submitted for approval, no payment needed.',
      awaiting_payment: 'Article created — call POST /payments/initiate with linkedType "article_publish" and this article\'s id (R95.00) to submit it for approval.',
    };
    res.status(201).json({
      article,
      sectionCount,
      suggested: {
        categoryId: derived.suggestedCategoryId,
        categoryName: derived.suggestedCategoryName,
        keyTakeaways: derived.keyTakeaways,
        keywords: derived.keywords,
        tags: derived.tags,
      },
      message: messages[status],
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// PATCH /articles/:id — owner or admin can edit before/after approval.
router.patch('/:id', requireOwnerOrAdmin(getArticleOwnerId), async (req, res, next) => {
  try {
    const { title, body, kickerSuppliedBy, emotion, categoryId, bannerImageUrl } = req.body;
    const setClauses = [];
    const values = [];

    if (title !== undefined) { values.push(title); setClauses.push(`title = $${values.length}`); }
    if (body !== undefined) { values.push(body); setClauses.push(`body = $${values.length}`); }
    if (kickerSuppliedBy !== undefined) { values.push(kickerSuppliedBy); setClauses.push(`kicker_supplied_by = $${values.length}`); }
    if (categoryId !== undefined) { values.push(categoryId || null); setClauses.push(`category_id = $${values.length}`); }
    if (bannerImageUrl !== undefined) { values.push(bannerImageUrl || null); setClauses.push(`banner_image_url = $${values.length}`); }
    if (emotion !== undefined) {
      if (emotion && !ALLOWED_EMOTIONS.includes(emotion)) {
        return res.status(400).json({ error: 'emotion must be one of: ' + ALLOWED_EMOTIONS.join(', ') + '.' });
      }
      values.push(emotion || null); setClauses.push(`emotion = $${values.length}`);
    }

    // The editorial fields, including the derived ones — an editor correcting
    // a clumsy auto-generated takeaway or keyword is the entire point of
    // storing them rather than recomputing on every read.
    const { seoTitle, subtitle, metaDescription, conclusion, ctaLabel, ctaUrl,
      keyTakeaways, keywords, tags, slug, sections } = req.body;
    if (seoTitle !== undefined) { values.push(seoTitle || null); setClauses.push(`seo_title = $${values.length}`); }
    if (subtitle !== undefined) { values.push(subtitle || null); setClauses.push(`subtitle = $${values.length}`); }
    if (metaDescription !== undefined) { values.push(metaDescription || null); setClauses.push(`meta_description = $${values.length}`); }
    if (conclusion !== undefined) { values.push(conclusion || null); setClauses.push(`conclusion = $${values.length}`); }
    if (ctaLabel !== undefined) { values.push(ctaLabel || null); setClauses.push(`cta_label = $${values.length}`); }
    if (ctaUrl !== undefined) { values.push(ctaUrl || null); setClauses.push(`cta_url = $${values.length}`); }
    if (Array.isArray(keyTakeaways)) { values.push(keyTakeaways.filter(Boolean)); setClauses.push(`key_takeaways = $${values.length}`); }
    if (Array.isArray(keywords)) { values.push(keywords.filter(Boolean)); setClauses.push(`keywords = $${values.length}`); }
    if (Array.isArray(tags)) { values.push(tags.filter(Boolean)); setClauses.push(`tags = $${values.length}`); }
    if (slug !== undefined && String(slug).trim()) {
      values.push(await uniqueSlug(slugify(slug), Number(req.params.id)));
      setClauses.push(`slug = $${values.length}`);
    }

    if (setClauses.length === 0 && !Array.isArray(sections)) {
      return res.status(400).json({ error: 'No editable fields provided.' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let article = null;
      if (setClauses.length > 0) {
        values.push(req.params.id);
        const result = await client.query(
          `UPDATE articles SET ${setClauses.join(', ')} WHERE id = $${values.length} RETURNING *`,
          values
        );
        if (result.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Article not found.' });
        }
        article = result.rows[0];
      } else {
        const existing = await client.query('SELECT * FROM articles WHERE id = $1', [req.params.id]);
        if (existing.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Article not found.' });
        }
        article = existing.rows[0];
      }
      if (Array.isArray(sections)) {
        await replaceSections(client, article.id, sections);
      }
      await client.query('COMMIT');
      res.json({ article, sections: await loadSections(article.id) });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

// DELETE /articles/:id — admin only. Deliberately not open to the author:
// once a piece is published other people may have linked to, saved or
// commented on it, so removing it is an editorial decision. Sections,
// comments and saves cascade away with the row.
router.delete('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query('DELETE FROM articles WHERE id = $1 RETURNING id, title', [req.params.id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Article not found.' });
    }
    res.json({ deleted: true, article: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
