// Unplug — structured data (schema.org) and the breadcrumb trail.
//
// WHAT THIS DOES. Search engines read schema.org JSON-LD to understand what a
// page IS — a news article, a business, a list — rather than guessing from the
// text. Get it right and a result can carry a headline, a date and an image
// instead of a blue link. Get it wrong and Google ignores the page's markup
// entirely, or worse, flags the site for describing content that is not there.
//
// WHY THIS RUNS IN THE BROWSER rather than being injected by a server.
//
// The article body, the profile, the Top 10 board — all of it is fetched and
// rendered here, in JavaScript. Google runs JavaScript when it indexes, so it
// sees that content on a second pass. Structured data has one hard rule:
// IT MUST DESCRIBE WHAT IS ACTUALLY ON THE PAGE. Injecting "this is an article
// by Thandi published on Tuesday" into the HTML before the article itself has
// loaded creates a window where the markup makes a claim the page cannot
// support — which is the one thing Google explicitly penalises.
//
// So the schema is written at the same moment the content it describes
// appears. Data and description arrive together and cannot disagree.
//
// ONE SOURCE FOR THE BREADCRUMB. The visible trail a reader clicks and the
// BreadcrumbList a crawler reads are built from the same array, in the same
// call. They cannot drift, because there is nothing to keep in step.
//
// NOTHING IS INVENTED. Every builder below omits a field it has no real value
// for. An article with no author byline gets no author; a business with no
// address gets no address. A missing field costs a rich-result feature. A
// fabricated one is a lie about a real person, and this is a magazine about
// real people.

(function () {
  'use strict';

  var ORIGIN = 'https://www.unplugnews.com';
  var ORG_ID = ORIGIN + '/#organization';

  // The page-level schema lives in its OWN script tag. The sitewide
  // Organization and WebSite block in the HTML head is never touched — that
  // describes the publication and is true on every page.
  var NODE_ID = 'unplug-page-schema';

  function absolute(url) {
    if (!url) return null;
    // &amp; is undone first. Some links were stored already HTML-escaped, and
    // JSON-LD is not HTML: an "&amp;" left in a sameAs URL is a link to an
    // address that does not exist.
    var s = String(url).trim().replace(/&amp;/g, '&');
    if (!s) return null;
    if (/^https?:\/\//i.test(s)) return s;
    return ORIGIN + (s.charAt(0) === '/' ? '' : '/') + s;
  }

  // Schema dates are ISO 8601. An unparseable date is dropped rather than
  // guessed at — a wrong datePublished is worse than none, because it is the
  // field Google shows next to the headline.
  function isoDate(value) {
    if (!value) return null;
    var d = new Date(value);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  // Plain text, always. Every string in this file passes through here.
  //
  // Profile bios and article bodies hold real markup — the imported WordPress
  // ones carry <img> tags and "<!-- wp:paragraph -->" comments. Schema.org
  // fields are text, not HTML: handing Google a description made of tags gets
  // the whole block treated as junk, and a bio that renders as a picture on the
  // page becomes an empty-looking string in the markup.
  //
  // Entities are decoded after the tags come out, so "Jack &amp; Jill" reads
  // the way it was written rather than the way it was stored.
  function text(value, max) {
    if (value === null || value === undefined) return null;
    var s = String(value)
      .replace(/<!--[\s\S]*?-->/g, ' ')     // comments, WordPress block markers included
      .replace(/<[^>]*>/g, ' ')             // tags
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#0?39;|&apos;/gi, "'")
      .replace(/\s+/g, ' ')
      .trim();
    if (!s) return null;
    return max && s.length > max ? s.slice(0, max - 1) + '…' : s;
  }

  // Drops every key whose value is null, undefined, '' or an empty array, so a
  // builder can list every field it might emit and the absent ones simply do
  // not appear.
  function compact(obj) {
    var out = {};
    Object.keys(obj).forEach(function (k) {
      var v = obj[k];
      if (v === null || v === undefined || v === '') return;
      if (Array.isArray(v) && v.length === 0) return;
      out[k] = v;
    });
    return out;
  }

  var publisher = { '@id': ORG_ID };

  // -------------------------------------------------------------------------
  // Writing the graph onto the page
  // -------------------------------------------------------------------------

  function clear() {
    var existing = document.getElementById(NODE_ID);
    if (existing) existing.parentNode.removeChild(existing);
  }

  // Replaces whatever the previous page wrote. Clearing on every set is what
  // stops an article's schema lingering on the homepage after a reader
  // navigates away — the same class of mistake as a canonical tag left
  // pointing at the last page viewed.
  function setGraph(nodes) {
    clear();
    var list = (nodes || []).filter(Boolean);
    if (!list.length) return;
    var script = document.createElement('script');
    script.type = 'application/ld+json';
    script.id = NODE_ID;
    // textContent, never innerHTML: this string contains titles and names
    // people typed, and JSON.stringify does not escape "</script>".
    script.textContent = JSON.stringify({
      '@context': 'https://schema.org',
      '@graph': list,
    }, null, 2);
    document.head.appendChild(script);
  }

  // -------------------------------------------------------------------------
  // Breadcrumbs — the visible trail and the BreadcrumbList, from one array
  //
  // trail: [{ name, url }, ...] ending with the current page, whose url may be
  // omitted because a breadcrumb never links to where you already are.
  // -------------------------------------------------------------------------

  function breadcrumbList(trail) {
    var items = (trail || []).filter(function (t) { return t && t.name; });
    if (items.length < 2) return null;   // "Home" alone is not a trail
    return {
      '@type': 'BreadcrumbList',
      itemListElement: items.map(function (t, i) {
        return compact({
          '@type': 'ListItem',
          position: i + 1,
          name: text(t.name, 120),
          // The last item is the current page and carries no item URL, which
          // is what Google's own examples do.
          item: t.url ? absolute(t.url) : undefined,
        });
      }),
    };
  }

  function renderBreadcrumb(trail, containerId) {
    var host = document.getElementById(containerId || 'breadcrumb');
    if (!host) return;
    var items = (trail || []).filter(function (t) { return t && t.name; });
    if (items.length < 2) { host.innerHTML = ''; host.hidden = true; return; }

    var nav = document.createElement('nav');
    nav.setAttribute('aria-label', 'Breadcrumb');
    nav.className = 'breadcrumb';

    var ol = document.createElement('ol');
    ol.className = 'breadcrumb-list';

    items.forEach(function (t, i) {
      var last = i === items.length - 1;
      var li = document.createElement('li');
      li.className = 'breadcrumb-item';

      if (last || !t.url) {
        var span = document.createElement('span');
        span.textContent = t.name;
        // Announces to a screen reader which crumb is the page you are on,
        // rather than leaving it as one more item in a list.
        span.setAttribute('aria-current', 'page');
        li.appendChild(span);
      } else {
        var a = document.createElement('a');
        a.href = t.url;
        a.textContent = t.name;
        li.appendChild(a);
      }
      ol.appendChild(li);
    });

    nav.appendChild(ol);
    host.innerHTML = '';
    host.appendChild(nav);
    host.hidden = false;
  }

  // The one call a page makes: draws the trail and returns the matching
  // BreadcrumbList for the graph. Because both come from here, the thing a
  // reader sees and the thing a crawler reads are the same thing by
  // construction.
  function breadcrumb(trail, containerId) {
    renderBreadcrumb(trail, containerId);
    return breadcrumbList(trail);
  }

  // -------------------------------------------------------------------------
  // Builders. Each takes the object the page already fetched.
  // -------------------------------------------------------------------------

  // NewsArticle rather than Article: this is a news publication, and
  // NewsArticle is what Google's Top Stories treatment reads.
  function article(a, url) {
    if (!a) return null;
    var img = absolute(a.banner_image_url);
    return compact({
      '@type': 'NewsArticle',
      mainEntityOfPage: { '@type': 'WebPage', '@id': absolute(url) },
      // THE TITLE, NOT THE SEO TITLE. seo_title is written for the browser tab
      // and the search snippet, so it carries the " | Unplug Magazine" suffix.
      // headline is the headline of the piece itself; putting the publication
      // name inside it describes a story nobody wrote. Google truncates a
      // headline past about 110 characters.
      headline: text(a.title || a.seo_title, 110),
      description: text(a.meta_description || a.subtitle, 300),
      image: img ? [img] : undefined,
      datePublished: isoDate(a.published_at),
      // dateModified is deliberately absent: articles carry no modified
      // timestamp, and repeating datePublished here would assert the piece has
      // never been edited, which nobody knows to be true.
      author: authorOf(a),
      publisher: publisher,
      articleSection: text(a.category, 60),
      inLanguage: 'en',
    });
  }

  // Only a name we actually hold. published_by is the server's derived byline
  // (a typed byline, else the submitting account's name); contributor_name is
  // an explicit editorial credit with a page behind it. With neither, the
  // article gets no author rather than being credited to the publication,
  // which would put the magazine's name on a piece a person wrote.
  function authorOf(a) {
    var name = text(a.contributor_name || a.published_by || a.author_name, 120);
    if (!name) return undefined;
    return compact({
      '@type': 'Person',
      name: name,
      url: a.contributor_slug ? ORIGIN + '/?p=contributor&slug=' + encodeURIComponent(a.contributor_slug) : undefined,
    });
  }

  // A Directory listing is a Person or a LocalBusiness depending on what it
  // says it is. Calling a person a business (or the reverse) is the sort of
  // wrong type that makes Google discard the markup.
  function profile(p, url) {
    if (!p) return null;
    var isBusiness = p.type === 'business';
    var img = absolute(p.feature_image_url);

    var address = compact({
      '@type': 'PostalAddress',
      addressLocality: text(p.city, 120),
      addressRegion: text(p.province, 80),
      addressCountry: (p.city || p.province) ? 'ZA' : undefined,
    });

    var geo = (p.latitude && p.longitude) ? {
      '@type': 'GeoCoordinates',
      latitude: Number(p.latitude),
      longitude: Number(p.longitude),
    } : undefined;

    return compact({
      '@type': isBusiness ? 'LocalBusiness' : 'Person',
      '@id': absolute(url) + '#subject',
      name: text(p.display_name, 160),
      description: text(p.bio, 400),
      image: img || undefined,
      url: absolute(url),
      email: text(p.contact_email, 200),
      telephone: text(p.contact_phone, 40),
      // Only when there is something in it — an empty PostalAddress is noise.
      address: Object.keys(address).length > 1 ? address : undefined,
      geo: geo,
      // sameAs is where a listing's own social links belong. Never the
      // magazine's: that would claim the business runs our accounts.
      sameAs: socialUrls(p),
      // No aggregateRating. The site has reviews, but emitting a rating a
      // business has not earned — or one averaged from two friendly reviews —
      // is exactly the fabrication that gets structured data penalised.
    });
  }

  function socialUrls(p) {
    var links = p.social_links || p.socialLinks || [];
    if (!Array.isArray(links)) return undefined;
    var urls = links
      .map(function (l) { return absolute(l && (l.url || l.link_url)); })
      .filter(function (u) { return u && /^https:\/\//i.test(u); });
    return urls.length ? urls : undefined;
  }

  // A ranked list — the Top 10 board. ItemList is what makes a list eligible
  // to be shown as one rather than as a wall of text.
  function itemList(name, entries, url) {
    var items = (entries || []).filter(function (e) { return e && e.name; });
    if (!items.length) return null;
    return compact({
      '@type': 'ItemList',
      name: text(name, 120),
      url: absolute(url),
      numberOfItems: items.length,
      itemListOrder: 'https://schema.org/ItemListOrderDescending',
      itemListElement: items.map(function (e, i) {
        return compact({
          '@type': 'ListItem',
          position: i + 1,
          name: text(e.name, 160),
          url: e.url ? absolute(e.url) : undefined,
        });
      }),
    });
  }

  // An Event: a competition that opens and closes, or a dated happening.
  //
  // The closing date is the part readers care about and the part a result can
  // show, so it is carried as endDate rather than dropped. A competition whose
  // closing date has passed is marked EventScheduled no longer — saying an
  // event is upcoming after it has ended is a claim the page cannot support.
  function event(e, url) {
    if (!e || !e.name) return null;
    var start = isoDate(e.event_date || e.startDate || e.opens_at);
    if (!start) return null;   // an Event with no date is not an Event
    var end = isoDate(e.endDate || e.closes_at);

    // Location is required by schema.org. A venue when there is one; otherwise
    // the honest answer for a competition run on this site is that it happens
    // on this site — not a guessed address.
    var place = e.venue
      ? { '@type': 'Place', name: text(e.venue, 160) }
      : { '@type': 'VirtualLocation', url: absolute(url) || ORIGIN };

    return compact({
      '@type': 'Event',
      name: text(e.name, 160),
      description: text(e.description, 400),
      startDate: start,
      endDate: end || undefined,
      location: place,
      eventAttendanceMode: e.venue
        ? undefined
        : 'https://schema.org/OnlineEventAttendanceMode',
      image: absolute(e.image_url) || undefined,
      organizer: publisher,
      url: absolute(url),
      eventStatus: 'https://schema.org/EventScheduled',
    });
  }

  // An edition of the magazine.
  function edition(ed, url) {
    if (!ed || !(ed.title || ed.name)) return null;
    return compact({
      '@type': 'CreativeWork',
      name: text(ed.title || ed.name, 160),
      description: text(ed.description, 400),
      datePublished: isoDate(ed.published_at || ed.release_date),
      image: absolute(ed.cover_image_url) || undefined,
      publisher: publisher,
      url: absolute(url),
      inLanguage: 'en',
    });
  }

  window.UnplugSchema = {
    setGraph: setGraph,
    clear: clear,
    breadcrumb: breadcrumb,
    breadcrumbList: breadcrumbList,
    article: article,
    profile: profile,
    itemList: itemList,
    event: event,
    edition: edition,
    absolute: absolute,
  };
})();
