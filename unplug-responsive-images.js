// Unplug — responsive images.
//
// Turns one stored image URL into a <picture> that serves AVIF to browsers
// that understand it, WebP to those that do not, and the original to anything
// older — each at a width close to the space it actually occupies, instead of
// sending a 1,911 KB photograph to a phone.
//
// THE RULE THIS FILE OBEYS: NEVER OFFER A FILE THAT MIGHT NOT EXIST.
//
// Derivative names are predictable, so it is tempting to build a srcset by
// pattern and be done. That would be wrong. A browser handed a srcset entry
// that 404s shows a BROKEN IMAGE — it does not quietly fall back to the
// original. So a derivative is only ever offered for an image the backend has
// confirmed it made, which is what /images/manifest is for.
//
// AND IT IS NEVER WORSE THAN DOING NOTHING. picture() is synchronous and works
// before the manifest arrives, before it fails, and with the manifest missing
// altogether — in each case returning the same plain <img> the site used to
// build by hand. The manifest makes pages lighter; it can never make them
// broken. That is why nothing here waits on it.

window.UnplugImg = (function () {
  'use strict';

  // Filled in by load(); until then every lookup simply misses and callers get
  // the original. Kept as a plain object rather than a Map so the whole thing
  // can be dropped in from sessionStorage without rebuilding it.
  var manifest = null;

  // Cached for the tab's lifetime. The HTTP cache handles repeat visits; this
  // handles repeat page views within one visit, where the request would
  // otherwise be made again on every navigation.
  var CACHE_KEY = 'unplug_img_manifest_v1';

  function apiBase() {
    try {
      return (window.UnplugAPI && UnplugAPI.getApiBase && UnplugAPI.getApiBase())
        || 'https://unplug-ecosystem.onrender.com';
    } catch (e) {
      return 'https://unplug-ecosystem.onrender.com';
    }
  }

  // The storage object key inside a public Supabase URL, or null.
  //
  // Anything that is not one of our public storage URLs returns null on
  // purpose: an image hosted elsewhere must never be given a srcset pointing
  // into our bucket.
  function keyFromUrl(url) {
    var m = String(url || '').match(/\/storage\/v1\/object\/public\/[^/]+\/(.+)$/);
    if (!m) return null;
    try {
      return decodeURIComponent(m[1].split('?')[0]);
    } catch (e) {
      return m[1].split('?')[0];
    }
  }

  // Everything before the object key, so derivative URLs can be built without
  // hard-coding the Supabase project host.
  function bucketRoot(url) {
    var i = String(url).indexOf('/storage/v1/object/public/');
    if (i === -1) return null;
    var rest = String(url).slice(i + '/storage/v1/object/public/'.length);
    var bucket = rest.split('/')[0];
    return String(url).slice(0, i) + '/storage/v1/object/public/' + bucket + '/';
  }

  function stem(key) {
    return key.replace(/\.[^./]+$/, '');
  }

  function load() {
    if (manifest) return;
    // A previous page view in this tab already fetched it.
    try {
      var cached = sessionStorage.getItem(CACHE_KEY);
      if (cached) { manifest = JSON.parse(cached); return; }
    } catch (e) { /* private mode, quota — fall through and fetch */ }

    fetch(apiBase() + '/images/manifest')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || !data.images) return;
        manifest = data;
        try { sessionStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch (e) { /* not important */ }
      })
      .catch(function () {
        // Deliberately silent. No manifest means originals, which is exactly
        // how this site behaved before responsive images existed.
      });
  }

  // What is known about one stored image, or null if it has no derivatives.
  function entryFor(url) {
    if (!manifest) return null;
    var key = keyFromUrl(url);
    if (!key) return null;
    var e = manifest.images[key];
    if (!e) return null;
    return {
      key: key,
      root: bucketRoot(url),
      widths: e.w || manifest.widths,
      dims: e.d || null,
      formats: manifest.formats,
      prefix: manifest.prefix || 'derivatives/',
    };
  }

  function srcsetFor(entry, ext) {
    return entry.widths.map(function (w) {
      return entry.root + entry.prefix + stem(entry.key) + '-' + w + '.' + ext + ' ' + w + 'w';
    }).join(', ');
  }

  function escapeAttr(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Builds the markup for one image.
  //
  //   url    the stored original — always what ends up in <img src>
  //   opts   alt      required for anything meaningful; '' for decoration
  //          sizes    CSS sizes attribute; how wide this will render
  //          eager    true for the one image above the fold (see below)
  //          className, style  passed through to the <img>
  //          width/height      override the intrinsic size
  //
  // Returns an HTML STRING, because that is how every render path in this
  // codebase builds markup — template literals assigned to innerHTML.
  function picture(url, opts) {
    var o = opts || {};
    var alt = escapeAttr(o.alt || '');
    var cls = o.className ? ' class="' + escapeAttr(o.className) + '"' : '';
    var style = o.style ? ' style="' + escapeAttr(o.style) + '"' : '';

    // LAZY BY DEFAULT, EAGER ONLY WHERE IT COUNTS. Lazy-loading the image at
    // the top of the page delays the very thing the reader is waiting for and
    // makes Largest Contentful Paint worse, so the caller marks that one
    // eager. fetchpriority tells the browser which race to win.
    var loading = o.eager ? ' loading="eager" fetchpriority="high"' : ' loading="lazy" decoding="async"';

    var entry = entryFor(url);

    // Width and height stop the page jumping as pictures arrive. The mobile
    // site loses 0.343 of Cumulative Layout Shift today, nearly all of it one
    // image with no dimensions. CSS still controls the displayed size; these
    // only give the browser the aspect ratio to reserve.
    var w = o.width || (entry && entry.dims && entry.dims[0]);
    var h = o.height || (entry && entry.dims && entry.dims[1]);
    var dims = (w && h) ? ' width="' + w + '" height="' + h + '"' : '';

    var sizes = o.sizes ? ' sizes="' + escapeAttr(o.sizes) + '"' : '';
    var img = '<img src="' + escapeAttr(url) + '" alt="' + alt + '"'
      + cls + style + dims + loading + '>';

    // No derivatives known: the original, exactly as before. This is the path
    // taken for every image until the backfill has run, and for anything
    // hosted off-site.
    if (!entry || !entry.root) return img;

    var sources = entry.formats.map(function (f) {
      return '<source type="' + f.mime + '" srcset="'
        + escapeAttr(srcsetFor(entry, f.ext)) + '"' + sizes + '>';
    }).join('');

    return '<picture>' + sources + img + '</picture>';
  }

  // For images already in the DOM that were not built through picture():
  // adds loading="lazy" and decoding="async" to anything below the fold that
  // has not opted out. Cheap, and it covers the markup this helper has not
  // been threaded through yet.
  function lazifyExisting(root) {
    var scope = root || document;
    var imgs = scope.querySelectorAll('img:not([loading]):not([data-eager])');
    for (var i = 0; i < imgs.length; i++) {
      imgs[i].setAttribute('loading', 'lazy');
      imgs[i].setAttribute('decoding', 'async');
    }
    // Third-party embeds are the heaviest thing on the page after images —
    // a YouTube player is 466 KB before anyone presses play.
    var frames = scope.querySelectorAll('iframe:not([loading])');
    for (var j = 0; j < frames.length; j++) {
      frames[j].setAttribute('loading', 'lazy');
    }
  }

  load();

  return {
    picture: picture,
    lazifyExisting: lazifyExisting,
    keyFromUrl: keyFromUrl,
    bucketRoot: bucketRoot,
    // Exposed for tests and for the admin screen that reports coverage.
    _entryFor: entryFor,
    _setManifest: function (m) { manifest = m; },
    _manifest: function () { return manifest; },
  };
})();
