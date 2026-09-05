// THE RECOMMENDED SIZE FOR EVERY IMAGE ON THE SITE, IN ONE PLACE.
//
// These numbers used to be typed into each upload field by hand — about
// fifteen copies across the admin dashboard and the member dashboard — and
// they had already drifted apart:
//
//   * an EVENT image was "1600 × 900 (16:9)" on the member form and
//     "800 × 1200 (2:3 portrait)" in the admin, which are opposite shapes;
//   * an AD BANNER was "1920 × 600 (16:5)" on the member form, "1920 × 1080
//     (16:9)" in one admin panel and "1920 × 600" in another — three answers
//     in two files, and none of them the real one (see AD_SLOT_SIZES below);
//   * the DIRECTORY listing image had no number at all, because the spec
//     document gives two different ones for it.
//
// EVERY NUMBER BELOW COMES FROM WHAT THE SITE ACTUALLY RENDERS, not from the
// spec document — the document contradicts itself in at least two places and
// does not always match the CSS. Each entry cites the rule it came from, so
// the next person can check the reasoning instead of trusting the number.
//
// `w`/`h` drive the non-blocking dimension warning in image-upload.js, which
// compares the ASPECT RATIO with a 4% tolerance. So these are shape-and-scale
// guidance, not a demand for exact pixels.

const IMAGE_SPECS = {
  // --- editorial --------------------------------------------------------
  article_cover: {
    w: 1920, h: 1080, label: '16:9 landscape',
    // Shown at three different shapes, so no single ratio fits them all:
    //   .story-thumb      4/3    news cards and related stories
    //   .featured-figure  16/10  the homepage slider
    //   article page      up to 860 x 420 (~2.05:1, a max-height cap)
    // 16:9 sits between the widest and the narrowest, and is what cameras and
    // phones export anyway. It is cropped at both ends, hence the note.
    //
    // Still used by the Highlight boost's own optional override image
    // (a separate, admin-only feature — see routes/highlights.js), which
    // is unrelated to publishing the article itself. NOT used for the
    // article's own cover any more — see the two below.
    note: 'Cropped to 4:3 on story cards and wider on the article page, so keep the subject centred.',
  },
  // The article cover doubles as the article's own social-share image
  // (og:image/twitter:image — see seoSetImage in unplug-magazine.html), so
  // the choice offered when publishing is the two ratios those platforms
  // actually use, not a third, site-specific one: 1.91:1 is Facebook's and
  // Twitter's own link-preview ratio, 4:5 is Instagram's own portrait-post
  // ratio. Whichever is chosen is still cropped into whatever shape the
  // on-site story cards/slider need (same as article_cover always was) —
  // this only changes what shape is offered and cropped from at upload
  // time, not how the site displays it afterwards.
  article_cover_landscape: {
    w: 1080, h: 566, label: '1.91:1 landscape',
    note: 'Facebook and Twitter\'s own link-preview ratio. Still cropped to fit the story cards and slider on the site itself.',
  },
  article_cover_portrait: {
    w: 1080, h: 1350, label: '4:5 portrait',
    note: 'Instagram\'s own portrait-post ratio. Still cropped to fit the story cards and slider on the site itself.',
  },
  article_body_image: {
    w: 1600, h: 1200, label: '4:3 landscape',
    note: 'Pictures inside the story body.',           // .art-gallery img 4/3
  },
  // The per-SECTION picture, not the "More images" gallery above — .art-figure
  // img is height:auto with no forced crop, so unlike every other image field
  // on the site, whichever shape is chosen here shows at its own real
  // proportions on the article page. Landscape and portrait are therefore a
  // straight 4:3/3:4 flip of the same numbers, not a different pair borrowed
  // from a social-platform convention the way the cover's is.
  article_section_image_landscape: {
    w: 1600, h: 1200, label: '4:3 landscape',
    note: 'Pictures inside the story body, shown at their own natural shape (not cropped to a box).',
  },
  article_section_image_portrait: {
    w: 1200, h: 1600, label: '3:4 portrait',
    note: 'Pictures inside the story body, shown at their own natural shape (not cropped to a box).',
  },

  event_image: {
    w: 1600, h: 900, label: '16:9 landscape',
    // LANDSCAPE, and this is the one the two dashboards disagreed about — the
    // admin said 800 x 1200 (2:3 portrait), which is the opposite shape.
    //   .cal-thumb img   width:100%; height:170px   the calendar card
    //   event detail     max-height:220px           full width of the column
    // A portrait upload is almost entirely cropped away in both.
    note: 'The calendar card shows a wide strip, so keep the subject centred.',
  },

  // --- directory and people --------------------------------------------
  directory_listing: {
    w: 1200, h: 1200, label: '1:1 square',
    // .dir-photo is aspect-ratio 1/1 on the Directory card and in the members
    // grid; .profile-photo-lg is a 110x110 circle on the listing page.
    note: 'Shown as a square on the Directory and as a circle on the listing itself, so keep the subject centred.',
  },
  profile_gallery: {
    w: 1200, h: 1200, label: '1:1 square',
    note: 'Shown as a square in the listing gallery.',  // .profile-gallery-item 1/1
  },
  person_portrait: {
    w: 800, h: 800, label: '1:1 square',
    note: 'A head-and-shoulders photo works best.',
  },
  impact_maker_photo: {
    w: 1080, h: 1350, label: '4:5 portrait',
    // Same numbers as gallery_photo below — a real card-shape reason, not
    // borrowed. Also used for a sponsor/business image: the crop is a
    // recommendation, not a demand (see the file header), so a landscape
    // logo still uploads fine without needing a second spec.
    note: 'A tall photo fills the Impact Makers card; a wide one is cropped at both ends.',
  },

  // --- gallery ----------------------------------------------------------
  gallery_photo: {
    w: 1080, h: 1350, label: '4:5 portrait',
    note: 'A tall photo fills the Gallery grid; a wide one is cropped at both ends.',       // .gallery-item 4/5
  },

  // --- editions ---------------------------------------------------------
  edition_cover: {
    w: 1200, h: 1600, label: '3:4 portrait',
    note: 'A magazine cover shape.',                    // .home-edition-cover 3/4
  },

  // --- projects ---------------------------------------------------------
  project_cover: {
    w: 1600, h: 1000, label: '16:10 landscape',
    note: 'The picture that represents the project in listings.',  // .proj-thumb, .spotlight-cover 16/10
  },
  project_image: {
    w: 1600, h: 1200, label: '4:3 landscape',
    note: 'Pictures inside the project gallery.',       // .proj-gallery img, .inv-proj-gallery-img 4/3
  },

  // --- paid placements --------------------------------------------------
  marketplace_poster: {
    w: 1600, h: 900, label: '16:9 landscape',
    note: 'Shown at 16:9 in the Marketplace.',          // .market-poster 16/9
  },
  placement_example: {
    w: 1200, h: 900, label: '4:3 landscape',
    note: 'The example picture on the rate card.',       // .brand-ad-preview 4/3
  },
  poster_slide: {
    w: 2100, h: 700, label: '3:1 wide banner',
    note: 'The wide advertiser slideshow.',             // .poster-slide 21/7
  },

  // --- page furniture ---------------------------------------------------
  cms_block: { w: 1920, h: 1080, label: '16:9 landscape', note: 'A page content block.' },       // .cms-block-img 16/9
  cms_block_portrait: { w: 1200, h: 1600, label: '3:4 portrait', note: 'A portrait page block.' }, // .cms-block-img-portrait 3/4
  cms_block_square: { w: 1200, h: 1200, label: '1:1 square', note: 'A square page block.' },      // .cms-block-img-square 1/1
  popup_image: { w: 1200, h: 900, label: '4:3 landscape', note: 'Shown inside the popup card.' },

  // --- the share card ---------------------------------------------------
  share_card_photo: {
    w: 1080, h: 1080, label: '1:1 square',
    note: 'Drawn into a circle on the card, so centre the face.',
  },
// --- fields that had NO guidance at all until now ----------------------
  //
  // Every one of these is an upload field somebody can already use; none of
  // them told the person what shape to bring. An upload with no stated size
  // is not a neutral default, it is a picture that gets cropped somewhere the
  // person who chose it never sees.
  ad_banner_mobile: {
    w: 300, h: 250, label: 'Medium Rectangle',
    // <picture><source media="(max-width:640px)" srcset="mobile_image_url">
    // The wide leaderboards are unreadable on a phone, so the mobile file is
    // the squarer format. object-fit is `contain`, so nothing is cropped.
    note: 'Shown on phones in place of the wide banner.',
  },
  sponsor_logo: {
    w: 600, h: 360, label: '5:3 landscape',
    // .proj-sponsor .logo-wrap is 150 x 90 with object-fit:contain, so the
    // whole logo is always visible and the ratio is guidance, not a crop.
    note: 'The whole logo always shows, so a transparent PNG works best.',
  },
  competition_entry: {
    w: 1080, h: 1350, label: '4:5 portrait',
    note: 'A portrait photo of the entrant.',
  },
  youtube_thumb: {
    w: 1920, h: 1080, label: '16:9 landscape',
    note: 'The picture on the YouTube panel.',        // .youtube-embed 56.25% = 16:9
  },
  site_feature_edition: {
    w: 1200, h: 900, label: '4:3 landscape',
    note: 'The invitation block near the bottom of the homepage.',
  },
};

// AD BANNERS ARE NOT ONE SIZE, which is why every hardcoded number for them
// was wrong. Each slot on the site is a standard advertising format, and the
// public page states it in the placeholder that sits there until a banner is
// sold ("Advertisement — 728×90 Leaderboard"). The size therefore depends on
// the placement the advertiser chose, and the buy form has that dropdown
// already — it just never used it for anything.
const AD_SLOT_SIZES = {
  'home-sponsor-1': { w: 300, h: 250, label: 'Medium Rectangle' },
  'home-sponsor-2': { w: 300, h: 250, label: 'Medium Rectangle' },
  'home-sponsor-3': { w: 300, h: 250, label: 'Medium Rectangle' },
  'news-leaderboard': { w: 728, h: 90, label: 'Leaderboard' },
  'directory-sponsor': { w: 300, h: 250, label: 'Medium Rectangle' },
  'gallery-sponsor': { w: 300, h: 250, label: 'Medium Rectangle' },
  'top10-sponsor': { w: 300, h: 250, label: 'Medium Rectangle' },
  'editions-sponsor': { w: 300, h: 250, label: 'Medium Rectangle' },
  'editions-leaderboard': { w: 728, h: 90, label: 'Leaderboard' },
  'competitions-leaderboard': { w: 728, h: 90, label: 'Leaderboard' },
  'investors-leaderboard': { w: 728, h: 90, label: 'Leaderboard' },
  'about-leaderboard': { w: 728, h: 90, label: 'Leaderboard' },
  'contact-leaderboard': { w: 728, h: 90, label: 'Leaderboard' },
};

// A ready-made sentence, so the admin and the member form word it identically.
function describe(spec) {
  if (!spec) return null;
  return `${spec.w} × ${spec.h}px (${spec.label})` + (spec.note ? ` — ${spec.note}` : '');
}

module.exports = { IMAGE_SPECS, AD_SLOT_SIZES, describe };
