// Promote Existing Content compatibility guard.
//
// The older member dashboard still calls loadHighlightServices() when the user
// enters My Unplug. That loader predates scheduled publishing and considers
// every status='approved' article eligible. Promote Existing Content is stricter:
// the article must already be publicly live. Run the legacy loader first so it
// can do its normal package setup, then replace only the article pick-list with
// the correct live-only result.
(function guardPromoteExistingAgainstLegacyLoader() {
  'use strict';

  if (!document.getElementById('hlServicesCard')) return;
  if (typeof window.loadHighlightServices !== 'function') return;

  const legacyLoadHighlightServices = window.loadHighlightServices;

  window.loadHighlightServices = async function loadHighlightServicesLiveOnly() {
    await legacyLoadHighlightServices();

    const picker = document.getElementById('svcArtPick');
    if (!picker || typeof api !== 'function') return;

    try {
      const data = await api('/articles/mine');
      const today = new Date().toISOString().slice(0, 10);
      const eligible = (data.articles || []).filter((article) =>
        article.status === 'approved'
        && (!article.scheduled_for || String(article.scheduled_for).slice(0, 10) <= today));

      picker.innerHTML = eligible.length
        ? eligible.map((article) => `<option value="${article.id}">${escapeAttrM(article.title || `Article #${article.id}`)}</option>`).join('')
        : '<option value="">No published articles available</option>';

      const button = document.getElementById('svcArtBtn');
      if (button) button.disabled = eligible.length === 0;
    } catch (err) {
      picker.innerHTML = '<option value="">Could not load your published articles</option>';
      const button = document.getElementById('svcArtBtn');
      if (button) button.disabled = true;
    }
  };
})();
