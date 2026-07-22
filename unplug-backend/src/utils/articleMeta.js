// Derives article metadata from the submitted text.
//
// What this is: extraction, not authorship. Takeaways are real sentences
// lifted from the article, keywords are the terms it actually uses most, and
// the category is a keyword match. Nothing here invents wording the author
// didn't write, which is the point — an editor reviews and corrects all of it
// before publishing, and a wrong-but-plausible invented sentence is far more
// dangerous in a news article than an obviously-needs-editing one.

// Words carrying no topical signal. Deliberately includes common South
// African filler alongside standard English stop words.
const STOP_WORDS = new Set(`a about above after again against all am an and any are aren't as at be because been
before being below between both but by can't cannot could couldn't did didn't do does doesn't doing don't down during
each few for from further had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself him
himself his how how's i i'd i'll i'm i've if in into is isn't it it's its itself let's me more most mustn't my myself no
nor not of off on once only or other ought our ours ourselves out over own same shan't she she'd she'll she's should
shouldn't so some such than that that's the their theirs them themselves then there there's these they they'd they'll
they're they've this those through to too under until up very was wasn't we we'd we'll we're we've were weren't what
what's when when's where where's which while who who's whom why why's with won't would wouldn't you you'd you'll you're
you've your yours yourself yourselves also just get got make made say said says will now new one two three back come
came take took see saw know knew think thought want went going really much many lot
making taking giving getting coming going doing being having finally already always never often since still even
another around before during without within across among however therefore because although though while whether
years year time times day days week weeks month months thing things people person part parts way ways`.split(/\s+/));

// Related terms per category, so a suggestion can be made from what an
// article is actually about rather than requiring it to literally contain the
// category's own name. Curated deliberately — this is a lookup table, not a
// model, and adding a term here is a visible editorial decision.
const CATEGORY_HINTS = {
  'arts & creativity': ['art', 'artist', 'music', 'musician', 'band', 'album', 'song', 'paint', 'design', 'creative', 'dance', 'theatre', 'poet', 'craft'],
  'entertainment & culture': ['film', 'movie', 'music', 'album', 'band', 'concert', 'festival', 'celebrity', 'culture', 'heritage', 'tradition', 'performance', 'show'],
  'business': ['business', 'company', 'entrepreneur', 'startup', 'market', 'revenue', 'client', 'trade', 'shop', 'store', 'brand', 'invest'],
  'career success': ['career', 'job', 'promotion', 'skills', 'training', 'employ', 'workplace', 'profession', 'graduate', 'interview'],
  'community impact': ['community', 'volunteer', 'charity', 'donate', 'outreach', 'support', 'neighbour', 'township', 'upliftment', 'ubuntu'],
  'education & skills': ['school', 'learn', 'student', 'teacher', 'education', 'training', 'university', 'college', 'bursary', 'literacy'],
  'health & wellness': ['health', 'wellness', 'fitness', 'mental', 'doctor', 'clinic', 'therapy', 'nutrition', 'exercise'],
  'sport': ['sport', 'team', 'match', 'player', 'coach', 'league', 'tournament', 'athlete', 'rugby', 'soccer', 'cricket'],
  'deaf community': ['deaf', 'sign', 'sasl', 'hearing', 'interpreter', 'accessibility', 'inclusion'],
};

function stripHtml(text) {
  return String(text || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

// URL slug from the title. Kept to 80 characters so links stay readable.
function slugify(title) {
  return String(title || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80)
    .replace(/-$/, '');
}

function sentences(text) {
  return stripHtml(text)
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 40 && s.length < 300);
}

// Word frequency, ignoring stop words and very short tokens.
function termFrequency(text) {
  const counts = new Map();
  stripHtml(text).toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/)
    .filter((w) => w.length > 3 && !STOP_WORDS.has(w))
    .forEach((w) => counts.set(w, (counts.get(w) || 0) + 1));
  return counts;
}

function keywords(text, limit = 8) {
  const all = [...termFrequency(text).entries()].sort((a, b) => b[1] - a[1]);
  // Prefer words the article uses more than once — a single mention usually
  // isn't what the piece is about. But short articles rarely repeat anything,
  // and returning nothing at all is worse than returning its main nouns, so
  // fall back to the top terms when the repeated ones are too few.
  const repeated = all.filter(([, n]) => n > 1);
  const source = repeated.length >= Math.min(limit, 3) ? repeated : all;
  return source.slice(0, limit).map(([w]) => w);
}

// Picks the sentences that best represent the article, by scoring each on the
// frequency of the meaningful words it contains. Returned in the order they
// appear so the takeaways still read as a sequence.
function keyTakeaways(text, limit = 4) {
  const freq = termFrequency(text);
  const list = sentences(text);
  if (list.length === 0) return [];
  const scored = list.map((sentence, index) => {
    const words = sentence.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/)
      .filter((w) => w.length > 3 && !STOP_WORDS.has(w));
    if (words.length === 0) return { sentence, index, score: 0 };
    const total = words.reduce((sum, w) => sum + (freq.get(w) || 0), 0);
    // Divide by length so a long rambling sentence doesn't win on volume.
    return { sentence, index, score: total / words.length };
  });
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .sort((a, b) => a.index - b.index)
    .map((s) => s.sentence);
}

// Tags are keywords presented for humans: title case, and capped tighter
// because a wall of tags helps nobody.
function suggestedTags(text, limit = 5) {
  return keywords(text, limit).map((w) => w.charAt(0).toUpperCase() + w.slice(1));
}

// Meta description: the opening of the article, trimmed at a word boundary.
// Search engines and social cards cut around 160 characters.
function metaDescription(text, limit = 155) {
  const clean = stripHtml(text);
  if (clean.length <= limit) return clean;
  const cut = clean.slice(0, limit);
  return cut.slice(0, cut.lastIndexOf(' ')).replace(/[,;:]$/, '') + '…';
}

// Suggests a category by matching its name against the article's own words.
// Returns null when nothing matches rather than guessing — a wrong category
// silently applied is worse than asking the editor to choose.
function suggestCategory(text, categories) {
  const freq = termFrequency(text);
  const lower = stripHtml(text).toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const cat of categories || []) {
    const name = String(cat.name || '').toLowerCase();
    // The category's own words count double — an article that says
    // "community" outright is a stronger signal than one that says "donate".
    const ownWords = name.split(/[^a-z]+/).filter((w) => w.length > 3);
    let score = ownWords.reduce((sum, w) => sum + (freq.get(w) || 0) * 2, 0);
    // Then related terms, matched as prefixes so "artist"/"artists" and
    // "employ"/"employment" both count.
    for (const hint of CATEGORY_HINTS[name] || []) {
      for (const [word, n] of freq) {
        if (word.startsWith(hint)) score += n;
      }
      // Short hints like "art" or "job" get filtered out of freq, so check
      // the raw text for those as whole words.
      if (hint.length <= 4 && new RegExp(`\\b${hint}s?\\b`).test(lower)) score += 1;
    }
    if (score > bestScore) { bestScore = score; best = cat; }
  }
  return bestScore > 0 ? best : null;
}

// Everything an article needs derived in one pass. Sections are folded into
// the text so metadata reflects the whole piece, not just the intro.
function deriveMetadata({ title, body, sections, categories }) {
  const full = [body || '', ...(sections || []).map((s) => `${s.sub_heading || ''} ${s.paragraph || ''}`)]
    .join('\n\n');
  const category = suggestCategory(`${title || ''} ${full}`, categories);
  return {
    slug: slugify(title),
    keyTakeaways: keyTakeaways(full),
    keywords: keywords(`${title || ''} ${full}`),
    tags: suggestedTags(full),
    metaDescription: metaDescription(full),
    suggestedCategoryId: category ? category.id : null,
    suggestedCategoryName: category ? category.name : null,
  };
}

module.exports = {
  slugify, keywords, keyTakeaways, suggestedTags, metaDescription,
  suggestCategory, deriveMetadata, stripHtml,
};
