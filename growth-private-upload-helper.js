'use strict';

(function growthPrivateUploadHelper(){
  if (window.__unplugGrowthPrivateUploadHelper) return;
  window.__unplugGrowthPrivateUploadHelper = true;

  function token(){
    try { return localStorage.getItem('unplug_auth_token') || ''; }
    catch (_) { return ''; }
  }

  document.addEventListener('click', async (event) => {
    const link = event.target.closest('a[href*="/growth-application/upload/admin/"]');
    if (!link) return;
    event.preventDefault();

    const auth = token();
    if (!auth) {
      alert('Your admin session has expired. Please sign in again.');
      return;
    }

    const originalText = link.textContent;
    link.textContent = 'Opening…';
    link.setAttribute('aria-busy', 'true');
    try {
      const response = await fetch(link.href, {
        headers: { Authorization: 'Bearer ' + auth, Accept: '*/*' },
        cache: 'no-store',
      });
      if (!response.ok) {
        let message = `Could not open file (${response.status}).`;
        try {
          const body = await response.json();
          if (body && body.error) message = body.error;
        } catch (_) {}
        throw new Error(message);
      }
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const opened = window.open(objectUrl, '_blank', 'noopener,noreferrer');
      if (!opened) {
        URL.revokeObjectURL(objectUrl);
        throw new Error('Your browser blocked the secure file window. Please allow pop-ups for Unplug and try again.');
      }
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60 * 1000);
    } catch (error) {
      alert(error.message || 'The private Growth file could not be opened.');
    } finally {
      link.textContent = originalText;
      link.removeAttribute('aria-busy');
    }
  });
})();