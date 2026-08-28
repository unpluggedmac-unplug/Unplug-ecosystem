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
    // A preview has no id. Without this the builder would post impressions and
    // conversions for a popup nobody has seen, and the report that tells you
    // whether a popup is worth keeping would be counting the person who made it.
    if (!popup || !popup.id) return;
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
      // ---- composed popups -------------------------------------------
      // Blocks stack in the order the admin put them in. Each rule here is
      // for a block type; none of them can be reached by a popup that has no
      // blocks, which keeps the old fixed layout rendering exactly as before.
      '.unplug-popup-blocks{display:flex;flex-direction:column;align-items:flex-start;}',
      '.unplug-popup-blocks>*{max-width:100%;}',
      '.unplug-popup h3{font-size:19px;line-height:1.3;margin:0 0 8px;font-family:inherit;}',
      '.unplug-popup-divider{border:0;border-top:1px solid var(--paper-line,rgba(15,14,14,.18));',
      '  width:100%;margin:14px 0;}',
      // A 16:9 frame that holds its shape before the embed loads, so the card
      // does not jump to a new height a second after it appears.
      '.unplug-popup-embed{position:relative;width:100%;aspect-ratio:16/9;margin:0 0 14px;',
      '  background:var(--paper,#efe9dd);border-radius:8px;overflow:hidden;}',
      '.unplug-popup-embed iframe{position:absolute;inset:0;width:100%;height:100%;border:0;}',
      // Audio players are short and wide, not 16:9.
      '.unplug-popup-embed.is-audio{aspect-ratio:auto;height:120px;}',
      '.unplug-popup-transcript{width:100%;margin:0 0 14px;}',
      '.unplug-popup-transcript summary{cursor:pointer;font-size:13px;font-weight:700;padding:4px 0;}',
      '.unplug-popup-transcript p{font-size:13.5px;margin:8px 0 0;white-space:pre-wrap;}',

      // ---- where it sits ----------------------------------------------
      // Only the centred one dims the page behind it. A corner card that
      // greyed out the article it is sitting on would be a modal wearing a
      // different shape, and the point of a corner card is that somebody can
      // carry on reading.
      '.unplug-popup-back.at-center{align-items:center;justify-content:center;}',
      '.unplug-popup-back.at-top{align-items:flex-start;justify-content:center;}',
      '.unplug-popup-back.at-bottom{align-items:flex-end;justify-content:center;}',
      '.unplug-popup-back.at-top-left{align-items:flex-start;justify-content:flex-start;}',
      '.unplug-popup-back.at-top-right{align-items:flex-start;justify-content:flex-end;}',
      '.unplug-popup-back.at-bottom-left{align-items:flex-end;justify-content:flex-start;}',
      '.unplug-popup-back.at-bottom-right{align-items:flex-end;justify-content:flex-end;}',
      '.unplug-popup-back.is-corner{background:none;pointer-events:none;}',
      '.unplug-popup-back.is-corner .unplug-popup{pointer-events:auto;}',

      // ---- how wide ----------------------------------------------------
      '.unplug-popup.w-small{max-width:340px;}',
      '.unplug-popup.w-medium{max-width:440px;}',
      '.unplug-popup.w-large{max-width:620px;}',

      // On a phone there is no such thing as a corner: anything not centred
      // becomes a card at the bottom, full width, because a 340px card pinned
      // to a corner of a 375px screen is just a badly placed modal.
      '@media(max-width:560px){',
      '  .unplug-popup-back{align-items:flex-end;justify-content:center;padding:10px;}',
      '  .unplug-popup,.unplug-popup.w-small,.unplug-popup.w-medium,.unplug-popup.w-large{max-width:100%;}}',

      // Somebody who has asked for less movement gets none. The dialog still
      // appears; it just does not slide. EVERY animation lives inside this
      // guard, including the ones an admin chooses in the builder — the
      // choice sets which animation, never whether the preference applies.
      '@media (prefers-reduced-motion: no-preference){',
      '  .unplug-popup{animation:unplug-popup-in .22s ease-out;}',
      '  .unplug-popup.anim-none{animation:none;}',
      '  .unplug-popup.anim-fade{animation:unplug-pop-fade .25s ease-out;}',
      '  .unplug-popup.anim-fade-up{animation:unplug-popup-in .22s ease-out;}',
      '  .unplug-popup.anim-slide-up{animation:unplug-pop-up .28s cubic-bezier(.2,.8,.3,1);}',
      '  .unplug-popup.anim-slide-down{animation:unplug-pop-down .28s cubic-bezier(.2,.8,.3,1);}',
      '  .unplug-popup.anim-slide-left{animation:unplug-pop-left .28s cubic-bezier(.2,.8,.3,1);}',
      '  .unplug-popup.anim-slide-right{animation:unplug-pop-right .28s cubic-bezier(.2,.8,.3,1);}',
      '  .unplug-popup.anim-zoom{animation:unplug-pop-zoom .22s ease-out;}',
      '  @keyframes unplug-popup-in{from{opacity:0;transform:translateY(12px);}to{opacity:1;transform:none;}}',
      '  @keyframes unplug-pop-fade{from{opacity:0;}to{opacity:1;}}',
      '  @keyframes unplug-pop-up{from{opacity:0;transform:translateY(40px);}to{opacity:1;transform:none;}}',
      '  @keyframes unplug-pop-down{from{opacity:0;transform:translateY(-40px);}to{opacity:1;transform:none;}}',
      '  @keyframes unplug-pop-left{from{opacity:0;transform:translateX(40px);}to{opacity:1;transform:none;}}',
      '  @keyframes unplug-pop-right{from{opacity:0;transform:translateX(-40px);}to{opacity:1;transform:none;}}',
      '  @keyframes unplug-pop-zoom{from{opacity:0;transform:scale(.92);}to{opacity:1;transform:none;}}}',
    ].join('\n');
    document.head.appendChild(css);
  }

  // --------------------------------------------------------------------------
  // Composed popups
  // --------------------------------------------------------------------------
  //
  // Every block below is built with createElement and its words set with
  // textContent. There is no branch in this file that turns a stored string
  // into markup, which is what lets an admin write whatever they like into a
  // popup without that being a way to put script on the page.
  //
  // The one element that takes a URL as a live attribute is the embed iframe,
  // and its src is not the address the admin typed: the server rewrote it to
  // a known player on a known host, or refused to store the block at all.

  var ALLOWED_ANIM = ['none', 'fade', 'fade-up', 'slide-up', 'slide-down',
    'slide-left', 'slide-right', 'zoom'];
  var ALLOWED_POS = ['center', 'top', 'bottom', 'top-left', 'top-right',
    'bottom-left', 'bottom-right'];
  var ALLOWED_WIDTH = ['small', 'medium', 'large'];
  var FONT_VARS = { body: 'var(--font-body,system-ui,sans-serif)',
    display: 'var(--font-display,Georgia,serif)',
    accent: 'var(--font-accent,Georgia,serif)' };

  // A colour is only ever used if it looks exactly like a six-digit hex. The
  // server already checks this; it is checked again here because this is the
  // side that writes it into a style attribute, and a value that reaches an
  // attribute should be checked by whoever puts it there.
  function hex(value) {
    return /^#[0-9a-fA-F]{6}$/.test(String(value || '')) ? value : null;
  }

  function inList(list, value, fallback) {
    return list.indexOf(value) === -1 ? fallback : value;
  }

  function applyStyle(card, popup) {
    var st = popup.style && typeof popup.style === 'object' ? popup.style : {};
    card.classList.add('w-' + inList(ALLOWED_WIDTH, st.width, 'medium'));
    if (FONT_VARS[st.font]) card.style.fontFamily = FONT_VARS[st.font];
    var bg = hex(st.background);
    if (bg) card.style.background = bg;
    var text = hex(st.textColor);
    if (text) card.style.color = text;
    return st;
  }

  function embedBlock(block, isAudio, media) {
    var wrap = document.createElement('div');
    wrap.className = 'unplug-popup-embed' + (isAudio ? ' is-audio' : '');
    var frame = document.createElement('iframe');
    // The src was built by the server from a fixed list of players. It is not
    // the string the admin pasted.
    var src = String(block.src || '');
    if (!/^https:\/\//.test(src)) return null;
    // AUTOPLAY IS MUTED, ALWAYS. Sound that starts on its own is blocked by
    // browsers anyway, and a popup that starts talking over somebody is the
    // version of this feature people write in to complain about.
    if (media && media.autoplay) {
      src += (src.indexOf('?') === -1 ? '?' : '&') + 'autoplay=1&mute=1&muted=1';
    }
    if (media && media.loop) src += (src.indexOf('?') === -1 ? '?' : '&') + 'loop=1';
    frame.src = src;
    frame.setAttribute('loading', 'lazy');
    frame.setAttribute('allow', 'accelerometer; encrypted-media; picture-in-picture');
    frame.setAttribute('allowfullscreen', '');
    frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    // A frame with no title is announced as "frame" and nothing else.
    frame.title = block.title || (isAudio ? 'Audio' : 'Video');
    wrap.appendChild(frame);
    return wrap;
  }

  function renderBlocks(card, popup, titleId) {
    var holder = document.createElement('div');
    holder.className = 'unplug-popup-blocks';
    var st = popup.style && typeof popup.style === 'object' ? popup.style : {};
    var media = popup.media && typeof popup.media === 'object' ? popup.media : {};
    var titleColor = hex(st.titleColor);
    var btnBg = hex(st.buttonBg);
    var btnText = hex(st.buttonText);
    var labelled = false;

    popup.blocks.forEach(function (block, index) {
      if (!block || typeof block !== 'object') return;
      var el = null;

      if (block.type === 'heading') {
        // The FIRST heading is what names the dialog for a screen reader. A
        // composed popup may have no `title` on show at all, so without this
        // the dialog would announce itself with an empty label.
        el = document.createElement(labelled ? 'h3' : 'h2');
        el.textContent = block.text;
        if (!labelled) { el.id = titleId; labelled = true; }
        if (titleColor) el.style.color = titleColor;

      } else if (block.type === 'text') {
        el = document.createElement('p');
        el.textContent = block.text;
        // Line breaks the admin typed are line breaks the reader sees.
        el.style.whiteSpace = 'pre-wrap';

      } else if (block.type === 'image') {
        var url = safeUrl(block.url);
        if (!url) return;
        el = document.createElement('img');
        el.src = url;
        // Empty alt is a real answer — it means decorative. Only a filled-in
        // one is announced.
        el.alt = block.alt || '';
        if (!block.alt) el.setAttribute('role', 'presentation');

      } else if (block.type === 'button') {
        var href = safeUrl(block.url);
        if (!href) return;
        el = document.createElement('a');
        el.className = 'unplug-popup-cta';
        el.href = href;
        el.textContent = block.label;
        if (btnBg) el.style.background = btnBg;
        if (btnText) el.style.color = btnText;
        el.style.marginBottom = '14px';
        el.addEventListener('click', function () { record(popup, 'convert'); remember(popup); });

      } else if (block.type === 'video' || block.type === 'audio') {
        el = embedBlock(block, block.type === 'audio', media);
        if (!el) return;

      } else if (block.type === 'transcript') {
        el = document.createElement('details');
        el.className = 'unplug-popup-transcript';
        var summary = document.createElement('summary');
        summary.textContent = 'Read this instead';
        var para = document.createElement('p');
        para.textContent = block.text;
        el.appendChild(summary);
        el.appendChild(para);

      } else if (block.type === 'divider') {
        el = document.createElement('hr');
        el.className = 'unplug-popup-divider';

      } else if (block.type === 'spacer') {
        el = document.createElement('div');
        el.style.height = block.size === 'large' ? '28px' : block.size === 'small' ? '8px' : '16px';
        el.setAttribute('aria-hidden', 'true');

      } else if (block.type === 'email') {
        // The sign-up goes through exactly the same function the old
        // newsletter popup used, so consent is recorded the one way it has
        // always been recorded. A popup does not get its own way to subscribe
        // somebody.
        buildNewsletter(holder, popup, block.label);
        return;
      }

      if (el) holder.appendChild(el);
    });

    card.appendChild(holder);
    return labelled;
  }

  var openPopup = null;

  function close(popup, reason) {
    if (!openPopup) return;
    var back = openPopup.back;
    var restoreTo = openPopup.restoreFocus;
    if (openPopup.autoCloseTimer) clearTimeout(openPopup.autoCloseTimer);
    document.removeEventListener('keydown', openPopup.onKey, true);
    if (back && back.parentNode) back.parentNode.removeChild(back);
    document.body.style.overflow = openPopup.priorOverflow || '';
    openPopup = null;
    remember(popup);
    // Only a reader closing it counts as a dismissal — see the note on the
    // auto-close timer.
    if (reason === 'dismiss') record(popup, 'dismiss');
    // Focus goes back where it was, or a keyboard user is dropped at the top
    // of the document with no idea where they are.
    if (restoreTo && restoreTo.focus) { try { restoreTo.focus(); } catch (e) { /* ignore */ } }
  }

  function show(popup) {
    if (openPopup) return;
    styleOnce();

    var position = inList(ALLOWED_POS, popup.position, 'center');
    var corner = position !== 'center' && position !== 'top' && position !== 'bottom';

    var back = document.createElement('div');
    // A corner card does not dim the page. Only a centred dialog does, because
    // only a centred dialog is claiming the whole screen.
    back.className = 'unplug-popup-back at-' + position + (corner ? ' is-corner' : '');

    var card = document.createElement('div');
    card.className = 'unplug-popup anim-' + inList(ALLOWED_ANIM, popup.animation, 'fade-up');
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

    var st = applyStyle(card, popup);
    var composed = Array.isArray(popup.blocks) && popup.blocks.length > 0;

    if (composed) {
      // Built by an admin, block by block.
      var named = renderBlocks(card, popup, titleId);
      if (!named) {
        // Blocks with no heading among them: the dialog still needs a name,
        // so it borrows the popup's title. Without this a screen reader
        // announces an unlabelled dialog and the reader has no idea what has
        // just taken over the screen.
        card.setAttribute('aria-label', popup.title || 'Notice');
        card.removeAttribute('aria-labelledby');
      }
    } else {
      // THE ORIGINAL LAYOUT, UNCHANGED. Every popup made before the builder
      // existed comes through here, and this branch is what stops a deploy
      // from emptying them.
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
      if (hex(st.titleColor)) h.style.color = hex(st.titleColor);
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
          if (hex(st.buttonBg)) cta.style.background = hex(st.buttonBg);
          if (hex(st.buttonText)) cta.style.color = hex(st.buttonText);
          cta.addEventListener('click', function () {
            record(popup, 'convert');
            remember(popup);
          });
          card.appendChild(cta);
        }
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
    // Scrolling is only frozen for a dialog that owns the screen. Freezing it
    // behind a corner card would stop somebody reading the article the card is
    // sitting on top of, which is the whole reason to choose a corner.
    if (!corner) document.body.style.overflow = 'hidden';

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
      autoCloseTimer: null,
    };

    // Closes itself after a while, if the admin asked for that.
    //
    // NOT COUNTED AS A DISMISSAL. A dismissal is the reader saying no, and it
    // is the number the report leans on to tell a popup that is working from
    // one that is driving people off. A timer running out is the popup giving
    // up, not the reader refusing, and counting the two together would quietly
    // make every timed popup look unpopular.
    //
    // The timer is also dropped the moment somebody interacts with the card:
    // having it vanish mid-sentence, or while an email address is half typed,
    // is worse than it never closing at all.
    var closeAfter = Number(popup.auto_close_seconds);
    if (closeAfter > 0) {
      openPopup.autoCloseTimer = setTimeout(function () {
        close(popup, 'timeout');
      }, Math.min(300, closeAfter) * 1000);
      var cancelTimer = function () {
        if (openPopup && openPopup.autoCloseTimer) {
          clearTimeout(openPopup.autoCloseTimer);
          openPopup.autoCloseTimer = null;
        }
      };
      card.addEventListener('pointerdown', cancelTimer);
      card.addEventListener('keydown', cancelTimer);
      card.addEventListener('focusin', cancelTimer);
    }

    // Focus lands on the close button rather than the email field: opening
    // with the cursor in a text input is what makes a popup feel like it is
    // demanding something.
    x.focus();
    record(popup, 'impression');
  }

  function buildNewsletter(card, popup, labelOverride) {
    var row = document.createElement('div');
    row.className = 'unplug-popup-row';

    var input = document.createElement('input');
    input.type = 'email';
    input.placeholder = 'your@email.com';
    input.setAttribute('aria-label', 'Your email address');

    var submit = document.createElement('button');
    submit.type = 'button';
    submit.className = 'unplug-popup-cta';
    submit.textContent = labelOverride || popup.button_label || 'Subscribe';

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
          submit.textContent = labelOverride || popup.button_label || 'Subscribe';
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
    var arrivedAt = Date.now();
    var leaving = false;

    // WHAT MAKES A POPUP APPEAR.
    //
    //   scroll — the reader has got far enough down to have read something
    //   delay  — they have been on the page a while
    //   exit   — the pointer has left towards the top of the window, which is
    //            somebody heading for the address bar or a tab
    //
    // Scroll stays the default, and the reason is the same one written into
    // the scroll_percent default: a popup that fires before a reader has seen
    // anything worth staying for is the most reliable way to make them leave.
    // Exit intent is the gentlest of the three, because by then they are going
    // anyway. It only exists on a device with a pointer — on a phone there is
    // no such gesture, so an exit popup simply never fires there rather than
    // guessing at some substitute.
    function ready(popup) {
      var trigger = popup.trigger_type || 'scroll';
      if (trigger === 'delay') {
        var wait = Number(popup.trigger_seconds) || 20;
        return (Date.now() - arrivedAt) >= wait * 1000;
      }
      if (trigger === 'exit') return leaving;
      return scrollPercent() >= (Number(popup.scroll_percent) || 50);
    }

    function check() {
      if (fired || openPopup) return;
      if (!consentAnswered() || overlayShowing()) return;

      var page = currentPage();
      for (var i = 0; i < popups.length; i++) {
        var popup = popups[i];
        if (!eligible(popup, page)) continue;
        if (!ready(popup)) continue;
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

    // A delay trigger has nothing to listen to — nobody has to do anything for
    // time to pass — so it needs its own tick. Two seconds is coarse enough to
    // cost nothing and fine enough that "after 20 seconds" is not off by much.
    var delayTick = setInterval(function () {
      if (fired) { clearInterval(delayTick); return; }
      check();
    }, 2000);

    // Exit intent: the pointer crossing out of the top of the window. Only
    // upward, and only from a real pointer — a touch screen has no such
    // gesture, and treating any pointerout as leaving would fire the popup
    // when somebody's finger left the glass.
    document.addEventListener('mouseout', function (e) {
      if (fired || e.relatedTarget || e.clientY > 8) return;
      leaving = true;
      check();
    });

    // Also on navigation within the magazine, which is a single page: moving
    // from an article to the homepage is a new page view with a new scroll
    // position, and `fired` has to be released for it.
    function newPageView() {
      fired = false;
      // The clock restarts too. Without this, a "after 20 seconds" popup fires
      // the instant somebody opens a second page, because the 20 seconds were
      // spent on the first one.
      arrivedAt = Date.now();
      leaving = false;
      check();
    }
    window.addEventListener('popstate', newPageView);
    document.addEventListener('unplug:pageview', newPageView);

    // Once on arrival too. A reader who followed a link to an anchor part-way
    // down a page is already past the threshold and will never fire a scroll
    // event by sitting still.
    check();
  }

  // --------------------------------------------------------------------------
  // Preview
  // --------------------------------------------------------------------------
  //
  // THE ADMIN'S PREVIEW IS THIS RENDERER, not a second one written into the
  // dashboard. A builder that previews with its own drawing code shows the
  // admin something that is only approximately what readers get, and the gap
  // between the two grows every time either side is touched. So the admin page
  // loads this file and calls in here.
  //
  // It draws into a host element instead of over the page: no backdrop, no
  // focus trap, no scroll lock, no impression recorded. Nothing about a
  // preview should look like a reader saw the popup.
  window.UnplugPopups = {
    preview: function (popup, host) {
      if (!host) return null;
      styleOnce();
      host.textContent = '';
      var position = inList(ALLOWED_POS, popup.position, 'center');
      var corner = position !== 'center' && position !== 'top' && position !== 'bottom';

      var back = document.createElement('div');
      back.className = 'unplug-popup-back at-' + position + (corner ? ' is-corner' : '');
      // Inside its own box rather than over the screen.
      back.style.position = 'relative';
      back.style.inset = 'auto';
      back.style.zIndex = '0';
      back.style.minHeight = '260px';

      var card = document.createElement('div');
      card.className = 'unplug-popup anim-' + inList(ALLOWED_ANIM, popup.animation, 'fade-up');
      var titleId = 'unplug-preview-title';

      var x = document.createElement('button');
      x.type = 'button';
      x.className = 'unplug-popup-x';
      x.setAttribute('aria-label', 'Close');
      x.textContent = '×';
      // Inert: it is a picture of the close button, not the close button.
      x.addEventListener('click', function (e) { e.preventDefault(); });
      card.appendChild(x);

      var st = applyStyle(card, popup);
      if (Array.isArray(popup.blocks) && popup.blocks.length) {
        renderBlocks(card, popup, titleId);
      } else {
        var img = safeUrl(popup.image_url);
        if (img) {
          var picture = document.createElement('img');
          picture.src = img; picture.alt = '';
          card.appendChild(picture);
        }
        var h = document.createElement('h2');
        h.textContent = popup.title || '';
        if (hex(st.titleColor)) h.style.color = hex(st.titleColor);
        card.appendChild(h);
        if (popup.body) {
          var para = document.createElement('p');
          para.textContent = popup.body;
          card.appendChild(para);
        }
      }
      back.appendChild(card);
      host.appendChild(back);
      return card;
    },
  };

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

  // PREVIEW-ONLY MODE.
  //
  // The admin dashboard loads this file so its builder previews with the real
  // renderer instead of a second copy. Without this guard it would also start
  // watching for scroll and showing live popups over the dashboard — an admin
  // editing a popup would be interrupted by it.
  //
  // Read from the script tag rather than a global, because a global set after
  // the file loads is set too late:
  //   <script src="unplug-popups.js" data-preview-only></script>
  // document.currentScript is the direct answer, but it is null in a few
  // execution contexts, and the cost of it being null HERE is the renderer
  // firing live popups over the dashboard while somebody is editing one. So
  // the tag is looked for by hand as well: two ways to reach the same answer,
  // because only one of the two failure directions is harmless.
  var thisScript = document.currentScript;
  var previewOnly = !!(thisScript && thisScript.hasAttribute('data-preview-only'))
    || !!document.querySelector('script[data-preview-only]');

  if (previewOnly) {
    // window.UnplugPopups.preview is already assigned above and stays usable.
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
