// Make full-text search usable under embedded-postgres.
//
// THE PROBLEM. @embedded-postgres/<platform> ships share/tsearch_data with
// only the hunspell samples in it — every .stop file that a real Postgres
// install carries has been stripped out of the bundle. The 'english' text
// search configuration needs english.stop, so without it ANY call to
// to_tsvector('english', ...) fails with:
//
//     could not open stop-word file ".../tsearch_data/english.stop"
//
// This is a gap in the test dependency's packaging, not in our SQL. A real
// Postgres — Render's, Supabase's, any apt/brew install — has these files.
//
// WHY IT MATTERS TO EVERY TEST, NOT JUST THE SEARCH ONES. Migration 150 builds
// GIN indexes over to_tsvector('english', ...) on articles, profiles and
// my_unplug_profiles. Every test file runs every migration. On empty tables the
// CREATE INDEX succeeds — there are no rows to evaluate — so nothing complains
// at migration time. The failure lands later, on the first INSERT into any of
// those three tables, because maintaining the index needs the stop file. That
// is most of the suite. Wrapping the CREATE INDEX in an exception handler does
// NOT help for exactly this reason, which is worth knowing before trying it.
//
// THE FIX. Postgres only requires the file to EXIST. An empty one is valid and
// means "this language has no stop words". Stemming is unaffected: that comes
// from the snowball dictionary, which is compiled into the server, not read
// from disk. So "running" still finds "runs", which is the property the search
// tests actually care about.
//
// The one behavioural difference from production is that common words like
// "the" and "and" are indexed here instead of being discarded. Nothing in the
// suite depends on stop-word filtering, and a test that did would be testing
// Postgres rather than us.
//
// Writing into node_modules is not lovely. It is also self-healing — this runs
// from `pretest` on every run, so an npm install that wipes it costs nothing.

const fs = require('fs');
const path = require('path');

// Every configuration the codebase actually uses. Add to this list rather than
// creating files ad hoc in a test.
const LANGUAGES = ['english'];

// Deliberately NOT require.resolve(): these packages declare an `exports` map
// that does not expose package.json, so resolving through it throws and the
// whole helper silently does nothing. Walk the directory instead.
function shareDirs() {
  const root = path.join(__dirname, '..', '..', 'node_modules', '@embedded-postgres');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .map((platform) => path.join(root, platform, 'native', 'share', 'tsearch_data'))
    .filter((dir) => fs.existsSync(dir));
}

// Returns the files it had to create, so a caller can report them. Never
// throws: on a platform whose bundle is complete there is nothing to do, and
// that is a success, not a failure.
function ensureStopWords() {
  const created = [];
  for (const dir of shareDirs()) {
    for (const lang of LANGUAGES) {
      const file = path.join(dir, lang + '.stop');
      if (!fs.existsSync(file)) {
        fs.writeFileSync(file, '', 'utf8');
        created.push(path.relative(path.join(__dirname, '..', '..'), file));
      }
    }
  }
  return created;
}

module.exports = { ensureStopWords, shareDirs };
