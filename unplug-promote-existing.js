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

  card.setAttribute('data-promote-existing-content', 'true');
  card.innerHTML = `
    <h2>Promote Existing Content</h2>
    <p class="sub">Come back at any time and boost something you have already published. You do not need to submit it again.</p>

    <div class="instructions-box" style="margin-bottom:16px;">
      <strong>How it works:</strong> choose the published item, choose how long you want the promotion to run, then continue to checkout. Only content that is already approved and live can be promoted.
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
      <div class="field">
        <label for="svcArtPayMethod">Payment Method</label>
        <select id="svcArtPayMethod"><option value="eft" selected>Manual EFT</option></select>
        <p style="font-size:12px; color:var(--slate); margin-top:6px;">Card and Instant EFT payments via PayFast and Ozow will be available soon. For now, all payments are handled by manual EFT.</p>
      </div>
      <div id="svcArtError" class="error-banner" style="display:none;"></div>
      <div class="field" style="border-top:1px solid var(--paper-line); padding-top:10px;">
        <p style="font-size:12.5px; margin-bottom:6px;"><strong>Cancellation &amp; Credit Policy:</strong> A minimum of 7 working days' notice is required to cancel before a service starts. If eligible, 100% of the amount paid will be credited to your account (no cash refund) — credit never expires. Once a service has started, no refund or unused-period credit will be provided, subject to applicable law.</p>
        <a href="unplug-magazine.html?p=refunds" target="_blank" rel="noopener" style="font-weight:600; text-decoration:underline; margin-right:14px;">VIEW TERMS &amp; CONDITIONS</a>
        <a href="unplug-magazine.html?p=refunds" target="_blank" rel="noopener" style="font-weight:600; text-decoration:underline;">VIEW CANCELLATION, REFUND &amp; ACCOUNT CREDIT POLICY</a>
        <label class="tc-row" style="margin-top:8px;"><input type="checkbox" id="svcArtTermsChk"> <span>I have read, understood and accept the Terms and Conditions, Privacy Policy, Refund Policy and Cancellation Policy of Unplug Magazine.</span></label>
      </div>
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
      <div class="field">
        <label for="svcProfPayMethod">Payment Method</label>
        <select id="svcProfPayMethod"><option value="eft" selected>Manual EFT</option></select>
        <p style="font-size:12px; color:var(--slate); margin-top:6px;">Card and Instant EFT payments via PayFast and Ozow will be available soon. For now, all payments are handled by manual EFT.</p>
      </div>
      <div id="svcProfError" class="error-banner" style="display:none;"></div>
      <div class="field" style="border-top:1px solid var(--paper-line); padding-top:10px;">
        <p style="font-size:12.5px; margin-bottom:6px;"><strong>Cancellation &amp; Credit Policy:</strong> A minimum of 7 working days' notice is required to cancel before a service starts. If eligible, 100% of the amount paid will be credited to your account (no cash refund) — credit never expires. Once a service has started, no refund or unused-period credit will be provided, subject to applicable law.</p>
        <a href="unplug-magazine.html?p=refunds" target="_blank" rel="noopener" style="font-weight:600; text-decoration:underline; margin-right:14px;">VIEW TERMS &amp; CONDITIONS</a>
        <a href="unplug-magazine.html?p=refunds" target="_blank" rel="noopener" style="font-weight:600; text-decoration:underline;">VIEW CANCELLATION, REFUND &amp; ACCOUNT CREDIT POLICY</a>
        <label class="tc-row" style="margin-top:8px;"><input type="checkbox" id="svcProfTermsChk"> <span>I have read, understood and accept the Terms and Conditions, Privacy Policy, Refund Policy and Cancellation Policy of Unplug Magazine.</span></label>
      </div>
      <button class="btn btn-solid" id="svcProfBtn" style="width:auto;">Continue to Checkout</button>
      <div class="instructions-box section-hidden" id="svcProfResult" style="margin-top:12px;"></div>
    </div>
  `;

  const typeSelect = document.getElementById('promoteExistingType');
  const articlePanel = document.getElementById('promoteExistingArticlePanel');
  const directoryPanel = document.getElementById('promoteExistingDirectoryPanel');
  const eligibility = document.getElementById('promoteExistingEligibility');

  function showEligibility(message, isProblem) {
    if (!message) {
      eligibility.textContent = '';
      eligibility.classList.add('section-hidden');
      return;
    }
    eligibility.textContent = message;
    eligibility.classList.remove('section-hidden');
    eligibility.style.borderColor = isProblem ? 'var(--red)' : '';
  }

  function showType(type) {
    const article = type === 'article';
    articlePanel.classList.toggle('section-hidden', !article);
    directoryPanel.classList.toggle('section-hidden', article);
    showEligibility('', false);
    if (!article) refreshDirectoryEligibility();
  }

  typeSelect.addEventListener('change', () => showType(typeSelect.value));

  function money(value) {
    const n = Number(value);
    return Number.isFinite(n) ? `R${n.toFixed(0)}` : '';
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
      if (!approved.length && typeSelect.value === 'article') {
        showEligibility('You do not have a published article available to promote yet. Once an article is approved and live, it will automatically appear here.', true);
      }
    } catch (err) {
      select.innerHTML = '<option value="">Could not load your articles</option>';
      document.getElementById('svcArtBtn').disabled = true;
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
        showEligibility('Your published Directory profile is ready to promote.', false);
      } else {
        select.innerHTML = '<option value="">No published Directory profile available</option>';
        document.getElementById('svcProfBtn').disabled = true;
        showEligibility('Your Directory profile must be approved and live before it can be promoted. You do not need to resubmit it — it will appear here automatically once approved.', true);
      }
    } catch (err) {
      select.innerHTML = '<option value="">No published Directory profile available</option>';
      document.getElementById('svcProfBtn').disabled = true;
      if (typeSelect.value === 'directory') {
        showEligibility('Create and publish your Directory profile first. Once it is approved, you can return here and promote that same profile without submitting it again.', true);
      }
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

  async function loadEligibleContent() {
    if (typeof AUTH_TOKEN === 'undefined' || !AUTH_TOKEN) return false;
    await Promise.all([loadPackages(), loadPublishedArticles(), refreshDirectoryEligibility()]);
    if (typeSelect.value === 'article') showEligibility('', false);
    return true;
  }

  const artBtn = document.getElementById('svcArtBtn');
  artBtn.dataset.wired = '1';
  artBtn.addEventListener('click', () => buyHighlight({
    targetType: 'article',
    targetId: Number(document.getElementById('svcArtPick').value),
    durationDays: Number(document.getElementById('svcArtDuration').value),
    requestedStartDate: document.getElementById('svcArtStart').value || undefined,
    errorEl: 'svcArtError',
    resultEl: 'svcArtResult',
    btn: 'svcArtBtn',
    termsChkId: 'svcArtTermsChk',
    payMethodId: 'svcArtPayMethod',
  }));

  const profBtn = document.getElementById('svcProfBtn');
  profBtn.dataset.wired = '1';
  profBtn.addEventListener('click', () => buyHighlight({
    targetType: 'directory',
    targetId: Number(document.getElementById('svcProfPick').value),
    durationDays: Number(document.getElementById('svcProfDuration').value),
    requestedStartDate: document.getElementById('svcProfStart').value || undefined,
    errorEl: 'svcProfError',
    resultEl: 'svcProfResult',
    btn: 'svcProfBtn',
    termsChkId: 'svcProfTermsChk',
    payMethodId: 'svcProfPayMethod',
  }));

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
