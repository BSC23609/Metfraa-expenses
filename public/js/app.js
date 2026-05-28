// ====================================================================
//  BHARAT STEEL GROUP · EXPENSE PORTAL — FRONTEND
// ====================================================================
//  Single-page app. State is held in memory; the server is the source
//  of truth for policy & rates. Uploads are decoupled via an
//  upload_token (UUID generated when a form opens).
// ====================================================================

(() => {
  'use strict';

  // ----- State ----------------------------------------------------
  const state = {
    user: null,              // { name, email, company, level, … }
    policy: null,            // pulled from /api/policy/me
    company: null,           // current company being acted on (always === user.company in this build)
    currentForm: null,       // 'bsc_conveyance' | 'bsc_expense' | 'met_local' | ...
    formData: null,          // form-specific working data
    uploadToken: null,
    uploads: [],             // [{id, filename, mime_type, size_bytes}]
    lastSubmission: null,    // result from a successful submit
    isAdmin: false,          // controls admin panel visibility
    adminEmployees: [],      // cached employee list for the admin panel
    adminPending: [],        // pending submissions
    adminSubmissions: [],    // all submissions
    currentPage: null,       // for the global Back button history
  };

  // ----- Constants ------------------------------------------------
  const COMPANY_LOGOS = {
    bsc: '/assets/bsc-logo.png',
    metfraa: '/assets/metfraa-logo.png',
  };

  const FORM_DEFS = {
    bsc: [
      { key: 'bsc_conveyance', title: 'Local Travel Conveyance', desc: 'Reimbursement for official local travel using personal vehicle.', icon: 'bike' },
      { key: 'bsc_expense',    title: 'Travel Expense Reimbursement', desc: 'Outstation business travel — accommodation, food, conveyance & other costs.', icon: 'briefcase' },
    ],
    metfraa: [
      { key: 'met_local',         title: 'Local Travel Allowance',           desc: 'Site / official travel using personal vehicle.', icon: 'bike' },
      { key: 'met_cab',           title: 'Cab Reimbursement',                 desc: 'Cab / taxi fare reimbursement for trips of 80 km or more.', icon: 'taxi' },
      { key: 'met_accommodation', title: 'Monthly Accommodation Reimbursement', desc: 'Site accommodation reimbursement.', icon: 'building' },
      { key: 'met_outstation',    title: 'Outstation Travel Reimbursement',  desc: 'Inter-city official travel.', icon: 'briefcase' },
      { key: 'met_misc',          title: 'Miscellaneous Reimbursements',      desc: 'Any other work expense — date, purpose, amount + bill.', icon: 'receipt' },
    ],
  };

  const ICONS = {
    bike: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="5.5" cy="17.5" r="3.5"/><circle cx="18.5" cy="17.5" r="3.5"/><path d="M15 6h3l-4 8-3-5-3 4"/></svg>',
    taxi: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 4h8l3 5H5l3-5z"/><path d="M3 14h18v4H3z"/><circle cx="7" cy="18" r="1.5" fill="currentColor"/><circle cx="17" cy="18" r="1.5" fill="currentColor"/><path d="M10 4V2h4v2"/></svg>',
    building: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="3" width="16" height="18"/><path d="M9 8h2M13 8h2M9 12h2M13 12h2M9 16h2M13 16h2"/></svg>',
    briefcase: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="7" width="18" height="13" rx="1"/><path d="M9 7V5a2 2 0 012-2h2a2 2 0 012 2v2M3 13h18"/></svg>',
    receipt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 2v20l2-1.5L8 22l2-1.5L12 22l2-1.5L16 22l2-1.5L20 22V2l-2 1.5L16 2l-2 1.5L12 2l-2 1.5L8 2 6 3.5 4 2z"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>',
    policy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M9 13h6M9 17h6M9 9h2"/></svg>',
    arrow: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M13 5l7 7-7 7"/></svg>',
  };

  // ----- DOM helpers ----------------------------------------------
  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const el = (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k === 'style') node.style.cssText = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v === true) node.setAttribute(k, '');
      else if (v != null && v !== false) node.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      node.append(c.nodeType ? c : document.createTextNode(c));
    }
    return node;
  };

  function fmt(n) {
    return Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function uuid() {
    // RFC4122 v4ish
    return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
      (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
    );
  }

  function toast(msg, type = '') {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast show ' + type;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.classList.remove('show'); }, 3600);
  }

  function showLoading(text = 'Working…') {
    $('#loadingText').textContent = text;
    $('#loadingOverlay').classList.add('show');
  }
  function hideLoading() { $('#loadingOverlay').classList.remove('show'); }

  function confirmModal({ title, body, recipient, confirmText = 'Confirm' }) {
    return new Promise(resolve => {
      $('#modalTitle').textContent = title;
      $('#modalBody').textContent = body;
      const r = $('#modalRecipient');
      if (recipient) { r.textContent = recipient; r.style.display = 'block'; }
      else { r.style.display = 'none'; }
      $('#modalConfirm').textContent = confirmText;
      const bk = $('#modalBackdrop');
      bk.classList.add('show');
      const done = (v) => {
        bk.classList.remove('show');
        $('#modalConfirm').onclick = null;
        $('#modalCancel').onclick  = null;
        resolve(v);
      };
      $('#modalConfirm').onclick = () => done(true);
      $('#modalCancel').onclick  = () => done(false);
    });
  }

  // Like confirmModal, but with a free-text input. Resolves to the entered
  // string (possibly empty) on confirm, or null on cancel.
  function promptModal({ title, body, placeholder = '', confirmText = 'Confirm' }) {
    return new Promise(resolve => {
      $('#modalTitle').textContent = title;
      $('#modalBody').textContent = body;
      const r = $('#modalRecipient');
      r.style.display = 'block';
      r.innerHTML = '';
      const input = el('input', {
        type: 'text', placeholder,
        style: 'width:100%;font-family:Inter,sans-serif;font-size:14px;padding:11px 14px;border:1px solid var(--bsg-line);border-radius:3px;background:#fff;',
      });
      r.appendChild(input);
      $('#modalConfirm').textContent = confirmText;
      const bk = $('#modalBackdrop');
      bk.classList.add('show');
      setTimeout(() => input.focus(), 50);
      const done = (v) => {
        bk.classList.remove('show');
        $('#modalConfirm').onclick = null;
        $('#modalCancel').onclick  = null;
        r.innerHTML = '';
        r.style.display = 'none';
        resolve(v);
      };
      $('#modalConfirm').onclick = () => done(input.value.trim());
      $('#modalCancel').onclick  = () => done(null);
    });
  }

  // ----- Submission viewer (in-app popup, data from DB) -----------
  let viewCurrentId = null;
  async function viewSubmission(id) {
    viewCurrentId = id;
    const bk = $('#viewBackdrop');
    $('#viewBody').innerHTML = '<div style="padding:40px;text-align:center;color:var(--bsg-muted);">Loading…</div>';
    bk.classList.add('show');
    try {
      const { submission: s } = await api(`/api/submissions/${id}`);
      $('#viewRef').textContent = s.reference;
      $('#viewTitle').textContent = FORM_LABEL[s.form_type] || s.form_type;
      const pill = $('#viewStatus');
      pill.textContent = s.status;
      pill.className = 'status-pill ' + s.status;
      $('#viewBody').innerHTML = '';
      $('#viewBody').appendChild(renderSubmissionDetail(s));
    } catch (err) {
      $('#viewBody').innerHTML = `<div style="padding:30px;color:var(--bsg-danger);">${err.message || 'Could not load submission.'}</div>`;
    }
  }

  function detailRow(label, value) {
    return el('div', { class: 'vd-cell' },
      el('div', { class: 'vd-label' }, label),
      el('div', { class: 'vd-value' }, value == null || value === '' ? '—' : String(value))
    );
  }

  function renderSubmissionDetail(s) {
    const wrap = el('div', { class: 'view-detail' });
    const p = s.payload || {};

    // Meta grid
    const meta = el('div', { class: 'vd-grid' },
      detailRow('Employee', s.employee.name),
      detailRow('Code', s.employee.code),
      detailRow('Level', s.employee.level),
      detailRow('Period', p.period || s.period),
      detailRow('Submitted', fmtDateShort(s.submitted_at)),
      detailRow('Status', s.status.charAt(0).toUpperCase() + s.status.slice(1)),
    );
    wrap.appendChild(meta);
    if (s.reviewed_by) {
      wrap.appendChild(el('div', { class: 'vd-review' },
        `${s.status === 'approved' ? 'Approved' : 'Reviewed'} by ${s.reviewed_by}${s.reviewed_at ? ' · ' + fmtDateShort(s.reviewed_at) : ''}${s.review_note ? ' · "' + s.review_note + '"' : ''}`
      ));
    }

    // Line items table per form type
    const t = el('table', { class: 'vd-table' });
    const head = (cols) => t.appendChild(el('thead', {}, el('tr', {}, ...cols.map(c => el('th', {}, c)))));
    const body = el('tbody');
    const money = (n) => '₹ ' + fmt(parseFloat(n) || 0);

    if (s.form_type === 'met_local' || s.form_type === 'bsc_conveyance') {
      head(['Date', 'From', 'To', 'Purpose', 'KM', 'Amount']);
      (p.trips || []).forEach(tr => body.appendChild(el('tr', {},
        el('td', {}, formatDate(tr.date)), el('td', {}, tr.from || '—'), el('td', {}, tr.to || '—'),
        el('td', {}, tr.purpose || '—'), el('td', { class: 'num' }, tr.km), el('td', { class: 'num' }, money(tr.amount))
      )));
    } else if (s.form_type === 'met_cab') {
      head(['Date', 'Pickup', 'Drop', 'Distance', 'Fare', 'Purpose']);
      (p.rides || []).forEach(r => body.appendChild(el('tr', {},
        el('td', {}, formatDate(r.date)), el('td', {}, r.pickup || '—'), el('td', {}, r.drop || '—'),
        el('td', { class: 'num' }, `${r.km || '—'} km`), el('td', { class: 'num' }, money(r.fare)), el('td', {}, r.purpose || '—')
      )));
    } else if (s.form_type === 'met_misc') {
      head(['Date', 'Purpose', 'Amount']);
      (p.items || []).forEach(it => body.appendChild(el('tr', {},
        el('td', {}, formatDate(it.date)), el('td', {}, it.purpose || '—'), el('td', { class: 'num' }, money(it.amount))
      )));
    } else if (s.form_type === 'met_accommodation') {
      head(['Date', 'Location', 'Hotel', 'Bill #', 'Amount']);
      (p.entries || []).forEach(e => body.appendChild(el('tr', {},
        el('td', {}, formatDate(e.date)), el('td', {}, e.location || '—'), el('td', {}, e.hotel || '—'),
        el('td', {}, e.bill_no || '—'), el('td', { class: 'num' }, money(e.amount))
      )));
    } else if (s.form_type === 'met_outstation' || s.form_type === 'bsc_expense') {
      head(['Trip', 'Category', 'Date', 'Description', 'Amount']);
      (p.trips || []).forEach(trip => {
        Object.entries(trip.categories || {}).forEach(([cat, arr]) => {
          (arr || []).forEach(it => {
            if (!(parseFloat(it.amount) > 0) && !it.desc) return;
            body.appendChild(el('tr', {},
              el('td', {}, trip.place || '—'),
              el('td', {}, cat.charAt(0).toUpperCase() + cat.slice(1)),
              el('td', {}, formatDate(it.date)), el('td', {}, it.desc || '—'),
              el('td', { class: 'num' }, money(it.amount))
            ));
          });
        });
      });
    }
    t.appendChild(body);
    wrap.appendChild(t);

    // Total
    wrap.appendChild(el('div', { class: 'vd-total' },
      el('span', {}, 'Total Reimbursement Claim'),
      el('strong', {}, money(s.total_amount))
    ));

    // Attachments — clickable to open the actual bill inline
    if (s.attachments && s.attachments.length) {
      const att = el('div', { class: 'vd-attachments' },
        el('div', { class: 'vd-label' }, `${s.attachments.length} Bill${s.attachments.length === 1 ? '' : 's'} Attached — click to view`)
      );
      s.attachments.forEach(a => {
        att.appendChild(el('a', {
          class: 'vd-chip vd-chip-link',
          href: `/api/submissions/${s.id}/attachment/${a.id}`,
          target: '_blank', rel: 'noopener',
          title: 'Open bill in a new tab',
        },
          el('span', { html: ICONS.receipt || '' , class: 'vd-chip-ico' }),
          a.filename
        ));
      });
      wrap.appendChild(att);
    }
    return wrap;
  }

  // ----- API ------------------------------------------------------
  async function api(path, opts = {}) {
    const res = await fetch(path, {
      credentials: 'same-origin',
      headers: opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {},
      ...opts,
    });
    if (res.status === 401) {
      window.location.href = '/login';
      throw new Error('Not authenticated');
    }
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : await res.text();
    if (!res.ok) {
      const msg = (data && data.error) || `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return data;
  }

  // ----- Boot -----------------------------------------------------
  async function boot() {
    try {
      const me = await api('/auth/me');
      state.user = me.user;
      state.company = me.user.company;

      const p = await api('/api/policy/me');
      state.policy = p.policy;

      // Is this user an admin? (controls visibility of the admin panel)
      try {
        const who = await api('/api/admin/whoami');
        state.isAdmin = !!who.is_admin;
      } catch (_) { state.isAdmin = false; }

      renderTopbar();
      // Metfraa-only: skip the company picker, go straight to the hub.
      route('hub');
    } catch (err) {
      console.error('Boot failed:', err);
      toast(err.message || 'Failed to load', 'error');
    }
  }

  function renderTopbar() {
    const u = state.user;
    $('#userName').textContent = u.name;
    $('#umName').textContent = u.name;
    $('#umEmail').textContent = u.email;
    if (u.level) {
      const levelName = { L1: 'Junior', L2: 'Senior', L3: 'Manager' }[u.level] || u.level;
      $('#umLevel').textContent = `METFRAA · ${String(levelName).toUpperCase()} (${u.level})`;
    } else {
      // Admin-only user (in ADMIN_EMAILS but not an employee) — no level.
      $('#umLevel').textContent = 'METFRAA · ADMINISTRATOR';
    }
    const initials = (u.name || '').split(/\s+/).filter(Boolean).slice(0, 2).map(s => s[0]).join('').toUpperCase();
    $('#userAvatar').textContent = initials || '·';

    // Inject the Admin menu item once, if the user is an admin.
    if (state.isAdmin && !$('#adminMenuBtn')) {
      const menu = $('#userMenu');
      const btn = el('button', { id: 'adminMenuBtn', type: 'button',
        style: 'width:100%;background:transparent;border:1px solid var(--bsg-line);padding:9px 12px;font-family:JetBrains Mono,monospace;font-size:11px;letter-spacing:0.12em;text-transform:uppercase;cursor:pointer;border-radius:2px;color:var(--bsg-text);margin-bottom:8px;transition:all .2s ease;',
        onclick: (e) => { e.stopPropagation(); $('#userMenu').classList.remove('open'); route('admin'); }
      }, 'Admin Panel');
      btn.addEventListener('mouseenter', () => { btn.style.background = 'var(--bsg-ink)'; btn.style.color = 'white'; btn.style.borderColor = 'var(--bsg-ink)'; });
      btn.addEventListener('mouseleave', () => { btn.style.background = 'transparent'; btn.style.color = 'var(--bsg-text)'; btn.style.borderColor = 'var(--bsg-line)'; });
      // place above the logout form
      const form = menu.querySelector('form');
      menu.insertBefore(btn, form);
    }
  }

  function setCompanyLogoInTopbar(show) {
    const div = $('#tbDivider');
    const logo = $('#tbCompanyLogo');
    if (show && state.company) {
      logo.src = COMPANY_LOGOS[state.company];
      logo.style.display = '';
      div.style.display = '';
    } else {
      logo.style.display = 'none';
      div.style.display = 'none';
    }
  }

  // ----- Router ---------------------------------------------------
  const routes = {
    landing:     renderHub,   // Metfraa-only: 'landing' collapses into the hub
    hub:         renderHub,
    history:     renderHistory,
    eligibility: renderEligibility,
    form:        renderForm,
    preview:     renderPreview,
    success:     renderSuccess,
    admin:       renderAdmin,
  };

  // Navigation history for the global Back button.
  const navHistory = [];

  function route(name, opts = {}) {
    // Metfraa-only: redirect any 'landing' nav to the hub.
    if (name === 'landing') name = 'hub';

    // Maintain a simple back-stack. Don't push duplicates or back-nav itself.
    if (!opts._back) {
      const current = state.currentPage;
      if (current && current !== name) navHistory.push(current);
    }
    state.currentPage = name;

    $$('.page').forEach(p => p.classList.remove('active'));
    const page = $('#page-' + name);
    if (!page) return;
    page.classList.add('active');
    setCompanyLogoInTopbar(true);

    // Show Back everywhere except the hub (home). Hidden when nothing to go back to.
    const backBtn = $('#backBtn');
    if (backBtn) backBtn.style.display = (name !== 'hub' && navHistory.length) ? 'inline-flex' : 'none';

    if (routes[name]) routes[name](opts);
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  function goBack() {
    const prev = navHistory.pop();
    route(prev || 'hub', { _back: true });
  }

  // ===================================================================
  //  LANDING — company picker (only user's company is enabled)
  // ===================================================================
  function renderLanding() {
    const grid = $('#companyGrid');
    grid.innerHTML = '';
    const all = [
      { key: 'bsc',     name: 'Bharat Steel' },
      { key: 'metfraa', name: 'Metfraa Steel Buildings' },
    ];
    for (const c of all) {
      const allowed = c.key === state.user.company;
      const card = el('div', { class: 'company-card' + (allowed ? '' : ' disabled'), title: allowed ? `Enter ${c.name}` : `You are not registered as a ${c.name} employee` });
      if (!allowed) {
        card.appendChild(el('div', { class: 'locked-pill' }, 'Locked'));
      }
      card.appendChild(el('div', { class: 'logo-area' }, el('img', { src: COMPANY_LOGOS[c.key], alt: c.name })));
      if (allowed) {
        card.addEventListener('click', () => {
          state.company = c.key;
          route('hub');
        });
      }
      grid.appendChild(card);
    }
  }

  // ===================================================================
  //  HUB — form options + Check Eligibility
  // ===================================================================
  async function renderHistory() {
    const tbody = $('#historyTableBody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--bsg-muted);padding:24px;">Loading…</td></tr>';
    try {
      const res = await api('/api/submissions');
      const rows = res.submissions || [];
      tbody.innerHTML = '';
      if (!rows.length) {
        tbody.appendChild(el('tr', {}, el('td', { colspan: 7, style: 'text-align:center;color:var(--bsg-muted);padding:32px;' }, 'No submissions yet.')));
        return;
      }
      for (const s of rows) {
        tbody.appendChild(el('tr', {},
          el('td', {}, el('strong', {}, s.reference)),
          el('td', {}, FORM_LABEL[s.form_type] || s.form_type),
          el('td', {}, s.period || '—'),
          el('td', { class: 'num', style: 'text-align:right;' }, '₹ ' + fmt(s.total_amount)),
          el('td', {}, el('span', { class: 'status-pill ' + s.status }, s.status)),
          el('td', {}, fmtDateShort(s.submitted_at)),
          el('td', {}, el('div', { class: 'admin-actions' },
            el('button', { class: 'view', onclick: () => viewSubmission(s.id) }, 'View')
          ))
        ));
      }
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--bsg-danger);padding:24px;">${err.message || 'Failed to load'}</td></tr>`;
    }
  }

  function renderHub() {
    const policy = state.policy;
    $('#hubTitle').textContent = policy ? policy.name : '';
    const grid = $('#optionGrid');
    grid.innerHTML = '';

    // Admin-only users (in ADMIN_EMAILS but not an employee) have no level
    // and can't file claims as themselves — point them at the admin panel.
    if (state.user && !state.user.level) {
      grid.appendChild(
        el('div', { class: 'option-card', onclick: () => route('admin') },
          el('div', { class: 'icon-wrap', html: ICONS.briefcase || '' }),
          el('h3', {}, 'Admin Panel'),
          el('p', {}, 'Review pending claims, manage employees, and view all submissions.'),
          el('div', { class: 'arrow' }, el('span', {}, 'Open'), el('div', { html: ICONS.arrow }))
        )
      );
      return;
    }

    const defs = FORM_DEFS[state.company] || [];

    for (const def of defs) {
      grid.appendChild(
        el('div', { class: 'option-card', onclick: () => openForm(def.key) },
          el('div', { class: 'icon-wrap', html: ICONS[def.icon] || ICONS.briefcase }),
          el('h3', {}, def.title),
          el('p', {}, def.desc),
          el('div', { class: 'arrow' },
            el('span', {}, 'Open'),
            el('div', { html: ICONS.arrow })
          )
        )
      );
    }
    // My Submissions card
    grid.appendChild(
      el('div', { class: 'option-card', onclick: () => route('history') },
        el('div', { class: 'icon-wrap', html: ICONS.receipt || ICONS.briefcase }),
        el('h3', {}, 'My Submissions'),
        el('p', {}, 'View your past claims and their approval status.'),
        el('div', { class: 'arrow' }, el('span', {}, 'View'), el('div', { html: ICONS.arrow }))
      )
    );
    // Eligibility card last
    grid.appendChild(
      el('div', { class: 'option-card eligibility', onclick: () => route('eligibility') },
        el('div', { class: 'icon-wrap', html: ICONS.policy }),
        el('h3', {}, 'Check Eligibility'),
        el('p', {}, 'See your entitlements, rates, and the full policy applicable to your level.'),
        el('div', { class: 'arrow' },
          el('span', {}, 'View'),
          el('div', { html: ICONS.arrow })
        )
      )
    );
  }

  // ===================================================================
  //  ELIGIBILITY — handled by policy-renderer.js
  // ===================================================================
  function renderEligibility() {
    if (window.renderPolicyDoc) {
      window.renderPolicyDoc($('#policyContent'), state.policy, state.user.level);
    }
  }

  // ===================================================================
  //  FORM — branches by form type
  // ===================================================================
  function openForm(formKey) {
    state.currentForm = formKey;
    state.formData = initFormData(formKey);
    state.uploadToken = uuid();
    state.uploads = [];
    route('form');
  }

  function initFormData(formKey) {
    const today = new Date();
    const period = today.toISOString().slice(0, 7); // YYYY-MM (most forms)
    const emptyExpenseTrip = () => ({
      place: '', from_date: '', to_date: '', purpose: '',
      categories: {
        accommodation: [{ date: '', desc: '', amount: '' }],
        food:          [{ date: '', desc: '', amount: '' }],
        conveyance:    [{ date: '', desc: '', amount: '' }],
        others:        [{ date: '', desc: '', amount: '' }],
      }
    });
    const emptyOutstationTrip = () => ({
      place: '', from_date: '', to_date: '', purpose: '', manager_approval: '',
      categories: {
        travel:           [{ date: '', desc: '', amount: '' }],
        accommodation:    [{ date: '', desc: '', amount: '' }],
        food:             [{ date: '', desc: '', amount: '' }],
        local_conveyance: [{ date: '', desc: '', amount: '' }],
        others:           [{ date: '', desc: '', amount: '' }],
      }
    });

    switch (formKey) {
      case 'bsc_conveyance':
      case 'met_local':
        return {
          period, vehicle_type: 'bike', vehicle_reg: '',
          trips: [{ date: '', from: '', to: '', purpose: '', km: '' }],
        };
      case 'bsc_expense':
        return { period, manager: '', trips: [emptyExpenseTrip()] };
      case 'met_cab':
        return {
          period,
          rides: [{ date: '', time: '', pickup: '', drop: '', km: '', fare: '', passengers: 1, purpose: '', notes: '' }],
        };
      case 'met_accommodation':
        return {
          period,
          entries: [{ date: '', location: '', hotel: '', bill_no: '', amount: '' }],
        };
      case 'met_outstation':
        return { period, trips: [emptyOutstationTrip()] };
      case 'met_misc':
        return { period, items: [{ date: '', purpose: '', amount: '' }] };
    }
  }

  // -- form titles
  const FORM_TITLES = {
    bsc_conveyance: 'Local Travel Conveyance',
    bsc_expense:    'Travel Expense Reimbursement',
    met_local:      'Local Travel Allowance',
    met_cab:        'Cab Reimbursement',
    met_accommodation: 'Monthly Accommodation Reimbursement',
    met_outstation: 'Outstation Travel Reimbursement',
    met_misc:       'Miscellaneous Reimbursements',
  };

  function renderForm() {
    $('#formTitle').textContent = FORM_TITLES[state.currentForm] || 'Form';
    const body = $('#formBody');
    body.innerHTML = '';

    // entitlement banner per form
    renderEntitlementBanner();

    // Cab is now a reimbursement (has a total + bills), so show both.
    $('#uploadSection').style.display = '';
    $('#summaryBar').style.display = '';

    switch (state.currentForm) {
      case 'bsc_conveyance': renderConveyanceForm(body, 'bsc'); break;
      case 'met_local':      renderConveyanceForm(body, 'metfraa'); break;
      case 'bsc_expense':    renderExpenseForm(body, 'bsc'); break;
      case 'met_outstation': renderExpenseForm(body, 'metfraa'); break;
      case 'met_cab':        renderCabForm(body); break;
      case 'met_misc':       renderMiscForm(body); break;
      case 'met_accommodation': renderAccommodationForm(body); break;
    }

    refreshUploadList();
    updateSummary();

    // Bind submit/preview
    $('#previewBtn').onclick = () => { if (validateForm()) route('preview'); };
    $('#submitBtn').onclick  = () => submitForm();

    bindUploadZone();
  }

  function renderEntitlementBanner() {
    const banner = $('#entitlementBanner');
    banner.innerHTML = '';
    const lvl = state.user.level;
    let label = '', value = '';
    const F = state.currentForm;
    if (F === 'bsc_conveyance') {
      label = 'Rates';
      value = 'Bike <strong>₹3.5/km</strong>  ·  Car <strong>₹5/km</strong>';
    } else if (F === 'met_local') {
      label = 'Rates';
      value = 'Bike <strong>₹4/km</strong>  ·  Car <strong>₹10/km</strong>  ·  Min trip <strong>5 km</strong>  ·  Car only for <strong>80 km+</strong>';
    } else if (F === 'bsc_expense') {
      const e = state.policy.forms.expense.per_level[lvl];
      if (e) value = `Food <strong>₹${fmt(e.food_per_day)}/day</strong>  ·  Accom <strong>₹${fmt(e.accommodation_per_day)}/day</strong>  ·  ${e.long_distance.join(' / ')}`;
      label = `Category ${lvl} entitlement`;
    } else if (F === 'met_outstation') {
      const e = state.policy.forms.outstation.per_level[lvl];
      if (e) value = `Train <strong>${e.train}</strong>  ·  Bus <strong>${e.bus}</strong>  ·  Food up to <strong>₹${fmt(e.food_per_day)}/day</strong>`;
      label = `Level ${lvl} entitlement`;
    } else if (F === 'met_accommodation') {
      const e = state.policy.forms.accommodation.per_level[lvl];
      if (e) value = `Daily limit <strong>₹${fmt(e.daily_limit)}/day</strong>  ·  Economical accommodation mandatory`;
      label = `Level ${lvl} entitlement`;
    } else if (F === 'met_cab') {
      label = 'Eligibility';
      value = 'Applicable for trips <strong>80 km+</strong> only  ·  attach the cab/taxi bill';
    } else if (F === 'met_misc') {
      label = 'Reimbursement';
      value = 'Enter each expense with date, purpose &amp; amount  ·  attach the bill for each';
    }

    if (!value) return;
    banner.innerHTML = `
      <div class="entitlement-banner">
        <div class="icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 1l3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z" fill="currentColor"/></svg>
        </div>
        <div class="info">
          <div class="label">${label}</div>
          <div class="value">${value}</div>
        </div>
      </div>`;
  }

  // ===================================================================
  //  FORM RENDERERS
  // ===================================================================

  // ---- Local conveyance (BSC) / Local Travel Allowance (Metfraa) ---
  function renderConveyanceForm(body, company) {
    const fd = state.formData;
    const policyKey = company === 'bsc' ? 'conveyance' : 'local';
    const rates = state.policy.forms[policyKey].rates;

    // Top card: period + vehicle
    const top = el('div', { class: 'card' },
      el('div', { class: 'card-title' }, 'Period & Vehicle'),
      el('div', { class: 'field-grid three' },
        field('period', 'Period (Month)', 'month', fd.period, true, v => { fd.period = v; }),
        el('div', { class: 'field' },
          el('label', {}, 'Vehicle Type', el('span', { class: 'req' }, '*')),
          (() => {
            const sel = el('select', { onchange: (e) => { fd.vehicle_type = e.target.value; renderForm(); } });
            for (const [k, r] of Object.entries(rates)) {
              const opt = el('option', { value: k }, `${r.label} — ₹${r.rate_per_km}/km`);
              if (k === fd.vehicle_type) opt.selected = true;
              sel.appendChild(opt);
            }
            return sel;
          })()
        ),
        field('vehicle_reg', 'Vehicle Reg. No.', 'text', fd.vehicle_reg, false, v => { fd.vehicle_reg = v; }, 'e.g. TN-09-AB-1234')
      )
    );
    body.appendChild(top);

    // Trips card
    const tripsCard = el('div', { class: 'card' },
      el('div', { class: 'card-title' }, 'Trips')
    );
    const colHeader = el('div', { class: 'col-header col-conv' },
      el('div', {}, 'Date'), el('div', {}, 'From'), el('div', {}, 'To'),
      el('div', {}, 'Purpose'), el('div', {}, 'KM'), el('div', {}, 'Amount'), el('div', {}, '')
    );
    tripsCard.appendChild(colHeader);

    const rate = rates[fd.vehicle_type].rate_per_km;
    const vLabel = (rates[fd.vehicle_type].label || '') + ' ' + fd.vehicle_type;
    const isCar = company === 'metfraa' && /car/i.test(vLabel);
    fd.trips.forEach((t, idx) => {
      // Compute amount
      const km = parseFloat(t.km) || 0;
      t.amount = +(km * rate).toFixed(2);
      const carShort = isCar && km > 0 && km < 80;

      const amountCell = el('input', {
        type: 'text', value: `₹ ${fmt(t.amount)}`, readOnly: true,
        class: 'ti', tabindex: '-1',
      });
      const row = el('div', { class: 'row row-conv' + (carShort ? ' error' : '') },
        rowInput('date', t.date, v => { t.date = v; updateSummary(); }),
        rowInput('text', t.from, v => { t.from = v; }, 'From'),
        rowInput('text', t.to,   v => { t.to = v; }, 'To'),
        rowInput('text', t.purpose, v => { t.purpose = v; }, 'Purpose'),
        // Update km + recompute this row's amount IN PLACE — no full
        // re-render, so the cursor stays in the field (bug fix).
        rowInput('number', t.km, v => {
          t.km = v;
          const k = parseFloat(v) || 0;
          t.amount = +(k * rate).toFixed(2);
          amountCell.value = `₹ ${fmt(t.amount)}`;
          // car-under-80 warning, toggled in place
          const bad = isCar && k > 0 && k < 80;
          row.classList.toggle('error', bad);
          let warn = row.querySelector('.car-warn');
          if (bad) {
            if (!warn) { warn = el('div', { class: 'car-warn od-warn', style: 'grid-column:1/-1;' }, ''); row.appendChild(warn); }
            warn.textContent = `Car travel needs 80 km+ — this trip is ${k} km. Use a two-wheeler for shorter distances.`;
          } else if (warn) { warn.remove(); }
          updateSummary();
        }, '0', { step: '0.1', min: '0' }),
        amountCell,
        removeRowBtn(() => { fd.trips.splice(idx, 1); if (!fd.trips.length) fd.trips.push({ date:'', from:'', to:'', purpose:'', km:'' }); renderForm(); })
      );
      if (carShort) {
        row.appendChild(el('div', { class: 'car-warn od-warn', style: 'grid-column:1/-1;' }, `Car travel needs 80 km+ — this trip is ${km} km. Use a two-wheeler for shorter distances.`));
      }
      tripsCard.appendChild(row);
    });

    tripsCard.appendChild(el('button', { class: 'add-row-btn', onclick: () => { fd.trips.push({ date:'', from:'', to:'', purpose:'', km:'' }); renderForm(); } }, '+ Add Trip'));
    body.appendChild(tripsCard);
  }

  // ---- BSC outstation expense / Metfraa outstation -----------------
  function renderExpenseForm(body, company) {
    const fd = state.formData;
    const isMetfraa = company === 'metfraa';
    const periodCard = el('div', { class: 'card' },
      el('div', { class: 'card-title' }, 'Period'),
      el('div', { class: 'field-grid' + (isMetfraa ? '' : ' three') },
        field('period', 'Reporting Month', 'month', fd.period, true, v => { fd.period = v; }),
        isMetfraa ? null : field('manager', 'Reporting Manager', 'text', fd.manager || '', false, v => { fd.manager = v; }, 'e.g. Ms. Anitha S.')
      )
    );
    body.appendChild(periodCard);

    // Trips
    fd.trips.forEach((trip, tIdx) => {
      const card = el('div', { class: 'trip-block' });
      card.appendChild(el('div', { class: 'trip-head' },
        el('h4', {}, el('span', { class: 'num' }, String(tIdx + 1).padStart(2, '0')), 'Trip Details'),
        fd.trips.length > 1
          ? el('button', { class: 'remove-btn', onclick: () => { fd.trips.splice(tIdx, 1); renderForm(); } }, '× Remove Trip')
          : null
      ));

      // Trip header fields
      card.appendChild(
        el('div', { class: 'field-grid' },
          field(`place-${tIdx}`, 'Destination', 'text', trip.place, true, v => { trip.place = v; }, 'e.g. Mumbai'),
          field(`purpose-${tIdx}`, 'Purpose', 'text', trip.purpose, true, v => { trip.purpose = v; }, 'e.g. Client meeting'),
          field(`from-${tIdx}`, 'From Date', 'date', trip.from_date, true, v => { trip.from_date = v; }),
          field(`to-${tIdx}`, 'To Date', 'date', trip.to_date, true, v => { trip.to_date = v; }),
          isMetfraa ? field(`mgr-${tIdx}`, 'Approved By (Manager)', 'text', trip.manager_approval || '', false, v => { trip.manager_approval = v; }, 'Manager name + date') : null
        )
      );

      // Category rows
      const cats = isMetfraa
        ? [['travel','Long-Distance Travel'], ['accommodation','Accommodation'], ['food','Food'], ['local_conveyance','Local Conveyance'], ['others','Other']]
        : [['accommodation','Accommodation'], ['food','Food'], ['conveyance','Conveyance'], ['others','Other']];

      const lvl = state.user.level;
      const entitlement = isMetfraa
        ? (state.policy.forms.outstation.per_level[lvl] || {})
        : (state.policy.forms.expense.per_level[lvl] || {});

      for (const [catKey, catLabel] of cats) {
        const items = trip.categories[catKey] || [];
        const cap = isMetfraa
          ? (catKey === 'food' && entitlement.food_per_day ? `up to ₹${fmt(entitlement.food_per_day)}/day` : '')
          : (catKey === 'food' && entitlement.food_per_day ? `up to ₹${fmt(entitlement.food_per_day)}/day`
            : catKey === 'accommodation' && entitlement.accommodation_per_day ? `up to ₹${fmt(entitlement.accommodation_per_day)}/day`
            : '');

        const cat = el('div', { class: 'expense-category' },
          el('div', { class: 'cat-head' },
            el('h5', {}, catLabel),
            cap ? el('div', { class: 'cap' }, cap) : null
          ),
          el('div', { class: 'col-header col-exp' },
            el('div', {}, 'Date'), el('div', {}, 'Description'), el('div', {}, 'Amount'), el('div', {}, '')
          )
        );

        items.forEach((it, iIdx) => {
          const row = el('div', { class: 'row row-exp' },
            rowInput('date', it.date, v => { it.date = v; }),
            rowInput('text', it.desc, v => { it.desc = v; }, 'Description / vendor'),
            rowInput('number', it.amount, v => { it.amount = v; updateSummary(); }, '0.00', { step: '0.01', min: '0' }),
            removeRowBtn(() => {
              items.splice(iIdx, 1);
              if (!items.length) items.push({ date:'', desc:'', amount:'' });
              renderForm();
            })
          );
          cat.appendChild(row);
        });
        cat.appendChild(el('button', { class: 'add-row-btn', onclick: () => { items.push({ date:'', desc:'', amount:'' }); renderForm(); } }, `+ Add ${catLabel} entry`));
        card.appendChild(cat);
      }

      // Trip total
      let tripTotal = 0;
      Object.values(trip.categories).forEach(arr => arr.forEach(i => { tripTotal += parseFloat(i.amount) || 0; }));
      card.appendChild(el('div', { class: 'trip-total' },
        el('div', { class: 'label' }, `Trip ${String(tIdx + 1).padStart(2, '0')} subtotal`),
        el('div', { class: 'value' }, `₹ ${fmt(tripTotal)}`)
      ));

      body.appendChild(card);
    });

    // Add trip
    body.appendChild(el('button', { class: 'add-trip-btn',
      onclick: () => {
        const empty = isMetfraa
          ? { place:'',from_date:'',to_date:'',purpose:'',manager_approval:'',
              categories:{ travel:[{date:'',desc:'',amount:''}], accommodation:[{date:'',desc:'',amount:''}], food:[{date:'',desc:'',amount:''}], local_conveyance:[{date:'',desc:'',amount:''}], others:[{date:'',desc:'',amount:''}] } }
          : { place:'',from_date:'',to_date:'',purpose:'',
              categories:{ accommodation:[{date:'',desc:'',amount:''}], food:[{date:'',desc:'',amount:''}], conveyance:[{date:'',desc:'',amount:''}], others:[{date:'',desc:'',amount:''}] } };
        fd.trips.push(empty);
        renderForm();
      }
    }, '+ Add Another Trip'));
  }

  // ---- Cab Reimbursement -----------------------------------------
  function renderCabForm(body) {
    const fd = state.formData;

    // Eligibility notice
    body.appendChild(el('div', { class: 'card', style: 'border-left:3px solid var(--bsg-warning);' },
      el('div', { class: 'card-title' }, 'Eligibility'),
      el('p', { style: 'margin:0;color:var(--bsg-text);line-height:1.6;' },
        'Cab reimbursement applies only to journeys of ', el('strong', {}, '80 km or more'),
        '. Shorter trips are not eligible. Attach the cab/taxi bill for each fare claimed.')
    ));

    const periodCard = el('div', { class: 'card' },
      el('div', { class: 'card-title' }, 'Reference Month (optional)'),
      el('div', { class: 'field-grid' },
        field('period', 'Reference Month', 'month', fd.period, false, v => { fd.period = v; })
      )
    );
    body.appendChild(periodCard);

    const ridesCard = el('div', { class: 'card' },
      el('div', { class: 'card-title' }, 'Cab Trip(s)')
    );
    ridesCard.appendChild(el('div', { class: 'col-header col-cab' },
      el('div', {}, 'Date'), el('div', {}, 'Pickup'), el('div', {}, 'Drop'),
      el('div', {}, 'Distance (km)'), el('div', {}, 'Fare (₹)'), el('div', {}, 'Purpose'), el('div', {}, '')
    ));

    fd.rides.forEach((r, idx) => {
      const km = parseFloat(r.km) || 0;
      const ineligible = km > 0 && km < 80;
      const row = el('div', { class: 'row row-cab' + (ineligible ? ' error' : '') },
        rowInput('date', r.date, v => { r.date = v; }),
        rowInput('text', r.pickup, v => { r.pickup = v; }, 'Pickup point'),
        rowInput('text', r.drop, v => { r.drop = v; }, 'Drop point'),
        rowInput('number', r.km, v => {
          r.km = v;
          const k = parseFloat(v) || 0;
          row.classList.toggle('error', k > 0 && k < 80);
          // toggle the inline warning
          let warn = row.querySelector('.cab-warn');
          if (k > 0 && k < 80) {
            if (!warn) { warn = el('div', { class: 'cab-warn od-warn', style: 'grid-column:1/-1;' }, ''); row.appendChild(warn); }
            warn.textContent = `Not eligible — ${k} km is under the 80 km minimum.`;
          } else if (warn) { warn.remove(); }
          updateSummary();
        }, '0', { step: '0.1', min: '0' }),
        rowInput('number', r.fare, v => { r.fare = v; updateSummary(); }, '0.00', { step: '0.01', min: '0' }),
        rowInput('text', r.purpose, v => { r.purpose = v; }, 'Purpose'),
        removeRowBtn(() => { fd.rides.splice(idx, 1); if (!fd.rides.length) fd.rides.push({ date:'', time:'', pickup:'', drop:'', km:'', fare:'', passengers:1, purpose:'', notes:'' }); renderForm(); })
      );
      if (ineligible) {
        row.appendChild(el('div', { class: 'cab-warn od-warn', style: 'grid-column:1/-1;' }, `Not eligible — ${km} km is under the 80 km minimum.`));
      }
      ridesCard.appendChild(row);
    });

    ridesCard.appendChild(el('button', { class: 'add-row-btn', onclick: () => { fd.rides.push({ date:'', time:'', pickup:'', drop:'', km:'', fare:'', passengers:1, purpose:'', notes:'' }); renderForm(); } }, '+ Add Another Cab Trip'));
    body.appendChild(ridesCard);
  }

  // ---- Miscellaneous Reimbursement -------------------------------
  function renderMiscForm(body) {
    const fd = state.formData;

    body.appendChild(el('div', { class: 'card' },
      el('div', { class: 'card-title' }, 'Reference Month (optional)'),
      el('div', { class: 'field-grid' },
        field('period', 'Reference Month', 'month', fd.period, false, v => { fd.period = v; })
      )
    ));

    const itemsCard = el('div', { class: 'card' },
      el('div', { class: 'card-title' }, 'Items')
    );
    itemsCard.appendChild(el('div', { class: 'col-header col-misc' },
      el('div', {}, 'Date'), el('div', {}, 'Purpose'), el('div', {}, 'Amount (₹)'), el('div', {}, '')
    ));

    fd.items.forEach((it, idx) => {
      const row = el('div', { class: 'row row-misc' },
        rowInput('date', it.date, v => { it.date = v; updateSummary(); }),
        rowInput('text', it.purpose, v => { it.purpose = v; }, 'What was this expense for?'),
        rowInput('number', it.amount, v => { it.amount = v; updateSummary(); }, '0.00', { step: '0.01', min: '0' }),
        removeRowBtn(() => { fd.items.splice(idx, 1); if (!fd.items.length) fd.items.push({ date:'', purpose:'', amount:'' }); renderForm(); })
      );
      itemsCard.appendChild(row);
    });

    itemsCard.appendChild(el('button', { class: 'add-row-btn', onclick: () => { fd.items.push({ date:'', purpose:'', amount:'' }); renderForm(); } }, '+ Add Item'));
    body.appendChild(itemsCard);
  }

  // ---- Monthly Accommodation -------------------------------------
  function renderAccommodationForm(body) {
    const fd = state.formData;
    const lvl = state.user.level;
    const limit = (state.policy.forms.accommodation.per_level[lvl] || {}).daily_limit || 0;

    const periodCard = el('div', { class: 'card' },
      el('div', { class: 'card-title' }, 'Period'),
      el('div', { class: 'field-grid' },
        field('period', 'Reporting Month', 'month', fd.period, true, v => { fd.period = v; })
      )
    );
    body.appendChild(periodCard);

    const entriesCard = el('div', { class: 'card' },
      el('div', { class: 'card-title' }, 'Accommodation Entries')
    );
    entriesCard.appendChild(el('div', { class: 'col-header col-acc' },
      el('div', {}, 'Date'), el('div', {}, 'Location'), el('div', {}, 'Hotel / Stay'),
      el('div', {}, 'Bill #'), el('div', {}, 'Amount'), el('div', {}, '')
    ));

    fd.entries.forEach((e, idx) => {
      const amt = parseFloat(e.amount) || 0;
      const over = amt > limit;
      const row = el('div', { class: 'row row-acc' + (over ? ' error' : '') },
        rowInput('date', e.date, v => { e.date = v; }),
        rowInput('text', e.location, v => { e.location = v; }, 'City / Site'),
        rowInput('text', e.hotel, v => { e.hotel = v; }, 'Hotel / lodge name'),
        rowInput('text', e.bill_no, v => { e.bill_no = v; }, 'Bill no.'),
        rowInput('number', e.amount, v => {
          e.amount = v;
          // toggle the over-limit highlight in place (no re-render → keeps cursor)
          row.classList.toggle('error', (parseFloat(v) || 0) > limit);
          updateSummary();
        }, '0.00', { step: '0.01', min: '0' }),
        removeRowBtn(() => { fd.entries.splice(idx, 1); if (!fd.entries.length) fd.entries.push({ date:'', location:'', hotel:'', bill_no:'', amount:'' }); renderForm(); })
      );
      entriesCard.appendChild(row);
    });

    // Over-limit warning if any
    const overAny = fd.entries.some(e => (parseFloat(e.amount) || 0) > limit);
    if (overAny && limit > 0) {
      entriesCard.appendChild(el('div', { style: 'margin-top:12px;padding:12px 14px;background:rgba(180,83,9,0.08);border-left:3px solid var(--bsg-warning);font-size:13px;color:var(--bsg-warning);border-radius:2px;' },
        `⚠ One or more entries exceed the daily limit of ₹${fmt(limit)}. Management approval is required.`
      ));
    }

    entriesCard.appendChild(el('button', { class: 'add-row-btn', onclick: () => { fd.entries.push({ date:'', location:'', hotel:'', bill_no:'', amount:'' }); renderForm(); } }, '+ Add Another Entry'));
    body.appendChild(entriesCard);
  }

  // ===================================================================
  //  FIELD HELPERS
  // ===================================================================
  function field(id, label, type, value, required, onchange, placeholder = '') {
    return el('div', { class: 'field' },
      el('label', { for: id }, label, required ? el('span', { class: 'req' }, '*') : null),
      el('input', { id, type, value: value || '', placeholder, oninput: (e) => onchange(e.target.value) })
    );
  }
  function rowInput(type, value, onchange, placeholder = '', extra = {}) {
    const attrs = { type, value: value == null ? '' : value, placeholder, oninput: (e) => onchange(e.target.value), ...extra };
    return el('input', attrs);
  }
  function removeRowBtn(onclick) {
    return el('button', { class: 'x-btn', title: 'Remove', onclick },
      el('span', { html: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>' })
    );
  }

  // ===================================================================
  //  SUMMARY (live totals)
  // ===================================================================
  function calcTotalAndCount() {
    const fd = state.formData;
    let total = 0, count = 0;
    switch (state.currentForm) {
      case 'bsc_conveyance':
      case 'met_local': {
        const rates = state.policy.forms[state.currentForm === 'bsc_conveyance' ? 'conveyance' : 'local'].rates;
        const rate = rates[fd.vehicle_type].rate_per_km;
        for (const t of fd.trips) {
          const km = parseFloat(t.km) || 0;
          if (km > 0) { total += km * rate; count++; }
        }
        break;
      }
      case 'bsc_expense':
      case 'met_outstation':
        for (const trip of fd.trips) {
          for (const arr of Object.values(trip.categories)) {
            for (const it of arr) {
              const a = parseFloat(it.amount) || 0;
              if (a > 0) { total += a; count++; }
            }
          }
        }
        break;
      case 'met_accommodation':
        for (const e of fd.entries) {
          const a = parseFloat(e.amount) || 0;
          if (a > 0) { total += a; count++; }
        }
        break;
      case 'met_cab':
        for (const r of fd.rides) {
          const f = parseFloat(r.fare) || 0;
          if (f > 0) { total += f; count++; }
        }
        break;
      case 'met_misc':
        for (const it of fd.items) {
          const a = parseFloat(it.amount) || 0;
          if (a > 0) { total += a; count++; }
        }
        break;
    }
    return { total: +total.toFixed(2), count };
  }

  function updateSummary() {
    const { total, count } = calcTotalAndCount();
    if ($('#grandTotal')) $('#grandTotal').textContent = fmt(total);
    if ($('#entryCount')) $('#entryCount').textContent = count;
  }

  // ===================================================================
  //  UPLOADS
  // ===================================================================
  function bindUploadZone() {
    const zone = $('#uploadZone');
    const input = $('#fileInput');
    if (!zone) return;
    zone.onclick = () => input.click();
    ['dragover', 'dragenter'].forEach(ev => zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.add('dragover'); }));
    ['dragleave', 'drop'].forEach(ev => zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.remove('dragover'); }));
    zone.addEventListener('drop', e => {
      e.preventDefault();
      const files = Array.from(e.dataTransfer.files || []);
      if (files.length) uploadFiles(files);
    });
    input.onchange = () => {
      const files = Array.from(input.files || []);
      if (files.length) uploadFiles(files);
      input.value = '';
    };
  }

  async function uploadFiles(files) {
    const list = $('#uploadList');
    // Optimistic items
    const placeholders = files.map(f => {
      const item = uploadItemNode(f.name, f.size, f.type, true);
      list.appendChild(item);
      return item;
    });

    try {
      const fd = new FormData();
      fd.append('upload_token', state.uploadToken);
      files.forEach(f => fd.append('files', f));
      const res = await api('/api/uploads', { method: 'POST', body: fd });
      placeholders.forEach(p => p.remove());
      for (const up of res.uploads) state.uploads.push(up);
      refreshUploadList();
      toast(`${files.length} file${files.length > 1 ? 's' : ''} uploaded`, 'success');
    } catch (err) {
      placeholders.forEach(p => { p.classList.remove('uploading'); p.classList.add('error'); });
      toast(err.message || 'Upload failed', 'error');
    }
  }

  function uploadItemNode(name, size, mime, uploading = false, id = null) {
    const isPdf = /pdf/i.test(mime || name);
    const item = el('div', { class: 'upload-item' + (uploading ? ' uploading' : '') },
      el('div', { class: 'icon', html: isPdf
        ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg>'
        : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>'
      }),
      el('div', { class: 'info' },
        el('div', { class: 'name', title: name }, name),
        el('div', { class: 'meta' }, `${(size / 1024).toFixed(1)} KB · ${mime || 'file'}`)
      ),
      uploading
        ? el('div', { class: 'meta' }, 'Uploading…')
        : el('button', { class: 'x', title: 'Remove', onclick: () => removeUpload(id) },
            el('span', { html: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>' })
          )
    );
    return item;
  }

  async function removeUpload(id) {
    try {
      await api(`/api/uploads/${id}?token=${encodeURIComponent(state.uploadToken)}`, { method: 'DELETE' });
      state.uploads = state.uploads.filter(u => u.id !== id);
      refreshUploadList();
    } catch (err) {
      toast(err.message || 'Could not remove upload', 'error');
    }
  }

  function refreshUploadList() {
    const list = $('#uploadList');
    if (!list) return;
    list.innerHTML = '';
    for (const u of state.uploads) {
      list.appendChild(uploadItemNode(u.filename, u.size_bytes, u.mime_type, false, u.id));
    }
  }

  // ===================================================================
  //  VALIDATION (client-side; the server is the real gatekeeper)
  // ===================================================================
  function validateForm() {
    const fd = state.formData;
    const F = state.currentForm;
    let ok = true, firstErr = '';

    const fail = (msg) => { ok = false; firstErr = firstErr || msg; };

    if (F === 'bsc_conveyance' || F === 'met_local') {
      if (!fd.period) fail('Period is required.');
      if (!fd.trips.some(t => t.date && t.from && t.to && parseFloat(t.km) > 0)) fail('Add at least one complete trip.');
      if (F === 'met_local' && fd.trips.some(t => t.km && parseFloat(t.km) < 5)) fail('Trips under 5 km are not eligible per Metfraa policy.');
      // Car only for 80 km+
      if (F === 'met_local') {
        const rates = state.policy.forms.local.rates;
        const vLabel = (rates[fd.vehicle_type].label || '') + ' ' + fd.vehicle_type;
        if (/car/i.test(vLabel) && fd.trips.some(t => t.km && parseFloat(t.km) < 80)) {
          fail('Car travel is not applicable for trips under 80 km. Use a two-wheeler for shorter distances.');
        }
      }
    } else if (F === 'bsc_expense' || F === 'met_outstation') {
      if (!fd.period) fail('Reporting month is required.');
      if (!fd.trips.length) fail('Add at least one trip.');
      for (const trip of fd.trips) {
        if (!trip.place || !trip.from_date || !trip.to_date || !trip.purpose) {
          fail('Every trip needs destination, dates, and purpose.');
          break;
        }
        const anyAmt = Object.values(trip.categories).some(arr => arr.some(i => parseFloat(i.amount) > 0));
        if (!anyAmt) {
          fail('Each trip needs at least one expense entry with an amount.');
          break;
        }
      }
    } else if (F === 'met_cab') {
      if (!fd.rides.some(r => r.date && r.pickup && r.drop && r.purpose && parseFloat(r.km) > 0 && parseFloat(r.fare) > 0)) {
        fail('Add at least one complete cab trip (date, pickup, drop, distance, fare, purpose).');
      }
      if (fd.rides.some(r => r.km && parseFloat(r.km) < 80)) {
        fail('Cab reimbursement is not applicable for trips under 80 km.');
      }
    } else if (F === 'met_misc') {
      if (!fd.items.some(it => it.date && it.purpose && parseFloat(it.amount) > 0)) {
        fail('Add at least one complete item (date, purpose, amount).');
      }
    } else if (F === 'met_accommodation') {
      if (!fd.period) fail('Reporting month is required.');
      if (!fd.entries.some(e => e.date && e.location && parseFloat(e.amount) > 0)) fail('Add at least one complete accommodation entry.');
    }

    if (!ok) toast(firstErr, 'error');
    return ok;
  }

  // ===================================================================
  //  PREVIEW
  // ===================================================================
  function renderPreview() {
    const fd = state.formData;
    const F = state.currentForm;
    const root = $('#reportRender');
    root.innerHTML = '';

    const { total } = calcTotalAndCount();
    const ref = '— preview —';
    const subtitleMap = {
      bsc_conveyance: 'BSC / FORM C',
      bsc_expense:    'BSC / FORM E',
      met_local:      'METFRAA / LTA',
      met_cab:        'METFRAA / CAB',
      met_accommodation: 'METFRAA / ACC',
      met_outstation: 'METFRAA / OUT',
    };

    // Header
    root.appendChild(el('div', { class: 'report-header' },
      el('img', { src: COMPANY_LOGOS[state.company], alt: state.company, class: 'r-co-logo' }),
      el('div', { class: 'r-title' },
        el('div', { class: 'form-type' }, subtitleMap[F] || ''),
        el('h1', {}, FORM_TITLES[F]),
        el('div', { class: 'ref' }, ref)
      )
    ));

    // Employee info
    const u = state.user;
    const cells = [
      ['NAME', u.name], ['EMPLOYEE ID', u.employee_code || '—'],
      ['DESIGNATION', u.designation || '—'], ['LEVEL', u.level || '—'],
      ['DEPARTMENT', u.department || '—'], ['EMAIL', u.email],
      ['PERIOD', fd.period || '—'], ['SUBMITTED', new Date().toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' })],
    ];
    const info = el('div', { class: 'employee-info' });
    for (const [label, value] of cells) {
      info.appendChild(el('div', { class: 'cell' },
        el('div', { class: 'label' }, label),
        el('div', { class: 'value' }, value)
      ));
    }
    root.appendChild(info);

    // Body
    switch (F) {
      case 'bsc_conveyance':
      case 'met_local': renderConveyancePreview(root, fd); break;
      case 'bsc_expense':
      case 'met_outstation': renderExpensePreview(root, fd, F === 'met_outstation'); break;
      case 'met_cab': renderCabPreview(root, fd); break;
      case 'met_misc': renderMiscPreview(root, fd); break;
      case 'met_accommodation': renderAccommodationPreview(root, fd); break;
    }

    // Grand total (all Metfraa forms are now reimbursements with a total)
    {
      root.appendChild(el('div', { class: 'grand-total' },
        el('div', { class: 'lbl' }, 'Total Reimbursement Claim'),
        el('div', { class: 'amt' }, el('span', { class: 'cur' }, '₹'), fmt(total))
      ));
    }

    // Attachments summary
    if (state.uploads.length) {
      const list = el('div', { class: 'list' });
      for (const u of state.uploads) {
        list.appendChild(el('span', {}, u.filename));
      }
      root.appendChild(el('div', { class: 'attachments-summary' },
        el('h4', {}, `${state.uploads.length} Bill${state.uploads.length === 1 ? '' : 's'} & Receipt${state.uploads.length === 1 ? '' : 's'} Attached`),
        list
      ));
    }
  }

  function renderConveyancePreview(root, fd) {
    const rates = state.policy.forms[state.currentForm === 'bsc_conveyance' ? 'conveyance' : 'local'].rates;
    const rate = rates[fd.vehicle_type].rate_per_km;
    const trips = fd.trips.filter(t => parseFloat(t.km) > 0);

    const section = el('div', { class: 'trip-section' });
    section.appendChild(el('div', { class: 'trip-banner' },
      el('div', { class: 'l' }, el('strong', {}, 'VEHICLE'), `${rates[fd.vehicle_type].label} · ₹${rate}/km${fd.vehicle_reg ? ' · ' + fd.vehicle_reg : ''}`),
      el('div', { class: 'r' }, `${trips.length} trip${trips.length === 1 ? '' : 's'}`)
    ));

    const table = el('table');
    table.appendChild(el('thead', {}, el('tr', {},
      ...['Date','From','To','Purpose','KM','Amount (₹)'].map(h => el('th', {}, h))
    )));
    const tbody = el('tbody');
    let total = 0;
    for (const t of trips) {
      const km = parseFloat(t.km) || 0;
      const amt = +(km * rate).toFixed(2);
      total += amt;
      tbody.appendChild(el('tr', {},
        el('td', {}, formatDate(t.date)),
        el('td', {}, t.from || '—'),
        el('td', {}, t.to || '—'),
        el('td', {}, t.purpose || '—'),
        el('td', { class: 'num' }, fmt(km)),
        el('td', { class: 'num' }, fmt(amt))
      ));
    }
    table.appendChild(tbody);
    table.appendChild(el('tfoot', {}, el('tr', {},
      el('td', { colspan: 5 }, 'Subtotal'),
      el('td', { class: 'amt' }, `₹ ${fmt(total)}`)
    )));
    section.appendChild(table);
    root.appendChild(section);
  }

  function renderExpensePreview(root, fd, isMetfraa) {
    const labelMap = isMetfraa
      ? { travel: 'Long-distance Travel', accommodation: 'Accommodation', food: 'Food', local_conveyance: 'Local Conveyance', others: 'Other' }
      : { accommodation: 'Accommodation', food: 'Food', conveyance: 'Conveyance', others: 'Other' };

    fd.trips.forEach((trip, idx) => {
      const section = el('div', { class: 'trip-section' });
      section.appendChild(el('div', { class: 'trip-banner' },
        el('div', { class: 'l' }, el('strong', {}, `TRIP ${String(idx + 1).padStart(2, '0')}`), trip.place || '—'),
        el('div', { class: 'r' }, `${formatDate(trip.from_date)} — ${formatDate(trip.to_date)}`)
      ));
      section.appendChild(el('div', { class: 'trip-meta' },
        el('div', { class: 'cell' }, el('div', { class: 'label' }, 'Purpose'), el('div', { class: 'value' }, trip.purpose || '—')),
        el('div', { class: 'cell' }, el('div', { class: 'label' }, 'Duration'), el('div', { class: 'value' }, daysBetween(trip.from_date, trip.to_date) + ' day(s)')),
        el('div', { class: 'cell' }, el('div', { class: 'label' }, isMetfraa ? 'Approved By' : 'Trip #'), el('div', { class: 'value' }, isMetfraa ? (trip.manager_approval || '—') : String(idx + 1)))
      ));

      const rows = [];
      let tripTotal = 0;
      for (const [cat, items] of Object.entries(trip.categories)) {
        for (const it of items) {
          const amt = parseFloat(it.amount) || 0;
          if (!amt) continue;
          tripTotal += amt;
          rows.push(el('tr', {},
            el('td', {}, formatDate(it.date)),
            el('td', {}, it.desc || '—'),
            el('td', {}, labelMap[cat] || cat),
            el('td', { class: 'num' }, fmt(amt))
          ));
        }
      }
      if (rows.length) {
        const table = el('table');
        table.appendChild(el('thead', {}, el('tr', {},
          ...['Date','Description','Category','Amount (₹)'].map(h => el('th', {}, h))
        )));
        const tbody = el('tbody');
        rows.forEach(r => tbody.appendChild(r));
        table.appendChild(tbody);
        table.appendChild(el('tfoot', {}, el('tr', {},
          el('td', { colspan: 3 }, `Trip ${String(idx + 1).padStart(2, '0')} subtotal`),
          el('td', { class: 'amt' }, `₹ ${fmt(tripTotal)}`)
        )));
        section.appendChild(table);
      } else {
        section.appendChild(el('div', { style: 'padding:14px;color:var(--bsg-muted);font-style:italic;background:var(--bsg-soft);' }, 'No expenses logged for this trip.'));
      }
      root.appendChild(section);
    });
  }

  function renderCabPreview(root, fd) {
    const rides = fd.rides.filter(r => parseFloat(r.fare) > 0 || r.pickup || r.drop);
    const section = el('div', { class: 'trip-section' });
    section.appendChild(el('div', { class: 'trip-banner' },
      el('div', { class: 'l' }, el('strong', {}, 'CAB REIMBURSEMENT'), 'Trips of 80 km or more'),
      el('div', { class: 'r' }, `${rides.length} trip${rides.length === 1 ? '' : 's'}`)
    ));

    const table = el('table');
    table.appendChild(el('thead', {}, el('tr', {},
      ...['Date','Pickup','Drop','Distance','Fare (₹)','Purpose'].map(h => el('th', {}, h))
    )));
    const tbody = el('tbody');
    for (const r of rides) {
      tbody.appendChild(el('tr', {},
        el('td', {}, formatDate(r.date)),
        el('td', {}, r.pickup || '—'),
        el('td', {}, r.drop || '—'),
        el('td', { class: 'num' }, `${r.km || '—'} km`),
        el('td', { class: 'num' }, fmt(parseFloat(r.fare) || 0)),
        el('td', {}, r.purpose || '—')
      ));
    }
    table.appendChild(tbody);
    section.appendChild(table);
    root.appendChild(section);
  }

  function renderMiscPreview(root, fd) {
    const items = fd.items.filter(it => parseFloat(it.amount) > 0 || it.purpose);
    const section = el('div', { class: 'trip-section' });
    section.appendChild(el('div', { class: 'trip-banner' },
      el('div', { class: 'l' }, el('strong', {}, 'MISCELLANEOUS'), 'Other work expenses'),
      el('div', { class: 'r' }, `${items.length} item${items.length === 1 ? '' : 's'}`)
    ));
    const table = el('table');
    table.appendChild(el('thead', {}, el('tr', {},
      ...['Date','Purpose','Amount (₹)'].map(h => el('th', {}, h))
    )));
    const tbody = el('tbody');
    for (const it of items) {
      tbody.appendChild(el('tr', {},
        el('td', {}, formatDate(it.date)),
        el('td', {}, it.purpose || '—'),
        el('td', { class: 'num' }, fmt(parseFloat(it.amount) || 0))
      ));
    }
    table.appendChild(tbody);
    section.appendChild(table);
    root.appendChild(section);
  }

  function renderAccommodationPreview(root, fd) {
    const lvl = state.user.level;
    const limit = (state.policy.forms.accommodation.per_level[lvl] || {}).daily_limit || 0;
    const entries = fd.entries.filter(e => parseFloat(e.amount) > 0);

    const section = el('div', { class: 'trip-section' });
    section.appendChild(el('div', { class: 'trip-banner' },
      el('div', { class: 'l' }, el('strong', {}, `LEVEL ${lvl}`), `Daily limit ₹${fmt(limit)}/day`),
      el('div', { class: 'r' }, `${entries.length} day${entries.length === 1 ? '' : 's'}`)
    ));

    const table = el('table');
    table.appendChild(el('thead', {}, el('tr', {},
      ...['Date','Location','Hotel / Stay','Bill #','Amount (₹)'].map(h => el('th', {}, h))
    )));
    const tbody = el('tbody');
    let total = 0;
    for (const e of entries) {
      const amt = parseFloat(e.amount) || 0;
      total += amt;
      const over = amt > limit;
      tbody.appendChild(el('tr', {},
        el('td', {}, formatDate(e.date)),
        el('td', {}, e.location || '—'),
        el('td', {}, e.hotel || '—'),
        el('td', {}, e.bill_no || '—'),
        el('td', { class: 'num', style: over ? 'color:var(--bsg-warning);font-weight:600;' : '' }, `${fmt(amt)}${over ? ' ⚠' : ''}`)
      ));
    }
    table.appendChild(tbody);
    table.appendChild(el('tfoot', {}, el('tr', {},
      el('td', { colspan: 4 }, 'Subtotal'),
      el('td', { class: 'amt' }, `₹ ${fmt(total)}`)
    )));
    section.appendChild(table);
    root.appendChild(section);
  }

  function formatDate(s) {
    if (!s) return '—';
    const d = new Date(s);
    if (isNaN(d)) return s;
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  function daysBetween(a, b) {
    if (!a || !b) return '—';
    const d1 = new Date(a), d2 = new Date(b);
    return Math.max(1, Math.round((d2 - d1) / 86400000) + 1);
  }

  // ===================================================================
  //  SUBMIT
  // ===================================================================
  async function submitForm() {
    if (!validateForm()) return;

    const isCab = state.currentForm === 'met_cab';
    const ok = await confirmModal({
      title: 'Submit for approval?',
      body: isCab
        ? 'Your cab request will be logged and sent to the admin for pre-approval. Bookings should not be made until approved.'
        : 'Your claim and bills will be logged and sent to the admin for approval. The final report is generated once approved.',
      confirmText: 'Submit',
    });
    if (!ok) return;

    showLoading('Submitting for approval…');
    try {
      const res = await api('/api/submissions', {
        method: 'POST',
        body: JSON.stringify({
          form_type: state.currentForm,
          upload_token: state.uploadToken,
          payload: state.formData,
        }),
      });
      state.lastSubmission = res.submission;
      route('success');
    } catch (err) {
      toast(err.message || 'Submission failed', 'error');
    } finally {
      hideLoading();
    }
  }

  // ===================================================================
  //  SUCCESS PAGE
  // ===================================================================
  function renderSuccess() {
    const s = state.lastSubmission;
    if (!s) { route('hub'); return; }
    $('#successRef').textContent = s.reference;
    // Pending approval: hide the download button (no report yet)
    const dlBtn = $('#downloadPdfBtn');
    if (dlBtn) dlBtn.style.display = 'none';
    const heading = document.querySelector('#page-success .success-wrap h1');
    const para = document.querySelector('#page-success .success-wrap p');
    if (heading) heading.textContent = 'Submitted for Approval';
    if (para) para.textContent = 'Your entry has been logged and sent to the admin for review. The final report is generated once it’s approved.';
    $('#successRecipients').textContent = s.od_synced
      ? '✓ Logged to OneDrive · pending admin approval'
      : 'Saved · pending admin approval';
  }

  // ===================================================================
  //  ADMIN PANEL
  // ===================================================================
  const LEVEL_LABEL = { L1: 'Junior', L2: 'Senior', L3: 'Manager' };

  let adminTab = 'pending';

  async function renderAdmin() {
    if (!state.isAdmin) { toast('Admin access required', 'error'); route('hub'); return; }
    await Promise.all([loadPending(), loadSubmissions(), loadEmployees()]);
    drawPendingTable();
    drawSubmissionsTable();
    drawEmployeeTable();
    switchTab(adminTab);
  }

  function switchTab(tab) {
    adminTab = tab;
    $$('.admin-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    $$('.admin-tabpane').forEach(p => p.classList.toggle('active', p.id === 'tab-' + tab));
  }

  // ---- Pending approvals --------------------------------------------
  async function loadPending() {
    try {
      const res = await api('/api/admin/pending');
      state.adminPending = res.submissions || [];
    } catch (err) { state.adminPending = []; }
    const badge = $('#pendingBadge');
    if (badge) {
      badge.textContent = state.adminPending.length;
      badge.classList.toggle('zero', state.adminPending.length === 0);
    }
  }

  function drawPendingTable() {
    const tbody = $('#pendTableBody');
    if (!tbody) return;
    const q = ($('#pendSearch') ? $('#pendSearch').value : '').toLowerCase().trim();
    const rows = (state.adminPending || []).filter(s => {
      if (!q) return true;
      return [s.employee_name, s.reference, s.form_type, s.period].filter(Boolean).some(v => String(v).toLowerCase().includes(q));
    });
    $('#pendCount').textContent = `${rows.length} pending`;
    tbody.innerHTML = '';
    for (const s of rows) {
      tbody.appendChild(el('tr', {},
        el('td', {}, el('strong', {}, s.reference)),
        el('td', {}, s.employee_name),
        el('td', {}, FORM_LABEL[s.form_type] || s.form_type),
        el('td', {}, s.period || '—'),
        el('td', { class: 'num', style: 'text-align:right;' }, '₹ ' + fmt(s.total_amount)),
        el('td', {}, fmtDateShort(s.submitted_at)),
        el('td', {},
          el('div', { class: 'admin-actions' },
            el('button', { class: 'view', onclick: () => viewSubmission(s.id) }, 'View'),
            el('button', { class: 'approve', onclick: () => approveSubmission(s) }, 'Approve'),
            el('button', { class: 'reject', onclick: () => rejectSubmission(s) }, 'Reject')
          )
        )
      ));
    }
    if (!rows.length) tbody.appendChild(el('tr', {}, el('td', { colspan: 7, style: 'text-align:center;color:var(--bsg-muted);padding:32px;' }, q ? 'No matches.' : 'Nothing pending. ')));
  }

  // ---- All submissions ----------------------------------------------
  async function loadSubmissions() {
    const status = $('#subStatusFilter') ? $('#subStatusFilter').value : '';
    try {
      const res = await api('/api/admin/submissions' + (status ? `?status=${status}` : ''));
      state.adminSubmissions = res.submissions || [];
    } catch (err) { state.adminSubmissions = []; }
  }

  function drawSubmissionsTable() {
    const tbody = $('#subTableBody');
    if (!tbody) return;
    const q = ($('#subSearch') ? $('#subSearch').value : '').toLowerCase().trim();
    const rows = (state.adminSubmissions || []).filter(s => {
      if (!q) return true;
      return [s.employee_name, s.reference, s.status, s.form_type].filter(Boolean).some(v => String(v).toLowerCase().includes(q));
    });
    $('#subCount').textContent = `${rows.length} shown`;
    tbody.innerHTML = '';
    for (const s of rows) {
      tbody.appendChild(el('tr', {},
        el('td', {}, el('strong', {}, s.reference)),
        el('td', {}, s.employee_name),
        el('td', {}, FORM_LABEL[s.form_type] || s.form_type),
        el('td', {}, s.period || '—'),
        el('td', { class: 'num', style: 'text-align:right;' }, '₹ ' + fmt(s.total_amount)),
        el('td', {}, el('span', { class: 'status-pill ' + s.status }, s.status)),
        el('td', {}, fmtDateShort(s.submitted_at)),
        el('td', {},
          el('div', { class: 'admin-actions' },
            el('button', { class: 'view', onclick: () => viewSubmission(s.id) }, 'View'),
            s.status === 'pending' ? el('button', { class: 'approve', onclick: () => approveSubmission(s) }, 'Approve') : null,
            s.status === 'pending' ? el('button', { class: 'reject', onclick: () => rejectSubmission(s) }, 'Reject') : null
          )
        )
      ));
    }
    if (!rows.length) tbody.appendChild(el('tr', {}, el('td', { colspan: 8, style: 'text-align:center;color:var(--bsg-muted);padding:32px;' }, 'No submissions.')));
  }

  async function approveSubmission(s) {
    const ok = await confirmModal({
      title: 'Approve this claim?',
      body: `${s.employee_name} · ${s.reference} · ₹${fmt(s.total_amount)}. The final report (with bills merged) will be generated and stored in OneDrive under Reports/.`,
      confirmText: 'Approve',
    });
    if (!ok) return;
    showLoading('Approving & generating report…');
    try {
      const res = await api(`/api/admin/submissions/${s.id}/approve`, { method: 'POST', body: JSON.stringify({}) });
      toast(res.od_synced ? 'Approved · report stored in OneDrive' : 'Approved · OneDrive sync pending (will retry)', res.od_synced ? 'success' : 'warning');
      await Promise.all([loadPending(), loadSubmissions()]);
      drawPendingTable(); drawSubmissionsTable();
    } catch (err) {
      toast(err.message || 'Approval failed', 'error');
    } finally { hideLoading(); }
  }

  async function rejectSubmission(s) {
    const note = await promptModal({
      title: 'Reject this claim?',
      body: `${s.employee_name} · ${s.reference}. Optionally add a reason (logged + written to the Excel sheet).`,
      placeholder: 'Reason (optional)',
      confirmText: 'Reject',
    });
    if (note === null) return; // cancelled
    showLoading('Rejecting…');
    try {
      await api(`/api/admin/submissions/${s.id}/reject`, { method: 'POST', body: JSON.stringify({ note }) });
      toast('Rejected', 'success');
      await Promise.all([loadPending(), loadSubmissions()]);
      drawPendingTable(); drawSubmissionsTable();
    } catch (err) {
      toast(err.message || 'Rejection failed', 'error');
    } finally { hideLoading(); }
  }

  const FORM_LABEL = {
    met_local: 'Local Travel', met_cab: 'Cab Reimbursement',
    met_accommodation: 'Accommodation', met_outstation: 'Outstation',
    met_misc: 'Miscellaneous',
    bsc_conveyance: 'Local Conveyance', bsc_expense: 'Travel Expense',
  };
  function fmtDateShort(s) {
    if (!s) return '—';
    const d = new Date(s); return isNaN(d) ? s : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
  }

  async function loadEmployees() {
    const showInactive = $('#showInactive') && $('#showInactive').checked;
    try {
      const res = await api('/api/admin/employees' + (showInactive ? '?all=1' : ''));
      state.adminEmployees = res.employees || [];
    } catch (err) {
      toast(err.message || 'Failed to load employees', 'error');
      state.adminEmployees = [];
    }
  }

  function drawEmployeeTable() {
    const tbody = $('#empTableBody');
    if (!tbody) return;
    const q = ($('#empSearch') ? $('#empSearch').value : '').toLowerCase().trim();
    const rows = state.adminEmployees.filter(e => {
      if (!q) return true;
      return [e.name, e.email, e.designation, e.employee_code].filter(Boolean)
        .some(v => v.toLowerCase().includes(q));
    });

    $('#empCount').textContent = `${rows.length} shown · ${state.adminEmployees.length} total`;
    tbody.innerHTML = '';
    for (const e of rows) {
      const methodLabel = { microsoft: 'Microsoft', google: 'Google', password: 'Password' }[e.auth_method] || e.auth_method;
      const tr = el('tr', { class: e.is_active ? '' : 'inactive' },
        el('td', {}, el('strong', {}, e.name)),
        el('td', {}, e.email),
        el('td', {}, e.designation || '—'),
        el('td', {}, el('span', { class: 'lvl-badge ' + e.level }, `${e.level} · ${LEVEL_LABEL[e.level] || ''}`)),
        el('td', {}, el('span', { class: 'method-badge ' + e.auth_method }, methodLabel)),
        el('td', {},
          el('div', { class: 'admin-actions' },
            el('button', { class: 'edit', onclick: () => openEmployeeModal(e) }, 'Edit'),
            e.auth_method === 'password'
              ? el('button', { class: 'view', onclick: () => resetPassword(e) }, 'Reset PW')
              : null,
            e.is_active
              ? el('button', { class: 'del', onclick: () => deactivateEmployee(e) }, 'Deactivate')
              : el('button', { class: 'reactivate', onclick: () => reactivateEmployee(e) }, 'Reactivate')
          )
        )
      );
      tbody.appendChild(tr);
    }
    if (!rows.length) {
      tbody.appendChild(el('tr', {}, el('td', { colspan: 6, style: 'text-align:center;color:var(--bsg-muted);padding:32px;' }, q ? 'No matches.' : 'No employees yet.')));
    }
  }

  async function resetPassword(emp) {
    const ok = await confirmModal({
      title: 'Reset password?',
      body: `${emp.name}'s password will be reset to the default (Metfraa@123). They'll be asked to set a new one on next login.`,
      confirmText: 'Reset',
    });
    if (!ok) return;
    try {
      const res = await api(`/api/admin/employees/${emp.id}/reset-password`, { method: 'POST', body: JSON.stringify({}) });
      toast(`Password reset to ${res.password}`, 'success');
    } catch (err) { toast(err.message || 'Reset failed', 'error'); }
  }

  let editingEmployeeId = null;

  function openEmployeeModal(emp) {
    editingEmployeeId = emp ? emp.id : null;
    $('#empModalTitle').textContent = emp ? 'Edit Employee' : 'Add Employee';
    $('#empName').value = emp ? emp.name : '';
    $('#empEmail').value = emp ? emp.email : '';
    $('#empLevel').value = emp ? (LEVEL_LABEL[emp.level] || 'Junior').toUpperCase() : 'JUNIOR';
    $('#empCode').value = emp ? (emp.employee_code || '') : '';
    $('#empDesignation').value = emp ? (emp.designation || '') : '';
    $('#empDepartment').value = emp ? (emp.department || '') : '';
    $('#empManager').value = emp ? (emp.manager_email || '') : '';
    $('#empAuthMethod').value = emp ? (emp.auth_method || '') : '';
    updateAuthHint();
    $('#empModalBackdrop').classList.add('show');
  }
  function updateAuthHint() {
    const v = $('#empAuthMethod').value;
    const email = $('#empEmail').value.trim().toLowerCase();
    const hint = $('#empAuthHint');
    if (!hint) return;
    let msg = '';
    if (v === 'password' || (!v && email && !email.endsWith('@metfraa.com') && !email.endsWith('@gmail.com'))) {
      msg = 'Portal password — default Metfraa@123, user must change it on first login.';
    } else if (v === 'microsoft' || (!v && email.endsWith('@metfraa.com'))) {
      msg = 'Microsoft (M365) SSO — they sign in with their work account.';
    } else if (v === 'google' || (!v && email.endsWith('@gmail.com'))) {
      msg = 'Google SSO — they sign in with their Google account.';
    } else {
      msg = 'Auto: Microsoft for @metfraa.com, Google for @gmail.com, Password for everything else.';
    }
    hint.textContent = msg;
  }
  function closeEmployeeModal() {
    $('#empModalBackdrop').classList.remove('show');
    editingEmployeeId = null;
  }

  async function saveEmployee() {
    const payload = {
      name: $('#empName').value.trim(),
      email: $('#empEmail').value.trim(),
      level: $('#empLevel').value,
      employee_code: $('#empCode').value.trim(),
      designation: $('#empDesignation').value.trim(),
      department: $('#empDepartment').value.trim(),
      manager_email: $('#empManager').value.trim(),
      auth_method: $('#empAuthMethod').value || undefined,
    };
    if (!payload.name || !payload.email) { toast('Name and email are required', 'error'); return; }

    showLoading(editingEmployeeId ? 'Updating…' : 'Adding…');
    try {
      if (editingEmployeeId) {
        await api(`/api/admin/employees/${editingEmployeeId}`, { method: 'PUT', body: JSON.stringify(payload) });
        toast('Employee updated', 'success');
      } else {
        const res = await api('/api/admin/employees', { method: 'POST', body: JSON.stringify(payload) });
        if (res.default_password) {
          toast(`Added. Password login: default is ${res.default_password}`, 'success');
        } else {
          toast('Employee added', 'success');
        }
      }
      closeEmployeeModal();
      await loadEmployees();
      drawEmployeeTable();
    } catch (err) {
      toast(err.message || 'Save failed', 'error');
    } finally {
      hideLoading();
    }
  }

  async function deactivateEmployee(emp) {
    const ok = await confirmModal({
      title: 'Deactivate employee?',
      body: `${emp.name} will no longer be able to sign in. Their past submissions are kept. You can reactivate them later.`,
      confirmText: 'Deactivate',
    });
    if (!ok) return;
    try {
      await api(`/api/admin/employees/${emp.id}`, { method: 'DELETE' });
      toast('Employee deactivated', 'success');
      await loadEmployees();
      drawEmployeeTable();
    } catch (err) { toast(err.message || 'Failed', 'error'); }
  }

  async function reactivateEmployee(emp) {
    try {
      await api(`/api/admin/employees/${emp.id}`, { method: 'PUT', body: JSON.stringify({ name: emp.name, email: emp.email, level: emp.level, is_active: 1 }) });
      toast('Employee reactivated', 'success');
      await loadEmployees();
      drawEmployeeTable();
    } catch (err) { toast(err.message || 'Failed', 'error'); }
  }

  // ===================================================================
  //  EVENT WIRING
  // ===================================================================
  document.addEventListener('click', (e) => {
    // Nav links
    const navAttr = e.target.closest('[data-nav]');
    if (navAttr) {
      e.preventDefault();
      route(navAttr.dataset.nav);
      return;
    }
    // Close user menu when clicking outside
    if (!e.target.closest('#userChip')) {
      $('#userMenu').classList.remove('open');
    }
  });

  $('#userChip').addEventListener('click', (e) => {
    if (e.target.closest('form')) return; // logout button
    e.stopPropagation();
    $('#userMenu').classList.toggle('open');
  });

  $('#backToForm').addEventListener('click', () => route('form'));
  $('#submitFromPreview').addEventListener('click', () => submitForm());
  $('#backBtn') && $('#backBtn').addEventListener('click', goBack);

  $('#historyRefreshBtn') && $('#historyRefreshBtn').addEventListener('click', renderHistory);

  // Submission viewer modal
  $('#viewClose') && $('#viewClose').addEventListener('click', () => $('#viewBackdrop').classList.remove('show'));
  $('#viewBackdrop') && $('#viewBackdrop').addEventListener('click', (e) => { if (e.target.id === 'viewBackdrop') $('#viewBackdrop').classList.remove('show'); });
  $('#viewDownload') && $('#viewDownload').addEventListener('click', () => {
    if (viewCurrentId != null) window.open(`/api/submissions/${viewCurrentId}/pdf?download=1`, '_blank');
  });

  // Admin panel events
  $('#addEmpBtn') && $('#addEmpBtn').addEventListener('click', () => openEmployeeModal(null));
  $('#empModalCancel') && $('#empModalCancel').addEventListener('click', closeEmployeeModal);
  $('#empModalSave') && $('#empModalSave').addEventListener('click', saveEmployee);
  $('#empSearch') && $('#empSearch').addEventListener('input', drawEmployeeTable);
  $('#showInactive') && $('#showInactive').addEventListener('change', async () => { await loadEmployees(); drawEmployeeTable(); });
  $('#empModalBackdrop') && $('#empModalBackdrop').addEventListener('click', (e) => { if (e.target.id === 'empModalBackdrop') closeEmployeeModal(); });
  $('#empAuthMethod') && $('#empAuthMethod').addEventListener('change', updateAuthHint);
  $('#empEmail') && $('#empEmail').addEventListener('input', updateAuthHint);

  // Admin tab switching
  $$('.admin-tab').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));
  $('#adminRefreshBtn') && $('#adminRefreshBtn').addEventListener('click', async () => {
    showLoading('Refreshing…');
    try {
      await Promise.all([loadPending(), loadSubmissions(), loadEmployees()]);
      drawPendingTable(); drawSubmissionsTable(); drawEmployeeTable();
      toast('Refreshed', 'success');
    } catch (e) { toast('Refresh failed', 'error'); }
    finally { hideLoading(); }
  });
  // Pending + Submissions search / filter
  $('#pendSearch') && $('#pendSearch').addEventListener('input', drawPendingTable);
  $('#subSearch') && $('#subSearch').addEventListener('input', drawSubmissionsTable);
  $('#subStatusFilter') && $('#subStatusFilter').addEventListener('change', async () => { await loadSubmissions(); drawSubmissionsTable(); });

  boot();
})();
