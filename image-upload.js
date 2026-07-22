// Image upload widget, shared by the admin and member dashboards.
//
// Replaces "paste a URL" entry. Pasting a URL meant the image lived on
// someone else's server: it could vanish, change, or be a link to something
// unrelated, and nothing was actually stored. Files uploaded here go to the
// site's own storage and get a permanent address.
//
// Uses a delegated listener rather than wiring each field on load, because
// article sections are added after the page renders and would otherwise
// come up dead.

(function () {
  let getApiBase = () => '';
  let getToken = () => null;

  // Each page has its own API base and session, so it tells us rather than us
  // guessing. Both are read lazily: the page can change its API base (it does,
  // on sign-in), and a value captured here would go stale.
  function init(options) {
    if (typeof options.getApiBase === 'function') getApiBase = options.getApiBase;
    else if (options.apiBase) getApiBase = () => options.apiBase;
    if (typeof options.getToken === 'function') getToken = options.getToken;
  }

  // The markup for one upload field. `value` pre-fills an existing image so
  // editing an article doesn't silently drop the picture already on it.
  function fieldHtml(name, value, label) {
    const safe = String(value || '').replace(/"/g, '&quot;');
    return `<div class="img-upload" data-name="${name}">
      ${label ? `<label>${label}</label>` : ''}
      <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" class="img-upload-input">
      <input type="hidden" class="img-upload-url" name="${name}" value="${safe}">
      <div class="img-upload-status"></div>
      <img class="img-upload-preview" src="${safe}" alt="" ${value ? '' : 'hidden'}>
    </div>`;
  }

  // Reads the stored URL out of a widget — what the form should submit.
  function valueOf(container) {
    const hidden = container ? container.querySelector('.img-upload-url') : null;
    return hidden ? hidden.value.trim() : '';
  }

  async function upload(file, widget) {
    const status = widget.querySelector('.img-upload-status');
    const hidden = widget.querySelector('.img-upload-url');
    const preview = widget.querySelector('.img-upload-preview');

    // Checked here as well as on the server so the person gets an immediate,
    // specific answer instead of waiting for a failed upload.
    if (!file.type.startsWith('image/')) {
      status.textContent = 'That file is not an image.';
      status.className = 'img-upload-status error';
      return;
    }
    const maxMb = 8;
    if (file.size > maxMb * 1024 * 1024) {
      status.textContent = `That image is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is ${maxMb} MB. Please resize it and try again.`;
      status.className = 'img-upload-status error';
      return;
    }

    status.textContent = 'Uploading…';
    status.className = 'img-upload-status';
    const form = new FormData();
    form.append('file', file);
    try {
      const token = getToken();
      const base = String(getApiBase() || '').replace(/\/+$/, '');
      const res = await fetch(base + '/uploads', {
        method: 'POST',
        // No Content-Type header: the browser must set the multipart
        // boundary itself, and setting it manually breaks the upload.
        headers: token ? { Authorization: 'Bearer ' + token } : {},
        body: form,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
      hidden.value = data.url;
      preview.src = data.url;
      preview.hidden = false;
      status.textContent = 'Uploaded.';
      status.className = 'img-upload-status ok';
    } catch (err) {
      status.textContent = err.message;
      status.className = 'img-upload-status error';
    }
  }

  document.addEventListener('change', (e) => {
    const input = e.target.closest('.img-upload-input');
    if (!input) return;
    const widget = input.closest('.img-upload');
    if (widget && input.files && input.files[0]) upload(input.files[0], widget);
  });

  window.UnplugUpload = { init, fieldHtml, valueOf };
})();
