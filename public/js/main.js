/* FirmLedger — progressive enhancement (site works fully without JS) */
(function () {
  'use strict';

  // ---- Reveal-on-scroll
  document.documentElement.classList.add('js');
  var rvEls = document.querySelectorAll('.rv');
  if (rvEls.length && 'IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -30px 0px' });
    rvEls.forEach(function (el) { io.observe(el); });
  } else {
    rvEls.forEach(function (el) { el.classList.add('in'); });
  }

  // ---- Mobile navigation
  var toggle = document.getElementById('menuBtn');
  var nav = document.getElementById('mobileNav');
  if (toggle && nav) toggle.addEventListener('click', function () {
    var open = nav.classList.toggle('open');
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  // ---- Clickable table rows
  document.querySelectorAll('tr.rowlink[data-href]').forEach(function (row) {
    row.addEventListener('click', function (e) {
      if (window.getSelection && String(window.getSelection()).length) return;
      if (e.target.closest('a, button, form')) return;
      window.location.href = row.getAttribute('data-href');
    });
  });

  // ---- Copy helpers
  function copyText(text, btn) {
    function done() {
      var original = btn.textContent;
      btn.textContent = 'Copied ✓';
      setTimeout(function () { btn.textContent = original; }, 1600);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, done);
    } else {
      var ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch (e) { /* noop */ }
      document.body.removeChild(ta); done();
    }
  }
  document.querySelectorAll('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      // With a selector: copy that element's text. Bare attribute: copy a
      // sibling input/textarea in the same row (badge snippets and similar).
      var sel = btn.getAttribute('data-copy');
      var el = sel ? document.querySelector(sel) : (btn.parentElement ? btn.parentElement.querySelector('textarea, input') : null);
      if (el) {
        var text = el.value !== undefined ? el.value : el.textContent;
        copyText(String(text).trim(), btn);
        if (el.select) { el.select(); }
      }
    });
  });
  document.querySelectorAll('[data-copy-val]').forEach(function (btn) {
    btn.addEventListener('click', function () { copyText(btn.getAttribute('data-copy-val'), btn); });
  });

  // ---- Live character counters (uniform field lengths)
  document.querySelectorAll('[data-count]').forEach(function (field) {
    var counter = document.querySelector('[data-count-for="' + field.name + '"]');
    if (!counter) return;
    var max = parseInt(field.getAttribute('maxlength'), 10) || 0;
    var min = parseInt(field.getAttribute('minlength'), 10) || 0;
    function paint() {
      var len = field.value.trim().length;
      counter.textContent = len + '/' + max;
      counter.classList.toggle('count-ok', len >= min && len <= max);
      counter.classList.toggle('count-warn', len > 0 && len < min);
    }
    field.addEventListener('input', paint);
    paint();
  });

  // ---- Fetch details from website (auto-fill)
  var fetchBtn = document.getElementById('fetchBtn');
  if (fetchBtn) {
    var status = document.getElementById('fetchStatus');
    fetchBtn.addEventListener('click', function () {
      var website = (document.getElementById('websiteInput') || {}).value || '';
      if (!website.trim()) { status.textContent = 'Enter a business name or website first.'; status.className = 'fetch-status err'; return; }
      fetchBtn.classList.add('loading');
      fetchBtn.textContent = 'Searching Wikipedia…';
      status.textContent = 'Looking up the Wikipedia article and Wikidata record…';
      status.className = 'fetch-status muted';
      var csrf = (document.querySelector('input[name="_csrf"]') || {}).value || '';
      fetch('/dashboard/fetch-details', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: '_csrf=' + encodeURIComponent(csrf) + '&website=' + encodeURIComponent(website),
      }).then(function (r) { return r.json(); }).then(function (data) {
        if (!data.ok) {
          status.textContent = data.error || 'Nothing usable found on that page.';
          status.className = 'fetch-status err';
          return;
        }
        var d = data.details, filled = [];
        function fill(id, value, label) {
          var el = document.getElementById(id) || document.querySelector('[name="' + id + '"]');
          if (el && value && !el.value.trim()) { el.value = value; el.dispatchEvent(new Event('input')); filled.push(label); }
        }
        fill('name', d.name, 'name');
        fill('descriptionInput', d.description, 'description');
        fill('logoUrl', d.logo_url, 'logo');
        fill('emailInput', d.email, 'email');
        fill('founded', d.founded, 'founded');
        fill('city', d.city, 'city');
        fill('country', d.country, 'country');
        // official website from Wikidata replaces a plain name typed in the fetch box
        if (d.website) {
          var wEl = document.getElementById('websiteInput');
          if (wEl && !/^https?:\/\/|[^\s]+\.[a-z]{2,}/i.test(wEl.value.trim())) {
            wEl.value = d.website; wEl.dispatchEvent(new Event('input')); filled.push('website');
          } else if (wEl && !wEl.value.trim()) {
            wEl.value = d.website; filled.push('website');
          }
        }
        // record the Wikipedia article as provenance
        if (d.source) { var es = document.getElementById('enrichSource'); if (es) es.value = d.source; }
        if (d.keywords) {
          var tags = document.querySelector('[name="tags"]');
          if (tags && !tags.value.trim()) {
            tags.value = d.keywords.split(',').slice(0, 5).map(function (s) { return s.trim(); }).filter(Boolean).join(', ');
            if (tags.value) filled.push('tags');
          }
        }
        Object.keys(d.socials || {}).forEach(function (k) { fill('social_' + k, d.socials[k], k); });
        // logo preview
        if (d.logo_url) {
          var prev = document.getElementById('logoPreview');
          var ph = document.getElementById('logoPlaceholder');
          if (prev && !prev.src) { prev.src = d.logo_url; prev.hidden = false; if (ph) ph.hidden = true; }
        }
        status.textContent = filled.length
          ? '✓ From Wikipedia: filled ' + filled.join(', ') + ' (only empty fields were touched; article saved as source)'
          : 'Article found and saved as source — your existing entries already cover what Wikipedia knows.';
        status.className = 'fetch-status ok';
      }).catch(function () {
        status.textContent = 'Request failed — check your connection and try again.';
        status.className = 'fetch-status err';
      }).finally(function () {
        fetchBtn.classList.remove('loading');
        fetchBtn.textContent = '⌁ Fetch from Wikipedia';
      });
    });
  }

  // ---- Logo URL preview (inputs are URL-only — no file uploads)
  var logoUrlInput = document.getElementById('logoUrl');
  if (logoUrlInput) {
    logoUrlInput.addEventListener('change', function () {
      var prev = document.getElementById('logoPreview');
      var ph = document.getElementById('logoPlaceholder');
      if (prev && /^https?:\/\//.test(logoUrlInput.value)) {
        prev.src = logoUrlInput.value;
        prev.hidden = false;
        if (ph) ph.hidden = true;
      }
    });
  }

  // ---- Name suggest (relationships + search boxes)
  document.querySelectorAll('input[data-suggest="names"]').forEach(function (input) {
    var box = document.createElement('ul');
    box.className = 'suggest-list';
    box.hidden = true;
    var wrap = input.closest('.suggest-box') || input.parentElement;
    wrap.style.position = 'relative';
    wrap.classList.add('suggest-box');
    input.parentNode.insertBefore(box, input.nextSibling);
    var timer = null;
    function hide() { box.hidden = true; }
    input.addEventListener('input', function () {
      clearTimeout(timer);
      var q = input.value.trim();
      if (q.length < 2) return hide();
      timer = setTimeout(function () {
        fetch('/suggest.json?q=' + encodeURIComponent(q))
          .then(function (r) { return r.json(); })
          .then(function (data) {
            box.innerHTML = '';
            if (!data.suggestions.length) return hide();
            data.suggestions.forEach(function (s) {
              var li = document.createElement('li');
              li.innerHTML = '<span></span><span class="suggest-cat"></span>';
              li.firstChild.textContent = s.name;
              li.lastChild.textContent = s.category;
              li.addEventListener('mousedown', function () { input.value = s.name; hide(); });
              box.appendChild(li);
            });
            box.hidden = false;
          })
          .catch(hide);
      }, 220);
    });
    input.addEventListener('blur', function () { setTimeout(hide, 150); });
  });
})();

// ---- FirmLedger UI: password fields (show/hide + match), professional toasts
(function () {
  'use strict';

  var EYE_ON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-7.5 11-7.5S23 12 23 12s-4 7.5-11 7.5S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  var EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 19.5C5 19.5 1 12 1 12a16.16 16.16 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4.5c7 0 11 7.5 11 7.5a16.5 16.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

  // attach show/hide toggle to any .pw-wrap input
  document.querySelectorAll('.pw-wrap').forEach(function (wrap) {
    var input = wrap.querySelector('input');
    if (!input || wrap.querySelector('.pw-eye')) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pw-eye';
    btn.setAttribute('aria-label', 'Show password');
    btn.setAttribute('aria-pressed', 'false');
    btn.innerHTML = '<span class="eye-on">' + EYE_ON + '</span><span class="eye-off">' + EYE_OFF + '</span>';
    btn.addEventListener('click', function () {
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      input.classList.toggle('pw-plain', show);
      wrap.classList.toggle('plain', show);
      btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      btn.setAttribute('aria-pressed', String(show));
      input.focus({ preventScroll: true });
    });
    wrap.appendChild(btn);
  });

  // password meter: input[data-pw-input] feeds the div whose id it names
  function pwScore(v) {
    var s = 0;
    if (v.length >= 8) s++;
    if (v.length >= 12) s++;
    if (/[a-z]/.test(v) && /[A-Z]/.test(v)) s++;
    if (/\d/.test(v) && /[^A-Za-z0-9]/.test(v)) s++;
    return Math.min(4, s);
  }
  var WORDS = ['Too short', 'Weak', 'Fair', 'Good', 'Strong'];
  document.querySelectorAll('[data-pw-input]').forEach(function (input) {
    var meter = document.getElementById(input.getAttribute('data-pw-input'));
    if (!meter) return;
    input.addEventListener('input', function () {
      var v = input.value;
      if (!v) { meter.innerHTML = ''; meter.style.display = 'none'; return; }
      meter.style.display = '';
      var s = v.length >= 8 ? pwScore(v) : 0;
      meter.innerHTML =
        '<div class="pw-gauge" data-score="' + s + '"><span></span><span></span><span></span><span></span></div>' +
        '<div class="pw-meter-label"></div>';
      meter.querySelector('.pw-meter-label').textContent =
        WORDS[s] + (s < 4 ? ' — ' + (s === 0 ? 'use at least 8 characters' : 'add numbers, symbols and mixed case for extra strength') : '');
    });
  });

  // confirm-password state: input[data-pw-confirm] compares to a target input id
  document.querySelectorAll('[data-pw-confirm]').forEach(function (input) {
    var target = document.getElementById(input.getAttribute('data-pw-confirm'));
    var note = document.getElementById(input.getAttribute('data-pw-note'));
    if (!target || !note) return;
    function check() {
      if (!input.value && !target.value) { note.className = 'pw-match'; note.textContent = ''; return; }
      var match = input.value === target.value;
      note.className = 'pw-match ' + (match ? 'ok' : 'bad');
      note.textContent = match ? '✓ Passwords match' : 'Passwords do not match';
      input.setCustomValidity(match ? '' : 'Passwords do not match');
    }
    input.addEventListener('input', check);
    target.addEventListener('input', check);
  });

  // professional toast popups replacing the flash bars
  var zone = document.createElement('div');
  zone.className = 'toast-zone';
  zone.setAttribute('aria-live', 'polite');
  document.body.appendChild(zone);
  function toast(kind, msg, title) {
    if (!msg) return;
    var el = document.createElement('div');
    el.className = 'toast toast-' + (kind === 'ok' ? 'ok' : 'err');
    var ico = kind === 'ok'
      ? '<span class="t-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>'
      : '<span class="t-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></span>';
    el.innerHTML = ico +
      '<div class="t-body"><div class="t-title">' + (title || (kind === 'ok' ? 'Done' : 'Something needs attention')) + '</div><div class="t-msg"></div></div>' +
      '<button type="button" class="t-x" aria-label="Dismiss"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>';
    el.querySelector('.t-msg').textContent = msg;
    zone.appendChild(el);
    var bar = document.createElement('span');
    bar.className = 't-bar';
    bar.style.animationDuration = '4500ms';
    el.appendChild(bar);
    function dismiss() {
      el.classList.add('leaving');
      setTimeout(function () { el.remove(); }, 320);
    }
    el.querySelector('.t-x').addEventListener('click', dismiss);
    setTimeout(dismiss, 4500);
  }
  window.__flToast = toast;
  // convert any inline flash alerts into toasts and remove the in-page boxes
  document.querySelectorAll('.flash-wrap .alert').forEach(function (box) {
    var kind = box.classList.contains('alert-ok') ? 'ok' : 'err';
    toast(kind, box.textContent.trim());
    box.closest('.flash-wrap').remove();
  });
})();

// ---- Auto-scrolling rails (Sponsored Content + Featured records): pause / play
// Both strips auto-scroll on CSS alone, so this is pure progressive enhancement —
// it only freezes the same animation for anyone who wants to read a card in place.
// `data-rail-target` picks the rail; it defaults to the sponsored strip.
(function () {
  'use strict';

  var ICO_PAUSE = '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';
  var ICO_PLAY = '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M8 5.2v13.6a1 1 0 0 0 1.53.85l10.6-6.8a1 1 0 0 0 0-1.7L9.53 4.35A1 1 0 0 0 8 5.2z"/></svg>';

  document.querySelectorAll('[data-rail-toggle]').forEach(function (btn) {
    var section = btn.closest('section');
    var rail = section ? section.querySelector(btn.getAttribute('data-rail-target') || '.sponsor-rail') : null;
    if (!rail) return;
    var ico = btn.querySelector('.sponsor-toggle-ico');
    var txt = btn.querySelector('.sponsor-toggle-txt');
    var what = btn.getAttribute('data-rail-label') || 'the sponsored listings scroll';
    btn.addEventListener('click', function () {
      var paused = rail.classList.toggle('is-paused');
      btn.setAttribute('aria-pressed', paused ? 'true' : 'false');
      btn.setAttribute('aria-label', paused
        ? 'Resume ' + what
        : 'Pause ' + what);
      if (ico) ico.innerHTML = paused ? ICO_PLAY : ICO_PAUSE;
      if (txt) txt.textContent = paused ? 'Play' : 'Pause';
    });
  });
})();
