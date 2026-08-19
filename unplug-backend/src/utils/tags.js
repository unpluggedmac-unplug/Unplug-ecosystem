// WHAT COUNTS AS A TAG. One place, because four different things write them:
// the article editor, a member editing their own Directory listing, a member
// editing their My Unplug profile, and an admin editing anyone's. Four copies
// of "trim it and cap it at ten" would drift, and the drift would only show up
// as inconsistent search results nobody could explain.
//
// The database enforces the ceiling too (migration 121). This layer exists to
// CLEAN input rather than to reject it: somebody typing eleven tags meant to
// tag their listing, and failing their whole save over the eleventh would be a
// worse answer than keeping the first ten.

const MAX_TAGS = 10;
const MAX_TAG_LENGTH = 40;

// Tags are matched against each other in search and grouped in the analytics,
// so "Cape Town", "cape town" and " Cape  Town " have to become one thing.
// Case is preserved for display — a reader sees the tag as written — but
// comparison for duplicates is case-insensitive.
function cleanTag(raw) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw)
    .replace(/\s+/g, ' ')
    .replace(/^[#\s,]+|[#\s,]+$/g, '')
    .trim();
  if (!text) return null;
  // A comma inside a single tag almost always means somebody pasted a list
  // into one box; splitting is handled by the caller, so anything left here is
  // stripped rather than stored as part of the word.
  return text.slice(0, MAX_TAG_LENGTH);
}

// Accepts an array, or the comma-separated string a text input produces.
// Returns at most ten clean, unique tags in the order they were given.
function normaliseTags(input) {
  if (input === null || input === undefined) return null;

  const list = Array.isArray(input)
    ? input
    : String(input).split(',');

  const out = [];
  const seen = new Set();
  for (const item of list) {
    const tag = cleanTag(item);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue; // the same tag twice is one tag
    seen.add(key);
    out.push(tag);
    if (out.length >= MAX_TAGS) break; // keep the first ten rather than failing the save
  }
  return out;
}

// True when the caller asked for more than we kept, so a screen can say
// "only the first ten were saved" instead of silently dropping the rest.
function wasTruncated(input) {
  if (input === null || input === undefined) return false;
  const list = Array.isArray(input) ? input : String(input).split(',');
  const clean = list.map(cleanTag).filter(Boolean);
  const unique = new Set(clean.map((t) => t.toLowerCase()));
  return unique.size > MAX_TAGS;
}

module.exports = { MAX_TAGS, MAX_TAG_LENGTH, cleanTag, normaliseTags, wasTruncated };
