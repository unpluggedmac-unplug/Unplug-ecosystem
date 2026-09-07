// Central member promotion flow for content that already exists.
//
// This deliberately does NOT create or resubmit an article/profile. It only
// lets a signed-in member choose content that is already published, choose a
// live highlight package, and send that existing content ID into the normal
// /highlights -> /payments flow.
(function installPromoteExistingContent() {
  'use strict';

  const card = document.getElementById('hlServicesCard');
  if (!card) return;

  // Make the return journey discoverable from the sidebar as well as inside
  // Browse Services. The regular My Unplug navigation still owns which section
  // is visible; this shortcut just points at that same Services section and
  // scrolls to the promotion card once the section has opened.
  const sidebar = document.getElementById('msSidebar');
  if (sidebar && !document.getElementById('promoteExistingNav')) {
    const browse = sidebar.querySelector('.ms-navlink[data-ms="services"]');
    if (browse) {
      const shortcut = document.createElement('button');
      shortcut.id = 'promoteExistingNav';
      shortcut.className = 'ms-navlink';
      shortcut.setAttribute('data-ms', 'services');
      shortcut.innerHTML = '<span>📣</span> Promote Existing Content';
      shortcut.addEventListener('click', () => {
        setTimeout(() => card.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
      });
      browse.insertAdjacentElement('afterend', shortcut);
    }
  }

  card.setAttribute('data-promote-existing-content', 'true');
  card.innerHTML = `
    <h2>Promote Existing Content</h2>
    <p class="sub">Come back at any time and boost something you have already published. You do not need to submit it again.</p>

    <div class="instructions-box" style="margin-bottom:16px;">
      <strong>How it works:</strong> choose the published item, choose how long you want the promotion to run, review the price, then continue to checkout. Only content that is already approved and live can be promoted.
    </div>

    <div class="field">
      <label for="promoteExistingType">What would you like to promote?</label>
      <select id="promoteExistingType">
        <option value="article">Published Article</option>
        <option value="directory">Published Directory Profile</option>
      </select>
      <p style="font-size:12px; color:var(--slate); margin-top:6px;">More content types can be added here whenever Unplug introduces a promotion service for them.</p>
    </div>

    <div id="promoteExistingEligibility" class="instructions-box section-hidden" style="margin-bottom:12px;"></div>

    <div id="promoteExistingArticlePanel">
      <div class="field-row">
        <div class="field">
          <label for="svcArtPick">Choose your published article</label>
          <select id="svcArtPick"><option value="">Loading your published articles…</option></select>
        </div>
        <div class="field">
          <label for="svcArtDuration">Promotion period</label>
          <select id="svcArtDuration"><option value="">Loading packages…</option></select>
        </div>
      </div>
      <div class="field">
        <label for="svcArtStart">Start date <span style="font-weight:400; color:var(--slate);">— today or later</span></label>
        <input id="svcArtStart" type="date">
      </div>
      ${checkoutExtras('Art')}
      <div class="field">
        <label for="svcArtPayMethod">Payment Method</label>
        <select id="svcArtPayMethod"><option value="eft" selected>Manual EFT</option></select>
        <p style="font-size:12px; color:var(--slate); margin-top:6px;">Card and Instant EFT payments via PayFast and Ozow will be available soon. For now, all cash payments are handled by manual EFT.</p>
      </div>
      <div id="svcArtError" class="error-banner" style="display:none;"></div>
      ${termsBlock('svcArtTermsChk')}
      <button class="btn btn-solid" id="svcArtBtn" style="width:auto;">Continue to Checkout</button>
      <div class="instructions-box section-hidden" id="svcArtResult" style="margin-top:12px;"></div>
    </div>

    <div id="promoteExistingDirectoryPanel" class="section-hidden">
      <div class="field-row">
        <div class="field">
          <label for="svcProfPick">Choose your published Directory profile</label>
          <select id="svcProfPick"><option value="">Loading your Directory profile…</option></select>
        </div>
        <div class="field">
          <label for="svcProfDuration">Promotion period</label>
          <select id="svcProfDuration"><option value="">Loading packages…</option></select>
        </div>
      </div>
      <div class="field">
        <label for="svcProfStart">Start date <span style="font-weight:400; color:var(--slate);">— today or later</span></label>
        <input id="svcProfStart" type="date">
      </div>
      ${checkoutExtras('Prof')}
      <div class="field">
        <label for="svcProfPayMethod">Payment Method</label>
        <select id="svcProfPayMethod"><option value="eft" selected>Manual EFT</option></select>
        <p style="font-size:12px; color:var(--slate); margin-top:6px;">Card and Instant EFT payments via PayFast and Ozow will be available soon. For now, all cash payments are handled by manual EFT.</p>
      </div>
      <div id="svcProfError" class="error-banner" style="display:none;"></div>
      ${termsBlock('svcProfTermsChk')}
      <button class="btn btn-solid" id="svcProfBtn" style="width:auto;">Continue to Checkout</button>
      <div class="instructions-box section-hidden" id="svcProfResult" style="margin-top:12px;"></div>
    </div>
  `;

  function checkoutExtras(prefix) {
    return `
      <div class="field" style="border-top:1px solid var(--paper-line); padding-top:10px;">
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

  function termsBlock(checkboxId) {
    return `
      <div class="field" style="border-top:1px solid var(--paper-line); padding-top:10px;">
        <p style="font-size:12.5px; margin-bottom:6px;"><strong>Cancellation &amp; Credit Policy:</strong> A minimum of 7 working days' notice is required to cancel before a service starts. If eligible, 100% of the amount paid will be credited to your account (no cash refund) — credit never expires. Once a service has started, no refund or unused-period credit will be provided, subject to applicable law.</p>
        <a href="unplug-magazine.html?p=refunds" target="_blank" rel="noopener" style="font-weight:600; text-decoration:underline; margin-right:14px;">VIEW TERMS &amp; CONDITIONS</a>
        <a href="unplug-magazine.html?p=refunds" target="_blank" rel="noopener" style="font-weight:600; text-decoration:underline;">VIEW CANCELLATION, REFUND &amp; ACCOUNT CREDIT POLICY</a>
        <label class="tc-row" style="margin-top:8px;"><input type="checkbox" id="${checkboxId}"> <span>I have read, understood and accept the Terms and Conditions, Privacy Policy, Refund Policy and Cancellation Policy of Unplug Magazine.</span></label>
      </div>`;
  }

  const typeSelect = document.getElementById('promoteExistingType');
  const articlePanel = document.getElementById('promoteExistingArticlePanel');
  const directoryPanel = document.getElementById('promoteExistingDirectoryPanel');
  const eligibility = document.getElementById('promoteExistingEligibility');
  const today = new Date().toISOString().slice(0, 10);
  ['svcArtStart', 'svcProfStart'].forEach((id) => {
    const input = document.getElementById(id);
    input.min = today;
    input.value = today;
  });

  const eligibilityState = {
    article: { message: '', problem: false },
    directory: { message: '', problem: false },
  };
  let creditBalance = 0;

  function setEligibility(type, message, problem) {
    eligibilityState[type] = { message: message || '', problem: !!problem };
    if (typeSelect.value === type) renderEligibility();
  }

  function renderEligibility() {
    const state = eligibilityState[typeSelect.value] || { message: '', problem: false };
    if (!state.message) {
      eligibility.textContent = '';
      eligibility.classList.add('section-hidden');
      eligibility.style.borderColor = '';
      return;
    }
    eligibility.textContent = state.message;
    eligibility.classList.remove('section-hidden');
    eligibility.style.borderColor = state.problem ? 'var(--red)' : '';
  }

  function showType(type) {
    const article = type === 'article';
    articlePanel.classList.toggle('section-hidden', !article);
    directoryPanel.classList.toggle('section-hidden', article);
    renderEligibility();
    refreshQuote(article ? 'Art' : 'Prof', article ? 'article' : 'directory');
  }

  typeSelect.addEventListener('change', () => showType(typeSelect.value));

  function money(value) {
    const n = Number(value);
    return Number.isFinite(n) ? `R${n.toFixed(2)}` : 'R0.00';
  }

  function fillPackages(selectId, packages) {
    const select = document.getElementById(selectId);
    const rows = Array.isArray(packages) ? packages : [];
    select.innerHTML = rows.length
      ? rows.map((p) => `<option value="${Number(p.durationDays)}">${Number(p.durationDays)} days — ${money(p.price)}</option>`).join('')
      : '<option value="">No promotion packages available</option>';
  }

  async function loadPublishedArticles() {
    const select = document.getElementById('svcArtPick');
    try {
      const data = await api('/articles/mine');
      const approved = (data.articles || []).filter((article) => article.status === 'approved');
      select.innerHTML = approved.length
        ? approved.map((article) => `<option value="${article.id}">${escapeAttrM(article.title || `Article #${article.id}`)}</option>`).join('')
        : '<option value="">No published articles available</option>';
      document.getElementById('svcArtBtn').disabled = approved.length === 0;
      setEligibility('article', approved.length
        ? `${approved.length} published article${approved.length === 1 ? '' : 's'} available to promote.`
        : 'You do not have a published article available to promote yet. Once an article is approved and live, it will automatically appear here.', !approved.length);
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

  async function loadPackages() {
    try {
      const data = await api('/highlights/packages');
      fillPackages('svcArtDuration', data.packages && data.packages.article);
      fillPackages('svcProfDuration', data.packages && data.packages.directory);
    } catch (err) {
      document.getElementById('svcArtDuration').innerHTML = '<option value="">Could not load packages</option>';
      document.getElementById('svcProfDuration').innerHTML = '<option value="">Could not load packages</option>';
    }
  }

  async function loadCredit() {
    try {
      const data = await api('/payments/credit');
      creditBalance = Number(data.balance) || 0;
    } catch (err) {
      creditBalance = 0;
    }
    ['Art', 'Prof'].forEach((prefix) => {
      document.getElementById(`svc${prefix}CreditBalance`).textContent = money(creditBalance);
      document.getElementById(`svc${prefix}CreditWrap`).classList.toggle('section-hidden', creditBalance <= 0);
      if (creditBalance <= 0) document.getElementById(`svc${prefix}UseCredit`).checked = false;
    });
  }

  async function refreshQuote(prefix, targetType) {
    const quoteEl = document.getElementById(`svc${prefix}Quote`);
    const durationDays = Number(document.getElementById(`svc${prefix}Duration`).value);
    if (!durationDays) {
      quoteEl.textContent = 'Choose a promotion period to see your total.';
      return null;
    }
    const voucherCode = document.getElementById(`svc${prefix}Voucher`).value.trim();
    const useCredit = document.getElementById(`svc${prefix}UseCredit`).checked;
    try {
      const quote = await api('/payments/quote', {
        method: 'POST',
        body: JSON.stringify({
          linkedType: 'highlight', durationDays, targetType,
          voucherCode: voucherCode || undefined, useCredit,
        }),
      });
      const lines = [`Promotion price: <strong>${money(quote.orderTotal)}</strong>`];
      if (quote.voucherDiscount > 0) lines.push(`Voucher discount: <strong>−${money(quote.voucherDiscount)}</strong>`);
      if (quote.creditApplied > 0) lines.push(`Unplug Credit: <strong>−${money(quote.creditApplied)}</strong>`);
      lines.push(`Amount to pay: <strong>${money(quote.amountToPay)}</strong>`);
      if (quote.voucherError) lines.push(`<span style="color:var(--red);">${escapeAttrM(quote.voucherError)}</span>`);
      if (quote.settledWithoutPayment) lines.push('<strong>Your voucher / Unplug Credit covers this promotion in full.</strong>');
      quoteEl.innerHTML = lines.join('<br>');
      return quote;
    } catch (err) {
      quoteEl.textContent = err.message || 'Could not calculate this total.';
      return null;
    }
  }

  async function purchasePromotion(config) {
    const {
      prefix, targetType, targetId, durationDays, requestedStartDate,
      errorEl, resultEl, btnId, termsChkId, payMethodId,
    } = config;
    const err = document.getElementById(errorEl);
    const box = document.getElementById(resultEl);
    err.style.display = 'none';

    if (!targetId) {
      err.textContent = 'Choose published content to promote.';
      err.style.display = 'block';
      return;
    }
    if (!durationDays) {
      err.textContent = 'Choose a promotion period.';
      err.style.display = 'block';
      return;
    }
    if (!document.getElementById(termsChkId).checked) {
      err.textContent = 'You must accept the Terms and Conditions before you can proceed with payment.';
      err.style.display = 'block';
      return;
    }

    const quote = await refreshQuote(prefix, targetType);
    if (!quote) {
      err.textContent = 'We could not confirm the promotion price. Please try again.';
      err.style.display = 'block';
      return;
    }
    if (quote.voucherError) {
      err.textContent = quote.voucherError;
      err.style.display = 'block';
      return;
    }

    const voucherCode = document.getElementById(`svc${prefix}Voucher`).value.trim();
    const useCredit = document.getElementById(`svc${prefix}UseCredit`).checked;
    const method = document.getElementById(payMethodId).value || 'eft';
    const button = document.getElementById(btnId);
    button.disabled = true;
    button.textContent = 'Processing…';

    try {
      // The ONLY new content row is the promotion itself. The selected article
      // or Directory profile ID is reused exactly as-is; it is never recreated.
      const created = await api('/highlights', {
        method: 'POST',
        body: JSON.stringify({ targetType, targetId, durationDays, requestedStartDate }),
      });
      const pay = await api('/payments/initiate', {
        method: 'POST',
        body: JSON.stringify({
          linkedType: 'highlight', linkedId: created.highlight.id, method,
          termsAccepted: true,
          termsVersion: (typeof SUBMIT_TERMS_VERSION !== 'undefined' ? SUBMIT_TERMS_VERSION : undefined),
          useCredit,
          voucherCode: voucherCode || undefined,
        }),
      });

      box.classList.remove('section-hidden');
      if (pay.paidInFull) {
        box.innerHTML = `<strong>Promotion booked — paid in full by your voucher / Unplug Credit.</strong><br><br>${escapeAttrM(pay.message || '')}`
          + (pay.payment && pay.payment.gateway_reference ? refNotice(pay.payment.gateway_reference) : '');
      } else if (pay.instructions) {
        const i = pay.instructions;
        box.innerHTML = `<strong>Promotion reserved.</strong> Pay via EFT using the details below — it starts for the paid period once payment clears and our team approves it.<br><br>
          <b>Bank:</b> ${escapeAttrM(i.bank)}<br><b>Account Name:</b> ${escapeAttrM(i.accountName)}<br>
          ${i.accountType ? `<b>Account Type:</b> ${escapeAttrM(i.accountType)}<br>` : ''}
          <b>Account Number:</b> ${escapeAttrM(i.accountNumber)}<br><b>Branch Code:</b> ${escapeAttrM(i.branchCode)}<br><br>
          ${escapeAttrM(i.note || '')}`
          + refNotice(i.reference)
          + (pay.payment && pay.payment.id ? popUploadBlock('payments', pay.payment.id) : '');
      } else {
        box.innerHTML = `<strong>Promotion reserved.</strong> ${escapeAttrM(pay.note || '')}`;
      }

      showToast('Promotion reserved — it now appears under My Services.');
      if (typeof loadPaymentHistory === 'function') loadPaymentHistory();
      if (typeof loadMyServices === 'function') loadMyServices();
      await loadCredit();
      await refreshQuote(prefix, targetType);
    } catch (error) {
      err.textContent = error.message || 'Could not start that promotion.';
      err.style.display = 'block';
    } finally {
      button.disabled = false;
      button.textContent = 'Continue to Checkout';
    }
  }

  function wireQuoteControls(prefix, targetType) {
    document.getElementById(`svc${prefix}Duration`).addEventListener('change', () => refreshQuote(prefix, targetType));
    document.getElementById(`svc${prefix}UseCredit`).addEventListener('change', () => refreshQuote(prefix, targetType));
    document.getElementById(`svc${prefix}VoucherBtn`).addEventListener('click', () => refreshQuote(prefix, targetType));
    document.getElementById(`svc${prefix}Voucher`).addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        refreshQuote(prefix, targetType);
      }
    });
  }

  wireQuoteControls('Art', 'article');
  wireQuoteControls('Prof', 'directory');

  const artBtn = document.getElementById('svcArtBtn');
  artBtn.dataset.wired = '1';
  artBtn.addEventListener('click', () => purchasePromotion({
    prefix: 'Art',
    targetType: 'article',
    targetId: Number(document.getElementById('svcArtPick').value),
    durationDays: Number(document.getElementById('svcArtDuration').value),
    requestedStartDate: document.getElementById('svcArtStart').value || undefined,
    errorEl: 'svcArtError', resultEl: 'svcArtResult', btnId: 'svcArtBtn',
    termsChkId: 'svcArtTermsChk', payMethodId: 'svcArtPayMethod',
  }));

  const profBtn = document.getElementById('svcProfBtn');
  profBtn.dataset.wired = '1';
  profBtn.addEventListener('click', () => purchasePromotion({
    prefix: 'Prof',
    targetType: 'directory',
    targetId: Number(document.getElementById('svcProfPick').value),
    durationDays: Number(document.getElementById('svcProfDuration').value),
    requestedStartDate: document.getElementById('svcProfStart').value || undefined,
    errorEl: 'svcProfError', resultEl: 'svcProfResult', btnId: 'svcProfBtn',
    termsChkId: 'svcProfTermsChk', payMethodId: 'svcProfPayMethod',
  }));

  async function loadEligibleContent() {
    if (typeof AUTH_TOKEN === 'undefined' || !AUTH_TOKEN) return false;
    await Promise.all([loadPackages(), loadPublishedArticles(), refreshDirectoryEligibility(), loadCredit()]);
    await Promise.all([refreshQuote('Art', 'article'), refreshQuote('Prof', 'directory')]);
    renderEligibility();
    return true;
  }

  // The member dashboard restores an existing login asynchronously. Wait for
  // that verified session rather than making unauthenticated requests during
  // page startup. Stop polling as soon as the eligible-content list is loaded.
  let attempts = 0;
  const readyTimer = setInterval(async () => {
    attempts += 1;
    if (await loadEligibleContent()) {
      clearInterval(readyTimer);
      return;
    }
    if (attempts >= 120) clearInterval(readyTimer);
  }, 500);

  showType('article');
})();
