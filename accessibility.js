/* ===========================================================================
   Unplug Magazine — One-Click Accessibility Toolbar
   ---------------------------------------------------------------------------
   A single self-contained script: it injects its own styles, a floating
   button, and a settings panel offering:
     👋 SASL Mode          — reveals South African Sign Language video content
                             where available and surfaces SASL resources
     🔊 Read aloud         — reads the main content via the browser's speech API
     🔍 Increase font size — cycles page zoom (100 → 115 → 130 → 145%)
     🌙 High contrast mode
     🖤 Dark mode
     📖 Dyslexia-friendly font
     📱 Simplified reading mode
   Preferences persist in localStorage and re-apply on every page load, so a
   visitor sets them once. Because the site is CSS-variable driven, dark and
   high-contrast modes are done by remapping those variables.

   Drop-in: add <script src="accessibility.js" defer></script> to any page.
   =========================================================================== */
(function () {
  'use strict';
  if (window.__unplugA11yLoaded) return;
  window.__unplugA11yLoaded = true;

  var STORE_KEY = 'unplug_a11y_prefs';
  var FONT_STEPS = [1, 1.15, 1.3, 1.45];

  var prefs = loadPrefs();

  function loadPrefs() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function savePrefs() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(prefs)); } catch (e) {}
  }

  // --- styles -------------------------------------------------------------
  var css = `
  .a11y-fab{ position:fixed; left:20px; bottom:20px; z-index:100000; width:56px; height:56px; border-radius:50%;
    background:#d20709; color:#fff; border:2px solid #fff; box-shadow:0 6px 20px rgba(0,0,0,0.3);
    cursor:pointer; font-size:26px; line-height:1; display:flex; align-items:center; justify-content:center; }
  .a11y-fab:hover{ background:#a80608; }
  .a11y-fab:focus-visible{ outline:3px solid #1f6feb; outline-offset:2px; }
  .a11y-panel{ position:fixed; left:20px; bottom:88px; z-index:100000; width:290px; max-width:calc(100vw - 40px);
    background:#fff; color:#161616; border:1px solid rgba(0,0,0,0.15); border-radius:12px;
    box-shadow:0 12px 40px rgba(0,0,0,0.28); padding:16px; display:none;
    font-family:'Inter',system-ui,sans-serif; }
  .a11y-panel.open{ display:block; }
  .a11y-panel h2{ font-size:15px; font-weight:700; margin:0 0 4px; font-family:inherit; }
  .a11y-panel .a11y-sub{ font-size:12px; color:#555; margin:0 0 12px; }
  .a11y-grid{ display:grid; grid-template-columns:1fr 1fr; gap:8px; }
  .a11y-opt{ display:flex; flex-direction:column; align-items:center; gap:4px; text-align:center;
    border:1px solid rgba(0,0,0,0.15); border-radius:9px; background:#fff; color:#161616;
    padding:11px 6px; font-size:11.5px; font-weight:600; cursor:pointer; font-family:inherit; line-height:1.2; }
  .a11y-opt .ic{ font-size:20px; }
  .a11y-opt:hover{ border-color:#d20709; }
  .a11y-opt.active{ background:#d20709; color:#fff; border-color:#d20709; }
  .a11y-opt:focus-visible{ outline:3px solid #1f6feb; outline-offset:1px; }
  .a11y-reset{ margin-top:10px; width:100%; border:none; background:none; color:#d20709; font-weight:700;
    font-size:12px; cursor:pointer; padding:6px; font-family:inherit; text-decoration:underline; }
  .a11y-sasl-note{ position:fixed; left:0; right:0; top:0; z-index:99998; background:#161616; color:#fff;
    font-family:'Inter',system-ui,sans-serif; font-size:13px; text-align:center; padding:9px 16px; display:none; }
  html.a11y-sasl .a11y-sasl-note{ display:block; }
  html.a11y-sasl [data-sasl]{ display:block !important; }

  /* Dark mode — remap the site's CSS variables (leave --black/red/accents). */
  html.a11y-dark{ --paper:#15140f; --cream:#1f1e1a; --ink:#ededea; --slate:#b7b3ab; --paper-line:rgba(255,255,255,0.16); }
  html.a11y-dark body{ background:#15140f; }
  html.a11y-dark img{ filter:brightness(0.92); }

  /* High contrast — pure black on white with hard borders. */
  html.a11y-contrast{ --paper:#ffffff; --cream:#ffffff; --ink:#000000; --slate:#000000; --paper-line:#000000; --red:#c00000; }
  html.a11y-contrast body{ background:#fff; }
  html.a11y-contrast a, html.a11y-contrast button{ text-decoration:underline; }
  html.a11y-contrast *{ border-color:#000 !important; }

  /* Dyslexia-friendly — legible stack + generous spacing. */
  html.a11y-dyslexia body, html.a11y-dyslexia body *{
    font-family:'Comic Sans MS','Trebuchet MS',Verdana,sans-serif !important;
    letter-spacing:0.04em !important; word-spacing:0.09em !important; line-height:1.65 !important; }

  /* Reduce motion — neutralise animations, transitions and auto-scrolling for
     motion-sensitive users, regardless of the OS setting. */
  html.a11y-motion *, html.a11y-motion *::before, html.a11y-motion *::after{
    animation-duration:0.001ms !important; animation-iteration-count:1 !important;
    transition-duration:0.001ms !important; scroll-behavior:auto !important; }

  /* Colour-blind safe — swap the red accent for an Okabe–Ito blue that stays
     distinguishable under red/green colour blindness, and never rely on colour
     alone: underline links and outline focus/active states. */
  html.a11y-cvd{ --red:#0072B2; --maroon:#005a8c; --gold:#E69F00; }
  html.a11y-cvd a:not(.btn){ text-decoration:underline; }
  html.a11y-cvd .btn-solid{ background:#0072B2; border-color:#0072B2; color:#fff; }

  /* Simplified reading — hide decoration/ads, narrow the measure. */
  html.a11y-simple .ad-slot,
  html.a11y-simple .print-mark,
  html.a11y-simple .poster-slideshow,
  html.a11y-simple .hero-print,
  html.a11y-simple .bday-print{ display:none !important; }
  html.a11y-simple .wrap, html.a11y-simple .youtube-inner{ max-width:760px !important; }
  html.a11y-simple p, html.a11y-simple li{ font-size:17px !important; line-height:1.75 !important; }

  @media(max-width:600px){ .a11y-fab{ left:14px; bottom:14px; } .a11y-panel{ left:14px; } }
  @media print{ .a11y-fab,.a11y-panel,.a11y-sasl-note{ display:none !important; } }
  `;
  var styleEl = document.createElement('style');
  styleEl.setAttribute('data-a11y', '');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  // --- markup -------------------------------------------------------------
  var saslNote = document.createElement('div');
  saslNote.className = 'a11y-sasl-note';
  saslNote.innerHTML = '👋 SASL Mode is on — sign-language content is shown where available. Learn Basic SASL in the <a href="unplug-magazine.html#deaf-community" style="color:#ffccc5;">Deaf Community</a> hub.';
  document.body.appendChild(saslNote);

  var fab = document.createElement('button');
  fab.className = 'a11y-fab';
  fab.setAttribute('aria-label', 'Accessibility options');
  fab.setAttribute('aria-expanded', 'false');
  fab.innerHTML = '<span aria-hidden="true">♿</span>';
  document.body.appendChild(fab);

  var panel = document.createElement('div');
  panel.className = 'a11y-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Accessibility options');
  panel.innerHTML =
    '<h2>Accessibility</h2>' +
    '<p class="a11y-sub">Adjust the site to suit you. Your choices are remembered.</p>' +
    '<div class="a11y-grid">' +
      optBtn('sasl', '👋', 'SASL Mode') +
      optBtn('read', '🔊', 'Read aloud') +
      optBtn('font', '🔍', 'Font size') +
      optBtn('contrast', '🌙', 'High contrast') +
      optBtn('dark', '🖤', 'Dark mode') +
      optBtn('dyslexia', '📖', 'Dyslexia font') +
      optBtn('motion', '🎬', 'Reduce motion') +
      optBtn('cvd', '🌈', 'Colour-blind') +
      optBtn('simple', '📱', 'Simplified') +
    '</div>' +
    '<button class="a11y-reset" type="button">Reset all</button>';
  document.body.appendChild(panel);

  function optBtn(key, icon, label) {
    return '<button class="a11y-opt" type="button" data-opt="' + key + '" aria-pressed="false">' +
      '<span class="ic" aria-hidden="true">' + icon + '</span><span>' + label + '</span></button>';
  }

  // --- behaviour ----------------------------------------------------------
  function togglePanel(force) {
    var open = force != null ? force : !panel.classList.contains('open');
    panel.classList.toggle('open', open);
    fab.setAttribute('aria-expanded', String(open));
  }
  fab.addEventListener('click', function () { togglePanel(); });
  document.addEventListener('click', function (e) {
    if (!panel.contains(e.target) && e.target !== fab && !fab.contains(e.target)) togglePanel(false);
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') togglePanel(false); });

  function setToggle(cls, on) {
    document.documentElement.classList.toggle('a11y-' + cls, on);
  }

  function applyFont() {
    var scale = FONT_STEPS[prefs.fontStep || 0] || 1;
    document.documentElement.style.zoom = scale === 1 ? '' : scale;
  }

  function reflect() {
    panel.querySelectorAll('.a11y-opt').forEach(function (btn) {
      var key = btn.dataset.opt;
      var active = false;
      if (key === 'font') active = (prefs.fontStep || 0) > 0;
      else if (key === 'read') active = speaking;
      else active = !!prefs[key];
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
      if (key === 'font') {
        var pct = Math.round((FONT_STEPS[prefs.fontStep || 0] || 1) * 100);
        btn.querySelector('span:last-child').textContent = 'Font ' + pct + '%';
      }
    });
  }

  function applyAll() {
    ['sasl', 'contrast', 'dark', 'dyslexia', 'motion', 'cvd', 'simple'].forEach(function (k) {
      setToggle(k, !!prefs[k]);
    });
    applyFont();
    reflect();
  }

  // Read-aloud via the Web Speech API.
  var speaking = false;
  var synth = window.speechSynthesis;
  function readableText() {
    var src = document.querySelector('.page.active') || document.querySelector('main') || document.body;
    var clone = src.cloneNode(true);
    clone.querySelectorAll('script,style,.a11y-fab,.a11y-panel,nav,header,footer').forEach(function (n) { n.remove(); });
    return (clone.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 6000);
  }
  function toggleRead() {
    if (!synth) { alert('Sorry — your browser does not support read-aloud.'); return; }
    if (speaking) { synth.cancel(); speaking = false; reflect(); return; }
    var text = readableText();
    if (!text) return;
    var u = new SpeechSynthesisUtterance(text);
    u.rate = 1; u.lang = 'en-ZA';
    u.onend = u.onerror = function () { speaking = false; reflect(); };
    synth.cancel();
    synth.speak(u);
    speaking = true; reflect();
  }

  panel.querySelectorAll('.a11y-opt').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var key = btn.dataset.opt;
      if (key === 'read') { toggleRead(); return; }
      if (key === 'font') {
        prefs.fontStep = ((prefs.fontStep || 0) + 1) % FONT_STEPS.length;
        applyFont();
      } else {
        prefs[key] = !prefs[key];
        setToggle(key, prefs[key]);
      }
      savePrefs();
      reflect();
    });
  });

  panel.querySelector('.a11y-reset').addEventListener('click', function () {
    if (synth) synth.cancel();
    speaking = false;
    prefs = {};
    savePrefs();
    ['sasl', 'contrast', 'dark', 'dyslexia', 'motion', 'cvd', 'simple'].forEach(function (k) { setToggle(k, false); });
    applyFont();
    reflect();
  });

  // Stop speech if the user navigates away.
  window.addEventListener('beforeunload', function () { if (synth) synth.cancel(); });

  applyAll();
})();
