/* ===========================================================================
   Unplug Magazine — "Unplug Assistant" chatbot
   ---------------------------------------------------------------------------
   A self-contained, rule-based FAQ assistant. No backend, no API key, no
   running cost — it matches the visitor's message against a small knowledge
   base and replies, offering quick-reply chips to guide the conversation.
   Text-first by design (works well for Deaf visitors). Drop-in:
     <script src="chatbot.js" defer></script>
   =========================================================================== */
(function () {
  'use strict';
  if (window.__unplugBotLoaded) return;
  window.__unplugBotLoaded = true;

  var EMAIL = 'info@unplugnews.com';

  // ---------------------------------------------------------------------
  // Handing over to a person.
  //
  // The assistant answers what it knows and then gets out of the way. Until
  // now it could not: the most it could do was print an email address in the
  // middle of a conversation and hope.
  //
  // WHATSAPP RATHER THAN A CHAT WINDOW, and the reason is the hosting. This
  // API sleeps when nobody is using it, so a WebSocket or an SSE stream dies
  // with it and the reader is left watching a window that implies somebody is
  // listening. Polling survives the sleep but only moves the problem — an
  // unattended chat box is worse than none, because it promises a person.
  //
  // WhatsApp works while the site is asleep, costs nothing, and the reply
  // comes from a phone instead of an admin screen somebody has to be watching.
  // ---------------------------------------------------------------------
  var HANDOFF = { number: '', hours: '' };
  var transcript = [];

  // The number is a setting rather than a constant here, so it can be changed
  // without a deploy — and so this file does not have to carry somebody's
  // personal phone number in a public repository.
  (function loadHandoff() {
    var base;
    try {
      base = localStorage.getItem('unplug_api_base') || 'https://unplug-ecosystem.onrender.com';
    } catch (e) {
      base = 'https://unplug-ecosystem.onrender.com';
    }
    fetch(base.replace(/\/$/, '') + '/public-settings')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !d.settings) return;
        HANDOFF.number = (d.settings.whatsapp_number || '').replace(/[^0-9]/g, '');
        HANDOFF.hours = d.settings.whatsapp_hours || '';
      })
      .catch(function () { /* no number means the email offer, which still works */ });
  })();

  // Knowledge base: each entry has trigger keywords, a reply (HTML allowed),
  // and optional follow-up quick-reply chips.
  var KB = [
    { id: 'submit', label: 'Submit a story', kw: ['submit', 'story', 'article', 'publish', 'write', 'contribute'],
      reply: 'To submit a story or article, use the <b>Submit a Story</b> button (top of the site) — it takes you to the Member Dashboard where you sign in (free) and submit. Publishing a paid article is charged there.',
      chips: ['Pricing', 'Contact'] },
    { id: 'directory', label: 'Join the Directory', kw: ['directory', 'listing', 'profile', 'get listed', 'join'],
      reply: 'The Directory lists people and businesses. Pick a package on the <b>Directory</b> page, then check out. Individual: Basic R150 / Pro R280 / Premium R400. Business: Basic R600 / Pro R1000 / Premium R1500 (once-off).',
      chips: ['Pricing', 'Deaf-owned badge', 'Submit a story'] },
    { id: 'pricing', label: 'Pricing', kw: ['price', 'pricing', 'cost', 'how much', 'fee', 'package', 'r150', 'payment', 'pay'],
      reply: 'Directory (once-off) — Individual: R150 / R280 / R400. Business: R600 / R1000 / R1500. Article publishing, event listings, edition downloads (R50) and competition entries are priced at checkout. Payment is by EFT to our FNB account, or card once live.',
      chips: ['How to pay (EFT)', 'Join the Directory'] },
    { id: 'eft', label: 'How to pay (EFT)', kw: ['eft', 'bank', 'account', 'transfer', 'fnb'],
      reply: 'We accept manual EFT. At checkout you’ll get our FNB account details and a unique reference — use that exact reference so we can match your payment. An admin confirms it once it reflects.',
      chips: ['Pricing', 'Contact'] },
    { id: 'deaf', label: 'Deaf Community', kw: ['deaf', 'sasl', 'sign language', 'accessibility', 'disability', 'hearing'],
      reply: 'We’re building for the Deaf community. Use the <b>♿ accessibility button</b> (bottom-left) for SASL mode, read-aloud, dark mode, dyslexia font and more. The <b>Deaf Community</b> page has a SASL learning hub, a jobs board, and Opportunity Passports.',
      chips: ['Deaf-owned badge', 'Jobs', 'Learn SASL'] },
    { id: 'badge', label: 'Deaf-owned badge', kw: ['deaf-owned', 'deaf owned', 'badge', 'verified'],
      reply: 'Deaf-owned businesses can be marked with a <b>🤟 Deaf-Owned Verified</b> badge on their Directory listing. Add your business to the Directory and request verification.',
      chips: ['Join the Directory', 'Contact'] },
    { id: 'jobs', label: 'Jobs', kw: ['job', 'jobs', 'vacancy', 'vacancies', 'work', 'employment', 'hiring', 'apply'],
      reply: 'The <b>Deaf Community</b> page has a jobs board where deaf-friendly employers post vacancies (live for 14 days) and you apply straight to the business by email. You can filter by remote, part-time, province, salary and more.',
      chips: ['Learn SASL', 'Opportunity Passport'] },
    { id: 'passport', label: 'Opportunity Passport', kw: ['passport', 'cv', 'resume', 'opportunity'],
      reply: 'Instead of a CV, Deaf users can publish an <b>Opportunity Passport</b> — a digital card with your skills, certifications, communication preferences and availability (no contact details shared). It shows for 14 days on the Deaf Community page.',
      chips: ['Jobs', 'Deaf Community'] },
    { id: 'learn', label: 'Learn SASL', kw: ['learn', 'lesson', 'sasl basics', 'greetings', 'teach'],
      reply: 'The <b>Deaf Community</b> page has a free SASL learning hub with short lessons — greetings, thank you, welcome, help, numbers, and emergency & restaurant phrases.',
      chips: ['Deaf Community', 'Jobs'] },
    { id: 'events', label: 'Events', kw: ['event', 'events', 'calendar', 'workshop'],
      reply: 'See upcoming events in the <b>Calendar Events</b> section on the homepage — you can add any event to your own Google/Apple/Outlook calendar. To list your own event, click <b>Submit your event</b>.',
      chips: ['Editions', 'Contact'] },
    { id: 'editions', label: 'Editions', kw: ['edition', 'magazine', 'issue', 'read', 'download', 'pdf'],
      reply: 'Read every issue free online on the <b>Editions</b> page (download a copy for R50). That page also has a <b>Save the Date</b> calendar of upcoming edition dates.',
      chips: ['Events', 'Contact'] },
    { id: 'contact', label: 'Contact', kw: ['contact', 'email', 'help', 'support', 'phone', 'reach'],
      reply: 'Email us at <a href="mailto:' + EMAIL + '">' + EMAIL + '</a> and we’ll get back to you. You can also use the Contact page.',
      chips: ['Submit a story', 'Pricing'] },
  ];

  var GREETING = 'Hi! I’m the Unplug Assistant 👋 How can I help? Pick a topic below or type your question.';
  var DEFAULT_CHIPS = ['Submit a story', 'Pricing', 'Deaf Community', 'Jobs', 'Contact'];
  var TALK = 'Talk to a person';

  // Offered on the fallback especially. Not knowing the answer is exactly the
  // moment somebody needs a human, and it used to be the moment they were
  // handed an email address and left to it.
  var FALLBACK = 'Sorry, I’m not sure about that one — but a person can help. '
    + 'Try a topic below, or ask to talk to somebody.';

  // --- styles -------------------------------------------------------------
  var css = `
  .ub-fab{ position:fixed; right:20px; bottom:20px; z-index:99990; height:52px; padding:0 20px; border-radius:26px;
    background:#161616; color:#fff; border:2px solid #fff; box-shadow:0 6px 20px rgba(0,0,0,0.3); cursor:pointer;
    font-family:'Inter',system-ui,sans-serif; font-size:14px; font-weight:700; display:flex; align-items:center; gap:8px; }
  .ub-fab:hover{ background:#000; }
  .ub-fab:focus-visible{ outline:3px solid #1f6feb; outline-offset:2px; }
  .ub-win{ position:fixed; right:20px; bottom:84px; z-index:99991; width:340px; max-width:calc(100vw - 40px); height:460px; max-height:70vh;
    background:#fff; border:1px solid rgba(0,0,0,0.15); border-radius:14px; box-shadow:0 16px 48px rgba(0,0,0,0.3);
    display:none; flex-direction:column; overflow:hidden; font-family:'Inter',system-ui,sans-serif; }
  .ub-win.open{ display:flex; }
  .ub-head{ background:#d20709; color:#fff; padding:13px 16px; display:flex; align-items:center; justify-content:space-between; }
  .ub-head b{ font-size:15px; }
  .ub-head .ub-x{ background:none; border:none; color:#fff; font-size:22px; cursor:pointer; line-height:1; }
  .ub-body{ flex:1; overflow-y:auto; padding:14px; background:#f7f5f2; display:flex; flex-direction:column; gap:10px; }
  .ub-msg{ max-width:85%; padding:10px 13px; border-radius:12px; font-size:13.5px; line-height:1.5; }
  .ub-bot{ background:#fff; border:1px solid rgba(0,0,0,0.1); align-self:flex-start; border-bottom-left-radius:3px; color:#161616; }
  .ub-bot a{ color:#d20709; }
  .ub-user{ background:#161616; color:#fff; align-self:flex-end; border-bottom-right-radius:3px; }
  .ub-chips{ display:flex; flex-wrap:wrap; gap:6px; padding:0 14px 8px; background:#f7f5f2; }
  .ub-handoff{ display:inline-block; margin-top:8px; background:#25D366; color:#fff; font-weight:700;
               padding:8px 14px; border-radius:6px; text-decoration:none; font-size:13px; }
  .ub-chip{ border:1px solid #d20709; color:#d20709; background:#fff; border-radius:16px; padding:6px 12px; font-size:12px;
    font-weight:600; cursor:pointer; font-family:inherit; }
  .ub-chip:hover{ background:#d20709; color:#fff; }
  .ub-input{ display:flex; border-top:1px solid rgba(0,0,0,0.12); background:#fff; }
  .ub-input input{ flex:1; border:none; padding:13px 14px; font-size:14px; font-family:inherit; outline:none; }
  .ub-input button{ border:none; background:#d20709; color:#fff; padding:0 18px; font-weight:700; cursor:pointer; font-family:inherit; }
  @media(max-width:600px){ .ub-fab{ right:14px; bottom:14px; } .ub-win{ right:10px; left:10px; width:auto; } }
  @media print{ .ub-fab,.ub-win{ display:none !important; } }
  `;
  var styleEl = document.createElement('style');
  styleEl.setAttribute('data-ub', '');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  // --- markup -------------------------------------------------------------
  var fab = document.createElement('button');
  fab.className = 'ub-fab';
  fab.setAttribute('aria-label', 'Open chat assistant');
  fab.innerHTML = '<span aria-hidden="true">💬</span> Chat';
  document.body.appendChild(fab);

  var win = document.createElement('div');
  win.className = 'ub-win';
  win.setAttribute('role', 'dialog');
  win.setAttribute('aria-label', 'Unplug Assistant');
  win.innerHTML =
    '<div class="ub-head"><b>Unplug Assistant</b><button class="ub-x" aria-label="Close chat">&times;</button></div>' +
    '<div class="ub-body" id="ubBody"></div>' +
    '<div class="ub-chips" id="ubChips"></div>' +
    '<form class="ub-input" id="ubForm"><input id="ubInput" type="text" placeholder="Type your question…" autocomplete="off" aria-label="Type your question"><button type="submit">Send</button></form>';
  document.body.appendChild(win);

  var body = win.querySelector('#ubBody');
  var chipsWrap = win.querySelector('#ubChips');
  var form = win.querySelector('#ubForm');
  var input = win.querySelector('#ubInput');
  var started = false;

  function open() {
    win.classList.add('open');
    if (!started) { started = true; botSay(GREETING, DEFAULT_CHIPS); }
    input.focus();
  }
  function close() { win.classList.remove('open'); }
  fab.addEventListener('click', function () { win.classList.contains('open') ? close() : open(); });
  win.querySelector('.ub-x').addEventListener('click', close);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });

  function scrollDown() { body.scrollTop = body.scrollHeight; }

  function botSay(html, chips) {
    // Kept as plain text for the handoff — the reply is written as HTML here,
    // and pasting markup into a WhatsApp message would be unreadable.
    transcript.push('Assistant: ' + String(html).replace(/<[^>]*>/g, ''));
    var m = document.createElement('div');
    m.className = 'ub-msg ub-bot';
    m.innerHTML = html;
    body.appendChild(m);
    renderChips(chips || DEFAULT_CHIPS);
    scrollDown();
  }
  function userSay(text) {
    transcript.push('Them: ' + text);
    var m = document.createElement('div');
    m.className = 'ub-msg ub-user';
    m.textContent = text;
    body.appendChild(m);
    scrollDown();
  }
  function renderChips(labels) {
    chipsWrap.innerHTML = '';
    (labels || []).forEach(function (label) {
      var c = document.createElement('button');
      c.className = 'ub-chip';
      c.type = 'button';
      c.textContent = label;
      c.addEventListener('click', function () { handle(label); });
      chipsWrap.appendChild(c);
    });
  }

  function findEntry(text) {
    var t = text.toLowerCase();
    // exact label match first (chips)
    for (var i = 0; i < KB.length; i++) {
      if (KB[i].label.toLowerCase() === t) return KB[i];
    }
    // keyword scoring
    var best = null, bestScore = 0;
    for (var j = 0; j < KB.length; j++) {
      var score = 0;
      KB[j].kw.forEach(function (k) { if (t.indexOf(k) !== -1) score++; });
      if (score > bestScore) { bestScore = score; best = KB[j]; }
    }
    return bestScore > 0 ? best : null;
  }

  function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function handOff() {
    // THE CONVERSATION GOES WITH THEM. Somebody who has just explained their
    // question to a machine should not have to explain it again to a person;
    // that repetition is the single most irritating thing about a handoff.
    var recent = transcript.slice(-8).join('\n');
    var intro = 'Hi Unplug — I was chatting on your website and would like to speak to someone.';
    var text = recent ? intro + '\n\n--- what I asked ---\n' + recent : intro;

    if (HANDOFF.number) {
      var url = 'https://wa.me/' + HANDOFF.number + '?text=' + encodeURIComponent(text);
      botSay('Opening WhatsApp so you can talk to one of us.'
        + (HANDOFF.hours ? ' We answer ' + escapeHtml(HANDOFF.hours) + '.' : '')
        + '<br><a class="ub-handoff" href="' + url + '" target="_blank" rel="noopener">'
        + 'Open WhatsApp</a>', DEFAULT_CHIPS);
      // Opened from the click that asked for it, so the browser does not treat
      // it as a popup — a blocked handoff is a dead end.
      window.open(url, '_blank', 'noopener');
      return;
    }

    // No number configured. Say so plainly rather than offering a button that
    // goes nowhere, and give the address that does work.
    botSay('I cannot open a chat right now, but a person will answer by email: '
      + '<a href="mailto:' + EMAIL + '">' + EMAIL + '</a>. '
      + 'Send what you asked me and we will pick it up.', DEFAULT_CHIPS);
  }

  function handle(text) {
    userSay(text);
    if (text.toLowerCase() === TALK.toLowerCase()
        || /\b(human|a person|real person|speak to|talk to someone|talk to somebody|agent)\b/i.test(text)) {
      setTimeout(handOff, 200);
      return;
    }
    var entry = findEntry(text);
    setTimeout(function () {
      if (entry) botSay(entry.reply, (entry.chips || DEFAULT_CHIPS).concat([TALK]));
      else botSay(FALLBACK, DEFAULT_CHIPS.concat([TALK]));
    }, 250);
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    handle(text);
  });
})();
