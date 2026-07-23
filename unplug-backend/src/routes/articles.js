const express = require('express');
const pool = require('../db');
const { requireAuth, requireOwnerOrAdmin, requireRole } = require('../middleware/auth');
const { getPagination, paginationMeta } = require('../utils/pagination');
const { deriveMetadata, slugify } = require('../utils/articleMeta');
const { publishesFree, statusForNewSubmission } = require('../utils/publishingRights');

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

const MAX_GALLERY_IMAGES = 5;

// Normalises the gallery to at most five non-empty URLs.
function cleanGallery(images) {
  if (!Array.isArray(images)) return null;
  return images.map((u) => String(u || '').trim()).filter(Boolean).slice(0, MAX_GALLERY_IMAGES);
}

// Normalises links to [{label, url}]. Anything without a URL is dropped —
// a labelled link that goes nowhere is worse than no link. Only http(s) is
// accepted: a javascript: URL here would run in every reader's browser.
function cleanLinks(links) {
  if (!Array.isArray(links)) return null;
  return links
    .map((l) => ({
      label: String((l && l.label) || '').trim().slice(0, 80),
      url: String((l && l.url) || '').trim(),
    }))
    .filter((l) => l.url && /^https?:\/\//i.test(l.url))
    .map((l) => ({ label: l.label || l.url.replace(/^https?:\/\//i, '').split('/')[0], url: l.url }))
    .slice(0, 12);
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
    // A future scheduled_for keeps an approved article hidden until its day —
    // then this same condition lets it through with no publish job involved.
    const conditions = [`a.status = 'approved'`, `(a.scheduled_for IS NULL OR a.scheduled_for <= CURRENT_DATE)`];
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

// GET /articles/admin/all — admin, every article at every status. Powers the
// editor's picklist so an admin can open a published, pending, draft or
// rejected article to edit it, not only the published ones the public list
// returns.
router.get('/admin/all', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT a.id, a.title, a.status, a.created_at, a.published_at, c.name AS category
         FROM articles a
         LEFT JOIN categories c ON c.id = a.category_id
        ORDER BY a.created_at DESC
        LIMIT 300`
    );
    res.json({ articles: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /articles/:id — public sees published only; an admin (identified by the
// global attachUser middleware when a token is sent) may load any status so
// the editor can open drafts and pending pieces.
router.get('/:id', async (req, res, next) => {
  try {
    const isAdmin = req.user && req.user.role === 'admin';
    // Public sees an article only once approved AND past its scheduled date; an
    // admin can open it any time (to preview a draft or a future-dated piece).
    const result = await pool.query(
      `SELECT a.*, c.name AS category
       FROM articles a
       LEFT JOIN categories c ON c.id = a.category_id
       WHERE a.id = $1
         AND ($2::boolean OR (a.status = 'approved'
              AND (a.scheduled_for IS NULL OR a.scheduled_for <= CURRENT_DATE)))`,
      [req.params.id, isAdmin]
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
      galleryImages, links, bodyFormat,
    } = req.body;
    if (!title || !body) {
      return res.status(400).json({ error: 'title and body are required.' });
    }
    if (emotion && !ALLOWED_EMOTIONS.includes(emotion)) {
      return res.status(400).json({ error: 'emotion must be one of: ' + ALLOWED_EMOTIONS.join(', ') + '.' });
    }
    if (Array.isArray(galleryImages) && galleryImages.filter(Boolean).length > MAX_GALLERY_IMAGES) {
      return res.status(400).json({ error: `You can add up to ${MAX_GALLERY_IMAGES} images besides the cover image.` });
    }

    // Derive the metadata from what was actually submitted, sections
    // included, so takeaways and keywords reflect the whole piece.
    const categories = await client.query("SELECT id, name FROM categories WHERE type = 'news'");
    const derived = deriveMetadata({ title, body, sections, categories: categories.rows });
    const slug = await uniqueSlug(derived.slug);

    let status;
    let profileId = null;

    // An admin can choose to save a piece as a draft rather than publish it.
    // Only meaningful for those who publish free — a paying member's article
    // follows the payment/approval flow and has no draft state to sit in.
    if (req.body.saveAsDraft && publishesFree(req.user)) {
      status = 'draft';
    } else if (publishesFree(req.user)) {
      // Admin publishes live; a consultant still goes through approval but
      // never through payment. No credit is spent either way.
      status = statusForNewSubmission(req.user, false);
    } else {
      const profileResult = await client.query(
        'SELECT id, free_article_credits FROM profiles WHERE user_id = $1',
        [req.user.id]
      );
      const hasCredit = profileResult.rows.length > 0 && profileResult.rows[0].free_article_credits > 0;
      status = statusForNewSubmission(req.user, hasCredit);
      if (hasCredit) profileId = profileResult.rows[0].id;
    }

    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO articles
        (author_user_id, category_id, title, body, kicker_supplied_by, banner_image_url, emotion,
         status, published_at, seo_title, subtitle, meta_description, conclusion, cta_label, cta_url,
         slug, key_takeaways, keywords, tags, suggested_category_id,
         gallery_images, links, body_format)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
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
        cleanGallery(galleryImages),
        JSON.stringify(cleanLinks(links) || []),
        bodyFormat === 'text' ? 'text' : 'html',
      ]
    );
    const article = result.rows[0];
    const sectionCount = await replaceSections(client, article.id, sections);

    if (profileId) {
      await client.query('UPDATE profiles SET free_article_credits = free_article_credits - 1 WHERE id = $1', [profileId]);
    }
    await client.query('COMMIT');

    // A consultant reaches 'pending' without spending a credit, so the credit
    // wording would be wrong for them — telling someone they used a credit
    // they still have is a small lie that costs trust.
    const messages = {
      approved: 'Published — this article is live on the site now.',
      pending: req.user.role === 'consultant'
        ? 'Article submitted for approval — no payment needed.'
        : 'Article created using your free Article credit — submitted for approval, no payment needed.',
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
    if (req.body.galleryImages !== undefined) {
      const cleaned = cleanGallery(req.body.galleryImages);
      if (Array.isArray(req.body.galleryImages) && req.body.galleryImages.filter(Boolean).length > MAX_GALLERY_IMAGES) {
        return res.status(400).json({ error: `You can add up to ${MAX_GALLERY_IMAGES} images besides the cover image.` });
      }
      values.push(cleaned); setClauses.push(`gallery_images = $${values.length}`);
    }
    if (req.body.links !== undefined) {
      values.push(JSON.stringify(cleanLinks(req.body.links) || []));
      setClauses.push(`links = $${values.length}`);
    }
    if (req.body.bodyFormat !== undefined) {
      values.push(req.body.bodyFormat === 'text' ? 'text' : 'html');
      setClauses.push(`body_format = $${values.length}`);
    }
    if (slug !== undefined && String(slug).trim()) {
      values.push(await uniqueSlug(slugify(slug), Number(req.params.id)));
      setClauses.push(`slug = $${values.length}`);
    }

    // Status and scheduling are editorial powers, so only an admin may change
    // them. Without this guard a member editing their own article could set it
    // to 'approved' and self-publish, bypassing review entirely.
    const isAdmin = req.user && req.user.role === 'admin';
    if (isAdmin && req.body.status !== undefined) {
      const allowed = ['draft', 'pending', 'approved', 'rejected'];
      if (!allowed.includes(req.body.status)) {
        return res.status(400).json({ error: 'status must be one of: ' + allowed.join(', ') + '.' });
      }
      values.push(req.body.status); setClauses.push(`status = $${values.length}`);
      // Stamp published_at the first time it goes live so the feed can order by
      // it; COALESCE keeps the original date if it's re-approved later.
      if (req.body.status === 'approved') {
        setClauses.push(`published_at = COALESCE(published_at, now())`);
      }
    }
    if (isAdmin && req.body.scheduledFor !== undefined) {
      values.push(req.body.scheduledFor || null);
      setClauses.push(`scheduled_for = $${values.length}`);
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

// POST /articles/backfill-metadata — admin. Generates the derived fields for
// articles published before this existed. Without it the whole feature only
// helps future articles while everything already published stays bare: no
// slug, no social-share summary, no keywords for search.
//
// Only fills what is missing — an editor's own wording is never overwritten —
// and reports what it touched rather than claiming silent success.
router.post('/backfill-metadata', requireRole('admin'), async (req, res, next) => {
  try {
    const categories = await pool.query("SELECT id, name FROM categories WHERE type = 'news'");
    const pending = await pool.query(
      `SELECT id, title, body, category_id, slug, meta_description, key_takeaways, keywords, tags
         FROM articles
        WHERE slug IS NULL OR meta_description IS NULL OR key_takeaways IS NULL
        ORDER BY id`
    );
    const updated = [];
    for (const article of pending.rows) {
      const sections = await loadSections(article.id);
      const derived = deriveMetadata({
        title: article.title,
        body: article.body,
        sections: sections.map((s) => ({ sub_heading: s.sub_heading, paragraph: s.paragraph })),
        categories: categories.rows,
      });
      const slug = article.slug || await uniqueSlug(derived.slug, article.id);
      await pool.query(
        `UPDATE articles SET
           slug = COALESCE(slug, $1),
           meta_description = COALESCE(meta_description, $2),
           key_takeaways = COALESCE(key_takeaways, $3),
           keywords = COALESCE(keywords, $4),
           tags = COALESCE(tags, $5),
           seo_title = COALESCE(seo_title, title),
           suggested_category_id = COALESCE(suggested_category_id, CASE WHEN category_id IS NULL THEN $6 ELSE NULL END)
         WHERE id = $7`,
        [slug, derived.metaDescription, derived.keyTakeaways, derived.keywords,
          derived.tags, derived.suggestedCategoryId, article.id]
      );
      updated.push({ id: article.id, title: article.title, slug });
    }
    res.json({
      processed: updated.length,
      articles: updated,
      message: updated.length
        ? `Filled in metadata for ${updated.length} article${updated.length === 1 ? '' : 's'}. Existing wording was left untouched.`
        : 'Every article already has its metadata — nothing to do.',
    });
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
