// Promote Existing Content — one member return journey for promotion services.
//
// The member chooses content they already own and that is already public. This
// module never recreates an article or Directory profile; the new row is only
// the paid promotion request. Eligibility is server-authoritative through
// GET /highlights/eligible, so the browser is not trusted to decide whether a
// draft, pending item, or future-scheduled article can be promoted.
(function installPromoteExistingContent() {
  'use strict';

  const card = document.getElementById('hlServicesCard');
  if (!card) return;

  const policy = "A minimum of 7 working days' notice is required to cancel before a service starts. If eligible, 100% of the amount paid will be credited to your account (no cash refund) — credit never expires. Once a service has started, no refund or unused-period credit will be provided, subject to applicable law.";
  const TYPE_LABELS = { article: 'Published Article', directory: 'Published Directory Profile' };
  const PREFIX_LABELS = { article: 'article', directory: 'Directory profile' };

  function esc(value) {
    const d = document.createElement('div');
    d.textContent = value == null ? '' : String(value);
    return d.innerHTML;
  }
  const money = (value) => `R${(Number(value) || 0).toFixed(2)}`;
  const sessionReady = () => typeof AUTH_TOKEN !== 'undefined' && !!AUTH_TOKEN;

  card.setAttribute('data-promote-existing-content', 'true');
  card.innerHTML = `
    <h2>Promote Existing Content</h2>
    <p class="sub">Come back at any time and boost something you have already published. You do not need to submit it again.</p>
    <div class="instructions-box" style="margin-bottom:16px;">
      <strong>How it works:</strong> choose the published item, choose how long you want the promotion to run, review the price, then continue to payment. Only content that is already approved and publicly live can be promoted.
    </div>

    <div class="field-row">
      <div class="field">
        <label for="promoteExistingType">What would you like to promote?</label>
        <select id="promoteExistingType">
          <option value="article">Published Article</option>
          <option value="directory">Published Directory Profile</option>
        </select>
      </div>
      <div class="field">
        <label for="promoteExistingItem">Choose your published item</label>
        <select id="promoteExistingItem"><option value="">Loading eligible content…</option></select>
      </div>
    </div>

    <div id="promoteExistingEligibility" class="instructions-box" style="margin-bottom:14px;">Checking what is ready to promote…</div>

    <div class="field-row">
      <div class="field">
        <label for="promoteExistingDuration">Promotion period</label>
        <select id="promoteExistingDuration"><option value="">Loading packages…</option></select>
      </div>
      <div class="field">
        <label for="promoteExistingStart">Start date <span style="font-weight:400; color:var(--slate);">— today or later</span></label>
        <input id="promoteExistingStart" type="date">
      </div>
    </div>

    <div class="field" style="border-top:1px solid var(--paper-line); padding-top:10px;">
      <label for="promoteExistingVoucher">Voucher code <span style="font-weight:400; color:var(--slate);">— optional</span></label>
      <div style="display:flex; gap:8px; align-items:flex-start;">
        <input id="promoteExistingVoucher" placeholder="e.g. UNPLUG2026" style="flex:1; min-width:0;">
        <button class="btn btn-line" type="button" id="promoteExistingVoucherBtn" style="width:auto; white-space:nowrap;">Apply</button>
      </div>
    </div>

    <div class="field section-hidden" id="promoteExistingCreditWrap" style="background:#faf7f2; border:1px solid var(--paper-line); padding:10px; border-radius:6px;">
      <label style="margin-bottom:4px;">Your Unplug Credit</label>
      <div style="font-size:13.5px;">Available: <b id="promoteExistingCreditBalance">R0.00</b></div>
      <label class="tc-row" style="margin-top:6px;"><input type="checkbox" id="promoteExistingUseCredit"> <span>Use my Unplug Credit toward this promotion</span></label>
    </div>

    <div class="instructions-box" id="promoteExistingQuote" style="margin-bottom:12px;">Choose a promotion period to see your total.</div>

    <div class="field">
      <label for="promoteExistingPayMethod">Payment Method</label>
      <select id="promoteExistingPayMethod"><option value="eft" selected>Manual EFT</option></select>
      <p style="font-size:12px; color:var(--slate); margin-top:6px;">Card and Instant EFT payments via PayFast and Ozow will be available soon. For now, all cash payments are handled by manual EFT.</p>
    </div>

    <div id="promoteExistingError" class="error-banner" style="display:none;"></div>

    <div class="field" style="border-top:1px solid var(--paper-line); padding-top:10px;">
      <p style="font-size:12.5px; margin-bottom:6px;"><strong>Cancellation &amp; Credit Policy:</strong> ${policy}</p>
      <a href="unplug-magazine.html?p=refunds" target="_blank" rel="noopener" style="font-weight:600; text-decoration:underline; margin-right:14px;">VIEW TERMS &amp; CONDITIONS</a>
      <a href="unplug-magazine.html?p=refunds" target="_blank" rel="noopener" style="font-weight:600; text-decoration:underline;">VIEW CANCELLATION, REFUND &amp; ACCOUNT CREDIT POLICY</a>
      <label class="tc-row" style="margin-top:8px;"><input type="checkbox" id="promoteExistingTermsChk"> <span>I have read, understood and accept the Terms and Conditions, Privacy Policy, Refund Policy and Cancellation Policy of Unplug Magazine.</span></label>
    </div>

    <button class="btn btn-solid" id="promoteExistingBtn" style="width:auto;" disabled>Continue to Payment</button>
    <div class="instructions-box section-hidden" id="promoteExistingResult" style="margin-top:12px;"></div>
  `;

  const typeSelect = document.getElementById('promoteExistingType');
  const itemSelect = document.getElementById('promoteExistingItem');
  const durationSelect = document.getElementById('promoteExistingDuration');
  const startInput = document.getElementById('promoteExistingStart');
  const eligibilityBox = document.getElementById('promoteExistingEligibility');
  const quoteBox = document.getElementById('promoteExistingQuote');
  const errorBox = document.getElementById('promoteExistingError');
  const resultBox = document.getElementById('promoteExistingResult');
  const buyBtn = document.getElementById('promoteExistingBtn');

  let eligibility = null;
  let packages = null;
  let creditBalance = 0;
  let loadInFlight = null;
  let latestQuote = null;

  function showError(message) {
    errorBox.textContent = message || '';
    errorBox.style.display = message ? 'block' : 'none';
  }

  function itemsFor(type) {
    if (!eligibility) return [];
    if (type === 'article') return (eligibility.articles || []).map((a) => ({ id: a.id, label: a.title || `Article #${a.id}` }));
    if (type === 'directory' && eligibility.directoryProfile) {
      const p = eligibility.directoryProfile;
      return [{ id: p.id, label: p.display_name || `Directory Profile #${p.id}` }];
    }
    return [];
  }

  function packagesForType(type) {
    return packages && Array.isArray(packages[type]) ? packages[type] : [];
  }

  function renderEligibility() {
    const type = typeSelect.value;
    const items = itemsFor(type);
    const rows = packagesForType(type);

    itemSelect.innerHTML = items.length
      ? items.map((item) => `<option value="${Number(item.id)}">${esc(item.label)}</option>`).join('')
      : `<option value="">No ${type === 'article' ? 'published articles' : 'published Directory profile'} available</option>`;

    durationSelect.innerHTML = rows.length
      ? rows.map((p) => `<option value="${Number(p.durationDays)}">${Number(p.durationDays)} days — ${money(p.price)}</option>`).join('')
      : '<option value="">No promotion packages available</option>';

    let message = '';
    let problem = false;
    if (!eligibility) {
      message = 'We could not confirm which content is ready to promote. Please try again.';
      problem = true;
    } else if (type === 'article') {
      const future = Number(eligibility.futureScheduledArticles) || 0;
      const scheduledNote = future
        ? ` ${future} approved article${future === 1 ? ' is' : 's are'} scheduled for later and will appear here automatically once live.`
        : '';
      if (items.length) {
        message = `${items.length} published article${items.length === 1 ? '' : 's'} available to promote.${scheduledNote}`;
      } else {
        message = `You do not have an article that is approved and publicly live yet. Once an article is live, it will automatically appear here.${scheduledNote}`;
        problem = true;
      }
    } else if (items.length) {
      message = 'Your published Directory profile is ready to promote.';
    } else {
      message = 'Your Directory profile must be approved and publicly live before it can be promoted. You do not need to resubmit it — it will appear here automatically once approved.';
      problem = true;
    }

    if (!rows.length) {
      message += ' No promotion package is currently available for this content type.';
      problem = true;
    }

    eligibilityBox.textContent = message;
    eligibilityBox.style.borderColor = problem ? 'var(--red)' : '';
    buyBtn.disabled = !items.length || !rows.length;

    const serverToday = eligibility && eligibility.serverToday;
    if (serverToday) {
      startInput.min = serverToday;
      if (!startInput.value || startInput.value < serverToday) startInput.value = serverToday;
    }

    latestQuote = null;
    refreshQuote();
  }

  async function loadPackages() {
    try {
      const data = await api('/highlights/packages');
      packages = data.packages || { article: [], directory: [] };
    } catch (err) {
      packages = { article: [], directory: [] };
      throw err;
    }
  }

  async function loadEligibility() {
    try {
      eligibility = await api('/highlights/eligible');
    } catch (err) {
      eligibility = null;
      throw err;
    }
  }

  async function loadCredit() {
    try {
      creditBalance = Number((await api('/payments/credit')).balance) || 0;
    } catch (err) {
      creditBalance = 0;
    }
    document.getElementById('promoteExistingCreditBalance').textContent = money(creditBalance);
    document.getElementById('promoteExistingCreditWrap').classList.toggle('section-hidden', creditBalance <= 0);
    if (creditBalance <= 0) document.getElementById('promoteExistingUseCredit').checked = false;
  }

  async function loadData() {
    if (!sessionReady()) return false;
    if (loadInFlight) return loadInFlight;

    loadInFlight = (async () => {
      const results = await Promise.allSettled([loadPackages(), loadEligibility(), loadCredit()]);
      renderEligibility();
      const failed = results.filter((r) => r.status === 'rejected');
      if (failed.length) {
        showError('Some promotion details could not be loaded. Please try again before paying.');
      } else {
        showError('');
      }
      return true;
    })().finally(() => { loadInFlight = null; });

    return loadInFlight;
  }

  async function refreshQuote() {
    if (!sessionReady()) {
      quoteBox.textContent = 'Sign in to see your promotion total.';
      latestQuote = null;
      return null;
    }
    const durationDays = Number(durationSelect.value);
    const targetType = typeSelect.value;
    if (!durationDays || !itemSelect.value) {
      quoteBox.textContent = 'Choose eligible content and a promotion period to see your total.';
      latestQuote = null;
      return null;
    }

    try {
      const voucherCode = document.getElementById('promoteExistingVoucher').value.trim();
      const quote = await api('/payments/quote', {
        method: 'POST',
        body: JSON.stringify({
          linkedType: 'highlight',
          durationDays,
          targetType,
          voucherCode: voucherCode || undefined,
          useCredit: document.getElementById('promoteExistingUseCredit').checked,
        }),
      });

      latestQuote = quote;
      const lines = [`Promotion price: <strong>${money(quote.orderTotal)}</strong>`];
      if (quote.voucherDiscount > 0) lines.push(`Voucher discount: <strong>−${money(quote.voucherDiscount)}</strong>`);
      if (quote.creditApplied > 0) lines.push(`Unplug Credit: <strong>−${money(quote.creditApplied)}</strong>`);
      lines.push(`Amount to pay: <strong>${money(quote.amountToPay)}</strong>`);
      if (quote.voucherError) lines.push(`<span style="color:var(--red);">${esc(quote.voucherError)}</span>`);
      if (quote.settledWithoutPayment) lines.push('<strong>Your voucher / Unplug Credit covers this promotion in full.</strong>');
      quoteBox.innerHTML = lines.join('<br>');
      return quote;
    } catch (err) {
      latestQuote = null;
      quoteBox.textContent = err.message || 'Could not calculate this total.';
      return null;
    }
  }

  function paymentReferenceNotice(reference) {
    if (typeof refNotice === 'function') return refNotice(reference);
    return reference ? `<div style="margin-top:12px;"><strong>Reference:</strong> ${esc(reference)}</div>` : '';
  }

  function uploadProofBlock(paymentId) {
    return (paymentId && typeof popUploadBlock === 'function') ? popUploadBlock('payments', paymentId) : '';
  }

  async function purchasePromotion() {
    showError('');
    resultBox.classList.add('section-hidden');

    const targetType = typeSelect.value;
    const targetId = Number(itemSelect.value);
    const durationDays = Number(durationSelect.value);
    if (!targetId) return showError('Choose published content to promote.');
    if (!durationDays) return showError('Choose a promotion period.');
    if (!document.getElementById('promoteExistingTermsChk').checked) {
      return showError('You must accept the Terms and Conditions before you can proceed with payment.');
    }

    const quote = latestQuote || await refreshQuote();
    if (!quote) return showError('We could not confirm the promotion price. Please try again.');
    if (quote.voucherError) return showError(quote.voucherError);

    buyBtn.disabled = true;
    buyBtn.textContent = 'Processing…';
    let createdHighlightId = null;

    try {
      const created = await api('/highlights', {
        method: 'POST',
        body: JSON.stringify({
          targetType,
          targetId,
          durationDays,
          requestedStartDate: startInput.value || undefined,
        }),
      });
      createdHighlightId = created.highlight && created.highlight.id;

      const pay = await api('/payments/initiate', {
        method: 'POST',
        body: JSON.stringify({
          linkedType: 'highlight',
          linkedId: createdHighlightId,
          method: document.getElementById('promoteExistingPayMethod').value || 'eft',
          termsAccepted: true,
          termsVersion: (typeof SUBMIT_TERMS_VERSION !== 'undefined' ? SUBMIT_TERMS_VERSION : undefined),
          useCredit: document.getElementById('promoteExistingUseCredit').checked,
          voucherCode: document.getElementById('promoteExistingVoucher').value.trim() || undefined,
        }),
      });

      resultBox.classList.remove('section-hidden');
      if (pay.paidInFull) {
        resultBox.innerHTML = `<strong>Promotion booked — paid in full by your voucher / Unplug Credit.</strong><br><br>${esc(pay.message || '')}`
          + (pay.payment && pay.payment.gateway_reference ? paymentReferenceNotice(pay.payment.gateway_reference) : '');
      } else if (pay.instructions) {
        const i = pay.instructions;
        resultBox.innerHTML = `<strong>Promotion reserved.</strong> Pay via EFT using the details below — it starts for the paid period once payment clears and our team approves it.<br><br>
          <b>Bank:</b> ${esc(i.bank)}<br><b>Account Name:</b> ${esc(i.accountName)}<br>
          ${i.accountType ? `<b>Account Type:</b> ${esc(i.accountType)}<br>` : ''}
          <b>Account Number:</b> ${esc(i.accountNumber)}<br><b>Branch Code:</b> ${esc(i.branchCode)}<br><br>${esc(i.note || '')}`
          + paymentReferenceNotice(i.reference)
          + (pay.payment && pay.payment.id ? uploadProofBlock(pay.payment.id) : '');
      } else {
        resultBox.innerHTML = `<strong>Promotion reserved.</strong> ${esc(pay.note || '')}`;
      }

      if (typeof showToast === 'function') showToast('Promotion reserved — it now appears under My Services.');
      if (typeof loadPaymentHistory === 'function') loadPaymentHistory();
      if (typeof loadMyServices === 'function') loadMyServices();
      await loadCredit();
      await refreshQuote();
    } catch (err) {
      const base = err.message || 'Could not start that promotion.';
      if (createdHighlightId) {
        showError(`${base} A promotion request was created before payment failed. Check My Services before trying again so you do not create a duplicate request.`);
      } else {
        showError(base);
        // Eligibility may have changed between page load and click — for
        // example an article was unpublished. Refresh the authoritative list.
        await loadData();
      }
    } finally {
      buyBtn.textContent = 'Continue to Payment';
      buyBtn.disabled = !itemsFor(typeSelect.value).length || !packagesForType(typeSelect.value).length;
    }
  }

  typeSelect.addEventListener('change', renderEligibility);
  itemSelect.addEventListener('change', refreshQuote);
  durationSelect.addEventListener('change', refreshQuote);
  document.getElementById('promoteExistingUseCredit').addEventListener('change', refreshQuote);
  document.getElementById('promoteExistingVoucherBtn').addEventListener('click', refreshQuote);
  document.getElementById('promoteExistingVoucher').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); refreshQuote(); }
  });
  buyBtn.addEventListener('click', purchasePromotion);

  // A first-class route to this return journey. The shortcut is created after
  // the original member navigation was wired, so it deliberately clicks the
  // already-wired Browse Services button first; merely adding data-ms="services"
  // here would leave the Services section hidden when the member came from
  // Profile / My Unplug / Payments.
  function openPromoteExisting() {
    const browse = document.querySelector('#msSidebar .ms-navlink[data-ms="services"]');
    if (browse) browse.click();
    setTimeout(() => card.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
  }

  const sidebar = document.getElementById('msSidebar');
  if (sidebar && !document.getElementById('promoteExistingNav')) {
    const browse = sidebar.querySelector('.ms-navlink[data-ms="services"]');
    if (browse) {
      const shortcut = document.createElement('button');
      shortcut.id = 'promoteExistingNav';
      shortcut.className = 'ms-navlink';
      shortcut.type = 'button';
      shortcut.innerHTML = '<span>📣</span> Promote Existing Content';
      shortcut.addEventListener('click', openPromoteExisting);
      browse.insertAdjacentElement('afterend', shortcut);
    }
  }

  // Also surface the return journey in the service catalogue itself, so a
  // member browsing what Unplug offers can immediately distinguish "submit
  // something new" from "promote something I already have".
  function addCatalogueShortcut() {
    const grid = document.getElementById('msServicesGrid');
    if (!grid || document.getElementById('promoteExistingServiceTile')) return;
    const tile = document.createElement('button');
    tile.id = 'promoteExistingServiceTile';
    tile.type = 'button';
    tile.className = 'ms-service';
    tile.innerHTML = '<span class="t">Promote Existing Content</span><span class="d">Boost an article or Directory profile already published</span>';
    tile.addEventListener('click', openPromoteExisting);
    grid.insertAdjacentElement('afterbegin', tile);
  }

  const originalRenderServices = window.msRenderServices;
  if (typeof originalRenderServices === 'function' && !originalRenderServices.__promoteExistingWrapped) {
    const wrappedRenderServices = function wrappedRenderServices() {
      const result = originalRenderServices.apply(this, arguments);
      addCatalogueShortcut();
      return result;
    };
    wrappedRenderServices.__promoteExistingWrapped = true;
    window.msRenderServices = wrappedRenderServices;
  }
  addCatalogueShortcut();

  // Retire the old split Highlight Article / Highlight Profile loader on this
  // card. enterMemberDashboard still calls loadHighlightServices() for legacy
  // compatibility; once this module is installed that call must refresh the
  // unified, server-authoritative journey rather than rewriting its pickers.
  const legacyLoadHighlightServices = window.loadHighlightServices;
  if (typeof legacyLoadHighlightServices === 'function' && !legacyLoadHighlightServices.__promoteExistingWrapped) {
    const wrappedLoadHighlightServices = async function wrappedLoadHighlightServices() {
      if (card.getAttribute('data-promote-existing-content') === 'true') return loadData();
      return legacyLoadHighlightServices.apply(this, arguments);
    };
    wrappedLoadHighlightServices.__promoteExistingWrapped = true;
    window.loadHighlightServices = wrappedLoadHighlightServices;
  }

  // Authentication restoration is async and this module is deferred. The
  // dashboard may therefore be installed a fraction of a second before the
  // token is restored. Poll briefly for the token, then load exactly once.
  let attempts = 0;
  const readyTimer = setInterval(async () => {
    attempts += 1;
    if (sessionReady()) {
      clearInterval(readyTimer);
      await loadData();
      return;
    }
    if (attempts >= 120) clearInterval(readyTimer);
  }, 500);
})();
