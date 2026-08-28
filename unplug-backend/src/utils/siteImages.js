// The pictures on the site an admin is allowed to swap.
//
// A picture is made changeable by doing two things:
//
//   1. tag the <img> in unplug-magazine.html with data-cms-img="<key>";
//   2. add the same key to the list below, with wording that tells an admin
//      which picture it is when they are looking at a dropdown, not the page.
//
// The list is what the admin screen renders, so adding an entry here is all
// that is needed to put a new upload field in front of the owner. There is no
// second copy of it anywhere.
//
// The pairing between the two IS a coupling, and this codebase has been bitten
// by that shape before — a price list that "mirrors" another price list drifts
// the moment one side changes. So test/siteImages.test.js asserts in both
// directions: every key here is tagged in the page, and every tag in the page
// is listed here. A mismatch fails the build rather than quietly producing an
// upload field that changes nothing, or a picture nobody can reach.
//
// Values are stored in page_content under page_key/content_key, split on the
// FIRST dot, exactly like the text keys: "home.feature_edition.image" is
// page "home", key "feature_edition.image".

const { IMAGE_SPECS } = require('./imageSpecs');

const SITE_IMAGES = [
  {
    key: 'home.feature_edition.image',
    label: 'Homepage — "Let\'s feature you in our upcoming edition"',
    hint: 'The picture in the invitation block near the bottom of the homepage. Swap it whenever the next edition changes.',
    // Guidance for the upload widget, not a hard crop. Taken from the one
    // size list rather than written out again here: a second copy of a number
    // is a number that will drift, which is the whole reason that list exists.
    ratio: IMAGE_SPECS.site_feature_edition,
  },
];

// Split on the first dot: "home.feature_edition.image" -> page "home".
function splitKey(key) {
  const dot = String(key).indexOf('.');
  if (dot < 1) return null;
  return { pageKey: key.slice(0, dot), contentKey: key.slice(dot + 1) };
}

function isKnownImageKey(key) {
  return SITE_IMAGES.some((i) => i.key === key);
}

// What may be stored as an image address.
//
// This value ends up as an <img src> on the public homepage, so it is checked
// on the way IN rather than trusted on the way out: an https URL, or a path on
// our own site. Anything else — javascript:, data:, a protocol-relative //host
// — is refused. The admin screen is behind a login, but a stored value that
// only gets validated at render time is one forgotten template away from being
// a hole.
function isSafeImageUrl(value) {
  const v = String(value == null ? '' : value).trim();
  if (!v) return false;
  if (v.length > 2000) return false;
  if (/^https:\/\/[^/\s]+\//i.test(v)) return true;      // absolute, https only
  if (/^\/[^/\s]/.test(v)) return true;                  // site-relative, not //host
  return false;
}

module.exports = { SITE_IMAGES, splitKey, isKnownImageKey, isSafeImageUrl };
