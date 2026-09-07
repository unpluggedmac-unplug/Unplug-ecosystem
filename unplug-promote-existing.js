// Promote Existing Content — member return journey.
// Reuses already-published Article / Directory IDs; it never recreates the
// underlying content. New rows are only the promotion and its payment.
(function installPromoteExistingContent() {
  'use strict';

  const card = document.getElementById('hlServicesCard');
  if (!card) return;

  const policy = "A minimum of 7 working days' notice is required to cancel before a service starts. If eligible, 100% of the amount paid will be credited to your account (no cash refund) — credit never expires. Once a service has started, no refund or unused-period credit will be provided, subject to applicable law.";

  function terms(id) {
    return `<div class="field" style="border-top:1px solid var(--paper-line); padding-top:10px;">
      <p style="font-size:12.5px; margin-bottom:6px;"><strong>Cancellation &amp; Credit Policy:</strong> ${policy}</p>
      <a href="unplug-magazine.html?p=refunds" target="_blank" rel="noopener" style="font-weight:600; text-decoration:underline; margin-right:14px;">VIEW TERMS &amp; CONDITIONS</a>
      <a href="unplug-magazine.html?p=refunds" target="_blank" rel="noopener" style="font-weight:600; text-decoration:underline;">VIEW CANCELLATION, REFUND &amp; ACCOUNT CREDIT POLICY</a>
      <label class="tc-row" style="margin-top:8px;"><input type="checkbox" id="${id}"> <span>I have read, understood and accept the Terms and Conditions, Privacy Policy, Refund Policy and Cancellation Policy of Unplug Magazine.</span></label>
    </div>`;
  }

  function extras(prefix) {
    return `<div class="field" style="border-top:1px solid var(--paper-line); padding-top:10px;">
      <label for="svc${prefix}Voucher">Voucher code <span style="font-weight:400; color:var(--slate);">— optional</span></label>
      <div style="display:flex; gap:8px; align-items:flex-start;">
        <input id="svc${prefix}Voucher" placeholder="e.g. UNPLUG2026" style="flex:1; min-width:0;">
        <button class="btn btn-line" type="button" id="svc${prefix}VoucherBtn" style="width:auto; white-space:nowrap;">Apply</button>
      </div>
    </div>
    <div class="field section-hidden" id="svc${prefix}CreditWrap" style="background:#faf7f2; border:1px solid var(--paper-line); padding:10px; border-radius:6px;">
      <label style="margin-bottom:4px;">Your Unplug Credit</label>
      <div style="font-size:13.5px;">Available: <b id="svc${prefix}CreditBalance">R0.00</b></div>
      <label class="tc-row" style="margin-top:6px;"><input type="checkbox" id="svc${prefix}UseCredit"> <span>Use my Unplug Credit toward this promotion</span></label>
    </div>
    <div class="instructions-box" id="svc${prefix}Quote" style="margin-bottom:12px;">Choose a promotion period to see your total.</div>`;
  }

  card.setAttribute('data-promote-existing-content', 'true');
  card.innerHTML = `<h2>Promote Existing Content</h2>
    <p class="sub">Come back at any time and boost something you have already published. You do not need to submit it again.</p>
    <div class="instructions-box" style="margin-bottom:16px;"><strong>How it works:</strong> choose the published item, choose how long you want the promotion to run, review the price, then continue to checkout. Only content that is already approved and live can be promoted.</div>
    <div class="field">
      <label for="promoteExistingType">What would you like to promote?</label>
      <select id="promoteExistingType"><option value="article">Published Article</option><option value="directory">Published Directory Profile</option></select>
      <p style="font-size:12px; color:var(--slate); margin-top:6px;">More content types can be added here whenever Unplug introduces a promotion service for them.</p>
    </div>
    <div id="promoteExistingEligibility" class="instructions-box section-hidden" style="margin-bottom:12px;"></div>

    <div id="promoteExistingArticlePanel">
      <div class="field-row">
        <div class="field"><label for="svcArtPick">Choose your published article</label><select id="svcArtPick"><option value="">Loading your published articles…</option></select></div>
        <div class="field"><label for="svcArtDuration">Promotion period</label><select id="svcArtDuration"><option value="">Loading packages…</option></select></div>
      </div>
      <div class="field"><label for="svcArtStart">Start date <span style="font-weight:400; color:var(--slate);">— today or later</span></label><input id="svcArtStart" type="date"></div>
      ${extras('Art')}
      <div class="field"><label for="svcArtPayMethod">Payment Method</label><select id="svcArtPayMethod"><option value="eft" selected>Manual EFT</option></select><p style="font-size:12px; color:var(--slate); margin-top:6px;">Card and Instant EFT payments via PayFast and Ozow will be available soon. For now, all cash payments are handled by manual EFT.</p></div>
      <div id="svcArtError" class="error-banner" style="display:none;"></div>
      ${terms('svcArtTermsChk')}
      <button class="btn btn-solid" id="svcArtBtn" style="width:auto;">Continue to Checkout</button>
      <div class="instructions-box section-hidden" id="svcArtResult" style="margin-top:12px;"></div>
    </div>

    <div id="promoteExistingDirectoryPanel" class="section-hidden">
      <div class="field-row">
        <div class="field"><label for="svcProfPick">Choose your published Directory profile</label><select id="svcProfPick"><option value="">Loading your Directory profile…</option></select></div>
        <div class="field"><label for="svcProfDuration">Promotion period</label><select id="svcProfDuration"><option value="">Loading packages…</option></select></div>
      </div>
      <div class="field"><label for="svcProfStart">Start date <span style="font-weight:400; color:var(--slate);">— today or later</span></label><input id="svcProfStart" type="date"></div>
      ${extras('Prof')}
      <div class="field"><label for="svcProfPayMethod">Payment Method</label><select id="svcProfPayMethod"><option value="eft" selected>Manual EFT</option></select><p style="font-size:12px; color:var(--slate); margin-top:6px;">Card and Instant EFT payments via PayFast and Ozow will be available soon. For now, all cash payments are handled by manual EFT.</p></div>
      <div id="svcProfError" class="error-banner" style="display:none;"></div>
      ${terms('svcProfTermsChk')}
      <button class="btn btn-solid" id="svcProfBtn" style="width:auto;">Continue to Checkout</button>
      <div class="instructions-box section-hidden" id="svcProfResult" style="margin-top:12px;"></div>
    </div>`;

  // A first-class sidebar route back to the promotion card.
  const sidebar = document.getElementById('msSidebar');
  if (sidebar && !document.getElementById('promoteExistingNav')) {
    const browse = sidebar.querySelector('.ms-navlink[data-ms="services"]');
    if (browse) {
      const shortcut = document.createElement('button');
      shortcut.id = 'promoteExistingNav';
      shortcut.className = 'ms-navlink';
      shortcut.setAttribute('data-ms', 'services');
      shortcut.innerHTML = '<span>📣</span> Promote Existing Content';
      shortcut.addEventListener('click', () => setTimeout(() => card.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80));
      browse.insertAdjacentElement('afterend', shortcut);
    }
  }

  const typeSelect = document.getElementById('promoteExistingType');
  const articlePanel = document.getElementById('promoteExistingArticlePanel');
  const directoryPanel = document.getElementById('promoteExistingDirectoryPanel');
  const eligibility = document.getElementById('promoteExistingEligibility');
  const eligibilityState = { article: { message: '', problem: false }, directory: { message: '', problem: false } };
  let creditBalance = 0;
  const today = new Date().toISOString().slice(0, 10);
  ['svcArtStart', 'svcProfStart'].forEach((id) => { const el = document.getElementById(id); el.min = today; el.value = today; });

  const sessionReady = () => typeof AUTH_TOKEN !== 'undefined' && !!AUTH_TOKEN;
  const money = (v) => `R${(Number(v) || 0).toFixed(2)}`;

  function setEligibility(type, message, problem) {
    eligibilityState[type] = { message: message || '', problem: !!problem };
    if (typeSelect.value === type) renderEligibility();
  }
  function renderEligibility() {
    const s = eligibilityState[typeSelect.value];
    eligibility.textContent = s.message;
    eligibility.classList.toggle('section-hidden', !s.message);
    eligibility.style.borderColor = s.problem ? 'var(--red)' : '';
  }
  function showType(type) {
    const isArticle = type === 'article';
    articlePanel.classList.toggle('section-hidden', !isArticle);
    directoryPanel.classList.toggle('section-hidden', isArticle);
    renderEligibility();
    // Do not call an authenticated endpoint during the page's sign-in restore.
    // api() treats a 401 as an expired session, so quoting before AUTH_TOKEN is
    // ready would incorrectly kick a returning member back to sign-in.
    if (sessionReady()) refreshQuote(isArticle ? 'Art' : 'Prof', isArticle ? 'article' : 'directory');
  }
  typeSelect.addEventListener('change', () => showType(typeSelect.value));

  function fillPackages(id, rows) {
    const el = document.getElementById(id);
    rows = Array.isArray(rows) ? rows : [];
    el.innerHTML = rows.length
      ? rows.map((p) => `<option value="${Number(p.durationDays)}">${Number(p.durationDays)} days — ${money(p.price)}</option>`).join('')
      : '<option value="">No promotion packages available</option>';
  }

  async function loadPackages() {
    const data = await api('/highlights/packages');
    fillPackages('svcArtDuration', data.packages && data.packages.article);
    fillPackages('svcProfDuration', data.packages && data.packages.directory);
  }

  async function loadPublishedArticles() {
    const select = document.getElementById('svcArtPick');
    try {
      const data = await api('/articles/mine');
      // status='approved' is not quite enough: an approved article can still
      // be scheduled for a future date, and the public article route hides it
      // until that date. Do not sell highlight days on something readers cannot
      // open yet. It will appear here automatically on its publication date.
      const approved = (data.articles || []).filter((article) =>
        article.status === 'approved'
        && (!article.scheduled_for || String(article.scheduled_for).slice(0, 10) <= today));
      const futureScheduled = (data.articles || []).filter((article) =>
        article.status === 'approved'
        && article.scheduled_for
        && String(article.scheduled_for).slice(0, 10) > today).length;
      select.innerHTML = approved.length
        ? approved.map((article) => `<option value="${article.id}">${escapeAttrM(article.title || `Article #${article.id}`)}</option>`).join('')
        : '<option value="">No published articles available</option>';
      document.getElementById('svcArtBtn').disabled = !approved.length;
      const scheduledNote = futureScheduled ? ` ${futureScheduled} approved article${futureScheduled === 1 ? ' is' : 's are'} scheduled for later and will appear here once live.` : '';
      setEligibility('article', approved.length
        ? `${approved.length} published article${approved.length === 1 ? '' : 's'} available to promote.${scheduledNote}`
        : `You do not have an article that is live and available to promote yet. Once an article is published, it will automatically appear here.${scheduledNote}`, !approved.length);
    } catch (err) {
      select.innerHTML = '<option value="">Could not load your articles</option>';
      document.getElementById('svcArtBtn').disabled = true;
      setEligibility('article', 'We could not load your published articles just now. Please try again.', true);
    }
  }

  async function refreshDirectoryEligibility() {
    const select = document.getElementById('svcProfPick');
    try {
      const data = await api('/profiles/me');
      const profile = data.profile;
      if (profile && profile.status === 'approved') {
        select.innerHTML = `<option value="${profile.id}">${escapeAttrM(profile.display_name || `Directory Profile #${profile.id}`)}</option>`;
        document.getElementById('svcProfBtn').disabled = false;
        setEligibility('directory', 'Your published Directory profile is ready to promote.', false);
      } else {
        select.innerHTML = '<option value="">No published Directory profile available</option>';
        document.getElementById('svcProfBtn').disabled = true;
        setEligibility('directory', 'Your Directory profile must be approved and live before it can be promoted. You do not need to resubmit it — it will appear here automatically once approved.', true);
      }
    } catch (err) {
      select.innerHTML = '<option value="">No published Directory profile available</option>';
      document.getElementById('svcProfBtn').disabled = true;
      setEligibility('directory', 'Create and publish your Directory profile first. Once it is approved, you can return here and promote that same profile without submitting it again.', true);
    }
  }

  async function loadCredit() {
    try { creditBalance = Number((await api('/payments/credit')).balance) || 0; } catch (err) { creditBalance = 0; }
    ['Art', 'Prof'].forEach((prefix) => {
      document.getElementById(`svc${prefix}CreditBalance`).textContent = money(creditBalance);
      document.getElementById(`svc${prefix}CreditWrap`).classList.toggle('section-hidden', creditBalance <= 0);
      if (creditBalance <= 0) document.getElementById(`svc${prefix}UseCredit`).checked = false;
    });
  }

  async function refreshQuote(prefix, targetType) {
    const out = document.getElementById(`svc${prefix}Quote`);
    if (!sessionReady()) { out.textContent = 'Sign in to see your promotion total.'; return null; }
    const durationDays = Number(document.getElementById(`svc${prefix}Duration`).value);
    if (!durationDays) { out.textContent = 'Choose a promotion period to see your total.'; return null; }
    try {
      const voucherCode = document.getElementById(`svc${prefix}Voucher`).value.trim();
      const quote = await api('/payments/quote', { method: 'POST', body: JSON.stringify({
        linkedType: 'highlight', durationDays, targetType,
        voucherCode: voucherCode || undefined,
        useCredit: document.getElementById(`svc${prefix}UseCredit`).checked,
      }) });
      const lines = [`Promotion price: <strong>${money(quote.orderTotal)}</strong>`];
      if (quote.voucherDiscount > 0) lines.push(`Voucher discount: <strong>−${money(quote.voucherDiscount)}</strong>`);
      if (quote.creditApplied > 0) lines.push(`Unplug Credit: <strong>−${money(quote.creditApplied)}</strong>`);
      lines.push(`Amount to pay: <strong>${money(quote.amountToPay)}</strong>`);
      if (quote.voucherError) lines.push(`<span style="color:var(--red);">${escapeAttrM(quote.voucherError)}</span>`);
      if (quote.settledWithoutPayment) lines.push('<strong>Your voucher / Unplug Credit covers this promotion in full.</strong>');
      out.innerHTML = lines.join('<br>');
      return quote;
    } catch (err) {
      out.textContent = err.message || 'Could not calculate this total.';
      return null;
    }
  }

  async function purchasePromotion(c) {
    const err = document.getElementById(c.errorEl);
    const box = document.getElementById(c.resultEl);
    err.style.display = 'none';
    if (!c.targetId) { err.textContent = 'Choose published content to promote.'; err.style.display = 'block'; return; }
    if (!c.durationDays) { err.textContent = 'Choose a promotion period.'; err.style.display = 'block'; return; }
    if (!document.getElementById(c.termsChkId).checked) { err.textContent = 'You must accept the Terms and Conditions before you can proceed with payment.'; err.style.display = 'block'; return; }

    // Validate voucher / credit and price BEFORE creating the promotion row, so
    // an invalid voucher cannot leave an abandoned awaiting-payment highlight.
    const quote = await refreshQuote(c.prefix, c.targetType);
    if (!quote) { err.textContent = 'We could not confirm the promotion price. Please try again.'; err.style.display = 'block'; return; }
    if (quote.voucherError) { err.textContent = quote.voucherError; err.style.display = 'block'; return; }

    const button = document.getElementById(c.btnId);
    button.disabled = true; button.textContent = 'Processing…';
    try {
      const created = await api('/highlights', { method: 'POST', body: JSON.stringify({
        targetType: c.targetType, targetId: c.targetId, durationDays: c.durationDays,
        requestedStartDate: c.requestedStartDate,
      }) });
      const pay = await api('/payments/initiate', { method: 'POST', body: JSON.stringify({
        linkedType: 'highlight', linkedId: created.highlight.id,
        method: document.getElementById(c.payMethodId).value || 'eft',
        termsAccepted: true,
        termsVersion: (typeof SUBMIT_TERMS_VERSION !== 'undefined' ? SUBMIT_TERMS_VERSION : undefined),
        useCredit: document.getElementById(`svc${c.prefix}UseCredit`).checked,
        voucherCode: document.getElementById(`svc${c.prefix}Voucher`).value.trim() || undefined,
      }) });

      box.classList.remove('section-hidden');
      if (pay.paidInFull) {
        box.innerHTML = `<strong>Promotion booked — paid in full by your voucher / Unplug Credit.</strong><br><br>${escapeAttrM(pay.message || '')}`
          + (pay.payment && pay.payment.gateway_reference ? refNotice(pay.payment.gateway_reference) : '');
      } else if (pay.instructions) {
        const i = pay.instructions;
        box.innerHTML = `<strong>Promotion reserved.</strong> Pay via EFT using the details below — it starts for the paid period once payment clears and our team approves it.<br><br>
          <b>Bank:</b> ${escapeAttrM(i.bank)}<br><b>Account Name:</b> ${escapeAttrM(i.accountName)}<br>
          ${i.accountType ? `<b>Account Type:</b> ${escapeAttrM(i.accountType)}<br>` : ''}
          <b>Account Number:</b> ${escapeAttrM(i.accountNumber)}<br><b>Branch Code:</b> ${escapeAttrM(i.branchCode)}<br><br>${escapeAttrM(i.note || '')}`
          + refNotice(i.reference) + (pay.payment && pay.payment.id ? popUploadBlock('payments', pay.payment.id) : '');
      } else {
        box.innerHTML = `<strong>Promotion reserved.</strong> ${escapeAttrM(pay.note || '')}`;
      }
      showToast('Promotion reserved — it now appears under My Services.');
      if (typeof loadPaymentHistory === 'function') loadPaymentHistory();
      if (typeof loadMyServices === 'function') loadMyServices();
      await loadCredit();
      await refreshQuote(c.prefix, c.targetType);
    } catch (e) {
      err.textContent = e.message || 'Could not start that promotion.';
      err.style.display = 'block';
    } finally {
      button.disabled = false; button.textContent = 'Continue to Checkout';
    }
  }

  function wireQuote(prefix, targetType) {
    document.getElementById(`svc${prefix}Duration`).addEventListener('change', () => refreshQuote(prefix, targetType));
    document.getElementById(`svc${prefix}UseCredit`).addEventListener('change', () => refreshQuote(prefix, targetType));
    document.getElementById(`svc${prefix}VoucherBtn`).addEventListener('click', () => refreshQuote(prefix, targetType));
    document.getElementById(`svc${prefix}Voucher`).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); refreshQuote(prefix, targetType); } });
  }
  wireQuote('Art', 'article');
  wireQuote('Prof', 'directory');

  const artBtn = document.getElementById('svcArtBtn');
  artBtn.dataset.wired = '1';
  artBtn.addEventListener('click', () => purchasePromotion({
    prefix: 'Art', targetType: 'article', targetId: Number(document.getElementById('svcArtPick').value),
    durationDays: Number(document.getElementById('svcArtDuration').value), requestedStartDate: document.getElementById('svcArtStart').value || undefined,
    errorEl: 'svcArtError', resultEl: 'svcArtResult', btnId: 'svcArtBtn', termsChkId: 'svcArtTermsChk', payMethodId: 'svcArtPayMethod',
  }));

  const profBtn = document.getElementById('svcProfBtn');
  profBtn.dataset.wired = '1';
  profBtn.addEventListener('click', () => purchasePromotion({
    prefix: 'Prof', targetType: 'directory', targetId: Number(document.getElementById('svcProfPick').value),
    durationDays: Number(document.getElementById('svcProfDuration').value), requestedStartDate: document.getElementById('svcProfStart').value || undefined,
    errorEl: 'svcProfError', resultEl: 'svcProfResult', btnId: 'svcProfBtn', termsChkId: 'svcProfTermsChk', payMethodId: 'svcProfPayMethod',
  }));

  async function loadEligibleContent() {
    if (!sessionReady()) return false;
    await Promise.all([loadPackages(), loadPublishedArticles(), refreshDirectoryEligibility(), loadCredit()]);
    await Promise.all([refreshQuote('Art', 'article'), refreshQuote('Prof', 'directory')]);
    renderEligibility();
    return true;
  }

  let attempts = 0;
  const readyTimer = setInterval(async () => {
    attempts += 1;
    if (await loadEligibleContent()) { clearInterval(readyTimer); return; }
    if (attempts >= 120) clearInterval(readyTimer);
  }, 500);

  showType('article');
})();
