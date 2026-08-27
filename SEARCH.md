# Search

Search was `ILIKE '%term%'` ordered by publication date, shown in an overlay
capped at eight of each kind. It found things. It just could not put the
obvious answer first, and it could not survive a typo.

## What changed

**Relevance.** The article actually *called* "Load Shedding" now comes first
for "load shedding", instead of whichever piece mentioned it most recently.
Title outranks standfirst outranks body, via `ts_rank` over weighted vectors.

**Stemming.** "running" finds "Runs". Full-text search understands that those
are the same word; `ILIKE` never could.

**Typos.** "fashon" is answered with *Did you mean Fashion?* rather than a
blank page.

**A results page.** `?p=search&q=…` — filterable by type, category and date,
paginated, with the matched words highlighted in context. The overlay stays as
the quick peek and now offers **See all results**; pressing Enter goes there.

The whole state of a search lives in the URL, which is the reason for having a
page at all: an overlay cannot be bookmarked, shared, or returned to with the
back button.

## The two things most likely to bite later

**1. The index expression must match the query, character for character.**

`idx_articles_fts` is an *expression* index. Postgres only uses it when the
query spells the expression identically. Add a column to the search in
`routes/search.js`, forget migration 150, and nothing looks broken — the same
results come back. The site just quietly starts reading every article body on
every keystroke.

Nothing would ever tell you. So `search.js` exports the expressions as `FTS`,
migration 150 is built from the same strings, and a test plans the real query
with `enable_seqscan = off` and fails if the planner cannot reach the index.

**2. Highlighting is never sent as HTML.**

`ts_headline` does **not** escape the text it is given, and the text it is
given is article bodies. Asking it for `<mark>` tags would mean handing the
client a string assembled out of user content and expecting it to be trusted.

So the server marks hits with `chr(2)`/`chr(3)`, and the client escapes the
whole snippet **first**, then swaps the markers for `<mark>`. Verified against
a hostile snippet: `<img onerror>` and `<script>` produce no elements, only
text. Unbalanced markers — a fragment cut mid-highlight — are balanced rather
than left to swallow the rest of the page.

Postgres's parser turns out to drop HTML tags from headlines anyway. That is a
useful second line of defence, not the first one.

## Public input, so: `websearch_to_tsquery`

Never `to_tsquery`. It **throws** on syntax it dislikes, and this endpoint
takes whatever a stranger types — `C++ & `, an unclosed quote, `!!!`. Those are
200s now, and there is a test that keeps them that way.

## pg_trgm may not be there

"Did you mean" is a trigram feature. `pg_trgm` is a contrib extension: a real
Postgres has it, the embedded build the tests run against **does not** — the
same gap migration 135 already documents.

Every migration re-runs on every deploy and `npm start` is
`migrate && node src/app.js`, so a migration that throws is not a degraded
feature, it is the API never starting. The extension and its indexes are
therefore wrapped: a Postgres without them logs a loud notice and carries on,
and suggestions degrade to `null` rather than a 500.

**Consequence worth knowing:** the suggestion quality cannot be exercised
locally. The test asserts the graceful-degradation path instead, and skips the
quality assertion with a diagnostic when the extension is absent.

## The test environment needs a file that the bundle omits

`@embedded-postgres/*` ships `share/tsearch_data` containing only hunspell
samples — every `.stop` file was stripped. Without `english.stop`, *any*
`to_tsvector('english', …)` fails.

That is not confined to the search tests. Migration 150 indexes three tables
that nearly every test inserts into, and on empty tables the `CREATE INDEX`
succeeds — the failure only lands on the first INSERT afterwards. Wrapping the
index creation in an exception handler does **not** help for that reason.

`npm run pretest` therefore writes an empty `english.stop` if it is missing
(see `test/helpers/textSearch.js`). Empty is valid and means "no stop words";
stemming is unaffected because that comes from the compiled-in snowball
dictionary, not from disk.

## What is deliberately unchanged

`GET /search` keeps its old response shape — `{ query, results: { articles,
profiles, editions, members } }` — because the overlay reads exactly those
keys. Everything new (`totals`, `suggestion`, `snippet`, `page`, `limit`) is
additive, and a test asserts the old shape is intact.

Editions are still matched with `ILIKE`. They have a title and nothing else
worth searching; full-text search over six words would only stop "Ed" matching
"Edition", which is the opposite of helpful.

Tags are still matched with `ILIKE` rather than joining the tsvector, because a
tag exists so that a partial word finds the piece — "fash" finding "Fashion" —
which stemming does not do. A tag-only hit is ranked below a real textual
match rather than at the bottom.

## Privacy

Pending articles and unpublished My Unplug profiles are not search results, and
there are tests for both. A search result is a public page.

A search that finds **nothing** is still recorded as an analytics event. It is
the most useful editorial signal on the site: a subject the audience asked for
and the magazine does not cover. Traffic figures can only ever describe what
was already published.

## Files

| | |
|---|---|
| `unplug-backend/src/routes/search.js` | Ranking, filters, pagination, suggestions. Exports `FTS`. |
| `unplug-backend/db/migrations/150_search_ranking.sql` | The GIN and trigram indexes. |
| `unplug-backend/test/siteSearch.test.js` | 25 tests against a real PostgreSQL. |
| `unplug-backend/test/helpers/textSearch.js` | Works around the embedded-postgres packaging gap. |
| `unplug-magazine.html` | The results page, and the overlay's route into it. |

## Rolling back

Drop the six indexes from migration 150 and revert `search.js` — the old ILIKE
version is one commit back and its response shape is unchanged, so the overlay
keeps working either way. Remove `page-search` and the `?p=search` route from
the magazine. Nothing else references any of it.
