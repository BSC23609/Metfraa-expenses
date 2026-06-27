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
    openAdvances: [],        // employee's open Travel Advances awaiting settlement
    settling: null,          // { advance: <row>, actual_amount: '', notes: '' } while user is settling
    projects: null,          // cached list of active projects for the Purpose+Project dropdown
    adminProjects: [],       // admin's view of all projects (active + inactive)
    editingProject: null,    // currently editing project (modal)
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
      { key: 'met_cab',           title: 'Cab Reimbursement',                 desc: 'Cab / taxi fare reimbursement for trips of 80 km or more (up & down combined).', icon: 'taxi' },
      { key: 'met_accommodation', title: 'Monthly Accommodation Reimbursement', desc: 'Site accommodation reimbursement.', icon: 'building' },
      { key: 'met_outstation',    title: 'Outstation Travel Reimbursement',  desc: 'Inter-city official travel.', icon: 'briefcase' },
      { key: 'met_misc',          title: 'Miscellaneous Reimbursements',      desc: 'Any other work expense — date, purpose, amount + bill.', icon: 'receipt' },
      { key: 'met_advance',       title: 'Travel Advance Request',            desc: 'Request an upfront amount for an upcoming official trip.', icon: 'briefcase' },
      { key: 'met_dtr',           title: 'Daily Travel Reimbursement',        desc: 'Daily commute — Bus / Bike Taxi / Auto / Share Auto. Submit at month end.', icon: 'bike' },
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
  function promptModal({ title, body, placeholder = '', confirmText = 'Confirm', required = false, textarea = false }) {
    return new Promise(resolve => {
      $('#modalTitle').textContent = title;
      $('#modalBody').textContent = body;
      const r = $('#modalRecipient');
      r.style.display = 'block';
      r.innerHTML = '';
      // Use a textarea for long-form responses (e.g. "what needs to change"
      // explanations from HR) — required reasons usually run multiple lines.
      const useTextarea = textarea || required;
      const input = useTextarea
        ? el('textarea', {
            placeholder, rows: 3,
            style: 'width:100%;font-family:Inter,sans-serif;font-size:14px;padding:11px 14px;border:1px solid var(--bsg-line);border-radius:3px;background:#fff;resize:vertical;min-height:80px;',
          })
        : el('input', {
            type: 'text', placeholder,
            style: 'width:100%;font-family:Inter,sans-serif;font-size:14px;padding:11px 14px;border:1px solid var(--bsg-line);border-radius:3px;background:#fff;',
          });
      r.appendChild(input);
      $('#modalConfirm').textContent = confirmText;
      const confirmBtn = $('#modalConfirm');
      // For 'required' fields, keep the confirm button disabled until the
      // user types something so the form can't be submitted blank.
      if (required) {
        confirmBtn.disabled = true;
        confirmBtn.style.opacity = '0.55';
        confirmBtn.style.cursor = 'not-allowed';
        input.oninput = () => {
          const ok = !!input.value.trim();
          confirmBtn.disabled = !ok;
          confirmBtn.style.opacity = ok ? '' : '0.55';
          confirmBtn.style.cursor = ok ? '' : 'not-allowed';
        };
      }
      const bk = $('#modalBackdrop');
      bk.classList.add('show');
      setTimeout(() => input.focus(), 50);
      const done = (v) => {
        bk.classList.remove('show');
        confirmBtn.onclick = null;
        $('#modalCancel').onclick  = null;
        confirmBtn.disabled = false;
        confirmBtn.style.opacity = '';
        confirmBtn.style.cursor = '';
        r.innerHTML = '';
        r.style.display = 'none';
        resolve(v);
      };
      confirmBtn.onclick = () => {
        const v = input.value.trim();
        if (required && !v) { input.focus(); return; }
        done(v);
      };
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
      pill.textContent = statusLabel(s.status);
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
    const PURPOSE_NAMES = { project_visit: 'Project Visit', site_visit: 'Site Visit', sales_visit: 'Sales Visit', metfraa_office: 'Visit to Metfraa - Office', metfraa_factory: 'Visit to Metfraa - Factory', purchase_visit: 'Purchase Visit' };
    const purposeText = PURPOSE_NAMES[s.purpose_category] || '—';
    let projectText = '—';
    if (s.project) projectText = s.project.code && s.project.code !== s.project.name ? `${s.project.name} (${s.project.code})` : s.project.name;
    else if (s.client_name) projectText = `${s.client_name} (Prospect)`;

    const meta = el('div', { class: 'vd-grid' },
      detailRow('Employee', s.employee.name),
      detailRow('Code', s.employee.code),
      detailRow('Level', s.employee.level),
      detailRow('Purpose', purposeText),
      detailRow('Project', projectText),
      detailRow('Period', p.period || s.period),
      detailRow('Submitted', fmtDateShort(s.submitted_at)),
      detailRow('Status', statusLabel(s.status).replace(/^./, c => c.toUpperCase())),
    );
    wrap.appendChild(meta);

    // If HR has sent this back for edits, surface the message + an
    // action button right under the meta grid so the owner can fix it.
    if (s.status === 'draft' && s.changes_required) {
      const ownsIt = state.user && s.employee && s.employee.email && state.user.email
        && s.employee.email.toLowerCase() === state.user.email.toLowerCase();
      const banner = el('div', { class: 'draft-banner', style: 'margin: 16px 0;' },
        el('div', { class: 'dbl' }, 'What needs to change'),
        el('div', { class: 'dbm' }, s.changes_required),
        el('div', { class: 'dbs' },
          `Sent back by ${s.reviewed_by || 'HR'}`,
          s.returned_at ? ' · ' + new Date(s.returned_at.replace(' ', 'T') + (s.returned_at.endsWith('Z') ? '' : 'Z')).toLocaleString('en-IN') : ''
        )
      );
      if (ownsIt) {
        banner.appendChild(el('button', {
          class: 'btn',
          style: 'margin-top:10px;background:#d97706;color:#fff;border:0;padding:9px 18px;border-radius:3px;font-weight:600;font-size:13px;cursor:pointer;',
          onclick: () => { $('#viewBackdrop').classList.remove('show'); openDraftForEdit(s.id); },
        }, 'Edit & Resubmit →'));
      }
      wrap.appendChild(banner);
    }

    if (s.reviewed_by) {
      const reviewedLabel = s.form_type === 'met_advance'
        ? (s.status === 'rejected' ? 'Rejected' : 'Advance approved')
        : (s.status === 'approved' ? 'Approved' : (s.status === 'draft' ? 'Sent back for edits' : 'Reviewed'));
      wrap.appendChild(el('div', { class: 'vd-review' },
        `${reviewedLabel} by ${s.reviewed_by}${s.reviewed_at ? ' · ' + fmtDateShort(s.reviewed_at) : ''}${s.review_note ? ' · "' + s.review_note + '"' : ''}`
      ));
    }
    // Settlement block (only for travel advances that have been settled or are awaiting settlement review)
    if (s.form_type === 'met_advance' && s.actuals) {
      const a = s.actuals;
      const diff = a.difference;
      const diffText = Math.abs(diff) < 0.01
        ? 'Balanced — no money changes hands.'
        : (diff < 0
            ? `Employee to return ₹ ${fmt(Math.abs(diff))} to the company.`
            : `Company to reimburse employee an additional ₹ ${fmt(diff)}.`);
      wrap.appendChild(el('div', { class: 'vd-settlement' },
        el('div', { class: 'vd-label' }, 'Settlement'),
        el('div', { class: 'vd-grid' },
          el('div', { class: 'vd-cell' },
            el('div', { class: 'vd-label' }, 'Advance'),
            el('div', { class: 'vd-value' }, '₹ ' + fmt(a.advance_amount))
          ),
          el('div', { class: 'vd-cell' },
            el('div', { class: 'vd-label' }, 'Actual spent'),
            el('div', { class: 'vd-value' }, '₹ ' + fmt(a.actual_amount))
          ),
          el('div', { class: 'vd-cell' },
            el('div', { class: 'vd-label' }, 'Settled at'),
            el('div', { class: 'vd-value' }, s.settled_at ? fmtDateShort(s.settled_at) : '—')
          )
        ),
        el('div', { class: 'vd-diff ' + (Math.abs(diff) < 0.01 ? 'balanced' : (diff < 0 ? 'to-return' : 'to-claim')) }, diffText),
        a.notes ? el('div', { style: 'margin-top:8px;font-size:13px;color:var(--bsg-muted);' }, 'Notes: ' + a.notes) : null
      ));
      if (s.settlement_reviewed_by) {
        wrap.appendChild(el('div', { class: 'vd-review' },
          `Settlement ${s.status === 'settled' ? 'approved' : 'rejected'} by ${s.settlement_reviewed_by}${s.settlement_reviewed_at ? ' · ' + fmtDateShort(s.settlement_reviewed_at) : ''}${s.settlement_note ? ' · "' + s.settlement_note + '"' : ''}`
        ));
      }
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
    } else if (s.form_type === 'met_advance') {
      head(['Field', 'Detail']);
      const rows = [
        ['Destination',    p.destination || '—'],
        ['Travel from',    formatDate(p.travel_from)],
        ['Travel to',      formatDate(p.travel_to)],
        ['Mode of travel', p.mode || 'Not specified'],
        ['Purpose',        p.purpose || '—'],
      ];
      if (p.notes) rows.push(['Notes', p.notes]);
      rows.forEach(([label, val]) => body.appendChild(el('tr', {},
        el('td', { style: 'font-weight:600;width:30%;' }, label),
        el('td', {}, val)
      )));
    } else if (s.form_type === 'met_dtr') {
      const MODE_LABEL = { bus: 'Bus', bike_taxi: 'Bike Taxi', auto: 'Auto', share_auto: 'Share Auto' };
      const PURPOSE_LABEL = { project_visit: 'Project Visit', site_visit: 'Site Visit', sales_visit: 'Sales Visit', metfraa_office: 'Visit to Metfraa - Office', metfraa_factory: 'Visit to Metfraa - Factory', purchase_visit: 'Purchase Visit' };
      // Project lookup map sent down on the submission (server resolves project IDs to names)
      const projLookup = s.dtr_project_lookup || {};
      head(['Date', 'Mode', 'From → To', 'Purpose', 'Project', 'Bill', 'Fare']);
      (p.entries || []).forEach(e => {
        let project = '—';
        if (e.project_id != null && projLookup[e.project_id]) {
          const pr = projLookup[e.project_id];
          project = pr.code && pr.code !== pr.name ? `${pr.name} (${pr.code})` : pr.name;
        } else if (e.client_name) {
          project = `${e.client_name} (Prospect)`;
        }
        body.appendChild(el('tr', {},
          el('td', {}, formatDate(e.date)),
          el('td', {}, MODE_LABEL[e.mode] || e.mode),
          el('td', {}, (e.from || '—') + ' → ' + (e.to || '—')),
          el('td', {}, PURPOSE_LABEL[e.purpose_category] || '—'),
          el('td', {}, project),
          el('td', {}, e.mode === 'bus' ? '—' : '✓'),
          el('td', { class: 'num' }, money(e.fare))
        ));
      });
    }
    t.appendChild(body);
    wrap.appendChild(t);

    // Total
    const totalLabel = s.form_type === 'met_advance'
      ? 'Advance Amount Requested'
      : 'Total Reimbursement Claim';
    wrap.appendChild(el('div', { class: 'vd-total' },
      el('span', {}, totalLabel),
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
      const levelName = { L1: 'Junior', L2: 'Senior', L3: 'Managerial' }[u.level] || u.level;
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
    openAdvances: renderOpenAdvances,
    settleAdvance: renderSettleAdvance,
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
      // Keep the drafts cache in sync so the hub badge reflects reality
      state.draftSubmissions = rows.filter(s => s.status === 'draft');
      tbody.innerHTML = '';
      if (!rows.length) {
        tbody.appendChild(el('tr', {}, el('td', { colspan: 7, style: 'text-align:center;color:var(--bsg-muted);padding:32px;' }, 'No submissions yet.')));
        return;
      }
      for (const s of rows) {
        const isDraft = s.status === 'draft';
        const actions = el('div', { class: 'admin-actions' },
          el('button', { class: 'view', onclick: () => viewSubmission(s.id) }, 'View')
        );
        if (isDraft) {
          actions.appendChild(el('button', {
            class: 'approve',
            style: 'background:#d97706;border-color:#d97706;',
            onclick: () => openDraftForEdit(s.id),
          }, 'Edit & Resubmit'));
        }
        tbody.appendChild(el('tr', { class: isDraft ? 'row-draft' : '' },
          el('td', {}, el('strong', {}, s.reference)),
          el('td', {}, FORM_LABEL[s.form_type] || s.form_type),
          el('td', {}, s.period || '—'),
          el('td', { class: 'num', style: 'text-align:right;' }, '₹ ' + fmt(s.total_amount)),
          el('td', {}, el('span', { class: 'status-pill ' + s.status }, statusLabel(s.status))),
          el('td', {}, fmtDateShort(s.submitted_at)),
          el('td', {}, actions)
        ));
      }
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--bsg-danger);padding:24px;">${err.message || 'Failed to load'}</td></tr>`;
    }
  }

  // ===================================================================
  //  OPEN ADVANCES  (employee: list of approved advances awaiting settle)
  // ===================================================================
  async function renderOpenAdvances() {
    const root = $('#openAdvList');
    if (!root) return;
    root.innerHTML = '<div style="padding:30px;text-align:center;color:var(--bsg-muted);">Loading…</div>';
    try {
      const res = await api('/api/submissions/open-advances');
      const list = res.advances || [];
      state.openAdvances = list;
      root.innerHTML = '';
      if (!list.length) {
        root.appendChild(el('div', { class: 'card', style: 'text-align:center;color:var(--bsg-muted);padding:48px;' },
          'You have no open advances at the moment.'
        ));
        return;
      }
      for (const adv of list) {
        const p = adv.payload || {};
        const isPending  = adv.status === 'pending';
        const isRejected = adv.status === 'settlement_rejected';
        const canSettle  = !isPending; // only after admin approves the advance
        const card = el('div', { class: 'card advance-list-card' });
        card.appendChild(el('div', { class: 'adv-row-head' },
          el('div', {},
            el('div', { class: 'adv-ref' }, adv.reference),
            el('div', { class: 'adv-dest' }, p.destination || '—',
              p.travel_from ? el('span', { class: 'adv-dates' }, ` · ${formatDate(p.travel_from)} – ${formatDate(p.travel_to)}`) : null
            )
          ),
          el('div', { class: 'adv-amt' },
            el('span', { class: 'adv-amt-lbl' }, isPending ? 'Requested' : 'Advance'),
            el('span', { class: 'adv-amt-val' }, '₹ ' + fmt(adv.total_amount))
          )
        ));
        if (p.purpose) {
          card.appendChild(el('div', { class: 'adv-purpose' }, p.purpose));
        }
        // Status pill class + label vary by state
        let pillClass = 'approved';
        let pillLabel = 'advance approved · awaiting settlement';
        if (isPending)  { pillClass = 'pending';  pillLabel = 'awaiting admin approval'; }
        if (isRejected) { pillClass = 'rejected'; pillLabel = 'settlement rejected — resubmit'; }

        const actions = el('div', { class: 'admin-actions' },
          el('button', { class: 'view', onclick: () => viewSubmission(adv.id) }, 'View')
        );
        if (canSettle) {
          actions.appendChild(el('button', { class: 'approve', onclick: () => startSettle(adv) }, 'Settle'));
        }
        card.appendChild(el('div', { class: 'adv-row-foot' },
          el('div', {}, el('span', { class: 'status-pill ' + pillClass }, pillLabel)),
          actions
        ));
        root.appendChild(card);
      }
    } catch (err) {
      root.innerHTML = `<div class="card" style="color:var(--bsg-danger);text-align:center;padding:30px;">${err.message || 'Failed to load open advances.'}</div>`;
    }
  }

  function startSettle(advance) {
    state.settling = { advance, actual_amount: '', notes: '' };
    state.uploadToken = uuid();
    state.uploads = [];
    route('settleAdvance');
  }

  function renderSettleAdvance() {
    if (!state.settling) { route('openAdvances'); return; }
    const adv = state.settling.advance;
    const p = adv.payload || {};

    // Summary card
    const summary = $('#settleAdvanceSummary');
    summary.innerHTML = '';
    summary.appendChild(el('div', { class: 'card-title' }, 'Advance Being Settled'));
    summary.appendChild(el('div', { class: 'vd-grid' },
      el('div', { class: 'vd-cell' },
        el('div', { class: 'vd-label' }, 'Reference'),
        el('div', { class: 'vd-value' }, adv.reference)
      ),
      el('div', { class: 'vd-cell' },
        el('div', { class: 'vd-label' }, 'Destination'),
        el('div', { class: 'vd-value' }, p.destination || '—')
      ),
      el('div', { class: 'vd-cell' },
        el('div', { class: 'vd-label' }, 'Travel Dates'),
        el('div', { class: 'vd-value' }, p.travel_from ? `${formatDate(p.travel_from)} – ${formatDate(p.travel_to)}` : '—')
      ),
      el('div', { class: 'vd-cell' },
        el('div', { class: 'vd-label' }, 'Advance Approved'),
        el('div', { class: 'vd-value' }, '₹ ' + fmt(adv.total_amount))
      )
    ));

    // Wire inputs
    const actualInput = $('#settleActual');
    const notesInput  = $('#settleNotes');
    actualInput.value = state.settling.actual_amount || '';
    notesInput.value  = state.settling.notes || '';
    actualInput.oninput = (e) => { state.settling.actual_amount = e.target.value; updateSettleDifference(); };
    notesInput.oninput  = (e) => { state.settling.notes = e.target.value; };

    updateSettleDifference();
    refreshSettleUploadList();
    bindSettleUploadZone();

    $('#settleSubmitBtn').onclick = submitSettlement;
  }

  function updateSettleDifference() {
    const diffEl = $('#settleDifference');
    if (!diffEl || !state.settling) return;
    const advance = state.settling.advance.total_amount;
    const actual = parseFloat(state.settling.actual_amount) || 0;
    if (!state.settling.actual_amount) {
      diffEl.innerHTML = '';
      return;
    }
    const diff = +(actual - advance).toFixed(2);
    if (Math.abs(diff) < 0.01) {
      diffEl.className = 'settle-diff balanced';
      diffEl.innerHTML = `<strong>Balanced.</strong> Actual exactly matches the advance — no money changes hands.`;
    } else if (diff < 0) {
      diffEl.className = 'settle-diff to-return';
      diffEl.innerHTML = `<strong>To return:</strong> ₹ ${fmt(Math.abs(diff))} (advance was ₹ ${fmt(advance)}, you spent ₹ ${fmt(actual)}).`;
    } else {
      diffEl.className = 'settle-diff to-claim';
      diffEl.innerHTML = `<strong>To be reimbursed:</strong> ₹ ${fmt(diff)} (advance was ₹ ${fmt(advance)}, you spent ₹ ${fmt(actual)}).`;
    }
  }

  // Mini upload zone for the settlement page (separate from the form's main zone)
  function refreshSettleUploadList() {
    const list = $('#settleUploadList'); if (!list) return;
    list.innerHTML = '';
    for (const u of state.uploads) {
      list.appendChild(el('div', { class: 'upload-item' },
        el('span', { class: 'name' }, u.filename),
        el('button', { class: 'remove', onclick: async () => {
          try {
            await api(`/api/uploads/${u.id}?token=${encodeURIComponent(state.uploadToken)}`, { method: 'DELETE' });
            state.uploads = state.uploads.filter(x => x.id !== u.id);
            refreshSettleUploadList();
          } catch (e) { toast(e.message || 'Could not remove', 'error'); }
        } }, '×')
      ));
    }
  }

  function bindSettleUploadZone() {
    const zone = $('#settleUploadZone');
    const input = $('#settleFileInput');
    if (!zone || !input) return;
    zone.onclick = () => input.click();
    input.onchange = async () => {
      if (!input.files || !input.files.length) return;
      const fd = new FormData();
      fd.append('upload_token', state.uploadToken);
      for (const f of input.files) fd.append('files', f);
      try {
        showLoading('Uploading bills…');
        const res = await api('/api/uploads', { method: 'POST', body: fd });
        for (const up of res.uploads || []) state.uploads.push(up);
        refreshSettleUploadList();
      } catch (e) {
        toast(e.message || 'Upload failed', 'error');
      } finally {
        hideLoading();
        input.value = '';
      }
    };
    zone.ondragover = (e) => { e.preventDefault(); zone.classList.add('drag'); };
    zone.ondragleave = () => zone.classList.remove('drag');
    zone.ondrop = (e) => {
      e.preventDefault(); zone.classList.remove('drag');
      input.files = e.dataTransfer.files; input.onchange();
    };
  }

  async function submitSettlement() {
    const st = state.settling;
    if (!st) return;
    const actual = parseFloat(st.actual_amount);
    if (!(actual >= 0)) { toast('Actual amount spent is required.', 'error'); return; }
    if (!state.uploads.length) { toast('Attach at least one bill before submitting.', 'error'); return; }

    try {
      showLoading('Submitting settlement…');
      const res = await api(`/api/submissions/${st.advance.id}/settle`, {
        method: 'POST',
        body: JSON.stringify({
          upload_token: state.uploadToken,
          actuals: { actual_amount: actual, notes: st.notes || '' },
        }),
      });
      toast('Settlement filed. Awaiting admin approval.', 'success');
      state.settling = null;
      state.uploadToken = null;
      state.uploads = [];
      route('openAdvances');
    } catch (e) {
      toast(e.message || 'Settlement failed', 'error');
    } finally {
      hideLoading();
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

    // "Action required" banner — surfaces submissions HR sent back for
    // edits. Card is mounted hidden and populated by an async refresh so
    // we don't block the hub render on a network call.
    const draftsCard = el('div', { class: 'option-card drafts-card', id: 'draftsCard', style: 'display:none;', onclick: () => route('history') },
      el('div', { class: 'icon-wrap drafts-icon', html: ICONS.receipt || ICONS.briefcase }),
      el('h3', {},
        'Action required',
        el('span', { class: 'card-badge drafts-badge', id: 'draftsBadge' }, '0')
      ),
      el('p', { id: 'draftsCardDesc' }, 'Submissions HR sent back for edits. Open one to see what to fix and resubmit.'),
      el('div', { class: 'arrow' }, el('span', {}, 'Review'), el('div', { html: ICONS.arrow }))
    );
    grid.appendChild(draftsCard);
    refreshDraftsCount();

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
    // Open Advances card (only visible if the user has any open advances)
    const openAdvCard = el('div', { class: 'option-card advance-card', id: 'openAdvancesCard', style: 'display:none;', onclick: () => route('openAdvances') },
      el('div', { class: 'icon-wrap', html: ICONS.briefcase }),
      el('h3', {},
        'Open Travel Advances',
        el('span', { class: 'card-badge', id: 'openAdvBadge' }, '0')
      ),
      el('p', {}, 'Track and settle your travel advances. Pending advances awaiting approval are listed here too.'),
      el('div', { class: 'arrow' }, el('span', {}, 'Settle'), el('div', { html: ICONS.arrow }))
    );
    grid.appendChild(openAdvCard);
    // Async: load count + show card if > 0
    refreshOpenAdvancesCount();
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

  // Fetch and display the open-advances count on the hub
  async function refreshOpenAdvancesCount() {
    try {
      const res = await api('/api/submissions/open-advances');
      const list = res.advances || [];
      state.openAdvances = list;
      const card = $('#openAdvancesCard');
      const badge = $('#openAdvBadge');
      if (!card || !badge) return;
      badge.textContent = list.length;
      card.style.display = list.length > 0 ? '' : 'none';
    } catch (_) { /* not fatal; just hide */ }
  }

  // Hub "Action required" card — shows count of submissions that HR sent
  // back to the employee for edits (status='draft' with changes_required).
  // Drafts are also cached so the history page can mark them without a
  // second network call.
  async function refreshDraftsCount() {
    try {
      const res = await api('/api/submissions');
      const all = res.submissions || [];
      const drafts = all.filter(s => s.status === 'draft');
      state.draftSubmissions = drafts;
      const card = $('#draftsCard');
      const badge = $('#draftsBadge');
      if (!card || !badge) return;
      badge.textContent = drafts.length;
      card.style.display = drafts.length > 0 ? '' : 'none';
      const desc = $('#draftsCardDesc');
      if (desc) {
        desc.textContent = drafts.length === 1
          ? '1 submission was sent back for edits. Open it to see what to fix.'
          : `${drafts.length} submissions were sent back for edits. Open them to see what to fix.`;
      }
    } catch (_) { /* not fatal */ }
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
    // Every form now starts with categorization fields. They're stored on
    // formData but stripped from the payload at submit time.
    state.formData.purpose_category = '';
    state.formData.project_id = '';
    state.formData.client_name = '';
    state.uploadToken = uuid();
    state.uploads = [];
    state.editingSubmissionId = null;   // fresh submission, not an edit
    state.editingDraftMeta = null;
    // Ensure projects are loaded (cached on state.projects)
    loadProjectsIfNeeded();
    route('form');
  }

  // Open a returned-for-edit draft submission in the form view. Re-uses
  // the standard form pipeline — seeds state.formData from the saved
  // payload, clones the existing attachments into pending uploads so the
  // user can keep/remove them, and flags state.editingSubmissionId so
  // submitForm() routes to PATCH instead of POST.
  async function openDraftForEdit(submissionId) {
    showLoading('Opening for edit…');
    try {
      // 1) Load the full submission detail
      const { submission: s } = await api(`/api/submissions/${submissionId}`);
      if (s.status !== 'draft') {
        toast('This submission is not in draft status and cannot be edited.', 'error');
        return;
      }
      state.currentForm = s.form_type;
      state.editingSubmissionId = s.id;
      state.editingDraftMeta = {
        reference: s.reference,
        changes_required: s.changes_required || '',
        returned_at: s.returned_at,
        reviewed_by: s.reviewed_by,
      };
      // 2) Seed the form's working state from the saved payload. The
      //    payload mirrors what initFormData(formKey) would produce, plus
      //    the submission-level categorization fields the validator
      //    stripped before persisting.
      const fresh = initFormData(s.form_type);
      state.formData = { ...fresh, ...(s.payload || {}) };
      state.formData.purpose_category = s.purpose_category || '';
      state.formData.project_id = s.project ? s.project.id : '';
      state.formData.client_name = s.client_name || '';

      // 3) Fresh upload token; ask the server to clone the existing
      //    attachments into the new token's pending pool so they appear
      //    in the upload list. Employee can remove any; new uploads use
      //    the same token.
      state.uploadToken = uuid();
      state.uploads = [];
      try {
        const cloneRes = await api(`/api/submissions/${s.id}/clone-attachments`, {
          method: 'POST',
          body: JSON.stringify({ upload_token: state.uploadToken }),
        });
        state.uploads = cloneRes.uploads || [];
      } catch (e) {
        console.error('[clone-attachments]', e);
        // Non-fatal — user can still resubmit; they'll just need to re-attach bills
      }

      // For DTR, re-link entry.bill_pending_id to the new pending upload
      // ids (the cloned ones expose original_attachment_id + row_idx).
      if (s.form_type === 'met_dtr' && Array.isArray(state.formData.entries)) {
        for (let i = 0; i < state.formData.entries.length; i++) {
          const e = state.formData.entries[i];
          if (!e || e.mode === 'bus') continue;
          // Find the cloned upload that has this row_idx
          const cloned = state.uploads.find(u => u.row_idx === i);
          if (cloned) {
            e.bill_pending_id = cloned.id;
            e.bill_filename = cloned.filename;
          }
        }
      }

      loadProjectsIfNeeded();
      route('form');
    } catch (err) {
      toast(err.message || 'Could not open for edit', 'error');
    } finally {
      hideLoading();
    }
  }

  // Projects (fetched once per session; refreshed when admin changes the list)
  async function loadProjectsIfNeeded() {
    if (Array.isArray(state.projects) && state.projects.length) return;
    try {
      const res = await api('/api/projects');
      state.projects = res.projects || [];
      // If the form is already rendered, refresh the project dropdown
      const sel = $('#ppProjectSel');
      if (sel) populateProjectOptions(sel);
    } catch (_) { state.projects = []; }
  }

  function populateProjectOptions(sel) {
    const current = sel.value;
    sel.innerHTML = '<option value="">— Select project —</option>';
    for (const p of (state.projects || [])) {
      const opt = document.createElement('option');
      opt.value = String(p.id);
      opt.textContent = p.code && p.code !== p.name ? `${p.name} (${p.code})` : p.name;
      sel.appendChild(opt);
    }
    if (current) sel.value = current;
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
      case 'met_advance':
        return {
          period,
          destination: '',
          travel_from: '',
          travel_to: '',
          mode: '',
          purpose: '',
          notes: '',
          amount: '',
        };
      case 'met_dtr':
        // Daily Travel Reimbursement — month-long collection of commute trips.
        // Each entry has its own purpose/project + (for non-bus modes) a bill.
        return {
          period, // YYYY-MM, defaults to current month
          entries: [makeBlankDtrEntry()],
        };
    }
  }

  function makeBlankDtrEntry() {
    return {
      date: '', mode: '', from: '', to: '', fare: '', remarks: '',
      purpose_category: '', project_id: '', client_name: '',
      bill_pending_id: null,   // upload id for the row's bill (non-bus only)
      bill_filename: null,     // display only
    };
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
    met_advance:    'Travel Advance Request',
    met_dtr:        'Daily Travel Reimbursement',
  };

  function renderForm() {
    $('#formTitle').textContent = FORM_TITLES[state.currentForm] || 'Form';
    const body = $('#formBody');
    body.innerHTML = '';

    // entitlement banner per form
    renderEntitlementBanner();

    // Travel Advance is pre-trip — no bills yet, no item-list total to live-update.
    // DTR has its OWN per-row uploads, not the form-level zone.
    const isAdvance = state.currentForm === 'met_advance';
    const isDtr     = state.currentForm === 'met_dtr';
    $('#uploadSection').style.display = (isAdvance || isDtr) ? 'none' : '';
    $('#summaryBar').style.display    = isAdvance ? 'none' : '';

    switch (state.currentForm) {
      case 'bsc_conveyance': renderConveyanceForm(body, 'bsc'); break;
      case 'met_local':      renderConveyanceForm(body, 'metfraa'); break;
      case 'bsc_expense':    renderExpenseForm(body, 'bsc'); break;
      case 'met_outstation': renderExpenseForm(body, 'metfraa'); break;
      case 'met_cab':        renderCabForm(body); break;
      case 'met_misc':       renderMiscForm(body); break;
      case 'met_advance':    renderAdvanceForm(body); break;
      case 'met_dtr':        renderDtrForm(body); break;
      case 'met_accommodation': renderAccommodationForm(body); break;
    }

    // DTR has per-row categorization — skip the submission-level card.
    if (!isDtr) {
      const ppCard = buildPurposeProjectCard();
      body.insertBefore(ppCard, body.firstChild);
    }

    // Edit mode: pin a banner showing HR's "what to change" note above
    // everything else so the employee can't miss it. Updates the page
    // title and submit button label to match.
    if (state.editingSubmissionId && state.editingDraftMeta) {
      const m = state.editingDraftMeta;
      const banner = el('div', { class: 'draft-banner' },
        el('div', { class: 'dbl' }, 'What needs to change'),
        el('div', { class: 'dbm' }, m.changes_required || '(No specific message provided)'),
        el('div', { class: 'dbs' },
          `Sent back by ${m.reviewed_by || 'HR'}`,
          m.returned_at ? ' · ' + new Date(m.returned_at.replace(' ', 'T') + (m.returned_at.endsWith('Z') ? '' : 'Z')).toLocaleString('en-IN') : ''
        )
      );
      body.insertBefore(banner, body.firstChild);
      $('#formTitle').textContent = `Edit · ${m.reference}`;
      if ($('#submitBtn')) $('#submitBtn').textContent = 'Resubmit';
    } else if ($('#submitBtn')) {
      $('#submitBtn').textContent = 'Submit';
    }

    refreshUploadList();
    updateSummary();

    // Bind submit/preview
    $('#previewBtn').onclick = () => { if (validateForm()) route('preview'); };
    $('#submitBtn').onclick  = () => submitForm();

    bindUploadZone();
  }

  // -----------------------------------------------------------------
  //  Purpose + Project card — shown at the top of EVERY form.
  //  - Purpose is required (Project Visit / Site Visit / Sales Visit).
  //  - For Project / Site Visit, a Project from the active list is required.
  //  - For Sales Visit, the employee can either pick a project (existing
  //    client) OR type a Client / Prospect name (free text).
  // -----------------------------------------------------------------
  function buildPurposeProjectCard() {
    const fd = state.formData;
    const card = el('div', { class: 'card purpose-project-card' },
      el('div', { class: 'card-title' }, 'Purpose & Project')
    );

    const grid = el('div', { class: 'field-grid' });

    // Purpose dropdown
    const purposeField = el('div', { class: 'field' },
      el('label', { for: 'ppPurposeSel' }, 'Purpose ', el('span', { class: 'req' }, '*'))
    );
    const purposeSel = el('select', { id: 'ppPurposeSel' });
    purposeSel.innerHTML = '<option value="">— Select purpose —</option>'
      + '<option value="project_visit">Project Visit</option>'
      + '<option value="site_visit">Site Visit</option>'
      + '<option value="sales_visit">Sales Visit</option>'
      + '<option value="metfraa_office">Visit to Metfraa - Office</option>'
      + '<option value="metfraa_factory">Visit to Metfraa - Factory</option>' + '<option value="purchase_visit">Purchase Visit</option>';
    purposeSel.value = fd.purpose_category || '';
    purposeSel.onchange = (e) => {
      // Clear any stale project / client picks when switching purpose —
      // avoids carrying over a Project selection into a Sales Visit etc.
      const prev = fd.purpose_category;
      fd.purpose_category = e.target.value;
      if (prev !== e.target.value) {
        fd.project_id = '';
        fd.client_name = '';
      }
      // Re-render this card to reveal / hide the Project & Client fields.
      const newCard = buildPurposeProjectCard();
      card.replaceWith(newCard);
    };
    purposeField.appendChild(purposeSel);
    grid.appendChild(purposeField);

    const hasPurpose = !!fd.purpose_category;
    const isSales = fd.purpose_category === 'sales_visit';
    const isInternal = fd.purpose_category === 'metfraa_office' || fd.purpose_category === 'metfraa_factory';
    const projectOptional = isSales || isInternal;

    // Project dropdown — only show once purpose has been picked.
    if (hasPurpose) {
      let projLabelText = 'Project';
      if (isSales)    projLabelText = 'Project (optional for Sales Visit)';
      if (isInternal) projLabelText = 'Project (optional — internal visit)';
      const projField = el('div', { class: 'field' },
        el('label', { for: 'ppProjectSel' }, projLabelText, ' ', projectOptional ? null : el('span', { class: 'req' }, '*'))
      );
      const projectSel = el('select', { id: 'ppProjectSel' });
      populateProjectOptions(projectSel);
      projectSel.value = fd.project_id || '';
      projectSel.onchange = (e) => {
        fd.project_id = e.target.value;
        if (e.target.value) fd.client_name = '';
      };
      projField.appendChild(projectSel);
      grid.appendChild(projField);
    }

    card.appendChild(grid);

    if (!hasPurpose) {
      // Helpful prompt while waiting for the purpose pick
      card.appendChild(el('div', {
        style: 'margin-top:10px;padding:10px 12px;background:#f6f8fa;border-radius:3px;font-size:12px;color:var(--bsg-muted);'
      }, 'Select a purpose above to choose the project.'));
    } else if (isInternal) {
      // Internal visit — destination is implicit (own office / factory).
      card.appendChild(el('div', {
        style: 'margin-top:10px;padding:10px 12px;background:rgba(37,99,235,0.06);border-radius:3px;font-size:12px;color:var(--bsg-blue);'
      }, fd.purpose_category === 'metfraa_office'
          ? 'Visit to Metfraa Office — project link is optional.'
          : 'Visit to Metfraa Factory — project link is optional.'));
    } else if (isSales) {
      // For Sales Visit, also offer a Client / Prospect Name input as an
      // alternative to picking a project from the list.
      const clientField = el('div', { class: 'field full', style: 'margin-top:14px;' },
        el('label', { for: 'ppClientName' }, 'Client / Prospect Name'),
        el('div', { style: 'font-size:11px;color:var(--bsg-muted);margin-bottom:6px;' },
          'For a Sales Visit, either pick an existing project above OR enter a new client / prospect name here.'
        )
      );
      const clientInput = el('input', { id: 'ppClientName', type: 'text', placeholder: 'e.g. ABC Corp', class: 'ti' });
      clientInput.value = fd.client_name || '';
      clientInput.oninput = (e) => {
        fd.client_name = e.target.value;
        if (e.target.value && fd.project_id) {
          fd.project_id = '';
          const sel = $('#ppProjectSel');
          if (sel) sel.value = '';
        }
      };
      clientField.appendChild(clientInput);
      card.appendChild(clientField);
    }

    return card;
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
      value = 'Bike <strong>₹4/km</strong>  ·  Car <strong>₹10/km</strong>  ·  Min trip <strong>5 km</strong>  ·  Car only for <strong>80 km+ (up &amp; down combined)</strong>';
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
      value = 'Applicable for trips <strong>80 km+ (up &amp; down combined)</strong> only  ·  attach the cab/taxi bill';
    } else if (F === 'met_misc') {
      label = 'Reimbursement';
      value = 'Enter each expense with date, purpose &amp; amount  ·  attach the bill for each';
    } else if (F === 'met_advance') {
      label = 'Advance Request';
      value = 'For upcoming trips only  ·  enter estimated amount + justification  ·  settle after travel with actual bills';
    } else if (F === 'met_dtr') {
      label = 'Daily Travel';
      value = 'Add an entry per commute trip  ·  <strong>Bus = no bill</strong>  ·  Bike Taxi / Auto / Share Auto need a bill per trip';
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
        'Cab reimbursement applies only to journeys of ', el('strong', {}, '80 km or more (up & down combined)'),
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

  // ---- Travel Advance Request ------------------------------------
  function renderAdvanceForm(body) {
    const fd = state.formData;

    // Trip details
    body.appendChild(el('div', { class: 'card' },
      el('div', { class: 'card-title' }, 'Trip Details'),
      el('div', { class: 'field-grid' },
        field('adv_destination', 'Destination',     'text',  fd.destination, true,  v => { fd.destination = v; }, 'e.g. Bangalore'),
        field('adv_mode',        'Mode of Travel',  'text',  fd.mode,        false, v => { fd.mode = v; },        'Train / Bus / Car / Flight')
      ),
      el('div', { class: 'field-grid' },
        field('adv_from', 'Travel From (Date)', 'date', fd.travel_from, true, v => { fd.travel_from = v; }),
        field('adv_to',   'Travel To (Date)',   'date', fd.travel_to,   true, v => { fd.travel_to = v; })
      )
    ));

    // Purpose & amount
    const justCard = el('div', { class: 'card' },
      el('div', { class: 'card-title' }, 'Purpose & Estimated Amount')
    );
    // Purpose (textarea-style — wider, with help text)
    const purposeField = el('div', { class: 'field full' },
      el('label', {}, 'Purpose / Justification ', el('span', { class: 'req' }, '*')),
      el('textarea', {
        class: 'ti', rows: 4,
        placeholder: 'e.g. Site visit at the Bangalore project — review structural work and meet client. Expected 3 days.',
        oninput: (e) => { fd.purpose = e.target.value; }
      })
    );
    // Set textarea value after creation (oninput-style attrs don't carry initial value reliably)
    setTimeout(() => { const ta = purposeField.querySelector('textarea'); if (ta) ta.value = fd.purpose || ''; }, 0);
    justCard.appendChild(purposeField);

    justCard.appendChild(el('div', { class: 'field-grid' },
      field('adv_amount', 'Estimated Advance Amount (₹)', 'number', fd.amount, true,
        v => { fd.amount = v; updateSummary(); }, '0.00')
    ));

    justCard.appendChild(el('div', { class: 'field full' },
      el('label', {}, 'Additional Notes (optional)'),
      el('textarea', {
        class: 'ti', rows: 2,
        placeholder: 'Anything else management should know — accompanying staff, special requirements, etc.',
        oninput: (e) => { fd.notes = e.target.value; }
      })
    ));
    setTimeout(() => { const tas = justCard.querySelectorAll('textarea'); if (tas[1]) tas[1].value = fd.notes || ''; }, 0);

    body.appendChild(justCard);

    // Settlement reminder card (informational)
    body.appendChild(el('div', { class: 'card', style: 'background:rgba(37,99,235,0.06);border-left:3px solid var(--bsg-blue);' },
      el('div', { class: 'card-title' }, 'After your trip'),
      el('p', { style: 'margin:0;font-size:13px;color:var(--bsg-ink);' },
        'Submit your actual bills via the reimbursement forms after travel. ',
        'If you have spent less than the advance, return the balance to finance. ',
        'If you have spent more, the company will reimburse the difference against the bills.'
      )
    ));
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

  // ---- Daily Travel Reimbursement ---------------------------------
  //   Month-long batch of commute trips. Each entry is a self-contained
  //   card with its own purpose/project AND its own (conditional) bill
  //   upload. Bus rides need no bill; everything else does.
  function renderDtrForm(body) {
    const fd = state.formData;

    // Header card — period (month) selection + summary
    body.appendChild(el('div', { class: 'card' },
      el('div', { class: 'card-title' }, 'Reimbursement Period'),
      el('div', { class: 'field-grid' },
        el('div', { class: 'field' },
          el('label', { for: 'dtrPeriod' }, 'Month ', el('span', { class: 'req' }, '*')),
          (() => {
            const ip = el('input', { id: 'dtrPeriod', type: 'month' });
            ip.value = fd.period || '';
            ip.oninput = (e) => { fd.period = e.target.value; };
            return ip;
          })()
        ),
        el('div', { class: 'field' },
          el('label', {}, 'Entries'),
          el('div', { style: 'padding:8px 0;font-size:14px;color:var(--bsg-ink);' },
            (fd.entries || []).length + ' entries · ₹ ' + fmt(calcTotalAndCount().total)
          )
        )
      ),
      el('div', { style: 'font-size:11px;color:var(--bsg-muted);margin-top:8px;' },
        'Add one entry per commute trip. Bus rides need no bill; for Bike Taxi, Auto, or Share Auto, attach a bill on the row itself.'
      )
    ));

    // Entries
    const entriesWrap = el('div', { class: 'dtr-entries' });
    (fd.entries || []).forEach((e, idx) => {
      entriesWrap.appendChild(buildDtrEntryCard(e, idx));
    });
    body.appendChild(entriesWrap);

    body.appendChild(el('button', {
      class: 'add-row-btn',
      onclick: () => { fd.entries.push(makeBlankDtrEntry()); renderForm(); }
    }, '+ Add Daily Entry'));
  }

  function buildDtrEntryCard(e, idx) {
    const card = el('div', { class: 'card dtr-entry' });

    // Header strip with the entry number and a remove button
    card.appendChild(el('div', { class: 'dtr-entry-head' },
      el('div', { class: 'dtr-entry-num' }, 'Entry #' + (idx + 1)),
      (state.formData.entries.length > 1)
        ? el('button', { class: 'remove-row-btn', onclick: () => {
            state.formData.entries.splice(idx, 1);
            renderForm();
          } }, '× Remove')
        : null
    ));

    // Row 1: Date | Mode | Fare
    card.appendChild(el('div', { class: 'field-grid' },
      el('div', { class: 'field' },
        el('label', {}, 'Date ', el('span', { class: 'req' }, '*')),
        (() => {
          const ip = el('input', { type: 'date' });
          ip.value = e.date || '';
          ip.oninput = (ev) => { e.date = ev.target.value; };
          return ip;
        })()
      ),
      el('div', { class: 'field' },
        el('label', {}, 'Mode ', el('span', { class: 'req' }, '*')),
        (() => {
          const sel = el('select');
          sel.innerHTML = '<option value="">— Select mode —</option>'
            + '<option value="bus">Bus</option>'
            + '<option value="bike_taxi">Bike Taxi</option>'
            + '<option value="auto">Auto</option>'
            + '<option value="share_auto">Share Auto</option>';
          sel.value = e.mode || '';
          sel.onchange = (ev) => {
            const prev = e.mode;
            e.mode = ev.target.value;
            // If switching TO bus, clear any uploaded bill (it's no longer needed)
            if (e.mode === 'bus' && e.bill_pending_id) {
              const billId = e.bill_pending_id;
              e.bill_pending_id = null;
              e.bill_filename = null;
              // Best-effort cleanup of the orphaned pending upload
              api(`/api/uploads/${billId}?token=${encodeURIComponent(state.uploadToken)}`, { method: 'DELETE' })
                .catch(() => { /* ignore */ });
            }
            // Re-render this row so the upload widget shows/hides
            if (prev !== e.mode) renderForm();
          };
          return sel;
        })()
      ),
      el('div', { class: 'field' },
        el('label', {}, 'Fare (₹) ', el('span', { class: 'req' }, '*')),
        (() => {
          const ip = el('input', { type: 'number', step: '0.01', min: '0', placeholder: '0.00' });
          ip.value = e.fare || '';
          ip.oninput = (ev) => { e.fare = ev.target.value; updateSummary(); };
          return ip;
        })()
      )
    ));

    // Row 2: From | To
    card.appendChild(el('div', { class: 'field-grid' },
      el('div', { class: 'field' },
        el('label', {}, 'From ', el('span', { class: 'req' }, '*')),
        (() => {
          const ip = el('input', { type: 'text', placeholder: 'e.g. Home, Office, Adyar' });
          ip.value = e.from || '';
          ip.oninput = (ev) => { e.from = ev.target.value; };
          return ip;
        })()
      ),
      el('div', { class: 'field' },
        el('label', {}, 'To ', el('span', { class: 'req' }, '*')),
        (() => {
          const ip = el('input', { type: 'text', placeholder: 'e.g. Client Site, AMNS' });
          ip.value = e.to || '';
          ip.oninput = (ev) => { e.to = ev.target.value; };
          return ip;
        })()
      )
    ));

    // Row 3: Per-row Purpose & Project (with progressive disclosure like the
    // submission-level card)
    card.appendChild(buildDtrPurposeProjectInline(e, idx));

    // Row 4: Remarks (optional)
    card.appendChild(el('div', { class: 'field full', style: 'margin-top:10px;' },
      el('label', {}, 'Remarks (optional)'),
      (() => {
        const ta = el('textarea', { class: 'ti', rows: 2, placeholder: 'Any notes about this trip…' });
        ta.value = e.remarks || '';
        ta.oninput = (ev) => { e.remarks = ev.target.value; };
        return ta;
      })()
    ));

    // Row 5: Bill upload (only for non-bus modes)
    const needsBill = e.mode && e.mode !== 'bus';
    if (needsBill) {
      card.appendChild(buildDtrBillUploader(e, idx));
    } else if (e.mode === 'bus') {
      card.appendChild(el('div', {
        style: 'margin-top:10px;padding:8px 12px;background:rgba(5,150,105,0.08);border-radius:3px;font-size:12px;color:var(--bsg-success);'
      }, 'No bill required for Bus.'));
    }

    return card;
  }

  // Inline purpose+project for a single DTR entry (mirrors buildPurposeProjectCard but flat)
  function buildDtrPurposeProjectInline(e, idx) {
    const wrap = el('div', { class: 'dtr-purpose-block' },
      el('div', { class: 'dtr-purpose-lbl' }, 'Purpose & Project for this entry')
    );

    const grid = el('div', { class: 'field-grid' });

    // Purpose
    const purposeSel = el('select');
    purposeSel.innerHTML = '<option value="">— Select purpose —</option>'
      + '<option value="project_visit">Project Visit</option>'
      + '<option value="site_visit">Site Visit</option>'
      + '<option value="sales_visit">Sales Visit</option>'
      + '<option value="metfraa_office">Visit to Metfraa - Office</option>'
      + '<option value="metfraa_factory">Visit to Metfraa - Factory</option>' + '<option value="purchase_visit">Purchase Visit</option>';
    purposeSel.value = e.purpose_category || '';
    purposeSel.onchange = (ev) => {
      const prev = e.purpose_category;
      e.purpose_category = ev.target.value;
      if (prev !== ev.target.value) {
        e.project_id = '';
        e.client_name = '';
      }
      renderForm();   // re-render to reveal/swap the Project/Client field
    };
    grid.appendChild(el('div', { class: 'field' },
      el('label', {}, 'Purpose ', el('span', { class: 'req' }, '*')),
      purposeSel
    ));

    // Project — only after purpose is picked
    const hasPurpose = !!e.purpose_category;
    const isSales = e.purpose_category === 'sales_visit';
    const isInternal = e.purpose_category === 'metfraa_office' || e.purpose_category === 'metfraa_factory';
    const projectOptional = isSales || isInternal;
    if (hasPurpose) {
      const projSel = el('select');
      populateProjectOptions(projSel);
      projSel.value = e.project_id || '';
      projSel.onchange = (ev) => {
        e.project_id = ev.target.value;
        if (ev.target.value) e.client_name = '';
      };
      let projLabelText = 'Project';
      if (isSales)    projLabelText = 'Project (optional)';
      if (isInternal) projLabelText = 'Project (optional)';
      grid.appendChild(el('div', { class: 'field' },
        el('label', {}, projLabelText, ' ', projectOptional ? null : el('span', { class: 'req' }, '*')),
        projSel
      ));
    }

    wrap.appendChild(grid);

    if (!hasPurpose) {
      wrap.appendChild(el('div', {
        style: 'margin-top:8px;padding:8px 10px;background:#f6f8fa;border-radius:3px;font-size:11px;color:var(--bsg-muted);'
      }, 'Select a purpose above to pick the project.'));
    } else if (isInternal) {
      wrap.appendChild(el('div', {
        style: 'margin-top:8px;padding:8px 10px;background:rgba(37,99,235,0.06);border-radius:3px;font-size:11px;color:var(--bsg-blue);'
      }, e.purpose_category === 'metfraa_office'
          ? 'Visit to Metfraa Office — project link is optional.'
          : 'Visit to Metfraa Factory — project link is optional.'));
    } else if (isSales) {
      const ip = el('input', { type: 'text', placeholder: 'e.g. ABC Corp', class: 'ti' });
      ip.value = e.client_name || '';
      ip.oninput = (ev) => {
        e.client_name = ev.target.value;
        if (ev.target.value && e.project_id) {
          e.project_id = '';
          // The Project select is the previous sibling — clear its visible value
          const projSel = wrap.querySelector('select:nth-of-type(2)');
          if (projSel) projSel.value = '';
        }
      };
      wrap.appendChild(el('div', { class: 'field full', style: 'margin-top:10px;' },
        el('label', {}, 'Client / Prospect Name'),
        el('div', { style: 'font-size:11px;color:var(--bsg-muted);margin-bottom:6px;' },
          'For a Sales Visit, either pick a project above OR enter the client name.'
        ),
        ip
      ));
    }

    return wrap;
  }

  // Per-row bill uploader for DTR entries that need a bill
  function buildDtrBillUploader(e, idx) {
    const wrap = el('div', { class: 'dtr-bill', style: 'margin-top:12px;' });

    if (e.bill_pending_id && e.bill_filename) {
      // Already uploaded — show name + remove
      wrap.appendChild(el('div', { class: 'dtr-bill-attached' },
        el('span', { class: 'icon' }, '📎'),
        el('span', { class: 'fname' }, e.bill_filename),
        el('button', { class: 'remove', onclick: async () => {
          try {
            await api(`/api/uploads/${e.bill_pending_id}?token=${encodeURIComponent(state.uploadToken)}`, { method: 'DELETE' });
            e.bill_pending_id = null;
            e.bill_filename = null;
            renderForm();
          } catch (err) { toast(err.message || 'Failed to remove', 'error'); }
        } }, '×')
      ));
      return wrap;
    }

    // Not yet uploaded — show the dropzone
    const inputId = 'dtrBillInput_' + idx;
    const zone = el('label', { for: inputId, class: 'dtr-bill-zone' },
      el('span', { class: 'icon' }, '📎'),
      el('div', {},
        el('div', { class: 'text' }, 'Attach bill / receipt for this trip'),
        el('div', { class: 'hint' }, 'Required for ' + (e.mode === 'bike_taxi' ? 'Bike Taxi' : (e.mode === 'auto' ? 'Auto' : 'Share Auto')) + ' · JPG, PNG, PDF, etc. up to 10 MB')
      )
    );
    const input = el('input', { type: 'file', id: inputId, accept: 'image/*,.pdf', style: 'display:none;' });
    input.onchange = async () => {
      if (!input.files || !input.files.length) return;
      const fd = new FormData();
      fd.append('upload_token', state.uploadToken);
      fd.append('row_idx', String(idx));
      fd.append('files', input.files[0]);  // single file per row
      try {
        showLoading('Uploading bill…');
        const res = await api('/api/uploads', { method: 'POST', body: fd });
        const up = (res.uploads || [])[0];
        if (up) {
          e.bill_pending_id = up.id;
          e.bill_filename = up.filename;
          renderForm();
        }
      } catch (err) {
        toast(err.message || 'Upload failed', 'error');
      } finally {
        hideLoading();
      }
    };
    wrap.appendChild(zone);
    wrap.appendChild(input);
    return wrap;
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
      case 'met_advance': {
        const a = parseFloat(fd.amount) || 0;
        if (a > 0) { total = a; count = 1; }
        break;
      }
      case 'met_dtr':
        for (const e of (fd.entries || [])) {
          const f = parseFloat(e.fare) || 0;
          if (f > 0) { total += f; count++; }
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

    // Categorization (purpose + project) — required on every form EXCEPT
    // DTR, which has its own per-entry categorization (checked below).
    if (F !== 'met_dtr') {
      if (!fd.purpose_category) {
        fail('Please pick a Purpose.');
      } else if (fd.purpose_category === 'sales_visit') {
        // Sales Visit: needs either a project OR a client/prospect name
        if (!fd.project_id && !(fd.client_name && fd.client_name.trim())) {
          fail('For a Sales Visit, pick a project or enter the client / prospect name.');
        }
      } else if (fd.purpose_category === 'metfraa_office' || fd.purpose_category === 'metfraa_factory') {
        // Internal visit — no project / client required
      } else {
        // Project Visit / Site Visit: project required
        if (!fd.project_id) fail('Please select a Project for this visit.');
      }
    }

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
    } else if (F === 'met_advance') {
      if (!fd.destination) fail('Destination is required.');
      else if (!fd.travel_from) fail('Travel start date is required.');
      else if (!fd.travel_to)   fail('Travel end date is required.');
      else if (fd.travel_to < fd.travel_from) fail('Travel end date must be on or after the start date.');
      else if (!fd.purpose || !fd.purpose.trim()) fail('Purpose / justification is required.');
      else if (!(parseFloat(fd.amount) > 0)) fail('Estimated advance amount must be greater than zero.');
    } else if (F === 'met_accommodation') {
      if (!fd.period) fail('Reporting month is required.');
      if (!fd.entries.some(e => e.date && e.location && parseFloat(e.amount) > 0)) fail('Add at least one complete accommodation entry.');
    } else if (F === 'met_dtr') {
      if (!fd.period) fail('Reimbursement month is required.');
      else if (!Array.isArray(fd.entries) || !fd.entries.length) fail('Add at least one daily travel entry.');
      else {
        for (let i = 0; i < fd.entries.length; i++) {
          const e = fd.entries[i];
          const lbl = `Entry #${i + 1}`;
          if (!e.date)                          { fail(`${lbl}: date is required.`); break; }
          if (!e.mode)                          { fail(`${lbl}: pick a mode of commute.`); break; }
          if (!e.from || !e.from.trim())        { fail(`${lbl}: From location is required.`); break; }
          if (!e.to || !e.to.trim())            { fail(`${lbl}: To location is required.`); break; }
          if (!(parseFloat(e.fare) > 0))        { fail(`${lbl}: fare must be greater than zero.`); break; }
          if (!e.purpose_category)              { fail(`${lbl}: pick a Purpose.`); break; }
          if (e.purpose_category === 'sales_visit') {
            if (!e.project_id && !(e.client_name && e.client_name.trim())) {
              fail(`${lbl}: pick a project or enter the client / prospect name.`); break;
            }
          } else if (e.purpose_category === 'metfraa_office' || e.purpose_category === 'metfraa_factory') {
            // Internal visit — no project / client required
          } else if (!e.project_id) {
            fail(`${lbl}: select a Project.`); break;
          }
          if (e.mode !== 'bus' && !e.bill_pending_id) {
            const modeName = e.mode === 'bike_taxi' ? 'Bike Taxi' : (e.mode === 'auto' ? 'Auto' : 'Share Auto');
            fail(`${lbl}: a bill is required for ${modeName}.`); break;
          }
        }
      }
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

    // Purpose & Project strip (matches the same band that goes into the PDF).
    // DTR has per-entry purpose/project, so the strip is omitted there.
    if (F !== 'met_dtr') {
      const PURPOSE_NAMES = { project_visit: 'Project Visit', site_visit: 'Site Visit', sales_visit: 'Sales Visit', metfraa_office: 'Visit to Metfraa - Office', metfraa_factory: 'Visit to Metfraa - Factory', purchase_visit: 'Purchase Visit' };
      const purposeText = PURPOSE_NAMES[fd.purpose_category] || '—';
      let projectText = '—';
      if (fd.project_id) {
        const p = (state.projects || []).find(x => String(x.id) === String(fd.project_id));
        if (p) projectText = p.code && p.code !== p.name ? `${p.name} (${p.code})` : p.name;
      } else if (fd.client_name) {
        projectText = `${fd.client_name} (Prospect)`;
      }
      root.appendChild(el('div', { class: 'preview-purpose-strip' },
        el('div', {}, el('div', { class: 'label' }, 'PURPOSE'), el('div', { class: 'value' }, purposeText)),
        el('div', {}, el('div', { class: 'label' }, 'PROJECT'), el('div', { class: 'value' }, projectText))
      ));
    }

    // Body
    switch (F) {
      case 'bsc_conveyance':
      case 'met_local': renderConveyancePreview(root, fd); break;
      case 'bsc_expense':
      case 'met_outstation': renderExpensePreview(root, fd, F === 'met_outstation'); break;
      case 'met_cab': renderCabPreview(root, fd); break;
      case 'met_misc': renderMiscPreview(root, fd); break;
      case 'met_advance': renderAdvancePreview(root, fd); break;
      case 'met_dtr': renderDtrPreview(root, fd); break;
      case 'met_accommodation': renderAccommodationPreview(root, fd); break;
    }

    // Grand total (label varies by form type)
    {
      const totalLabel = F === 'met_advance'
        ? 'Advance Amount Requested'
        : 'Total Reimbursement Claim';
      root.appendChild(el('div', { class: 'grand-total' },
        el('div', { class: 'lbl' }, totalLabel),
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

  function renderAdvancePreview(root, fd) {
    const section = el('div', { class: 'trip-section' });
    section.appendChild(el('div', { class: 'trip-banner' },
      el('div', { class: 'l' }, el('strong', {}, 'TRAVEL ADVANCE'), 'Upcoming trip — settled after travel'),
      el('div', { class: 'r' }, '')
    ));
    // Two-col table of trip details
    const table = el('table');
    table.appendChild(el('thead', {}, el('tr', {},
      ...['Field','Detail'].map(h => el('th', {}, h))
    )));
    const tbody = el('tbody');
    const rows = [
      ['Destination',    fd.destination || '—'],
      ['Travel from',    formatDate(fd.travel_from)],
      ['Travel to',      formatDate(fd.travel_to)],
      ['Mode of travel', fd.mode || 'Not specified'],
      ['Purpose',        fd.purpose || '—'],
    ];
    if (fd.notes) rows.push(['Notes', fd.notes]);
    for (const [label, val] of rows) {
      tbody.appendChild(el('tr', {},
        el('td', { style: 'font-weight:600;width:30%;' }, label),
        el('td', {}, val)
      ));
    }
    table.appendChild(tbody);
    section.appendChild(table);
    root.appendChild(section);
  }

  function renderDtrPreview(root, fd) {
    const MODE_LABEL = { bus: 'Bus', bike_taxi: 'Bike Taxi', auto: 'Auto', share_auto: 'Share Auto' };
    const PURPOSE_LABEL = { project_visit: 'Project', site_visit: 'Site', sales_visit: 'Sales', metfraa_office: 'M. Office', metfraa_factory: 'M. Factory', purchase_visit: 'Purchase' };
    const projects = state.projects || [];
    const findProject = (id) => projects.find(p => String(p.id) === String(id));

    const section = el('div', { class: 'trip-section' });
    section.appendChild(el('div', { class: 'trip-banner' },
      el('div', { class: 'l' }, el('strong', {}, 'DAILY TRAVEL'),
        `${(fd.entries || []).length} entries · ${fd.period || '—'}`
      ),
      el('div', { class: 'r' }, '')
    ));

    const table = el('table');
    table.appendChild(el('thead', {}, el('tr', {},
      ...['Date', 'Mode', 'From', 'To', 'Purpose', 'Project', 'Bill', 'Fare'].map(h => el('th', {}, h))
    )));
    const tbody = el('tbody');
    (fd.entries || []).forEach(e => {
      let project = '—';
      if (e.project_id) {
        const p = findProject(e.project_id);
        if (p) project = p.code && p.code !== p.name ? `${p.name} (${p.code})` : p.name;
      } else if (e.client_name) {
        project = `${e.client_name} (Prospect)`;
      }
      tbody.appendChild(el('tr', {},
        el('td', {}, formatDate(e.date)),
        el('td', {}, MODE_LABEL[e.mode] || '—'),
        el('td', {}, e.from || '—'),
        el('td', {}, e.to || '—'),
        el('td', {}, PURPOSE_LABEL[e.purpose_category] || '—'),
        el('td', {}, project),
        el('td', {}, e.mode === 'bus' ? '—' : (e.bill_filename ? '✓' : 'missing')),
        el('td', { class: 'num' }, '₹ ' + fmt(parseFloat(e.fare) || 0))
      ));
    });
    table.appendChild(tbody);
    section.appendChild(table);

    // Remarks below the table (only show entries that have remarks)
    const withRemarks = (fd.entries || []).filter(e => e.remarks && e.remarks.trim());
    if (withRemarks.length) {
      const rWrap = el('div', { style: 'margin-top:14px;' },
        el('div', { style: 'font-family:monospace;font-size:10px;letter-spacing:.08em;color:var(--bsg-muted);margin-bottom:6px;' }, 'REMARKS')
      );
      for (const e of withRemarks) {
        rWrap.appendChild(el('div', { style: 'font-size:12px;color:var(--bsg-ink);margin-bottom:4px;' },
          el('strong', {}, formatDate(e.date) + ' — '), e.remarks
        ));
      }
      section.appendChild(rWrap);
    }

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
    const isEdit = !!state.editingSubmissionId;

    const ok = await confirmModal({
      title: isEdit ? 'Resubmit for approval?' : 'Submit for approval?',
      body: isEdit
        ? 'Your edited submission will be sent back to HR for review.'
        : (isCab
            ? 'Your cab request will be logged and sent to the admin for pre-approval. Bookings should not be made until approved.'
            : 'Your claim and bills will be logged and sent to the admin for approval. The final report is generated once approved.'),
      confirmText: isEdit ? 'Resubmit' : 'Submit',
    });
    if (!ok) return;

    showLoading(isEdit ? 'Resubmitting…' : 'Submitting for approval…');
    try {
      const url = isEdit
        ? `/api/submissions/${state.editingSubmissionId}`
        : '/api/submissions';
      const res = await api(url, {
        method: isEdit ? 'PATCH' : 'POST',
        body: JSON.stringify({
          form_type: state.currentForm,
          upload_token: state.uploadToken,
          payload: state.formData,
        }),
      });
      state.lastSubmission = res.submission;
      state.uploadToken = null;
      state.uploads = [];
      state.editingSubmissionId = null;
      state.editingDraftMeta = null;
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
    // The draft report is generated at submit-time now, so View + Download
    // both work right away. Re-wire the download button to point at this
    // submission and make it visible.
    const dlBtn = $('#downloadPdfBtn');
    if (dlBtn) {
      dlBtn.style.display = '';
      dlBtn.onclick = (e) => {
        e.preventDefault();
        window.open(`/api/submissions/${s.id}/pdf?download=1`, '_blank');
      };
    }
    const heading = document.querySelector('#page-success .success-wrap h1');
    const para = document.querySelector('#page-success .success-wrap p');
    if (heading) heading.textContent = 'Submitted for Approval';
    if (para) para.textContent = 'Your entry has been logged and the draft report is ready to view. You can download it now; once an admin approves, the report updates to show their sign-off.';
    $('#successRecipients').textContent = s.od_synced
      ? '✓ Draft report stored in OneDrive · awaiting admin approval'
      : 'Saved · awaiting admin approval';
  }

  // ===================================================================
  //  ADMIN PANEL
  // ===================================================================
  const LEVEL_LABEL = { L1: 'Junior', L2: 'Senior', L3: 'Managerial' };

  let adminTab = 'dashboard';

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
    if (tab === 'projects') loadProjectsAdmin().then(drawProjectTable);
    if (tab === 'dashboard') loadDashboard();
    if (tab === 'payments') loadPayments();
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

  // Per-tab folder open/closed state. Keyed by employee email so the
  // expanded/collapsed view survives any re-render (approve, refresh,
  // filter change). New employees default to OPEN.
  const folderState = { pend: new Map(), sub: new Map() };

  // Group an array of submission rows by employee, return [{ key, name,
  // email, code, subs: [], total: 0, count: 0 }] sorted A→Z by name.
  // Submissions inside each bucket are sorted newest first.
  function groupByEmployee(rows) {
    const buckets = new Map();
    for (const r of rows) {
      const key = (r.employee_email || r.employee_name || 'unknown').toLowerCase();
      let b = buckets.get(key);
      if (!b) {
        b = {
          key,
          name: r.employee_name || '(unknown)',
          email: r.employee_email || '',
          subs: [],
        };
        buckets.set(key, b);
      }
      b.subs.push(r);
    }
    for (const b of buckets.values()) {
      // Newest first
      b.subs.sort((a, b2) => {
        const ta = new Date(a.submitted_at || 0).getTime() || 0;
        const tb = new Date(b2.submitted_at || 0).getTime() || 0;
        return tb - ta;
      });
    }
    return Array.from(buckets.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  // Build the form-type filter dropdown from whatever forms appear in
  // the supplied rows. Avoids hard-coding a list that could drift; also
  // keeps the dropdown short to what's actually in use.
  function populateFormFilter(selectEl, rows) {
    if (!selectEl) return;
    const current = selectEl.value;
    const seen = new Set();
    for (const r of rows) if (r.form_type) seen.add(r.form_type);
    // Preserve the leading "All expense types" option
    selectEl.innerHTML = '<option value="">All expense types</option>'
      + Array.from(seen).sort().map(ft =>
          `<option value="${ft}"${ft === current ? ' selected' : ''}>${FORM_LABEL[ft] || ft}</option>`
        ).join('');
  }

  // Build the period (month) filter dropdown from the period values that
  // actually appear in the data. Newest first. Submissions without a
  // period get bucketed under a "no-period" sentinel option at the end,
  // so they remain reachable when HR filters.
  function populatePeriodFilter(selectEl, rows) {
    if (!selectEl) return;
    const current = selectEl.value;
    const periods = new Set();
    let hasNoPeriod = false;
    for (const r of rows) {
      if (r.period) periods.add(r.period);
      else hasNoPeriod = true;
    }
    // Sort YYYY-MM strings descending so newest months are at the top.
    const sorted = Array.from(periods).sort((a, b) => b.localeCompare(a));
    const monthLabel = (p) => {
      // 'YYYY-MM' → 'Aug 2026'. Anything else (e.g. free-form periods on
      // older data) gets passed through unchanged.
      const m = /^(\d{4})-(\d{2})$/.exec(p);
      if (!m) return p;
      const d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, 1);
      return isNaN(d) ? p : d.toLocaleString('en-IN', { month: 'short', year: 'numeric' });
    };
    let html = '<option value="">All months</option>'
      + sorted.map(p => `<option value="${p}"${p === current ? ' selected' : ''}>${monthLabel(p)}</option>`).join('');
    if (hasNoPeriod) {
      html += `<option value="__none__"${current === '__none__' ? ' selected' : ''}>(No month)</option>`;
    }
    selectEl.innerHTML = html;
  }

  // Renders the row of action buttons for a submission inside a folder.
  function renderRowActions(s) {
    const isSettlement = s.status === 'settlement_pending';
    const isPending = s.status === 'pending' || s.status === 'settlement_pending';
    return el('div', { class: 'admin-actions' },
      el('button', { class: 'view', onclick: () => viewSubmission(s.id) }, 'View'),
      isPending ? el('button', { class: 'approve', onclick: () => approveSubmission(s) }, isSettlement ? 'Approve Settlement' : 'Approve') : null,
      isPending ? el('button', { class: 'reject', onclick: () => rejectSubmission(s) }, isSettlement ? 'Reject Settlement' : 'Send back') : null,
    );
  }

  // Single submission row inside a folder body. Columns vary slightly
  // by tab — `withStatus` adds a status pill column for All Submissions.
  function buildFolderRow(s, opts = {}) {
    const isSettlement = s.status === 'settlement_pending';
    const cells = [
      el('td', {},
        el('strong', {}, s.reference),
        isSettlement ? el('span', { class: 'status-pill settlement_pending', style: 'margin-left:8px;font-size:9px;' }, 'settlement') : null,
      ),
      el('td', {}, FORM_LABEL[s.form_type] || s.form_type),
      el('td', {}, s.period || '—'),
      el('td', { class: 'num', style: 'text-align:right;' }, '₹ ' + fmt(s.total_amount)),
    ];
    if (opts.withStatus) {
      cells.push(el('td', {}, el('span', { class: 'status-pill ' + s.status }, statusLabel(s.status))));
    }
    cells.push(el('td', {}, fmtDateShort(s.submitted_at)));
    cells.push(el('td', { style: 'text-align:right;' }, renderRowActions(s)));
    return el('tr', { class: 'fr-row' }, ...cells);
  }

  // The whole folder UI for one employee. tabKey is 'pend' or 'sub' so
  // open/close state persists per tab independently.
  function buildEmployeeFolder({ tabKey, bucket, matchingSubs, totalSubs, withStatus }) {
    const stateMap = folderState[tabKey];
    if (!stateMap.has(bucket.key)) stateMap.set(bucket.key, true); // default OPEN

    const folder = el('div', { class: 'emp-folder' });
    const folderId = `${tabKey}-folder-${bucket.key.replace(/[^a-z0-9]/g, '_')}`;
    folder.id = folderId;
    if (stateMap.get(bucket.key)) folder.classList.add('open');

    // Header: caret + name + count badge + total ₹
    const totalAmt = matchingSubs.reduce((s, r) => s + (parseFloat(r.total_amount) || 0), 0);
    const head = el('div', { class: 'emp-folder-head', onclick: () => {
      const isOpen = folder.classList.toggle('open');
      stateMap.set(bucket.key, isOpen);
    } },
      el('div', { class: 'efh-left' },
        el('span', { class: 'efh-caret' }, '▶'),
        el('div', { class: 'efh-name' }, bucket.name),
        bucket.email ? el('div', { class: 'efh-email' }, bucket.email) : null,
      ),
      el('div', { class: 'efh-right' },
        el('span', { class: 'efh-total' }, '₹ ' + fmt(totalAmt)),
        el('span', { class: 'efh-badge' + (matchingSubs.length === 0 ? ' zero' : '') },
          matchingSubs.length === totalSubs
            ? String(matchingSubs.length)
            : `${matchingSubs.length} / ${totalSubs}`
        ),
      )
    );
    folder.appendChild(head);

    // Body: either the rows table or a "no matches" notice
    const body = el('div', { class: 'emp-folder-body' });
    if (matchingSubs.length === 0) {
      body.appendChild(el('div', { class: 'emp-no-match' }, 'No submissions match the current filter.'));
    } else {
      const table = el('table', { class: 'admin-table folder-table' });
      const headCells = ['Reference', 'Form', 'Period', 'Amount'];
      if (withStatus) headCells.push('Status');
      headCells.push('Submitted', 'Actions');
      table.appendChild(el('thead', {}, el('tr', {},
        ...headCells.map((h, i) => el('th', { style: i === 3 ? 'text-align:right;' : (i === headCells.length - 1 ? 'text-align:right;' : '') }, h))
      )));
      const tbody = el('tbody');
      for (const s of matchingSubs) tbody.appendChild(buildFolderRow(s, { withStatus }));
      table.appendChild(tbody);
      body.appendChild(table);
    }
    folder.appendChild(body);
    return folder;
  }

  // ---- Pending: folder-style render ---------------------------------
  function drawPendingTable() {
    const root = $('#pendFolders');
    if (!root) return;
    const all = state.adminPending || [];
    populateFormFilter($('#pendFormFilter'), all);
    populatePeriodFilter($('#pendPeriodFilter'), all);

    const q = ($('#pendSearch') ? $('#pendSearch').value : '').toLowerCase().trim();
    const formFilter = ($('#pendFormFilter') ? $('#pendFormFilter').value : '');
    const periodFilter = ($('#pendPeriodFilter') ? $('#pendPeriodFilter').value : '');

    // Two passes: textual search filter applies to the WHOLE folder
    // (any field match keeps the row), form-type/period filters apply
    // WITHIN a folder (other rows still count toward the parent total).
    const textMatch = (s) => {
      if (!q) return true;
      return [s.employee_name, s.employee_email, s.reference, s.form_type, s.period].filter(Boolean).some(v => String(v).toLowerCase().includes(q));
    };
    const formMatch = (s) => !formFilter || s.form_type === formFilter;
    const periodMatch = (s) => {
      if (!periodFilter) return true;
      if (periodFilter === '__none__') return !s.period;
      return s.period === periodFilter;
    };
    const rowMatches = (s) => formMatch(s) && periodMatch(s);

    const filtered = all.filter(textMatch);
    const buckets = groupByEmployee(filtered);

    let totalMatching = 0;
    root.innerHTML = '';
    if (!buckets.length) {
      root.appendChild(el('div', { class: 'empty-state' }, q ? 'No matches.' : 'Nothing pending.'));
    } else {
      for (const b of buckets) {
        const matching = b.subs.filter(rowMatches);
        totalMatching += matching.length;
        root.appendChild(buildEmployeeFolder({
          tabKey: 'pend', bucket: b,
          matchingSubs: matching, totalSubs: b.subs.length,
          withStatus: false,
        }));
      }
    }
    const isFiltered = !!(formFilter || periodFilter);
    $('#pendCount').textContent = isFiltered
      ? `${totalMatching} pending · filtered`
      : `${all.length} pending across ${buckets.length} ${buckets.length === 1 ? 'employee' : 'employees'}`;
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
    const root = $('#subFolders');
    if (!root) return;
    const all = state.adminSubmissions || [];
    populateFormFilter($('#subFormFilter'), all);
    populatePeriodFilter($('#subPeriodFilter'), all);

    const q = ($('#subSearch') ? $('#subSearch').value : '').toLowerCase().trim();
    const formFilter = ($('#subFormFilter') ? $('#subFormFilter').value : '');
    const periodFilter = ($('#subPeriodFilter') ? $('#subPeriodFilter').value : '');

    const textMatch = (s) => {
      if (!q) return true;
      return [s.employee_name, s.employee_email, s.reference, s.status, s.form_type, s.period].filter(Boolean).some(v => String(v).toLowerCase().includes(q));
    };
    const formMatch = (s) => !formFilter || s.form_type === formFilter;
    const periodMatch = (s) => {
      if (!periodFilter) return true;
      if (periodFilter === '__none__') return !s.period;
      return s.period === periodFilter;
    };
    const rowMatches = (s) => formMatch(s) && periodMatch(s);

    const filtered = all.filter(textMatch);
    const buckets = groupByEmployee(filtered);

    let totalMatching = 0;
    root.innerHTML = '';
    if (!buckets.length) {
      root.appendChild(el('div', { class: 'empty-state' }, q ? 'No matches.' : 'No submissions yet.'));
    } else {
      for (const b of buckets) {
        const matching = b.subs.filter(rowMatches);
        totalMatching += matching.length;
        root.appendChild(buildEmployeeFolder({
          tabKey: 'sub', bucket: b,
          matchingSubs: matching, totalSubs: b.subs.length,
          withStatus: true,
        }));
      }
    }
    const isFiltered = !!(formFilter || periodFilter);
    $('#subCount').textContent = isFiltered
      ? `${totalMatching} shown · filtered`
      : `${all.length} across ${buckets.length} ${buckets.length === 1 ? 'employee' : 'employees'}`;
  }

  // Bulk expand/collapse helpers — flips every bucket on the given tab.
  function setAllFolders(tabKey, open) {
    const stateMap = folderState[tabKey];
    const rootSel = tabKey === 'pend' ? '#pendFolders' : '#subFolders';
    const root = $(rootSel);
    if (!root) return;
    // Update stored state first so future re-renders honour the bulk action.
    // We can't enumerate stateMap keys reliably (covers buckets we've rendered
    // before), so walk the rendered folders instead — they're the source of
    // truth for what's on screen right now.
    for (const folder of root.querySelectorAll('.emp-folder')) {
      const key = folder.id.replace(new RegExp('^' + tabKey + '-folder-'), '').replace(/_/g, '');
      // Re-derive the bucket key from the dataset would be cleaner; the
      // class flip is what the user actually sees, so the source of truth
      // is the DOM.
      folder.classList.toggle('open', open);
    }
    // Walk stored state too so anything filtered out keeps its new mode
    for (const k of stateMap.keys()) stateMap.set(k, open);
  }

  async function approveSubmission(s) {
    // Travel-advance settlements use a different endpoint + tone
    if (s.status === 'settlement_pending') return approveSettlementHandler(s);

    const isAdvance = s.form_type === 'met_advance';
    const ok = await confirmModal({
      title: isAdvance ? 'Approve this advance?' : 'Approve this claim?',
      body: isAdvance
        ? `${s.employee_name} · ${s.reference} · ₹${fmt(s.total_amount)}. The advance will be marked approved and stays OPEN until the employee settles it after the trip.`
        : `${s.employee_name} · ${s.reference} · ₹${fmt(s.total_amount)}. The final report (with bills merged) will be generated and stored in OneDrive under Reports/.`,
      confirmText: 'Approve',
    });
    if (!ok) return;
    showLoading(isAdvance ? 'Approving advance…' : 'Approving & generating report…');
    try {
      const res = await api(`/api/admin/submissions/${s.id}/approve`, { method: 'POST', body: JSON.stringify({}) });
      if (res.advance_open) {
        toast('Advance approved · open until settled', 'success');
      } else {
        toast(res.od_synced ? 'Approved · report stored in OneDrive' : 'Approved · OneDrive sync pending (will retry)', res.od_synced ? 'success' : 'warning');
      }
      await Promise.all([loadPending(), loadSubmissions()]);
      drawPendingTable(); drawSubmissionsTable();
    } catch (err) {
      toast(err.message || 'Approval failed', 'error');
    } finally { hideLoading(); }
  }

  async function approveSettlementHandler(s) {
    const ok = await confirmModal({
      title: 'Approve this settlement?',
      body: `${s.employee_name} · ${s.reference}. This closes the advance, generates the final report (advance + actuals + bills), and stores it in OneDrive.`,
      confirmText: 'Approve Settlement',
    });
    if (!ok) return;
    showLoading('Approving settlement & generating final report…');
    try {
      const res = await api(`/api/admin/submissions/${s.id}/approve-settlement`, { method: 'POST', body: JSON.stringify({}) });
      toast(res.od_synced ? 'Settlement approved · advance closed' : 'Settlement approved · OneDrive sync pending', res.od_synced ? 'success' : 'warning');
      await Promise.all([loadPending(), loadSubmissions()]);
      drawPendingTable(); drawSubmissionsTable();
    } catch (err) {
      toast(err.message || 'Settlement approval failed', 'error');
    } finally { hideLoading(); }
  }

  async function rejectSubmission(s) {
    if (s.status === 'settlement_pending') return rejectSettlementHandler(s);

    // The new reject flow is "send back to draft for edits". HR MUST
    // describe what the employee needs to fix — that text becomes the
    // changes_required message shown on the draft and emailed to them.
    const changesRequired = await promptModal({
      title: 'Send back for edits?',
      body: `${s.employee_name} · ${s.reference}. The employee will see this message and can edit and resubmit. Be specific so they know what to fix.`,
      placeholder: 'What needs to change? (e.g. "Wrong project picked on entry #3 — should be AMNS, not KGISL")',
      confirmText: 'Send back',
      required: true,
    });
    if (changesRequired === null) return; // cancelled
    if (!changesRequired || !changesRequired.trim()) {
      toast('Please describe what needs to change.', 'error');
      return;
    }
    showLoading('Sending back…');
    try {
      await api(`/api/admin/submissions/${s.id}/reject`, {
        method: 'POST',
        body: JSON.stringify({ changes_required: changesRequired.trim() }),
      });
      toast('Sent back to employee for edits', 'success');
      await Promise.all([loadPending(), loadSubmissions()]);
      drawPendingTable(); drawSubmissionsTable();
    } catch (err) {
      toast(err.message || 'Send-back failed', 'error');
    } finally { hideLoading(); }
  }

  async function rejectSettlementHandler(s) {
    const note = await promptModal({
      title: 'Reject this settlement?',
      body: `${s.employee_name} · ${s.reference}. The advance will return to "settlement_rejected" status — the employee can re-file with corrections.`,
      placeholder: 'Reason (so the employee knows what to fix)',
      confirmText: 'Reject Settlement',
    });
    if (note === null) return;
    showLoading('Rejecting settlement…');
    try {
      await api(`/api/admin/submissions/${s.id}/reject-settlement`, { method: 'POST', body: JSON.stringify({ note }) });
      toast('Settlement rejected', 'success');
      await Promise.all([loadPending(), loadSubmissions()]);
      drawPendingTable(); drawSubmissionsTable();
    } catch (err) {
      toast(err.message || 'Settlement rejection failed', 'error');
    } finally { hideLoading(); }
  }

  const FORM_LABEL = {
    met_local: 'Local Travel', met_cab: 'Cab Reimbursement',
    met_accommodation: 'Accommodation', met_outstation: 'Outstation',
    met_misc: 'Miscellaneous', met_advance: 'Travel Advance',
    met_dtr: 'Daily Travel',
    bsc_conveyance: 'Local Conveyance', bsc_expense: 'Travel Expense',
  };
  // Human-readable status labels — used everywhere a status pill text
  // is rendered. Anything not in the map falls back to the raw status.
  const STATUS_LABEL = {
    pending: 'pending',
    approved: 'approved',
    rejected: 'rejected',
    draft: 'needs edits',
    advance_approved: 'advance approved',
    settlement_pending: 'settlement pending',
    settled: 'settled',
    settlement_rejected: 'settlement rejected',
  };
  function statusLabel(s) { return STATUS_LABEL[s] || s; }
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

  // ---- Projects (admin) ---------------------------------------------
  async function loadProjectsAdmin() {
    try {
      const res = await api('/api/admin/projects');
      state.adminProjects = res.projects || [];
    } catch (_) { state.adminProjects = []; }
  }

  function drawProjectTable() {
    const tbody = $('#projTableBody'); if (!tbody) return;
    tbody.innerHTML = '';
    const rows = state.adminProjects || [];
    if ($('#projCount')) $('#projCount').textContent = `${rows.length} project${rows.length === 1 ? '' : 's'}`;
    if (!rows.length) {
      tbody.appendChild(el('tr', {}, el('td', { colspan: 5, style: 'text-align:center;color:var(--bsg-muted);padding:32px;' }, 'No projects yet — click + Add Project.')));
      return;
    }
    for (const p of rows) {
      tbody.appendChild(el('tr', {},
        el('td', {}, el('strong', {}, p.name)),
        el('td', {}, p.code || '—'),
        el('td', {}, el('span', { class: 'status-pill ' + (p.is_active ? 'approved' : 'rejected') }, p.is_active ? 'active' : 'inactive')),
        el('td', {}, fmtDateShort(p.created_at)),
        el('td', { style: 'text-align:right;' }, el('div', { class: 'admin-actions' },
          el('button', { class: 'view', onclick: () => openProjectModal(p) }, 'Edit'),
          p.is_active
            ? el('button', { class: 'reject', onclick: () => deleteProject(p) }, 'Delete')
            : el('button', { class: 'approve', onclick: () => reactivateProject(p) }, 'Reactivate')
        ))
      ));
    }
  }

  function openProjectModal(project) {
    state.editingProject = project; // null = add
    $('#projModalTitle').textContent = project ? 'Edit Project' : 'Add Project';
    $('#projName').value = project ? project.name : '';
    $('#projCode').value = project && project.code ? project.code : '';
    $('#projModalBackdrop').classList.add('show');
  }

  function closeProjectModal() {
    $('#projModalBackdrop').classList.remove('show');
    state.editingProject = null;
  }

  async function saveProject() {
    const name = $('#projName').value.trim();
    const code = $('#projCode').value.trim();
    if (!name) { toast('Project name is required', 'error'); return; }
    showLoading('Saving project…');
    try {
      const editing = state.editingProject;
      if (editing) {
        await api(`/api/admin/projects/${editing.id}`, {
          method: 'PUT', body: JSON.stringify({ name, code }),
        });
      } else {
        await api('/api/admin/projects', {
          method: 'POST', body: JSON.stringify({ name, code }),
        });
      }
      // Invalidate the cached active list used by forms
      state.projects = null;
      toast(editing ? 'Project updated' : 'Project added', 'success');
      closeProjectModal();
      await loadProjectsAdmin();
      drawProjectTable();
    } catch (err) {
      toast(err.message || 'Save failed', 'error');
    } finally { hideLoading(); }
  }

  async function deleteProject(project) {
    const ok = await confirmModal({
      title: 'Delete this project?',
      body: `"${project.name}" will be removed. If any submissions reference it, the project is deactivated (kept for history) instead of being hard-deleted.`,
      confirmText: 'Delete',
    });
    if (!ok) return;
    try {
      const res = await api(`/api/admin/projects/${project.id}`, { method: 'DELETE' });
      state.projects = null;
      toast(res.deactivated ? `Deactivated (kept for ${res.submissions_retained} submissions)` : 'Deleted', 'success');
      await loadProjectsAdmin();
      drawProjectTable();
    } catch (err) {
      toast(err.message || 'Delete failed', 'error');
    }
  }

  async function reactivateProject(project) {
    try {
      await api(`/api/admin/projects/${project.id}`, {
        method: 'PUT', body: JSON.stringify({ is_active: 1 }),
      });
      state.projects = null;
      toast('Reactivated', 'success');
      await loadProjectsAdmin();
      drawProjectTable();
    } catch (err) { toast(err.message || 'Reactivate failed', 'error'); }
  }

  // ---- Payments (admin) ---------------------------------------------
  //   Lets HR pick a month, see every employee with approved/settled
  //   submissions for that month + their total payable, mark them paid
  //   (which records who/when + sends a confirmation email), or undo.
  //   Drill-in modal shows the itemised breakdown before marking.
  let paySelectedEmp = null;   // current employee in the detail modal

  async function loadPayments() {
    // Default the month picker to the current month if nothing's set
    const ip = $('#payMonth');
    if (ip && !ip.value) {
      const now = new Date();
      ip.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    }
    await drawPaymentsTable();
  }

  async function drawPaymentsTable() {
    const tbody = $('#payTableBody');
    if (!tbody) return;
    const monthStr = $('#payMonth').value;
    if (!monthStr) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--bsg-muted);padding:32px;">Pick a month to view payable employees.</td></tr>';
      $('#payCount').textContent = '';
      return;
    }
    const [y, m] = monthStr.split('-').map(n => parseInt(n, 10));
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--bsg-muted);padding:32px;">Loading…</td></tr>';
    try {
      const data = await api(`/api/admin/payments?year=${y}&month=${m}`);
      state.paymentsForMonth = data;
      tbody.innerHTML = '';
      const emps = data.employees || [];
      if (!emps.length) {
        tbody.appendChild(el('tr', {},
          el('td', { colspan: 6, style: 'text-align:center;color:var(--bsg-muted);padding:32px;' },
            `No approved or settled claims for ${monthName(m)} ${y}.`)
        ));
      }
      let paidCount = 0, totalPayable = 0;
      for (const emp of emps) {
        const isPaid = !!emp.paid;
        if (isPaid) paidCount++;
        totalPayable += emp.total_payable;

        tbody.appendChild(el('tr', { class: isPaid ? 'pay-row-paid' : '' },
          el('td', {},
            el('strong', {}, emp.name),
            el('div', { style: 'font-family:monospace;font-size:11px;color:var(--bsg-muted);margin-top:2px;' }, emp.email)
          ),
          el('td', { class: 'num', style: 'text-align:right;font-weight:600;' }, '₹ ' + fmt(emp.total_payable)),
          el('td', {}, `${emp.submission_count} ${emp.submission_count === 1 ? 'claim' : 'claims'}`),
          el('td', {}, el('span', {
            class: 'status-pill ' + (isPaid ? 'approved' : 'pending'),
          }, isPaid ? 'paid' : 'unpaid')),
          el('td', { style: 'font-size:12px;color:var(--bsg-muted);' },
            isPaid ? formatPaidLine(emp.paid) : '—'
          ),
          el('td', { style: 'text-align:right;' },
            el('div', { class: 'admin-actions' },
              el('button', { class: 'view', onclick: () => openPayDetail(emp) }, 'View'),
              isPaid
                ? el('button', { class: 'reject', onclick: () => undoPaid(emp) }, 'Undo')
                : el('button', { class: 'approve', onclick: () => markPaidWithConfirm(emp) }, 'Mark Paid')
            )
          )
        ));
      }
      const subtitle = paidCount === emps.length && emps.length > 0
        ? `${emps.length} ${emps.length === 1 ? 'employee' : 'employees'} · all paid · ₹ ${fmt(totalPayable)} total`
        : `${emps.length} ${emps.length === 1 ? 'employee' : 'employees'} · ${paidCount} paid · ₹ ${fmt(totalPayable)} total`;
      $('#payCount').textContent = subtitle;
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--bsg-danger);padding:24px;">${err.message || 'Failed to load'}</td></tr>`;
    }
  }

  function formatPaidLine(paid) {
    if (!paid) return '—';
    let line = (paid.paid_by ? paid.paid_by.split('@')[0] : 'admin') + ' · ';
    try {
      const iso = paid.paid_at && paid.paid_at.length === 19 && paid.paid_at[10] === ' '
        ? paid.paid_at.replace(' ', 'T') + 'Z' : paid.paid_at;
      line += iso ? new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
    } catch (_) { line += paid.paid_at || ''; }
    if (paid.email_sent_at) line += ' · ✉ sent';
    return line;
  }

  function monthName(m) {
    return new Date(2000, m - 1, 1).toLocaleString('en-IN', { month: 'long' });
  }

  // Detail modal: show the breakdown of which submissions are being paid
  function openPayDetail(emp) {
    paySelectedEmp = emp;
    const data = state.paymentsForMonth || {};
    $('#payDetailEmp').textContent = emp.email || '—';
    $('#payDetailMonth').textContent = `${emp.name} · ${monthName(data.month)} ${data.year}`;
    const pill = $('#payDetailStatusPill');
    pill.className = 'status-pill ' + (emp.paid ? 'approved' : 'pending');
    pill.textContent = emp.paid ? 'paid' : 'unpaid';

    const body = $('#payDetailBody');
    body.innerHTML = '';

    // Summary band
    const total = emp.total_payable;
    body.appendChild(el('div', { class: 'paid-summary' },
      el('div', {},
        el('div', { class: 'ps-label' }, 'TOTAL PAYABLE'),
        el('div', { class: 'ps-amount' }, '₹ ' + fmt(total)),
      ),
      el('div', { style: 'text-align:right;' },
        el('div', { class: 'ps-label' }, 'CLAIMS'),
        el('div', { class: 'ps-count' }, String(emp.submission_count)),
      )
    ));

    // Breakdown table
    const table = el('table', { class: 'admin-table', style: 'margin-top:18px;' });
    table.appendChild(el('thead', {}, el('tr', {},
      el('th', {}, 'Reference'),
      el('th', {}, 'Form'),
      el('th', {}, 'Status'),
      el('th', { style: 'text-align:right;' }, 'Amount'),
      el('th', { style: 'text-align:right;' }, 'Actions'),
    )));
    const tbody = el('tbody');
    for (const s of (emp.submissions || [])) {
      tbody.appendChild(el('tr', {},
        el('td', {}, el('strong', {}, s.reference)),
        el('td', {}, FORM_LABEL[s.form_type] || s.form_type),
        el('td', {}, el('span', { class: 'status-pill ' + s.status }, statusLabel(s.status))),
        el('td', { class: 'num', style: 'text-align:right;' }, '₹ ' + fmt(s.payable_amount)),
        el('td', { style: 'text-align:right;' },
          el('button', { class: 'view', onclick: () => {
            $('#payDetailBackdrop').classList.remove('show');
            viewSubmission(s.id);
          } }, 'Open')
        ),
      ));
    }
    table.appendChild(tbody);
    body.appendChild(table);

    if (emp.paid) {
      body.appendChild(el('div', { class: 'pay-already', style: 'margin-top:18px;' },
        el('div', { style: 'font-family:monospace;font-size:10px;letter-spacing:0.08em;color:#065f46;text-transform:uppercase;margin-bottom:4px;' }, 'Already paid'),
        el('div', { style: 'font-size:13px;' }, `Marked paid by ${emp.paid.paid_by} on ${formatPaidLine(emp.paid).replace(emp.paid.paid_by.split('@')[0] + ' · ', '')}`),
        emp.paid.email_sent_at
          ? el('div', { style: 'font-size:12px;color:var(--bsg-muted);margin-top:4px;' }, 'Confirmation email was sent to the employee.')
          : null,
      ));
    }

    // Show/hide the Mark Paid button based on state
    const markBtn = $('#payDetailMark');
    markBtn.style.display = emp.paid ? 'none' : '';

    $('#payDetailBackdrop').classList.add('show');
  }

  async function markPaidWithConfirm(emp) {
    // The detail modal is the canonical mark-paid flow; the table button
    // just opens it. (Direct mark on the table row could land badly if HR
    // hadn't reviewed the breakdown.)
    openPayDetail(emp);
  }

  async function confirmMarkPaid() {
    if (!paySelectedEmp) return;
    const data = state.paymentsForMonth || {};
    const ok = await confirmModal({
      title: `Mark as paid?`,
      body: `${paySelectedEmp.name} will be recorded as paid ₹${fmt(paySelectedEmp.total_payable)} for ${monthName(data.month)} ${data.year}, and a confirmation email will be sent to ${paySelectedEmp.email}.`,
      confirmText: 'Mark Paid & Send Email',
    });
    if (!ok) return;
    showLoading('Marking paid…');
    try {
      const res = await api('/api/admin/payments/mark', {
        method: 'POST',
        body: JSON.stringify({
          employee_id: paySelectedEmp.id,
          year: data.year, month: data.month,
        }),
      });
      if (res.email_sent) toast('Marked paid & email sent', 'success');
      else toast('Marked paid (email could not be sent: ' + (res.email_error || 'unknown') + ')', 'success');
      $('#payDetailBackdrop').classList.remove('show');
      paySelectedEmp = null;
      await drawPaymentsTable();
    } catch (err) {
      toast(err.message || 'Mark-paid failed', 'error');
    } finally { hideLoading(); }
  }

  async function undoPaid(emp) {
    const data = state.paymentsForMonth || {};
    const ok = await confirmModal({
      title: 'Undo paid status?',
      body: `Remove the paid marker for ${emp.name} · ${monthName(data.month)} ${data.year}. (No email is sent on undo; the confirmation email they already received stays in their inbox.)`,
      confirmText: 'Undo',
    });
    if (!ok) return;
    showLoading('Undoing…');
    try {
      await api('/api/admin/payments/unmark', {
        method: 'POST',
        body: JSON.stringify({ employee_id: emp.id, year: data.year, month: data.month }),
      });
      toast('Reverted to unpaid', 'success');
      await drawPaymentsTable();
    } catch (err) {
      toast(err.message || 'Undo failed', 'error');
    } finally { hideLoading(); }
  }

  // ---- Dashboard (admin) --------------------------------------------
  //   Fetches aggregated spend from /api/admin/dashboard and renders
  //   summary tiles + three Chart.js charts. Charts are recreated on each
  //   refresh (destroyed first so canvases don't accumulate).
  const dashCharts = { category: null, project: null, employee: null };

  function dashRangeFromPreset(preset) {
    const today = new Date();
    const y = today.getFullYear(), m = today.getMonth(); // 0-11
    const iso = (d) => d.toISOString().slice(0, 10);
    const lastDay = (yr, mo) => new Date(yr, mo + 1, 0); // mo is 0-11; last day of that month
    switch (preset) {
      case 'this_month':
        return { from: iso(new Date(y, m, 1)), to: iso(lastDay(y, m)) };
      case 'last_month': {
        const lmY = m === 0 ? y - 1 : y;
        const lmM = m === 0 ? 11 : m - 1;
        return { from: iso(new Date(lmY, lmM, 1)), to: iso(lastDay(lmY, lmM)) };
      }
      case 'this_fy': {
        // Apr 1 of this FY (which starts in Apr of either this or last calendar year)
        const fyStartY = m >= 3 ? y : y - 1;
        return { from: iso(new Date(fyStartY, 3, 1)), to: iso(new Date(fyStartY + 1, 2, 31)) };
      }
      case 'last_fy': {
        const fyStartY = (m >= 3 ? y : y - 1) - 1;
        return { from: iso(new Date(fyStartY, 3, 1)), to: iso(new Date(fyStartY + 1, 2, 31)) };
      }
      case 'ytd':
        return { from: iso(new Date(y, 0, 1)), to: iso(today) };
      default:
        return null; // custom — leave as-is
    }
  }

  async function loadDashboard() {
    // Compute date range from preset (if not custom)
    const preset = $('#dashPreset').value;
    const range = dashRangeFromPreset(preset);
    if (range) {
      $('#dashFrom').value = range.from;
      $('#dashTo').value   = range.to;
    }
    const from = $('#dashFrom').value;
    const to   = $('#dashTo').value;
    const includePending = $('#dashIncludePending').checked ? '1' : '0';

    const tiles = $('#dashTiles');
    tiles.innerHTML = '<div style="padding:30px;text-align:center;color:var(--bsg-muted);">Loading…</div>';

    try {
      const params = new URLSearchParams();
      if (from) params.set('from', from);
      if (to)   params.set('to', to);
      params.set('include_pending', includePending);
      const data = await api('/api/admin/dashboard?' + params.toString());
      renderDashboard(data);
    } catch (err) {
      tiles.innerHTML = `<div style="color:var(--bsg-danger);padding:24px;">${err.message || 'Failed to load dashboard'}</div>`;
    }
  }

  function renderDashboard(d) {
    // Tiles
    const s = d.summary || {};
    const fmtINR = (n) => '₹ ' + fmt(n || 0);
    const tiles = $('#dashTiles');
    tiles.innerHTML = '';
    const tile = (label, value, subtle) => el('div', { class: 'dash-tile' },
      el('div', { class: 'dash-tile-lbl' }, label),
      el('div', { class: 'dash-tile-val' }, value),
      subtle ? el('div', { class: 'dash-tile-sub' }, subtle) : null
    );
    tiles.appendChild(tile('Total Spend', fmtINR(s.total_spend)));
    tiles.appendChild(tile('Submissions', String(s.total_submissions || 0)));
    tiles.appendChild(tile('Employees', String(s.active_employees || 0)));
    tiles.appendChild(tile('Projects', String(s.active_projects || 0)));
    if (s.open_advances && s.open_advances.count > 0) {
      tiles.appendChild(tile(
        'Open Advances',
        String(s.open_advances.count),
        fmtINR(s.open_advances.total_requested) + ' committed'
      ));
    }

    // Empty-state
    const hasData = (d.by_category && d.by_category.length) || (d.by_project && d.by_project.length) || (d.by_employee && d.by_employee.length);
    $('#dashEmptyMsg').style.display = hasData ? 'none' : '';
    document.querySelector('.dash-charts').style.display = hasData ? '' : 'none';
    if (!hasData) return;

    // Charts — destroy any previous instances first
    for (const k of Object.keys(dashCharts)) {
      if (dashCharts[k]) { dashCharts[k].destroy(); dashCharts[k] = null; }
    }
    if (typeof Chart === 'undefined') {
      $('#dashEmptyMsg').textContent = 'Chart library failed to load. Check your network.';
      $('#dashEmptyMsg').style.display = '';
      document.querySelector('.dash-charts').style.display = 'none';
      return;
    }

    // Colour palette (cyclable)
    const palette = ['#2563eb', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#a855f7', '#f97316', '#06b6d4', '#84cc16'];
    const pickColors = (n) => Array.from({ length: n }, (_, i) => palette[i % palette.length]);

    // -- Category chart (vertical bar)
    const cat = d.by_category || [];
    dashCharts.category = new Chart($('#dashChartCategory'), {
      type: 'bar',
      data: {
        labels: cat.map(c => c.label),
        datasets: [{ label: 'Spend (₹)', data: cat.map(c => c.total), backgroundColor: pickColors(cat.length), borderWidth: 0 }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => '₹ ' + fmt(ctx.parsed.y) } } },
        scales: { y: { beginAtZero: true, ticks: { callback: (v) => '₹' + fmt(v) } } },
      },
    });

    // -- Project chart (donut)
    const proj = (d.by_project || []).slice(0, 12);
    dashCharts.project = new Chart($('#dashChartProject'), {
      type: 'doughnut',
      data: {
        labels: proj.map(p => p.name),
        datasets: [{ data: proj.map(p => p.total), backgroundColor: pickColors(proj.length), borderWidth: 1, borderColor: '#fff' }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: 'right', labels: { boxWidth: 12, font: { size: 11 } } },
          tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ₹ ${fmt(ctx.parsed)}` } },
        },
        cutout: '55%',
      },
    });

    // -- Employee chart (horizontal bar, top 15)
    const emp = (d.by_employee || []).slice(0, 15);
    dashCharts.employee = new Chart($('#dashChartEmployee'), {
      type: 'bar',
      data: {
        labels: emp.map(e => e.name),
        datasets: [{ label: 'Spend (₹)', data: emp.map(e => e.total), backgroundColor: '#2563eb', borderWidth: 0 }],
      },
      options: {
        indexAxis: 'y', responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => '₹ ' + fmt(ctx.parsed.x) } } },
        scales: { x: { beginAtZero: true, ticks: { callback: (v) => '₹' + fmt(v) } } },
      },
    });
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
  $('#openAdvRefreshBtn') && $('#openAdvRefreshBtn').addEventListener('click', renderOpenAdvances);

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

  // Project admin
  $('#addProjectBtn')   && $('#addProjectBtn').addEventListener('click', () => openProjectModal(null));
  $('#projModalCancel') && $('#projModalCancel').addEventListener('click', closeProjectModal);
  $('#projModalSave')   && $('#projModalSave').addEventListener('click', saveProject);
  $('#projModalBackdrop') && $('#projModalBackdrop').addEventListener('click', (e) => { if (e.target.id === 'projModalBackdrop') closeProjectModal(); });

  // Dashboard
  $('#dashRefreshBtn')      && $('#dashRefreshBtn').addEventListener('click', loadDashboard);
  $('#dashPreset')          && $('#dashPreset').addEventListener('change', loadDashboard);
  $('#dashIncludePending')  && $('#dashIncludePending').addEventListener('change', loadDashboard);
  $('#dashFrom')            && $('#dashFrom').addEventListener('change', () => { $('#dashPreset').value = 'custom'; loadDashboard(); });
  $('#dashTo')              && $('#dashTo').addEventListener('change', () => { $('#dashPreset').value = 'custom'; loadDashboard(); });
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
  $('#pendFormFilter') && $('#pendFormFilter').addEventListener('change', drawPendingTable);
  $('#pendPeriodFilter') && $('#pendPeriodFilter').addEventListener('change', drawPendingTable);
  $('#pendExpandAll')  && $('#pendExpandAll').addEventListener('click',  () => setAllFolders('pend', true));
  $('#pendCollapseAll')&& $('#pendCollapseAll').addEventListener('click', () => setAllFolders('pend', false));
  $('#subSearch') && $('#subSearch').addEventListener('input', drawSubmissionsTable);
  $('#subFormFilter') && $('#subFormFilter').addEventListener('change', drawSubmissionsTable);
  $('#subPeriodFilter') && $('#subPeriodFilter').addEventListener('change', drawSubmissionsTable);
  $('#subStatusFilter') && $('#subStatusFilter').addEventListener('change', async () => { await loadSubmissions(); drawSubmissionsTable(); });
  $('#subExpandAll')   && $('#subExpandAll').addEventListener('click',  () => setAllFolders('sub', true));
  $('#subCollapseAll') && $('#subCollapseAll').addEventListener('click', () => setAllFolders('sub', false));

  // Payments tab
  $('#payMonth')      && $('#payMonth').addEventListener('change', drawPaymentsTable);
  $('#payRefreshBtn') && $('#payRefreshBtn').addEventListener('click', drawPaymentsTable);
  $('#payDetailClose')&& $('#payDetailClose').addEventListener('click', () => { $('#payDetailBackdrop').classList.remove('show'); paySelectedEmp = null; });
  $('#payDetailMark') && $('#payDetailMark').addEventListener('click', confirmMarkPaid);
  $('#payDetailBackdrop') && $('#payDetailBackdrop').addEventListener('click', (e) => { if (e.target.id === 'payDetailBackdrop') { $('#payDetailBackdrop').classList.remove('show'); paySelectedEmp = null; } });

  boot();
})();
