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
//
// Payment Portal Redevelopment Phase 4 added the crop/zoom/reposition/
// rotate step below (openCropper) — self-contained in this one file
// (injects its own modal markup + CSS into <body>/<head> on first use)
// so every existing caller across every page gets it automatically,
// with zero HTML changes anywhere. A field only gets the crop step when
// it already passes a `recommended` { w, h } ratio hint — fields that
// don't (a handful of free-form uploads) keep uploading exactly as
// before, unchanged.

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
  // `recommended`, when passed, is { w, h, label } (e.g. { w:1080, h:1350,
  // label:'1080 × 1350px, 4:5 portrait' }) — an optional dimension hint shown
  // beside the field and checked (non-blocking) after a file is chosen. Every
  // existing caller that doesn't pass it behaves exactly as before.
  function fieldHtml(name, value, label, recommended) {
    const safe = String(value || '').replace(/"/g, '&quot;');
    const hint = recommended
      ? `<p class="img-upload-hint">Recommended size: ${recommended.w} × ${recommended.h}px${recommended.label ? ' — ' + recommended.label : ''}. JPG, PNG or WEBP, max 5MB.</p>`
      : '';
    const ratioAttrs = recommended ? ` data-ratio-w="${recommended.w}" data-ratio-h="${recommended.h}"` : '';
    return `<div class="img-upload" data-name="${name}"${ratioAttrs}>
      ${label ? `<label>${label}</label>` : ''}
      ${hint}
      <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" class="img-upload-input">
      <input type="hidden" class="img-upload-url" name="${name}" value="${safe}">
      <div class="img-upload-status"></div>
      <div class="img-upload-warning" hidden></div>
      <img class="img-upload-preview" src="${safe}" alt="" ${value ? '' : 'hidden'}>
      ${recommended ? `<button type="button" class="img-upload-recrop" hidden>Re-crop this image</button>` : ''}
    </div>`;
  }

  // Reads the chosen file's pixel dimensions client-side (no upload/server
  // round-trip needed) and warns — but never blocks — if they don't match the
  // field's recommended ratio. Only still relevant for fields that DON'T
  // offer the crop step (see below) — a cropped export always matches
  // exactly, by construction.
  function checkDimensions(file, widget) {
    const ratioW = Number(widget.dataset.ratioW);
    const ratioH = Number(widget.dataset.ratioH);
    const warning = widget.querySelector('.img-upload-warning');
    if (!ratioW || !ratioH || !warning) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const targetRatio = ratioW / ratioH;
      const actualRatio = img.naturalWidth / img.naturalHeight;
      // ~4% tolerance — exact-pixel matches aren't required, just the same shape.
      if (Math.abs(actualRatio - targetRatio) / targetRatio > 0.04) {
        warning.textContent = `Incorrect image size. Please upload a ${ratioW} × ${ratioH}px image in a ${ratioW}:${ratioH} ratio for the best result (yours is ${img.naturalWidth} × ${img.naturalHeight}px). It will still upload, but may crop or look off.`;
        warning.hidden = false;
      } else {
        warning.hidden = true;
      }
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  }

  // Reads the stored URL out of a widget — what the form should submit.
  function valueOf(container) {
    const hidden = container ? container.querySelector('.img-upload-url') : null;
    return hidden ? hidden.value.trim() : '';
  }

  async function upload(fileOrBlob, widget, filename) {
    const status = widget.querySelector('.img-upload-status');
    const hidden = widget.querySelector('.img-upload-url');
    const preview = widget.querySelector('.img-upload-preview');

    // Checked here as well as on the server so the person gets an immediate,
    // specific answer instead of waiting for a failed upload.
    if (!fileOrBlob.type.startsWith('image/')) {
      status.textContent = 'That file is not an image.';
      status.className = 'img-upload-status error';
      return;
    }
    const maxMb = 8;
    if (fileOrBlob.size > maxMb * 1024 * 1024) {
      status.textContent = `That image is ${(fileOrBlob.size / 1024 / 1024).toFixed(1)} MB — the limit is ${maxMb} MB. Please resize it and try again.`;
      status.className = 'img-upload-status error';
      return;
    }

    status.textContent = 'Uploading…';
    status.className = 'img-upload-status';
    const form = new FormData();
    // A cropped export is a Blob, not a File — Blobs have no filename of
    // their own, and the upload route needs one with a real extension to
    // infer content type sensibly server-side, so it's supplied explicitly
    // here rather than left to FormData's default ("blob").
    form.append('file', fileOrBlob, filename || (fileOrBlob.name || 'upload.jpg'));
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
      const recrop = widget.querySelector('.img-upload-recrop');
      if (recrop) recrop.hidden = false;
      // Setting .value programmatically doesn't fire input/change, so callers
      // that need to react once the upload finishes (e.g. refresh a live
      // preview elsewhere on the page) can listen for this instead.
      widget.dispatchEvent(new CustomEvent('img-upload:done', { bubbles: true, detail: { url: data.url } }));
    } catch (err) {
      status.textContent = err.message;
      status.className = 'img-upload-status error';
    }
  }

  // ---------------------------------------------------------------------
  // Crop / zoom / reposition / rotate — Payment Portal Redevelopment
  // Phase 4. One shared modal, injected once, reused for every field.
  // ---------------------------------------------------------------------
  let cropperReady = false;
  let cropperEls = null;

  function ensureCropperDom() {
    if (cropperReady) return cropperEls;
    cropperReady = true;

    const style = document.createElement('style');
    style.textContent = `
      .uc-overlay{ position:fixed; inset:0; background:rgba(20,16,12,0.72); z-index:9999; display:flex; align-items:center; justify-content:center; padding:20px; }
      .uc-overlay[hidden]{ display:none; }
      .uc-box{ background:#fff; border-radius:8px; padding:20px; max-width:520px; width:100%; box-shadow:0 20px 60px rgba(0,0,0,0.35); }
      .uc-title{ font-weight:700; font-size:15px; margin-bottom:10px; font-family:'Playfair Display',Georgia,serif; }
      .uc-stage{ position:relative; overflow:hidden; margin:0 auto 14px; background:#111; cursor:grab; touch-action:none; border-radius:4px; }
      .uc-stage:active{ cursor:grabbing; }
      .uc-controls{ display:flex; align-items:center; gap:10px; margin-bottom:14px; }
      .uc-controls input[type=range]{ flex:1; }
      .uc-btnrow{ display:flex; gap:8px; flex-wrap:wrap; }
      .uc-btnrow button{ flex:1; min-width:90px; padding:9px 12px; font-size:12.5px; font-weight:600; border-radius:4px; cursor:pointer; border:1px solid #d8d0c4; background:#fff; }
      .uc-btnrow button.uc-primary{ background:#d20709; border-color:#d20709; color:#fff; }
      .uc-btnrow button.uc-primary:hover{ background:#b30507; }
      .uc-btnrow button:not(.uc-primary):hover{ border-color:#d20709; color:#d20709; }
      .uc-hint{ font-size:11.5px; color:#79726a; margin-bottom:10px; }
    `;
    document.head.appendChild(style);

    const overlay = document.createElement('div');
    overlay.className = 'uc-overlay';
    overlay.hidden = true;
    overlay.innerHTML = `
      <div class="uc-box">
        <div class="uc-title">Adjust your image</div>
        <p class="uc-hint">Drag to reposition, use the slider to zoom, or rotate. This is exactly what will be used.</p>
        <div class="uc-stage"><canvas></canvas></div>
        <div class="uc-controls">
          <span style="font-size:12px;">Zoom</span>
          <input type="range" min="1" max="3" step="0.01" value="1" class="uc-zoom">
        </div>
        <div class="uc-btnrow">
          <button type="button" class="uc-rotate">Rotate 90°</button>
          <button type="button" class="uc-cancel">Cancel</button>
          <button type="button" class="uc-save uc-primary">Use This Image</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    cropperEls = {
      overlay,
      canvas: overlay.querySelector('canvas'),
      stage: overlay.querySelector('.uc-stage'),
      zoom: overlay.querySelector('.uc-zoom'),
      rotateBtn: overlay.querySelector('.uc-rotate'),
      cancelBtn: overlay.querySelector('.uc-cancel'),
      saveBtn: overlay.querySelector('.uc-save'),
    };
    return cropperEls;
  }

  // Bakes a rotation into a fresh canvas so pan/zoom afterward is a plain
  // 2D rectangle selection rather than compounding rotate+translate+scale
  // transforms — much less room for the math to drift wrong across drags.
  function rotatedCanvasOf(img, deg) {
    const rad = (deg * Math.PI) / 180;
    const swap = deg % 180 !== 0;
    const w = img.naturalWidth, h = img.naturalHeight;
    const c = document.createElement('canvas');
    c.width = swap ? h : w;
    c.height = swap ? w : h;
    const ctx = c.getContext('2d');
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate(rad);
    ctx.drawImage(img, -w / 2, -h / 2);
    return c;
  }

  // Opens the cropper for `file` at the given target ratio. Resolves with a
  // cropped JPEG Blob, or null if the person cancelled.
  function openCropper(file, ratioW, ratioH) {
    return new Promise((resolve) => {
      const els = ensureCropperDom();
      const objectUrl = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        // Viewport size on screen — capped so it never overflows a small
        // phone, always matching the target ratio exactly.
        const maxW = Math.min(440, window.innerWidth - 80);
        const stageW = maxW;
        const stageH = Math.round((maxW * ratioH) / ratioW);
        els.canvas.width = stageW;
        els.canvas.height = stageH;
        els.stage.style.width = stageW + 'px';
        els.stage.style.height = stageH + 'px';
        const ctx = els.canvas.getContext('2d');

        let rotation = 0;
        let rotated = rotatedCanvasOf(img, rotation);
        let zoom = 1; // 1 = smallest legal (cover-fit); slider goes up from there
        let panX = 0, panY = 0; // extra offset beyond centered, in stage px

        function coverScale() {
          return Math.max(stageW / rotated.width, stageH / rotated.height);
        }
        function draw() {
          const scale = coverScale() * zoom;
          const drawW = rotated.width * scale;
          const drawH = rotated.height * scale;
          const baseX = (stageW - drawW) / 2;
          const baseY = (stageH - drawH) / 2;
          // Clamp panning so the image can never show a gap at any edge.
          const minX = Math.min(0, stageW - drawW);
          const minY = Math.min(0, stageH - drawH);
          panX = Math.max(minX - baseX, Math.min(-baseX, panX));
          panY = Math.max(minY - baseY, Math.min(-baseY, panY));
          const x = baseX + panX;
          const y = baseY + panY;
          ctx.clearRect(0, 0, stageW, stageH);
          ctx.drawImage(rotated, 0, 0, rotated.width, rotated.height, x, y, drawW, drawH);
          els._lastDraw = { x, y, drawW, drawH, scale };
        }

        els.zoom.value = '1';
        draw();

        // Drag to reposition — mouse and touch, one set of handlers.
        let dragging = false, lastX = 0, lastY = 0;
        function pointerDown(e) {
          dragging = true;
          const p = e.touches ? e.touches[0] : e;
          lastX = p.clientX; lastY = p.clientY;
        }
        function pointerMove(e) {
          if (!dragging) return;
          const p = e.touches ? e.touches[0] : e;
          panX += p.clientX - lastX;
          panY += p.clientY - lastY;
          lastX = p.clientX; lastY = p.clientY;
          draw();
          if (e.touches) e.preventDefault();
        }
        function pointerUp() { dragging = false; }
        els.canvas.addEventListener('mousedown', pointerDown);
        window.addEventListener('mousemove', pointerMove);
        window.addEventListener('mouseup', pointerUp);
        els.canvas.addEventListener('touchstart', pointerDown, { passive: true });
        window.addEventListener('touchmove', pointerMove, { passive: false });
        window.addEventListener('touchend', pointerUp);

        function onZoom() { zoom = Number(els.zoom.value) || 1; draw(); }
        function onRotate() {
          rotation = (rotation + 90) % 360;
          rotated = rotatedCanvasOf(img, rotation);
          panX = 0; panY = 0; zoom = 1; els.zoom.value = '1';
          draw();
        }
        function cleanup() {
          URL.revokeObjectURL(objectUrl);
          els.canvas.removeEventListener('mousedown', pointerDown);
          window.removeEventListener('mousemove', pointerMove);
          window.removeEventListener('mouseup', pointerUp);
          els.canvas.removeEventListener('touchstart', pointerDown);
          window.removeEventListener('touchmove', pointerMove);
          window.removeEventListener('touchend', pointerUp);
          els.zoom.removeEventListener('input', onZoom);
          els.rotateBtn.removeEventListener('click', onRotate);
          els.cancelBtn.removeEventListener('click', onCancel);
          els.saveBtn.removeEventListener('click', onSave);
          els.overlay.hidden = true;
        }
        function onCancel() { cleanup(); resolve(null); }
        function onSave() {
          // Re-render the same crop at a real export resolution (the
          // on-screen stage is deliberately small for a fast, smooth drag).
          const outW = Math.min(1600, Math.max(ratioW, 800));
          const outH = Math.round((outW * ratioH) / ratioW);
          const out = document.createElement('canvas');
          out.width = outW; out.height = outH;
          const octx = out.getContext('2d');
          const k = outW / stageW; // same crop rectangle, scaled up to export size
          const d = els._lastDraw;
          octx.drawImage(rotated, 0, 0, rotated.width, rotated.height, d.x * k, d.y * k, d.drawW * k, d.drawH * k);
          out.toBlob((blob) => { cleanup(); resolve(blob); }, 'image/jpeg', 0.9);
        }
        els.zoom.addEventListener('input', onZoom);
        els.rotateBtn.addEventListener('click', onRotate);
        els.cancelBtn.addEventListener('click', onCancel);
        els.saveBtn.addEventListener('click', onSave);
        els.overlay.hidden = false;
      };
      img.onerror = () => { URL.revokeObjectURL(objectUrl); resolve(null); };
      img.src = objectUrl;
    });
  }

  async function handleFileChosen(file, widget) {
    const ratioW = Number(widget.dataset.ratioW);
    const ratioH = Number(widget.dataset.ratioH);
    // Only fields that already declare a target ratio get the crop step —
    // see the file header for why this is safe to turn on universally.
    if (ratioW && ratioH && file.type.startsWith('image/') && file.type !== 'image/gif') {
      const cropped = await openCropper(file, ratioW, ratioH);
      if (!cropped) return; // cancelled — leave whatever was there before
      upload(cropped, widget, 'cropped.jpg');
      return;
    }
    checkDimensions(file, widget);
    upload(file, widget);
  }

  document.addEventListener('change', (e) => {
    const input = e.target.closest('.img-upload-input');
    if (!input) return;
    const widget = input.closest('.img-upload');
    if (widget && input.files && input.files[0]) {
      handleFileChosen(input.files[0], widget);
      input.value = ''; // lets choosing the SAME file again still fire 'change'
    }
  });

  // "Re-crop this image" — re-opens the cropper on the CURRENTLY uploaded
  // image (fetched back as a blob) rather than requiring a fresh file
  // pick, for the common case of "the crop just needs nudging."
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.img-upload-recrop');
    if (!btn) return;
    const widget = btn.closest('.img-upload');
    const url = valueOf(widget);
    const ratioW = Number(widget.dataset.ratioW);
    const ratioH = Number(widget.dataset.ratioH);
    if (!url || !ratioW || !ratioH) return;
    btn.disabled = true;
    try {
      const res = await fetch(url);
      const blob = await res.blob();
      const cropped = await openCropper(blob, ratioW, ratioH);
      if (cropped) upload(cropped, widget, 'cropped.jpg');
    } catch (err) {
      const status = widget.querySelector('.img-upload-status');
      status.textContent = 'Could not reload that image to re-crop it.';
      status.className = 'img-upload-status error';
    } finally {
      btn.disabled = false;
    }
  });

  window.UnplugUpload = { init, fieldHtml, valueOf };
})();
