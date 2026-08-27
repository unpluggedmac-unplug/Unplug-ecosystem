// Unplug — rendering an admin-built form.
//
// Drop a container anywhere and the form appears in it:
//
//   <div data-unplug-form="bursary-2026"></div>
//
// and /form/bursary-2026 renders the same definition as a page of its own.
// One definition, two placements — a link you can send, and a form at the
// bottom of the page that explains it.
//
// NAMED UnplugFormRender, NOT UnplugForms. window.UnplugForms already belongs
// to unplug-spam-forms.js, which supplies the honeypot and the form token to
// every form on this site. Taking that name would have silently disabled the
// spam protection on all of them, and the symptom would have been a rise in
// junk that nobody connected to a rename.
//
// BUILT WITH createElement AND textContent. Every label, option and help note
// is text an admin typed and is rendered on a public page.

window.UnplugFormRender = (function () {
  'use strict';

  function apiBase() {
    try {
      return (window.UnplugAPI && UnplugAPI.getApiBase && UnplugAPI.getApiBase())
        || localStorage.getItem('unplug_api_base')
        || 'https://unplug-ecosystem.onrender.com';
    } catch (e) {
      return 'https://unplug-ecosystem.onrender.com';
    }
  }

  function el(tag, text, style) {
    var node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (style) node.setAttribute('style', style);
    return node;
  }

  function note(container, text, bad) {
    container.textContent = '';
    container.appendChild(el('p', text,
      'padding:18px; color:' + (bad ? 'var(--red,#d20709)' : 'var(--slate,#454545)')
      + '; line-height:1.6; margin:0;'));
  }

  // One field. Returns { wrap, read } so the submit handler does not have to
  // know how each kind stores its answer.
  function buildField(field, formEl) {
    var id = 'uf-' + field.key + '-' + Math.random().toString(36).slice(2, 7);
    var wrap = el('div', null, 'margin-bottom:16px;');
    var input;

    if (field.kind === 'checkbox') {
      var row = el('label', null,
        'display:flex; gap:9px; align-items:flex-start; font-size:14px; line-height:1.5; cursor:pointer;');
      input = document.createElement('input');
      input.type = 'checkbox';
      input.id = id;
      input.style.marginTop = '3px';
      row.appendChild(input);
      row.appendChild(el('span', field.label + (field.required ? ' *' : '')));
      wrap.appendChild(row);
      if (field.help) wrap.appendChild(el('p', field.help,
        'font-size:12.5px; color:var(--slate,#454545); margin:5px 0 0 26px;'));
      return { wrap: wrap, read: function () { return input.checked; } };
    }

    var label = el('label', field.label + (field.required ? ' *' : ''),
      'display:block; font-size:13px; font-weight:700; margin-bottom:5px;');
    label.setAttribute('for', id);
    wrap.appendChild(label);

    if (field.kind === 'textarea') {
      input = document.createElement('textarea');
      input.rows = 5;
    } else if (field.kind === 'select') {
      input = document.createElement('select');
      var blank = el('option', field.placeholder || '— choose —');
      blank.value = '';
      input.appendChild(blank);
      (field.options || []).forEach(function (opt) {
        var o = el('option', opt);
        o.value = opt;
        input.appendChild(o);
      });
    } else if (field.kind === 'radio') {
      // A fieldset, so a screen reader announces the question before the
      // choices rather than reading five unlabelled buttons.
      var group = el('div', null, 'display:flex; flex-direction:column; gap:6px;');
      group.setAttribute('role', 'radiogroup');
      group.setAttribute('aria-label', field.label);
      var name = 'uf-radio-' + id;
      (field.options || []).forEach(function (opt) {
        var row2 = el('label', null, 'display:flex; gap:8px; align-items:center; font-size:14px; cursor:pointer;');
        var radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = name;
        radio.value = opt;
        row2.appendChild(radio);
        row2.appendChild(el('span', opt));
        group.appendChild(row2);
      });
      wrap.appendChild(group);
      if (field.help) wrap.appendChild(el('p', field.help,
        'font-size:12.5px; color:var(--slate,#454545); margin:5px 0 0;'));
      return {
        wrap: wrap,
        read: function () {
          var picked = group.querySelector('input:checked');
          return picked ? picked.value : '';
        },
      };
    } else if (field.kind === 'file') {
      input = document.createElement('input');
      input.type = 'file';
    } else {
      input = document.createElement('input');
      input.type = field.kind === 'email' ? 'email'
        : field.kind === 'phone' ? 'tel'
          : field.kind === 'number' ? 'number'
            : field.kind === 'date' ? 'date' : 'text';
    }

    input.id = id;
    if (field.placeholder && input.tagName !== 'SELECT') input.placeholder = field.placeholder;
    if (field.maxLength && input.tagName !== 'SELECT') input.maxLength = field.maxLength;
    if (field.required) input.required = true;
    input.style.cssText = 'width:100%; max-width:520px;';
    wrap.appendChild(input);
    if (field.help) wrap.appendChild(el('p', field.help,
      'font-size:12.5px; color:var(--slate,#454545); margin:5px 0 0;'));

    // A file field uploads immediately and keeps the resulting URL, so the
    // submission carries an address rather than the bytes — the upload
    // endpoint already exists, needs a member, and checks the actual bytes.
    if (field.kind === 'file') {
      var stored = '';
      var status = el('p', '', 'font-size:12.5px; margin:5px 0 0; min-height:16px;');
      wrap.appendChild(status);
      input.addEventListener('change', function () {
        var file = input.files && input.files[0];
        if (!file) { stored = ''; return; }
        var token = window.UnplugAPI && UnplugAPI.getToken && UnplugAPI.getToken();
        if (!token) {
          status.style.color = 'var(--red,#d20709)';
          status.textContent = 'Sign in as a member to attach a file.';
          input.value = '';
          return;
        }
        status.style.color = 'var(--slate,#454545)';
        status.textContent = 'Uploading…';
        var body = new FormData();
        body.append('file', file);
        fetch(apiBase() + '/uploads', {
          method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: body,
        })
          .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
          .then(function (res) {
            if (!res.ok) throw new Error(res.d.error || 'That upload did not work.');
            stored = res.d.url;
            status.textContent = 'Attached.';
          })
          .catch(function (err) {
            stored = '';
            status.style.color = 'var(--red,#d20709)';
            status.textContent = err.message;
          });
      });
      return { wrap: wrap, read: function () { return stored; } };
    }

    return { wrap: wrap, read: function () { return input.value.trim(); } };
  }

  function render(container, slug) {
    if (!container || !slug) return;
    note(container, 'Loading…');

    fetch(apiBase() + '/forms/' + encodeURIComponent(slug))
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok) { note(container, res.d.error || 'That form is not available.', true); return; }
        var form = res.d;

        // A closed form says so, in its own words. This is the common case for
        // a link somebody kept — not an error, just late.
        if (!form.open) {
          container.textContent = '';
          container.appendChild(el('h2', form.title, 'font-size:22px; margin:0 0 8px;'));
          container.appendChild(el('p', form.message,
            'color:var(--slate,#454545); line-height:1.6; margin:0;'));
          return;
        }

        container.textContent = '';
        container.appendChild(el('h2', form.title, 'font-size:24px; margin:0 0 8px;'));
        if (form.intro) {
          container.appendChild(el('p', form.intro,
            'color:var(--slate,#454545); line-height:1.65; margin:0 0 20px;'));
        }

        var formEl = document.createElement('form');
        formEl.setAttribute('novalidate', '');
        var readers = {};

        form.fields.forEach(function (field) {
          var built = buildField(field, formEl);
          readers[field.key] = built.read;
          formEl.appendChild(built.wrap);
        });

        if (form.requiresMember && !(window.UnplugAPI && UnplugAPI.getToken && UnplugAPI.getToken())) {
          // Said BEFORE the fields are filled in, not after. Finding out at the
          // submit button that the whole thing needed an account is the most
          // annoying possible moment to learn it.
          formEl.insertBefore(el('p',
            'This form asks for a file, so you will need to be signed in as an Unplug member to send it.',
            'font-size:13px; color:var(--red,#d20709); margin:0 0 16px;'), formEl.firstChild);
        }

        var msg = el('p', '', 'font-size:13.5px; margin:12px 0 0; min-height:18px;');
        var submit = el('button', 'Send');
        submit.type = 'submit';
        submit.className = 'btn btn-solid';
        submit.style.cssText = 'width:auto;';
        formEl.appendChild(submit);
        formEl.appendChild(msg);

        // The honeypot from the site's own spam protection, rather than a
        // second one of my own.
        if (window.UnplugForms && UnplugForms.attachHoneypot) UnplugForms.attachHoneypot(formEl);

        formEl.addEventListener('submit', function (e) {
          e.preventDefault();
          var answers = {};
          Object.keys(readers).forEach(function (key) { answers[key] = readers[key](); });

          submit.disabled = true;
          var was = submit.textContent;
          submit.textContent = 'Sending…';
          msg.style.color = 'var(--slate,#454545)';
          msg.textContent = '';

          var payload = { answers: answers };
          if (window.UnplugForms && UnplugForms.decorate) payload = UnplugForms.decorate(payload);
          var hp = formEl.querySelector('input[name="website"]');
          if (hp) payload.website = hp.value;

          var headers = { 'Content-Type': 'application/json' };
          var token = window.UnplugAPI && UnplugAPI.getToken && UnplugAPI.getToken();
          if (token) headers.Authorization = 'Bearer ' + token;

          fetch(apiBase() + '/forms/' + encodeURIComponent(slug), {
            method: 'POST', headers: headers, body: JSON.stringify(payload),
          })
            .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
            .then(function (res2) {
              if (!res2.ok) throw new Error(res2.d.error || 'That did not send.');
              // The form is replaced by the thank-you rather than left on
              // screen with a note under it — an empty form after a successful
              // send invites somebody to fill it in twice.
              container.textContent = '';
              container.appendChild(el('h2', 'Thank you', 'font-size:22px; margin:0 0 8px;'));
              container.appendChild(el('p', res2.d.message,
                'color:var(--slate,#454545); line-height:1.6; margin:0;'));
            })
            .catch(function (err) {
              submit.disabled = false;
              submit.textContent = was;
              msg.style.color = 'var(--red,#d20709)';
              msg.textContent = err.message;
            });
        });

        container.appendChild(formEl);
      })
      .catch(function () { note(container, 'That form could not be loaded.', true); });
  }

  function attachAll() {
    var nodes = document.querySelectorAll('[data-unplug-form]');
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].dataset.unplugFormRendered === '1') continue;
      nodes[i].dataset.unplugFormRendered = '1';
      render(nodes[i], nodes[i].getAttribute('data-unplug-form'));
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attachAll);
  } else {
    attachAll();
  }

  return { render: render, attachAll: attachAll };
})();
