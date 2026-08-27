#!/usr/bin/env node
// Runs from `pretest`. See test/helpers/textSearch.js for the whole story —
// briefly: the embedded-postgres bundle omits tsearch_data/english.stop, and
// without it every INSERT into articles, profiles or my_unplug_profiles fails,
// because migration 150 indexes to_tsvector('english', ...) over them.
//
// Safe to run any number of times, and on platforms where there is nothing to
// fix it prints nothing and exits 0.

const { ensureStopWords } = require('../test/helpers/textSearch');

try {
  const created = ensureStopWords();
  if (created.length) {
    console.log('Created missing text-search files for embedded-postgres: ' + created.join(', '));
  }
} catch (err) {
  // A failure here is not worth blocking the suite over — the tests that need
  // it will fail with a clear Postgres error naming the exact missing file.
  console.warn('Could not prepare text-search files: ' + err.message);
}
