// Unplug — the component library.
//
// Custom elements, one script, no dependencies, no build step. Drop the tag in
// and it works:
//
//   <unplug-accordion>…</unplug-accordion>
//   <unplug-countdown to="2026-12-25T00:00:00+02:00">…</unplug-countdown>
//   <unplug-separator shape="wave"></unplug-separator>
//   <unplug-lightbox>…</unplug-lightbox>
//   <unplug-tweet text="…"></unplug-tweet>
//   <unplug-reveal>…</unplug-reveal>
//   <unplug-testimonials>…</unplug-testimonials>
//   <unplug-coming-soon>…</unplug-coming-soon>
//
// THREE RULES SHAPE ALL OF IT.
//
// 1. LIGHT DOM, NOT SHADOW DOM. These components hold the magazine's own
//    content — articles, quotes, photographs. In a shadow root that content is
//    invisible to the page's stylesheet, to the site search, and to a search
//    engine reading the page. A styling quirk is a smaller price than content
//    nobody can find.
//
// 2. THEY READ THE TOKENS. Every colour, spacing and duration comes from
//    unplug-tokens.css. Nothing here hard-codes #d20709, so the brand changes
//    in one place — including motion, which flattens to 1ms under
//    prefers-reduced-motion without any component knowing about it.
//
// 3. THE MARKUP WORKS WITHOUT THE SCRIPT. An accordion is headings and
//    sections; unenhanced it is a readable page rather than a blank one. If
//    this file fails to load, the content is still there.

(function () {
  'use strict';

  // --------------------------------------------------------------------------
  // Shared helpers
  // --------------------------------------------------------------------------

  let idCounter = 0;
  const uid = (prefix) => `${prefix}-${++idCounter}`;

  // Asked once, here, rather than in each component — and re-read rather than
  // cached, because somebody can change the setting without reloading.
  const reducedMotion = () =>
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function styleOnce(id, css) {
    if (document.getElementById(id)) return;
    const style = document.createElement('style');
    style.id = id;
    style.textContent = css;
    document.head.appendChild(style);
  }

  // --------------------------------------------------------------------------
  // <unplug-accordion> — and tabs, which are the same information in a
  // different shape.
  //
  //   <unplug-accordion>
  //     <h3 slot="title">Question</h3>
  //     <div>Answer</div>
  //     …
  //   </unplug-accordion>
  //
  // The disclosure pattern, not the menu pattern: each heading is a real
  // <button> inside a heading element, which is what a screen reader announces
  // as "button, collapsed" and what a keyboard reaches with Tab. Arrow-key
  // navigation is deliberately NOT added — for a list of disclosures the
  // expected behaviour is Tab, and hijacking the arrow keys breaks scrolling
  // for somebody navigating by keyboard.
  // --------------------------------------------------------------------------
  class UnplugAccordion extends HTMLElement {
    connectedCallback() {
      if (this._built) return;
      this._built = true;

      styleOnce('unplug-accordion-styles', `
        unplug-accordion { display:block; border-top:1px solid var(--paper-line); }
        unplug-accordion .ua-item { border-bottom:1px solid var(--paper-line); }
        unplug-accordion .ua-trigger {
          width:100%; text-align:left; background:none; border:0; cursor:pointer;
          padding:var(--space-4) 0; font:inherit; font-weight:700; color:var(--ink);
          display:flex; justify-content:space-between; align-items:center; gap:var(--space-3);
        }
        unplug-accordion .ua-trigger:focus-visible { outline:2px solid var(--red); outline-offset:2px; }
        unplug-accordion .ua-mark { color:var(--red); font-size:1.2em; line-height:1; transition:transform var(--motion-base); }
        unplug-accordion .ua-trigger[aria-expanded="true"] .ua-mark { transform:rotate(45deg); }
        unplug-accordion .ua-panel { padding:0 0 var(--space-4); color:var(--slate); line-height:var(--leading-body); }
      `);

      const titles = [...this.querySelectorAll('[slot="title"]')];
      titles.forEach((titleEl) => {
        const panel = titleEl.nextElementSibling;
        if (!panel) return;

        const item = document.createElement('div');
        item.className = 'ua-item';

        // The heading LEVEL is kept from the markup. Replacing an h3 with a
        // div would remove it from the document outline a screen-reader user
        // navigates by.
        const heading = document.createElement(titleEl.tagName);
        const trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'ua-trigger';

        const label = document.createElement('span');
        label.textContent = titleEl.textContent;
        const mark = document.createElement('span');
        mark.className = 'ua-mark';
        mark.textContent = '+';
        mark.setAttribute('aria-hidden', 'true');   // "+" read aloud is noise
        trigger.appendChild(label);
        trigger.appendChild(mark);

        const panelId = uid('ua-panel');
        const triggerId = uid('ua-trigger');
        trigger.id = triggerId;
        trigger.setAttribute('aria-controls', panelId);
        trigger.setAttribute('aria-expanded', this.hasAttribute('open-first') && !titles.indexOf(titleEl) ? 'true' : 'false');

        panel.id = panelId;
        panel.className = 'ua-panel';
        panel.setAttribute('role', 'region');
        panel.setAttribute('aria-labelledby', triggerId);
        panel.hidden = trigger.getAttribute('aria-expanded') !== 'true';

        trigger.addEventListener('click', () => {
          const open = trigger.getAttribute('aria-expanded') === 'true';
          trigger.setAttribute('aria-expanded', String(!open));
          panel.hidden = open;
        });

        heading.appendChild(trigger);
        item.appendChild(heading);
        item.appendChild(panel);
        this.appendChild(item);
        titleEl.remove();
      });
    }
  }

  // --------------------------------------------------------------------------
  // <unplug-countdown to="2026-12-25T00:00:00+02:00">
  //
  // For competition deadlines and edition launches.
  //
  // THE TIME IS ANNOUNCED, NOT SHOUTED. A live region that updates every
  // second would have a screen reader reciting the seconds for ever. The
  // digits update visually; the accessible announcement is polite and only
  // changes when the minutes do.
  // --------------------------------------------------------------------------
  class UnplugCountdown extends HTMLElement {
    connectedCallback() {
      if (this._built) return;
      this._built = true;

      styleOnce('unplug-countdown-styles', `
        unplug-countdown { display:flex; gap:var(--space-4); font-family:var(--font-body); }
        unplug-countdown .uc-part { text-align:center; min-width:56px; }
        unplug-countdown .uc-num {
          display:block; font-size:var(--text-2xl); font-weight:800; color:var(--ink);
          font-variant-numeric:tabular-nums;
        }
        unplug-countdown .uc-label {
          display:block; font-size:var(--text-xs); text-transform:uppercase;
          letter-spacing:0.08em; color:var(--slate);
        }
        unplug-countdown[data-done="true"] .uc-num { color:var(--slate); }
      `);

      const target = new Date(this.getAttribute('to'));
      if (Number.isNaN(target.getTime())) {
        // A bad date shows nothing rather than "NaN days".
        this.hidden = true;
        return;
      }

      this._finishedText = this.getAttribute('finished') || 'Closed';
      const parts = {};
      ['days', 'hours', 'minutes', 'seconds'].forEach((unit) => {
        const box = document.createElement('span');
        box.className = 'uc-part';
        const num = document.createElement('span');
        num.className = 'uc-num';
        num.textContent = '--';
        const label = document.createElement('span');
        label.className = 'uc-label';
        label.textContent = unit;
        box.appendChild(num);
        box.appendChild(label);
        this.appendChild(box);
        parts[unit] = num;
      });

      // The polite announcement, separate from the ticking digits.
      const live = document.createElement('span');
      live.className = 'sr-only';
      live.setAttribute('aria-live', 'polite');
      live.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);';
      this.appendChild(live);

      let lastAnnouncedMinute = null;

      const tick = () => {
        const remaining = target.getTime() - Date.now();
        if (remaining <= 0) {
          this.setAttribute('data-done', 'true');
          Object.values(parts).forEach((p) => { p.textContent = '0'; });
          live.textContent = this._finishedText;
          clearInterval(this._timer);
          this.dispatchEvent(new CustomEvent('unplug:countdown-finished', { bubbles: true }));
          return;
        }
        const s = Math.floor(remaining / 1000);
        const days = Math.floor(s / 86400);
        const hours = Math.floor((s % 86400) / 3600);
        const minutes = Math.floor((s % 3600) / 60);
        const seconds = s % 60;

        parts.days.textContent = String(days);
        parts.hours.textContent = String(hours).padStart(2, '0');
        parts.minutes.textContent = String(minutes).padStart(2, '0');
        parts.seconds.textContent = String(seconds).padStart(2, '0');

        if (minutes !== lastAnnouncedMinute) {
          lastAnnouncedMinute = minutes;
          live.textContent = `${days} days, ${hours} hours and ${minutes} minutes remaining`;
        }
      };

      tick();
      this._timer = setInterval(tick, 1000);
    }

    disconnectedCallback() {
      // A timer left running on a removed element keeps the element alive and
      // keeps working for ever. On a single-page site that is a leak per visit.
      clearInterval(this._timer);
    }
  }

  // --------------------------------------------------------------------------
  // <unplug-separator shape="wave|slant|layered" flip height="60">
  //
  // Purely decorative, and marked as such: aria-hidden, so a screen reader
  // does not announce a shape that means nothing.
  // --------------------------------------------------------------------------
  const SEPARATOR_SHAPES = {
    wave: 'M0,40 C240,90 480,-10 720,40 C960,90 1200,-10 1440,40 L1440,120 L0,120 Z',
    slant: 'M0,120 L1440,0 L1440,120 Z',
    curve: 'M0,120 C480,0 960,0 1440,120 Z',
    layered: null,   // handled below: two paths at different opacities
  };

  class UnplugSeparator extends HTMLElement {
    connectedCallback() {
      if (this._built) return;
      this._built = true;

      const shape = this.getAttribute('shape') || 'wave';
      const height = this.getAttribute('height') || '60';
      const colour = this.getAttribute('colour') || 'var(--paper)';

      this.setAttribute('aria-hidden', 'true');
      this.style.cssText = `display:block; line-height:0; ${this.hasAttribute('flip') ? 'transform:scaleY(-1);' : ''}`;

      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 1440 120');
      svg.setAttribute('preserveAspectRatio', 'none');
      svg.setAttribute('focusable', 'false');
      svg.style.cssText = `display:block; width:100%; height:${height}px;`;

      const paths = shape === 'layered'
        ? [{ d: SEPARATOR_SHAPES.wave, opacity: 0.4 }, { d: SEPARATOR_SHAPES.curve, opacity: 1 }]
        : [{ d: SEPARATOR_SHAPES[shape] || SEPARATOR_SHAPES.wave, opacity: 1 }];

      paths.forEach((spec) => {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', spec.d);
        path.setAttribute('fill', colour);
        path.setAttribute('opacity', String(spec.opacity));
        svg.appendChild(path);
      });
      this.appendChild(svg);
    }
  }

  // --------------------------------------------------------------------------
  // <unplug-lightbox> — wraps a set of images.
  //
  // THE FOCUS TRAP IS THE WHOLE JOB. A dialog somebody can Tab out of, into a
  // page they cannot see, is worse than no dialog: they are lost with no way
  // back. Focus moves in on open, is held while open, and returns to whatever
  // opened it on close.
  // --------------------------------------------------------------------------
  class UnplugLightbox extends HTMLElement {
    connectedCallback() {
      if (this._built) return;
      this._built = true;

      styleOnce('unplug-lightbox-styles', `
        .ul-overlay {
          position:fixed; inset:0; background:rgba(15,14,14,0.92); z-index:9999;
          display:flex; align-items:center; justify-content:center; flex-direction:column;
          opacity:0; transition:opacity var(--motion-base);
        }
        .ul-overlay[data-open="true"] { opacity:1; }
        .ul-overlay img { max-width:92vw; max-height:78vh; object-fit:contain; }
        .ul-bar { display:flex; gap:var(--space-4); margin-top:var(--space-4); }
        .ul-bar button {
          background:none; border:1px solid rgba(255,255,255,0.5); color:#fff;
          padding:var(--space-2) var(--space-4); border-radius:var(--radius-sm);
          cursor:pointer; font:inherit;
        }
        .ul-bar button:focus-visible { outline:2px solid var(--red); outline-offset:2px; }
        .ul-caption { color:#fff; margin-top:var(--space-3); font-size:var(--text-sm); }
      `);

      this._images = [...this.querySelectorAll('img')];
      this._images.forEach((img, index) => {
        img.style.cursor = 'zoom-in';
        // Reachable and operable by keyboard, not only by mouse.
        img.tabIndex = 0;
        img.setAttribute('role', 'button');
        img.setAttribute('aria-label', `View ${img.alt || 'image'} full size`);
        img.addEventListener('click', () => this.open(index));
        img.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.open(index); }
        });
      });
    }

    open(index) {
      this._index = index;
      this._opener = document.activeElement;

      const overlay = document.createElement('div');
      overlay.className = 'ul-overlay';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-label', 'Image viewer');

      const img = document.createElement('img');
      const caption = document.createElement('div');
      caption.className = 'ul-caption';

      const bar = document.createElement('div');
      bar.className = 'ul-bar';
      const prev = this._button('Previous', () => this.step(-1));
      const next = this._button('Next', () => this.step(1));
      const close = this._button('Close', () => this.close());
      bar.appendChild(prev); bar.appendChild(next); bar.appendChild(close);

      overlay.appendChild(img);
      overlay.appendChild(caption);
      overlay.appendChild(bar);
      document.body.appendChild(overlay);
      document.body.style.overflow = 'hidden';

      this._overlay = overlay;
      this._img = img;
      this._captionEl = caption;
      this._show();

      requestAnimationFrame(() => overlay.setAttribute('data-open', 'true'));
      close.focus();

      this._onKey = (e) => {
        if (e.key === 'Escape') { this.close(); return; }
        if (e.key === 'ArrowRight') { this.step(1); return; }
        if (e.key === 'ArrowLeft') { this.step(-1); return; }
        if (e.key !== 'Tab') return;
        // The trap.
        const focusable = overlay.querySelectorAll('button');
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      };
      document.addEventListener('keydown', this._onKey);

      // Swipe, for a phone.
      let startX = null;
      overlay.addEventListener('touchstart', (e) => { startX = e.touches[0].clientX; }, { passive: true });
      overlay.addEventListener('touchend', (e) => {
        if (startX === null) return;
        const delta = e.changedTouches[0].clientX - startX;
        if (Math.abs(delta) > 50) this.step(delta < 0 ? 1 : -1);
        startX = null;
      });
    }

    _button(label, onClick) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', onClick);
      return b;
    }

    _show() {
      const source = this._images[this._index];
      this._img.src = source.currentSrc || source.src;
      this._img.alt = source.alt || '';
      this._captionEl.textContent =
        `${source.alt || ''}${this._images.length > 1 ? `  (${this._index + 1} of ${this._images.length})` : ''}`;
    }

    step(by) {
      this._index = (this._index + by + this._images.length) % this._images.length;
      this._show();
    }

    close() {
      if (!this._overlay) return;
      document.removeEventListener('keydown', this._onKey);
      this._overlay.remove();
      this._overlay = null;
      document.body.style.overflow = '';
      // Back where they were, or they are left at the top of the page with no
      // idea where the thing they were looking at went.
      if (this._opener && this._opener.focus) this._opener.focus();
    }
  }

  // --------------------------------------------------------------------------
  // <unplug-tweet text="…" url="…">
  //
  // A link, not a script. The official button loads code from another company
  // on every page it appears, which costs a request and tells them who read
  // the article. This is an anchor.
  // --------------------------------------------------------------------------
  class UnplugTweet extends HTMLElement {
    connectedCallback() {
      if (this._built) return;
      this._built = true;

      styleOnce('unplug-tweet-styles', `
        unplug-tweet { display:block; margin:var(--space-5) 0; }
        unplug-tweet .ut-quote {
          font-family:var(--font-display); font-size:var(--text-xl); line-height:1.35;
          color:var(--ink); border-left:3px solid var(--red); padding-left:var(--space-4);
        }
        unplug-tweet .ut-link {
          display:inline-block; margin-top:var(--space-3); margin-left:var(--space-4);
          font-size:var(--text-sm); font-weight:700; color:var(--red); text-decoration:none;
        }
        unplug-tweet .ut-link:hover, unplug-tweet .ut-link:focus-visible { text-decoration:underline; }
      `);

      const text = this.getAttribute('text') || this.textContent.trim();
      const url = this.getAttribute('url') || window.location.href;
      this.textContent = '';

      const quote = document.createElement('blockquote');
      quote.className = 'ut-quote';
      quote.textContent = text;

      const link = document.createElement('a');
      link.className = 'ut-link';
      link.href = 'https://twitter.com/intent/tweet?text='
        + encodeURIComponent(text) + '&url=' + encodeURIComponent(url);
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = 'Share this ↗';
      // The visible text says "share this"; on its own in a list of links that
      // is meaningless, so the accessible name carries the quote.
      link.setAttribute('aria-label', `Share on X: ${text}`);

      this.appendChild(quote);
      this.appendChild(link);
    }
  }

  // --------------------------------------------------------------------------
  // <unplug-reveal> — fades content in as it scrolls into view.
  //
  // IF THE READER HAS ASKED FOR LESS MOTION, THERE IS NO ANIMATION AT ALL and
  // the content is simply visible. Not a faster animation — none. The same is
  // true when IntersectionObserver is missing: the fallback is visible
  // content, never content stuck at opacity 0.
  // --------------------------------------------------------------------------
  class UnplugReveal extends HTMLElement {
    connectedCallback() {
      if (this._built) return;
      this._built = true;

      styleOnce('unplug-reveal-styles', `
        unplug-reveal { display:block; }
        unplug-reveal[data-animate="pending"] { opacity:0; transform:translateY(14px); }
        unplug-reveal[data-animate="in"] {
          opacity:1; transform:none;
          transition:opacity var(--motion-slow) ease-out, transform var(--motion-slow) ease-out;
        }
      `);

      if (reducedMotion() || !('IntersectionObserver' in window)) return;

      // CONTENT IS NOT HIDDEN UNTIL THE OBSERVER HAS PROVED IT WORKS.
      //
      // The obvious way round — hide now, reveal on intersection — fails badly
      // when the callback never arrives: the content stays at opacity 0 for
      // ever and the reader sees a blank space where an article was. That is
      // not hypothetical; it happened while testing this, in a browser tab
      // that was not compositing.
      //
      // So the FIRST callback decides. IntersectionObserver always delivers
      // one for the initial state, so if it is working the element is either
      // hidden-then-revealed or simply revealed. If it is not working, nothing
      // is ever hidden and the page reads exactly as it would without this
      // component.
      let first = true;
      const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.setAttribute('data-animate', 'in');
            observer.unobserve(entry.target);
          } else if (first) {
            // Below the fold on the first look: safe to hide, because this
            // callback arriving proves the next one will too.
            entry.target.setAttribute('data-animate', 'pending');
          }
        });
        first = false;
      }, { rootMargin: '0px 0px -10% 0px' });
      observer.observe(this);
      this._observer = observer;

      // Belt and braces. If anything at all goes wrong — a browser quirk, a
      // page restored from the back/forward cache — the content appears
      // anyway. A late fade is a blemish; permanently invisible content is a
      // broken page.
      this._failsafe = setTimeout(() => {
        if (this.getAttribute('data-animate') === 'pending') {
          this.setAttribute('data-animate', 'in');
          observer.disconnect();
        }
      }, 4000);
    }

    disconnectedCallback() {
      if (this._observer) this._observer.disconnect();
      clearTimeout(this._failsafe);
    }
  }

  // --------------------------------------------------------------------------
  // <unplug-testimonials> — social proof.
  //
  // A list, marked up as a list. Rotating carousels of quotes are a common
  // choice and a poor one: somebody reading slowly loses the sentence, and a
  // screen reader announces whichever one happens to be showing. These are all
  // present, and CSS decides how they sit.
  // --------------------------------------------------------------------------
  class UnplugTestimonials extends HTMLElement {
    connectedCallback() {
      if (this._built) return;
      this._built = true;

      styleOnce('unplug-testimonials-styles', `
        unplug-testimonials { display:grid; gap:var(--space-4);
          grid-template-columns:repeat(auto-fit, minmax(240px, 1fr)); }
        unplug-testimonials figure {
          margin:0; background:var(--cream); border:1px solid var(--paper-line);
          border-radius:var(--radius-md); padding:var(--space-5); box-shadow:var(--shadow-sm);
        }
        unplug-testimonials blockquote { margin:0; font-size:var(--text-base);
          line-height:var(--leading-body); color:var(--ink); }
        unplug-testimonials figcaption { margin-top:var(--space-3); font-size:var(--text-sm);
          color:var(--slate); font-weight:700; }
      `);
      this.setAttribute('role', 'list');
      this.querySelectorAll('figure').forEach((f) => f.setAttribute('role', 'listitem'));
    }
  }

  // --------------------------------------------------------------------------
  // <unplug-coming-soon> — a maintenance overlay for one page or section.
  //
  // NOT A SECURITY CONTROL, and the comment is here so nobody mistakes it for
  // one. It hides content in the browser; the content is still in the HTML and
  // still in the API. Anything that genuinely must not be seen is gated on the
  // server.
  // --------------------------------------------------------------------------
  class UnplugComingSoon extends HTMLElement {
    connectedCallback() {
      if (this._built) return;
      this._built = true;
      if (this.getAttribute('active') !== 'true') { this.hidden = true; return; }

      styleOnce('unplug-coming-soon-styles', `
        unplug-coming-soon {
          display:flex; align-items:center; justify-content:center; flex-direction:column;
          text-align:center; padding:var(--space-8) var(--space-5);
          background:var(--paper); border-radius:var(--radius-lg); gap:var(--space-3);
        }
        unplug-coming-soon h2 { font-family:var(--font-display); font-size:var(--text-2xl); color:var(--ink); margin:0; }
        unplug-coming-soon p { color:var(--slate); margin:0; max-width:48ch; }
      `);
      this.setAttribute('role', 'status');
    }
  }

  // --------------------------------------------------------------------------
  // Registration
  // --------------------------------------------------------------------------
  const REGISTRY = {
    'unplug-accordion': UnplugAccordion,
    'unplug-countdown': UnplugCountdown,
    'unplug-separator': UnplugSeparator,
    'unplug-lightbox': UnplugLightbox,
    'unplug-tweet': UnplugTweet,
    'unplug-reveal': UnplugReveal,
    'unplug-testimonials': UnplugTestimonials,
    'unplug-coming-soon': UnplugComingSoon,
  };

  Object.entries(REGISTRY).forEach(([tag, cls]) => {
    // Defining a name twice throws and would stop every component after it
    // from registering — which is how one duplicated script tag takes out the
    // whole library.
    if (!customElements.get(tag)) customElements.define(tag, cls);
  });

  window.UnplugComponents = { registry: Object.keys(REGISTRY), reducedMotion };
})();
