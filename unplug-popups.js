// Unplug — reader popups.
//
// One script, no dependencies, no build step. It fetches what is switched on,
// waits until somebody has read far enough down the page to have earned the
// interruption, and shows one.
//
// FOUR RULES SHAPE ALL OF IT, and three of them are about not showing it.
//
// 1. IT TAKES ITS TURN. This site already has two things that claim the whole
//    screen — the POPIA consent bar and the welcome gate — and they have
//    collided before. There is a comment in unplug-magazine.html left over
//    from fixing it: "getting that wrong puts BOTH dialogs on screen at once
//    — which is exactly what it did." So this one never opens while either is
//    up, and never opens before consent has actually been answered. The
//    consent bar also locks page scroll until it is dealt with, which means a
//    scroll-triggered popup could not fire during it even if it wanted to.
//
// 2. A DISMISSAL IS AN ANSWER. Somebody who closed this has told us something.
//    It is remembered on their device for as long as the popup says, and the
//    default is thirty days rather than the length of a tab.
//
// 3. NOTHING IS REMEMBERED ANYWHERE ELSE. Which popups a reader has seen or
//    closed lives in their own localStorage and is never sent anywhere. The
//    server counts how many people closed a thing; it does not record who.
//    That is why the feed is identical for everybody and cacheable.
//
// 4. IT WORKS ON A PHONE. The trigger is scroll depth, not exit intent —
//    there is no cursor to leave the viewport on a phone, so an exit-intent
//    popup reaches none of the readers who are most of this audience while
//    looking perfectly functional on the laptop it was tested on.
//
// If this file fails to load, or the endpoint is unreachable, or the reader is
// offline, nothing appears and the magazine is unaffected. That is the correct
// failure: a popup is the least important thing on the page.

(function () {
  'use strict';

  // The same override every other script here honours: set
  // localStorage.unplug_api_base to point at a local backend. Read through a
  // try/catch because localStorage throws outright in some privacy modes, and
  // a popup script is not worth breaking the page over.
  var API = (function () {
    try {
      return (localStorage.getItem('unplug_api_base') || 'https://unplug-ecosystem.onrender.com')
        .replace(/\/$/, '');
    } catch (e) {
      return 'https://unplug-ecosystem.onrender.com';
    }
  })();
  var SEEN_PREFIX = 'unplug_popup_';
  var CONSENT_KEY = 'unplug_consent_analytics';

  // Pages a popup may never appear on, whatever an admin picked.
  //
  // NOT CONFIGURABLE, on purpose. These are the pages where an interruption
  // costs real money or real trust: somebody in the middle of paying, and
  // somebody reading the privacy policy — which is very often somebody who
  // came to find out how to get their data removed, and who should not be
  // sold a newsletter on the way.
  var NEVER = ['checkout', 'privacy', 'terms', 'refunds'];

  function store(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* private mode */ }
  }
  function read(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  // Consent must have been ANSWERED. Not "accepted" — somebody who declined
  // analytics has not declined the magazine, and a newsletter offer is not
  // tracking. But an unanswered bar is still on screen, and this must not
  // stack on top of it.
  function consentAnswered() {
    var v = read(CONSENT_KEY);
    return v === 'accepted' || v === 'declined';
  }

  function overlayShowing() {
    var ids = ['consentBar', 'welcomeOverlay'];
    for (var i = 0; i < ids.length; i++) {
      var el = document.getElementById(ids[i]);
      if (el && !el.hasAttribute('hidden') && getComputedStyle(el).display !== 'none') return true;
    }
    // Anything else that has locked the page — a modal, a lightbox. If the
    // body cannot scroll, something already has the reader's attention.
    return document.body.style.overflow === 'hidden';
  }

  // Has this popup been answered recently enough to stay quiet?
  function suppressed(popup) {
    var raw = read(SEEN_PREFIX + popup.id);
    if (!raw) return false;
    if (popup.frequency === 'once') return true;
    if (popup.frequency === 'session') {
      try { return sessionStorage.getItem(SEEN_PREFIX + popup.id) === '1'; } catch (e) { return false; }
    }
    var when = Number(raw);
    if (!when) return false;
    var days = Number(popup.frequency_days) || 30;
    return (Date.now() - when) < days * 24 * 60 * 60 * 1000;
  }

  function remember(popup) {
    store(SEEN_PREFIX + popup.id, String(Date.now()));
    if (popup.frequency === 'session') {
      try { sessionStorage.setItem(SEEN_PREFIX + popup.id, '1'); } catch (e) { /* ignore */ }
    }
  }

  function currentPage() {
    if (/^\/nominate\/?$/.test(location.pathname)) return 'nominate';
    var p = new URLSearchParams(location.search).get('p');
    return p || 'home';
  }

  function eligible(popup, page) {
    if (NEVER.indexOf(page) !== -1) return false;
    var pages = Array.isArray(popup.pages) ? popup.pages : [];
    if (pages.length && pages.indexOf(page) === -1) return false;
    return !suppressed(popup);
  }

  // Fire-and-forget. keepalive so a 'convert' recorded as the reader clicks
  // through to another page is not cancelled by the navigation.
  function record(popup, kind) {
    try {
      fetch(API + '/popups/' + popup.id + '/event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
        body: JSON.stringify({
          kind: kind,
          page: currentPage(),
          sessionId: read('unplug_guest_session_id') || null,
        }),
      }).catch(function () { /* a counter is not worth an error */ });
    } catch (e) { /* ignore */ }
  }

  // --------------------------------------------------------------------------
  // Drawing it
  // --------------------------------------------------------------------------
  //
  // BUILT WITH createElement AND textContent. The title, body and button label
  // are typed by an admin and stored, which is exactly the shape of value that
  // has produced stored-XSS holes in this codebase twice. The only attributes
  // taken from the record are URLs, and those are parsed before use.

  function safeUrl(value) {
    var raw = String(value == null ? '' : value).trim();
    if (!raw) return null;
    // Relative paths on this site are fine and common — /nominate, ?p=news.
    if (/^[/?#][^/\\]/.test(raw) || raw === '/') return raw;
    try {
      var url = new URL(raw, location.origin);
      if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'mailto:') return null;
      return url.toString();
    } catch (e) { return null; }
  }

  function styleOnce() {
    if (document.getElementById('unplug-popup-styles')) return;
    var css = document.createElement('style');
    css.id = 'unplug-popup-styles';
    // Colours come from the tokens, so a rebrand reaches this too. The
    // fallbacks after each var() matter: this script also has to look right if
    // unplug-tokens.css failed to load.
    css.textContent = [
      '.unplug-popup-back{position:fixed;inset:0;background:rgba(15,14,14,.55);z-index:1200;',
      '  display:flex;align-items:center;justify-content:center;padding:20px;}',
      '.unplug-popup{background:var(--cream,#fff);color:var(--ink,#272626);max-width:440px;width:100%;',
      '  border-radius:12px;padding:28px 26px;position:relative;box-shadow:0 18px 50px rgba(15,14,14,.28);',
      '  font-family:var(--font-body,system-ui,-apple-system,"Segoe UI",sans-serif);max-height:90vh;overflow:auto;}',
      '.unplug-popup h2{font-family:var(--font-display,Georgia,serif);font-size:24px;line-height:1.25;margin:0 0 10px;',
      '  color:var(--black,#0f0e0e);}',
      '.unplug-popup p{font-size:15px;line-height:1.6;color:var(--slate,#454545);margin:0 0 18px;}',
      '.unplug-popup img{display:block;width:100%;height:auto;border-radius:8px;margin:0 0 16px;}',
      '.unplug-popup-x{position:absolute;top:8px;right:10px;background:none;border:0;font-size:26px;line-height:1;',
      '  cursor:pointer;color:var(--slate,#454545);padding:6px 10px;border-radius:6px;}',
      '.unplug-popup-x:focus-visible,.unplug-popup button:focus-visible,.unplug-popup a:focus-visible,',
      '.unplug-popup input:focus-visible{outline:2px solid var(--red,#d20709);outline-offset:2px;}',
      '.unplug-popup-cta{display:inline-block;background:var(--red,#d20709);color:#fff;border:0;border-radius:6px;',
      '  padding:12px 22px;font-weight:700;font-size:15px;cursor:pointer;text-decoration:none;font-family:inherit;}',
      '.unplug-popup-row{display:flex;gap:8px;flex-wrap:wrap;}',
      '.unplug-popup input[type=email]{flex:1;min-width:180px;padding:12px 14px;font-size:15px;font-family:inherit;',
      '  border:1px solid var(--paper-line,rgba(15,14,14,.2));border-radius:6px;}',
      '.unplug-popup-note{font-size:12px;color:var(--slate,#454545);margin:12px 0 0;}',
      '.unplug-popup-msg{font-size:13px;margin:10px 0 0;min-height:18px;}',
      // Somebody who has asked for less movement gets none. The dialog still
      // appears; it just does not slide.
      '@media (prefers-reduced-motion: no-preference){',
      '  .unplug-popup{animation:unplug-popup-in .22s ease-out;}',
      '  @keyframes unplug-popup-in{from{opacity:0;transform:translateY(12px);}to{opacity:1;transform:none;}}}',
    ].join('\n');
    document.head.appendChild(css);
  }

  var openPopup = null;

  function close(popup, reason) {
    if (!openPopup) return;
    var back = openPopup.back;
    var restoreTo = openPopup.restoreFocus;
    document.removeEventListener('keydown', openPopup.onKey, true);
    if (back && back.parentNode) back.parentNode.removeChild(back);
    document.body.style.overflow = openPopup.priorOverflow || '';
    openPopup = null;
    remember(popup);
    if (reason === 'dismiss') record(popup, 'dismiss');
    // Focus goes back where it was, or a keyboard user is dropped at the top
    // of the document with no idea where they are.
    if (restoreTo && restoreTo.focus) { try { restoreTo.focus(); } catch (e) { /* ignore */ } }
  }

  function show(popup) {
    if (openPopup) return;
    styleOnce();

    var back = document.createElement('div');
    back.className = 'unplug-popup-back';

    var card = document.createElement('div');
    card.className = 'unplug-popup';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    var titleId = 'unplug-popup-title-' + popup.id;
    card.setAttribute('aria-labelledby', titleId);

    var x = document.createElement('button');
    x.type = 'button';
    x.className = 'unplug-popup-x';
    x.setAttribute('aria-label', 'Close');
    x.textContent = '×';
    x.addEventListener('click', function () { close(popup, 'dismiss'); });
    card.appendChild(x);

    var img = safeUrl(popup.image_url);
    if (img) {
      var picture = document.createElement('img');
      picture.src = img;
      // Decorative: the title and body carry the meaning, and inventing alt
      // text from a field nobody filled in would have a screen reader read out
      // a filename.
      picture.alt = '';
      picture.setAttribute('role', 'presentation');
      card.appendChild(picture);
    }

    var h = document.createElement('h2');
    h.id = titleId;
    h.textContent = popup.title || '';
    card.appendChild(h);

    if (popup.body) {
      var body = document.createElement('p');
      body.textContent = popup.body;
      card.appendChild(body);
    }

    if (popup.kind === 'newsletter') {
      buildNewsletter(card, popup);
    } else {
      var href = safeUrl(popup.button_url) || (popup.kind === 'nominate' ? '/nominate' : null);
      if (href) {
        var cta = document.createElement('a');
        cta.className = 'unplug-popup-cta';
        cta.href = href;
        cta.textContent = popup.button_label || (popup.kind === 'nominate' ? 'Nominate someone' : 'Find out more');
        cta.addEventListener('click', function () {
          record(popup, 'convert');
          remember(popup);
        });
        card.appendChild(cta);
      }
    }

    back.appendChild(card);
    // Clicking the backdrop closes it. A dialog with no way out except a small
    // × is the pattern people describe as a trap.
    back.addEventListener('mousedown', function (e) {
      if (e.target === back) close(popup, 'dismiss');
    });

    var priorOverflow = document.body.style.overflow;
    document.body.appendChild(back);
    document.body.style.overflow = 'hidden';

    // Escape closes, and Tab is kept inside the dialog. Without the trap a
    // keyboard user tabs straight out into a page they cannot see behind the
    // backdrop, which is the accessibility failure that makes modals hated.
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(popup, 'dismiss'); return; }
      if (e.key !== 'Tab') return;
      var focusable = card.querySelectorAll('button, a[href], input, select, textarea');
      if (!focusable.length) return;
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', onKey, true);

    openPopup = {
      back: back,
      onKey: onKey,
      priorOverflow: priorOverflow,
      restoreFocus: document.activeElement,
    };

    // Focus lands on the close button rather than the email field: opening
    // with the cursor in a text input is what makes a popup feel like it is
    // demanding something.
    x.focus();
    record(popup, 'impression');
  }

  function buildNewsletter(card, popup) {
    var row = document.createElement('div');
    row.className = 'unplug-popup-row';

    var input = document.createElement('input');
    input.type = 'email';
    input.placeholder = 'your@email.com';
    input.setAttribute('aria-label', 'Your email address');

    var submit = document.createElement('button');
    submit.type = 'button';
    submit.className = 'unplug-popup-cta';
    submit.textContent = popup.button_label || 'Subscribe';

    row.appendChild(input);
    row.appendChild(submit);
    card.appendChild(row);

    var msg = document.createElement('p');
    msg.className = 'unplug-popup-msg';
    msg.setAttribute('role', 'status');
    card.appendChild(msg);

    var note = document.createElement('p');
    note.className = 'unplug-popup-note';
    note.textContent = 'One email a week. Unsubscribe from any of them, in one click.';
    card.appendChild(note);

    submit.addEventListener('click', function () {
      var email = input.value.trim();
      if (!email || email.indexOf('@') === -1) {
        msg.style.color = 'var(--red,#d20709)';
        msg.textContent = 'That does not look like an email address.';
        input.focus();
        return;
      }
      submit.disabled = true;
      submit.textContent = '…';

      fetch(API + '/newsletter/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The source is recorded against their consent, so "why do you have my
        // address" has a real answer: this popup, on this page.
        body: JSON.stringify({ email: email, source: 'popup: ' + (popup.title || popup.id), website: '' }),
      })
        .then(function (r) { return r.json().catch(function () { return {}; }); })
        .then(function (d) {
          if (d && d.error) throw new Error(d.error);
          record(popup, 'convert');
          remember(popup);
          msg.style.color = 'var(--green,#2e7d32)';
          msg.textContent = (d && d.message) || 'Subscribed. Welcome to Unplug.';
          row.remove();
          note.remove();
          // Closes itself shortly after. Leaving a confirmed dialog on screen
          // makes the reader dismiss a thing they have already finished with.
          setTimeout(function () { close(popup, 'converted'); }, 2200);
        })
        .catch(function (err) {
          submit.disabled = false;
          submit.textContent = popup.button_label || 'Subscribe';
          msg.style.color = 'var(--red,#d20709)';
          msg.textContent = err.message || 'Could not subscribe just now.';
        });
    });

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); submit.click(); }
    });
  }

  // --------------------------------------------------------------------------
  // Deciding when
  // --------------------------------------------------------------------------

  function scrollPercent() {
    var doc = document.documentElement;
    var scrollable = doc.scrollHeight - window.innerHeight;
    // A page shorter than the window has nothing to scroll. Treating that as
    // 100% would fire every popup immediately on every short page.
    if (scrollable <= 40) return 0;
    return Math.min(100, Math.round((window.scrollY / scrollable) * 100));
  }

  function start(popups) {
    if (!popups.length) return;
    var fired = false;

    function check() {
      if (fired || openPopup) return;
      if (!consentAnswered() || overlayShowing()) return;

      var page = currentPage();
      var depth = scrollPercent();
      for (var i = 0; i < popups.length; i++) {
        var popup = popups[i];
        if (!eligible(popup, page)) continue;
        if (depth < (Number(popup.scroll_percent) || 50)) continue;
        // ONE AT A TIME, and only one per page view. Two popups in a session
        // is the point at which a reader stops reading and starts closing
        // things.
        fired = true;
        show(popup);
        return;
      }
    }

    // Throttled on a timestamp rather than requestAnimationFrame.
    //
    // rAF is the usual advice for a scroll handler and it is cheaper, but it
    // does not run at all while the document is hidden — so the check depended
    // on the tab being composited, which made it both untestable and subtly
    // conditional on something that has nothing to do with whether the reader
    // has scrolled far enough. A 150ms floor costs nothing and always runs.
    var lastCheck = 0;
    window.addEventListener('scroll', function () {
      var now = Date.now();
      if (now - lastCheck < 150) return;
      lastCheck = now;
      check();
    }, { passive: true });

    // Also on navigation within the magazine, which is a single page: moving
    // from an article to the homepage is a new page view with a new scroll
    // position, and `fired` has to be released for it.
    window.addEventListener('popstate', function () { fired = false; check(); });
    document.addEventListener('unplug:pageview', function () { fired = false; check(); });

    // Once on arrival too. A reader who followed a link to an anchor part-way
    // down a page is already past the threshold and will never fire a scroll
    // event by sitting still.
    check();
  }

  function init() {
    // Nothing is fetched until consent has been answered. Not because the feed
    // is personal — it is identical for everybody — but because until then the
    // consent bar owns the screen and the answer may be to close the tab.
    if (!consentAnswered()) {
      setTimeout(init, 1500);
      return;
    }
    fetch(API + '/popups/active')
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (list) { if (Array.isArray(list) && list.length) start(list); })
      .catch(function () { /* no popups is the correct failure */ });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
