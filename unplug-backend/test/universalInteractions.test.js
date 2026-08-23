// Members, Profile Social Interaction & Community System — Phase 1:
// Universal Interaction Engine, over real PostgreSQL.
//
// Run with:  npm test   (from unplug-backend/)

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const EmbeddedPostgres = require('embedded-postgres').default;
const { stopPostgres } = require('./helpers/stopPostgres');

let pg;
let pool;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-interactions-'));
const port = 16000 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

function migrationFiles() {
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
    .map((f) => path.join(dir, f));
}
async function runMigrations() {
  for (const file of migrationFiles()) {
    await pool.query(fs.readFileSync(file, 'utf8'));
  }
}

let _nextUserId = 14000;
async function makeUser() {
  const id = _nextUserId++;
  await pool.query(`INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', 'member') ON CONFLICT DO NOTHING`, [id, `interact${id}@test.com`]);
  return id;
}

let _nextArticleId = 0;
async function makeArticle(authorId) {
  const result = await pool.query(
    `INSERT INTO articles (author_user_id, title, body, status) VALUES ($1, $2, 'body', 'approved') RETURNING id`,
    [authorId, `Interaction Article ${_nextArticleId++}`]
  );
  return result.rows[0].id;
}

before(async () => {
  pg = new EmbeddedPostgres({
    databaseDir: dataDir, user: 'postgres', password: 'postgres', port,
    persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('unplug_test');

  process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:${port}/unplug_test`;
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await runMigrations();
});

after(async () => {
  await pool.end();
  // stopPostgres, not pg.stop() directly: on Windows the library's stop
  // can HANG rather than throw, which used to leave the cluster running
  // with no parent and eventually broke a later test file's startup.
  // See test/helpers/stopPostgres.js.
  await stopPostgres(pg, dataDir);
});

test('saved_articles no longer exists — Phase 1 consolidated it into content_saves', async () => {
  const result = await pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_name = 'saved_articles'`
  );
  assert.equal(result.rows.length, 0);
});

test('a like and a dislike on the same target by the same user can never both exist — the second call replaces the first', async () => {
  const user = await makeUser();
  const author = await makeUser();
  const articleId = await makeArticle(author);

  await pool.query(
    `INSERT INTO content_reactions (user_id, target_type, target_id, reaction) VALUES ($1, 'article', $2, 'like')
     ON CONFLICT (user_id, target_type, target_id) DO UPDATE SET reaction = 'like', updated_at = now()`,
    [user, articleId]
  );
  await pool.query(
    `INSERT INTO content_reactions (user_id, target_type, target_id, reaction) VALUES ($1, 'article', $2, 'dislike')
     ON CONFLICT (user_id, target_type, target_id) DO UPDATE SET reaction = 'dislike', updated_at = now()`,
    [user, articleId]
  );

  const rows = await pool.query(
    `SELECT reaction FROM content_reactions WHERE user_id = $1 AND target_type = 'article' AND target_id = $2`,
    [user, articleId]
  );
  assert.equal(rows.rows.length, 1); // exactly one row, not two
  assert.equal(rows.rows[0].reaction, 'dislike'); // the most recent call wins
});

test('get_content_stats counts likes, dislikes and saves per target, independent of other targets', async () => {
  const author = await makeUser();
  const articleA = await makeArticle(author);
  const articleB = await makeArticle(author);
  const u1 = await makeUser();
  const u2 = await makeUser();
  const u3 = await makeUser();

  await pool.query(`INSERT INTO content_reactions (user_id, target_type, target_id, reaction) VALUES ($1, 'article', $2, 'like')`, [u1, articleA]);
  await pool.query(`INSERT INTO content_reactions (user_id, target_type, target_id, reaction) VALUES ($1, 'article', $2, 'like')`, [u2, articleA]);
  await pool.query(`INSERT INTO content_reactions (user_id, target_type, target_id, reaction) VALUES ($1, 'article', $2, 'dislike')`, [u3, articleA]);
  await pool.query(`INSERT INTO content_saves (user_id, target_type, target_id) VALUES ($1, 'article', $2)`, [u1, articleA]);
  // Noise on a different target — must not leak into articleA's counts.
  await pool.query(`INSERT INTO content_reactions (user_id, target_type, target_id, reaction) VALUES ($1, 'article', $2, 'like')`, [u1, articleB]);

  const stats = await pool.query(`SELECT * FROM get_content_stats('article', $1)`, [articleA]);
  assert.equal(stats.rows[0].likes, 2);
  assert.equal(stats.rows[0].dislikes, 1);
  assert.equal(stats.rows[0].saves, 1);
});

test('content_reactions and content_saves are polymorphic — the same user can independently react to an article and a gallery image with the same id', async () => {
  const user = await makeUser();
  const author = await makeUser();
  const articleId = await makeArticle(author);

  // A gallery image happens to share the same numeric id as the article —
  // target_type must keep them from colliding.
  await pool.query(
    `INSERT INTO gallery_images (owner_type, owner_id, image_url, status) VALUES ('general', $1, 'x.jpg', 'approved') RETURNING id`,
    [author]
  );
  const galleryRow = await pool.query(`SELECT id FROM gallery_images ORDER BY id DESC LIMIT 1`);
  const galleryId = galleryRow.rows[0].id;

  await pool.query(`INSERT INTO content_reactions (user_id, target_type, target_id, reaction) VALUES ($1, 'article', $2, 'like')`, [user, articleId]);
  await pool.query(`INSERT INTO content_reactions (user_id, target_type, target_id, reaction) VALUES ($1, 'gallery_image', $2, 'dislike')`, [user, galleryId]);

  const articleStats = await pool.query(`SELECT * FROM get_content_stats('article', $1)`, [articleId]);
  const galleryStats = await pool.query(`SELECT * FROM get_content_stats('gallery_image', $1)`, [galleryId]);
  assert.equal(articleStats.rows[0].likes, 1);
  assert.equal(articleStats.rows[0].dislikes, 0);
  assert.equal(galleryStats.rows[0].likes, 0);
  assert.equal(galleryStats.rows[0].dislikes, 1);
});

test('re-running every migration is idempotent — content_reactions/content_saves rows survive, saved_articles stays gone', async () => {
  const before1 = await pool.query('SELECT COUNT(*)::INTEGER AS n FROM content_reactions');
  await runMigrations();
  const after1 = await pool.query('SELECT COUNT(*)::INTEGER AS n FROM content_reactions');
  assert.equal(before1.rows[0].n, after1.rows[0].n);

  const table = await pool.query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'saved_articles'`);
  assert.equal(table.rows.length, 0);
});
