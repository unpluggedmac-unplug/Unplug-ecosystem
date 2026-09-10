(function () {
  'use strict';

  if (window.UnplugImageViewer) return;

  const PLACEHOLDER = 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 800">' +
    '<rect width="1200" height="800" fill="#f3efe8"/>' +
    '<g fill="none" stroke="#d20709" stroke-width="18" opacity=".45">' +
    '<circle cx="600" cy="325" r="72"/><path d="M500 325a100 100 0 0 1 200 0"/>' +
    '<path d="M450 325a150 150 0 0 1 300 0"/><path d="M400 325a200 200 0 0 1 400 0"/>' +
    '</g><text x="600" y="520" text-anchor="middle" font-family="Georgia,serif" font-size="64" fill="#222">UNPLUG</text>' +
    '<text x="600" y="580" text-anchor="middle" font-family="Arial,sans-serif" font-size="24" letter-spacing="12" fill="#777">MAGAZINE</text>' +
    '</svg>'
  );

  const style = document.createElement('style');
  style.id = 'unplugImageViewerStyles';
  style.textContent = `
    img.unplug-media-fit:not([data-unplug-card-crop="true"]) {
      object-fit: contain !important;
      background: #f3efe8;
    }
    [data-unplug-bg-media="true"] {
      background-size: contain !important;
      background-repeat: no-repeat !important;
      background-position: center !important;
      background-color: #f3efe8;
    }
    [data-unplug-media="true"] { cursor: zoom-in; }
    [data-unplug-media="true"]:focus-visible { outline: 3px solid #d20709; outline-offset: 3px; }
    .unplug-page-banner { display: block; margin-left: auto !important; margin-right: auto !important; }
    img.unplug-page-banner[data-unplug-orientation="landscape"] {
      width: 100% !important; height: auto !important; max-width: 1440px !important; max-height: none !important;
    }
    img.unplug-page-banner[data-unplug-orientation="portrait"] {
      width: auto !important; height: auto !important; max-width: min(680px, 100%) !important; max-height: none !important;
    }
    img.unplug-page-banner[data-unplug-orientation="square"] {
      width: auto !important; height: auto !important; max-width: min(860px, 100%) !important; max-height: none !important;
    }
    [data-unplug-bg-media="true"].unplug-page-banner {
      height: auto !important; max-height: none !important;
    }
    [data-unplug-bg-media="true"].unplug-page-banner[data-unplug-orientation="landscape"] {
      width: 100% !important; max-width: 1440px !important;
    }
    [data-unplug-bg-media="true"].unplug-page-banner[data-unplug-orientation="portrait"] {
      width: min(680px, 100%) !important; max-width: 680px !important;
    }
    [data-unplug-bg-media="true"].unplug-page-banner[data-unplug-orientation="square"] {
      width: min(860px, 100%) !important; max-width: 860px !important;
    }
    .unplug-img-broken { background: #f3efe8 !important; }
    .unplug-lightbox {
      position: fixed; inset: 0; z-index: 2147483600; background: rgba(8,8,8,.96); color: #fff;
      display: grid; grid-template-rows: auto minmax(0,1fr) auto; font-family: Inter, Arial, sans-serif;
    }
    .unplug-lightbox[hidden] { display: none !important; }
    .unplug-lightbox-toolbar {
      display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px;
      border-bottom: 1px solid rgba(255,255,255,.16); background: rgba(0,0,0,.3); flex-wrap: wrap;
    }
    .unplug-lightbox-tools { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .unplug-lightbox button, .unplug-lightbox a {
      min-height: 44px; border: 1px solid rgba(255,255,255,.7); background: transparent; color: #fff;
      padding: 9px 13px; font: 700 12px/1 Arial,sans-serif; letter-spacing: .03em; cursor: pointer; text-decoration: none;
      display: inline-flex; align-items: center; justify-content: center;
    }
    .unplug-lightbox button:hover, .unplug-lightbox a:hover { background: rgba(255,255,255,.12); }
    .unplug-lightbox .unplug-lb-close { background: #d20709; border-color: #d20709; min-width: 48px; font-size: 20px; }
    .unplug-lightbox-main { position: relative; min-height: 0; display: grid; grid-template-columns: 64px minmax(0,1fr) 64px; align-items: stretch; }
    .unplug-lightbox-stage { min-width: 0; min-height: 0; overflow: auto; display: flex; align-items: center; justify-content: center; padding: 18px; }
    .unplug-lightbox-image {
      display: block; max-width: 100%; max-height: calc(100vh - 190px); width: auto; height: auto; object-fit: contain;
      transform-origin: center center; transition: transform .12s ease; box-shadow: 0 8px 40px rgba(0,0,0,.45);
    }
    .unplug-lightbox-nav { border: 0 !important; background: transparent !important; font-size: 34px !important; min-width: 56px; }
    .unplug-lightbox-nav[hidden] { visibility: hidden; display: block !important; }
    .unplug-lightbox-footer {
      display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 18px;
      border-top: 1px solid rgba(255,255,255,.16); background: rgba(0,0,0,.35); flex-wrap: wrap;
    }
    .unplug-lightbox-caption { min-width: 0; flex: 1 1 280px; }
    .unplug-lightbox-caption strong { display: block; font: 700 15px/1.35 Georgia,serif; }
    .unplug-lightbox-caption span { color: #ccc; font-size: 12px; }
    .unplug-lightbox-cta { background: #d20709 !important; border-color: #d20709 !important; padding-left: 18px !important; padding-right: 18px !important; }
    .unplug-lightbox-cta[hidden] { display: none !important; }
    @media (max-width: 720px) {
      .unplug-lightbox-main { grid-template-columns: 44px minmax(0,1fr) 44px; }
      .unplug-lightbox-nav { min-width: 44px; padding: 4px !important; font-size: 28px !important; }
      .unplug-lightbox-stage { padding: 8px; }
      .unplug-lightbox-image { max-height: calc(100vh - 225px); }
      .unplug-lightbox-toolbar { padding: 8px; }
      .unplug-lightbox-footer { padding: 9px 10px; }
    }
  `;
  document.head.appendChild(style);

  let overlay = null;
  let currentItems = [];
  let currentIndex = -1;
  let zoom = 1;
  let lastFocus = null;
  let pointerStartX = null;
  let scanTimer = null;

  function textKey(el) {
    let node = el;
    const parts = [];
    for (let i = 0; node && i < 4; i++, node = node.parentElement) {
      parts.push(node.id || '', node.className || '', node.getAttribute && (node.getAttribute('data-ad-slot') || ''));
    }
    return parts.join(' ').toLowerCase();
  }

  function isBanner(el) {
    const key = textKey(el);
    return /(?:page[-_ ]?banner|banner|ad[-_ ]?slot|advert|leaderboard|billboard)/.test(key) || !!el.closest('[data-ad-slot]');
  }

  function isIgnoredImage(img) {
    if (!img || img.dataset.unplugNoLightbox === 'true') return true;
    if (img.dataset.unplugPlaceholder === 'true') return true;
    if (img.closest('[data-unplug-no-lightbox], button, .share, .share-row, .social-share, .social-icons')) return true;
    const key = textKey(img);
    const r = img.getBoundingClientRect();
    if ((r.width && r.width < 60) && (r.height && r.height < 60)) return true;
    if (/(?:icon|emoji|spinner|flag)/.test(key) && !isBanner(img)) return true;
    if (img.closest('header, nav') && /logo/.test(key)) return true;
    return false;
  }

  function imageSource(img) {
    return (img.currentSrc || img.src || '').trim();
  }

  function visible(el) {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && s.display !== 'none' && s.visibility !== 'hidden';
  }

  function orientation(w, h) {
    if (!w || !h) return 'landscape';
    const ratio = w / h;
    if (ratio > 1.12) return 'landscape';
    if (ratio < 0.89) return 'portrait';
    return 'square';
  }

  function applyOrientation(el, w, h) {
    const o = orientation(w, h);
    el.dataset.unplugOrientation = o;
    if (w && h && el.dataset.unplugBgMedia === 'true') el.style.aspectRatio = w + ' / ' + h;
    if (isBanner(el)) el.classList.add('unplug-page-banner');
  }

  function markBrokenImage(img) {
    if (!img || img.dataset.unplugPlaceholder === 'true') return;
    img.dataset.unplugOriginalSrc = imageSource(img);
    img.dataset.unplugPlaceholder = 'true';
    img.classList.add('unplug-img-broken');
    img.removeAttribute('srcset');
    if (img.parentElement && img.parentElement.tagName === 'PICTURE') {
      img.parentElement.querySelectorAll('source').forEach((source) => source.removeAttribute('srcset'));
    }
    img.onerror = null;
    img.src = PLACEHOLDER;
    img.removeAttribute('data-unplug-media');
    img.style.cursor = 'default';
  }

  function setupImage(img) {
    if (!img || img.dataset.unplugImageSetup === 'true') return;
    img.dataset.unplugImageSetup = 'true';
    img.addEventListener('error', function () { markBrokenImage(img); });

    const finish = function () {
      if (!img.naturalWidth || !img.naturalHeight) {
        if (img.complete && imageSource(img) && !imageSource(img).startsWith('data:')) markBrokenImage(img);
        return;
      }
      if (isIgnoredImage(img)) return;
      img.dataset.unplugMedia = 'true';
      img.classList.add('unplug-media-fit');
      applyOrientation(img, img.naturalWidth, img.naturalHeight);
      if (!img.closest('a[href]')) {
        if (!img.hasAttribute('tabindex')) img.tabIndex = 0;
        if (!img.hasAttribute('role')) img.setAttribute('role', 'button');
      }
      if (!img.hasAttribute('aria-label')) {
        img.setAttribute('aria-label', (img.alt || 'Image') + ' — view full image');
      }
    };

    if (img.complete) finish(); else img.addEventListener('load', finish, { once: true });
  }

  function extractBackgroundUrl(value) {
    if (!value || value === 'none') return '';
    const match = value.match(/url\((?:"|')?(.*?)(?:"|')?\)/i);
    return match ? match[1] : '';
  }

  function backgroundCandidate(el) {
    if (!el || el.dataset.unplugBgChecked === 'true') return;
    el.dataset.unplugBgChecked = 'true';
    if (el.closest('[data-unplug-no-lightbox], header, nav')) return;
    const key = textKey(el);
    if (!/(?:photo|image|thumb|avatar|poster|banner|profile|member|gallery|maker|contest|cover|media|picture|headshot|ad[-_ ]?slot)/.test(key)) return;
    const r = el.getBoundingClientRect();
    if (r.width < 75 || r.height < 75) return;
    const src = extractBackgroundUrl(getComputedStyle(el).backgroundImage);
    if (!src || src.startsWith('data:')) return;

    const probe = new Image();
    probe.onload = function () {
      el.dataset.unplugMedia = 'true';
      el.dataset.unplugBgMedia = 'true';
      el.dataset.unplugBgSrc = src;
      el.tabIndex = el.hasAttribute('tabindex') ? el.tabIndex : 0;
      if (!el.hasAttribute('role')) el.setAttribute('role', 'button');
      if (!el.hasAttribute('aria-label')) el.setAttribute('aria-label', 'View full image');
      applyOrientation(el, probe.naturalWidth, probe.naturalHeight);
    };
    probe.onerror = function () {
      el.dataset.unplugPlaceholder = 'true';
      el.style.backgroundImage = 'url("' + PLACEHOLDER.replace(/"/g, '%22') + '")';
      el.style.backgroundSize = 'contain';
      el.style.backgroundRepeat = 'no-repeat';
      el.style.backgroundPosition = 'center';
      el.classList.add('unplug-img-broken');
    };
    probe.src = src;
  }

  function captionFor(el) {
    if (!el) return '';
    if (el.dataset.unplugCaption) return el.dataset.unplugCaption;
    if (el.tagName === 'IMG' && el.alt) return el.alt;
    const figure = el.closest('figure');
    const figcaption = figure && figure.querySelector('figcaption');
    if (figcaption && figcaption.textContent.trim()) return figcaption.textContent.trim();
    const card = el.closest('article, .card, [class*="card"], [class*="profile"], [class*="member"], [class*="maker"], [class*="contest"]');
    if (card) {
      const title = card.querySelector('h1,h2,h3,h4,.name,[class*="title"]');
      if (title && title.textContent.trim()) return title.textContent.trim();
    }
    return el.getAttribute('title') || el.getAttribute('aria-label') || '';
  }

  function destinationFor(el) {
    if (!isBanner(el)) return '';
    const anchor = el.closest('a[href]') || el.querySelector && el.querySelector('a[href]');
    let href = anchor && anchor.getAttribute('href');
    if (!href) href = el.dataset.link || el.dataset.url || el.dataset.href || '';
    if (!href || href === '#' || /^javascript:/i.test(href)) return '';
    try { return new URL(href, window.location.href).href; } catch (_) { return ''; }
  }

  function mediaMeta(el) {
    if (!el) return null;
    const src = el.dataset.unplugBgMedia === 'true' ? el.dataset.unplugBgSrc : imageSource(el);
    if (!src || el.dataset.unplugPlaceholder === 'true' || src === PLACEHOLDER) return null;
    return { el, src, caption: captionFor(el), destination: destinationFor(el) };
  }

  function collectItems() {
    const seen = new Set();
    return Array.from(document.querySelectorAll('[data-unplug-media="true"]')).filter(visible).map(mediaMeta).filter(function (item) {
      if (!item || seen.has(item.src)) return false;
      seen.add(item.src);
      return true;
    });
  }

  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.className = 'unplug-lightbox';
    overlay.hidden = true;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Full image viewer');
    overlay.innerHTML = `
      <div class="unplug-lightbox-toolbar">
        <div class="unplug-lightbox-tools">
          <button type="button" data-lb-action="zoom-out" aria-label="Zoom out">−</button>
          <button type="button" data-lb-action="zoom-reset" aria-label="Reset zoom">100%</button>
          <button type="button" data-lb-action="zoom-in" aria-label="Zoom in">+</button>
        </div>
        <button type="button" class="unplug-lb-close" data-lb-action="close" aria-label="Close image viewer">×</button>
      </div>
      <div class="unplug-lightbox-main">
        <button type="button" class="unplug-lightbox-nav" data-lb-action="prev" aria-label="Previous image">‹</button>
        <div class="unplug-lightbox-stage" data-lb-stage>
          <img class="unplug-lightbox-image" alt="">
        </div>
        <button type="button" class="unplug-lightbox-nav" data-lb-action="next" aria-label="Next image">›</button>
      </div>
      <div class="unplug-lightbox-footer">
        <div class="unplug-lightbox-caption"><strong></strong><span></span></div>
        <a class="unplug-lightbox-cta" href="#" target="_blank" rel="noopener noreferrer" hidden>Visit advertiser / Learn more</a>
      </div>`;
    document.body.appendChild(overlay);

    overlay.addEventListener('click', function (event) {
      const action = event.target.closest('[data-lb-action]');
      if (action) {
        const name = action.dataset.lbAction;
        if (name === 'close') close();
        if (name === 'prev') move(-1);
        if (name === 'next') move(1);
        if (name === 'zoom-in') setZoom(zoom + 0.25);
        if (name === 'zoom-out') setZoom(zoom - 0.25);
        if (name === 'zoom-reset') setZoom(1);
        return;
      }
      if (event.target === overlay || event.target.matches('[data-lb-stage]')) close();
    });

    const stage = overlay.querySelector('[data-lb-stage]');
    stage.addEventListener('wheel', function (event) {
      if (overlay.hidden) return;
      event.preventDefault();
      setZoom(zoom + (event.deltaY < 0 ? 0.15 : -0.15));
    }, { passive: false });
    stage.addEventListener('pointerdown', function (event) { pointerStartX = event.clientX; });
    stage.addEventListener('pointerup', function (event) {
      if (pointerStartX == null) return;
      const delta = event.clientX - pointerStartX;
      pointerStartX = null;
      if (Math.abs(delta) > 55 && currentItems.length > 1) move(delta < 0 ? 1 : -1);
    });

    return overlay;
  }

  function setZoom(value) {
    zoom = Math.max(0.5, Math.min(4, Math.round(value * 100) / 100));
    if (!overlay) return;
    overlay.querySelector('.unplug-lightbox-image').style.transform = 'scale(' + zoom + ')';
    overlay.querySelector('[data-lb-action="zoom-reset"]').textContent = Math.round(zoom * 100) + '%';
  }

  function renderCurrent() {
    if (!overlay || currentIndex < 0 || !currentItems[currentIndex]) return;
    const item = currentItems[currentIndex];
    const image = overlay.querySelector('.unplug-lightbox-image');
    image.src = item.src;
    image.alt = item.caption || 'Full image';
    overlay.querySelector('.unplug-lightbox-caption strong').textContent = item.caption || 'Image';
    overlay.querySelector('.unplug-lightbox-caption span').textContent = currentItems.length > 1 ? (currentIndex + 1) + ' of ' + currentItems.length : '';
    const cta = overlay.querySelector('.unplug-lightbox-cta');
    if (item.destination) {
      cta.href = item.destination;
      cta.hidden = false;
    } else {
      cta.hidden = true;
      cta.removeAttribute('href');
    }
    const many = currentItems.length > 1;
    overlay.querySelector('[data-lb-action="prev"]').hidden = !many;
    overlay.querySelector('[data-lb-action="next"]').hidden = !many;
    setZoom(1);
  }

  function openFor(el) {
    const meta = mediaMeta(el);
    if (!meta) return;
    currentItems = collectItems();
    currentIndex = currentItems.findIndex((item) => item.el === el || item.src === meta.src);
    if (currentIndex < 0) {
      currentItems.unshift(meta);
      currentIndex = 0;
    }
    ensureOverlay();
    lastFocus = document.activeElement;
    overlay.hidden = false;
    document.documentElement.style.overflow = 'hidden';
    renderCurrent();
    overlay.querySelector('.unplug-lb-close').focus();
  }

  function close() {
    if (!overlay || overlay.hidden) return;
    overlay.hidden = true;
    document.documentElement.style.overflow = '';
    setZoom(1);
    if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
  }

  function move(delta) {
    if (currentItems.length < 2) return;
    currentIndex = (currentIndex + delta + currentItems.length) % currentItems.length;
    renderCurrent();
  }

  function clickedMedia(target) {
    if (!target || !target.closest) return null;
    return target.closest('[data-unplug-media="true"]');
  }

  document.addEventListener('click', function (event) {
    const media = clickedMedia(event.target);
    if (!media || media.dataset.unplugPlaceholder === 'true') return;
    event.preventDefault();
    openFor(media);
  });

  document.addEventListener('keydown', function (event) {
    if (!overlay || overlay.hidden) {
      if ((event.key === 'Enter' || event.key === ' ') && document.activeElement && document.activeElement.matches('[data-unplug-media="true"]')) {
        event.preventDefault();
        openFor(document.activeElement);
      }
      return;
    }
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); move(-1); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); move(1); }
    else if (event.key === '+' || event.key === '=') { event.preventDefault(); setZoom(zoom + 0.25); }
    else if (event.key === '-') { event.preventDefault(); setZoom(zoom - 0.25); }
    else if (event.key === '0') { event.preventDefault(); setZoom(1); }
  });

  function scan(root) {
    const scope = root && root.querySelectorAll ? root : document;
    if (root && root.tagName === 'IMG') setupImage(root);
    scope.querySelectorAll('img').forEach(setupImage);

    const selector = [
      '[style*="background-image"]', '[class*="photo"]', '[class*="image"]', '[class*="thumb"]',
      '[class*="avatar"]', '[class*="poster"]', '[class*="banner"]', '[class*="profile"]',
      '[class*="member"]', '[class*="gallery"]', '[class*="maker"]', '[class*="contest"]',
      '[class*="cover"]', '[class*="media"]', '[data-ad-slot]'
    ].join(',');
    if (root && root.matches && root.matches(selector)) backgroundCandidate(root);
    scope.querySelectorAll(selector).forEach(backgroundCandidate);
  }

  function queueScan(root) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(function () { scan(root || document); }, 120);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { scan(document); }, { once: true });
  else scan(document);

  const observer = new MutationObserver(function (mutations) {
    let root = null;
    for (const mutation of mutations) {
      if (mutation.addedNodes && mutation.addedNodes.length) {
        root = mutation.target;
        break;
      }
      if (mutation.type === 'attributes') {
        root = mutation.target;
        break;
      }
    }
    if (root) queueScan(root.nodeType === 1 ? root : document);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset', 'style', 'class'] });

  window.UnplugImageViewer = { open: openFor, close, scan: function () { scan(document); }, placeholder: PLACEHOLDER };
})();
