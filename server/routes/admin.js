// ====================================================================
//  ROUTES · /api/admin   (ADMIN_EMAILS only)
// ====================================================================

const express = require('express');
const { stmts, db } = require('../db');
const { requireAdmin } = require('../services/auth');
const { hashPassword, authMethodForEmail } = require('../services/auth');
const syncSvc = require('../services/sync');
const { buildReportPdf } = require('../services/report-builder');

const router = express.Router();

const LEVEL_MAP = { JUNIOR: 'L1', SENIOR: 'L2', MANAGER: 'L3', L1: 'L1', L2: 'L2', L3: 'L3' };
function normalizeLevel(v) {
  return LEVEL_MAP[(v || '').toUpperCase().trim()] || null;
}

// ---- Submissions overview -----------------------------------------
router.get('/submissions', requireAdmin, (req, res) => {
  const status = req.query.status;
  const rows = status ? stmts.listSubmissionsByStatus.all(status) : stmts.listAllSubmissions.all();
  res.json({ submissions: rows });
});

// ---- Pending approvals (convenience) ------------------------------
//   Returns BOTH new submissions awaiting first approval AND open
//   Travel Advances awaiting settlement approval. The frontend can
//   distinguish using the 'status' field on each row.
router.get('/pending', requireAdmin, (req, res) => {
  const pending = stmts.listSubmissionsByStatus.all('pending');
  const settlementPending = stmts.listSubmissionsByStatus.all('settlement_pending');
  res.json({
    submissions: [...pending, ...settlementPending],
    pending_count: pending.length,
    settlement_pending_count: settlementPending.length,
  });
});

// ---- Approve a submission -----------------------------------------
//  For most forms: generates the merged report (report + bills), stores it
//  on OneDrive under <Employee>/Reports/, flips status to 'approved',
//  updates Excel.
//
//  For Travel Advance requests: there are no bills yet — the advance stays
//  OPEN. We flip status to 'advance_approved' and skip the bill-merge step.
//  The advance closes later via the settlement endpoints below.
router.post('/submissions/:id/approve', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const sub = stmts.getSubmission.get(id);
  if (!sub) return res.status(404).json({ error: 'Submission not found.' });
  if (sub.status !== 'pending') {
    return res.status(400).json({ error: `Cannot approve a submission in '${sub.status}' status.` });
  }

  const isAdvance = sub.form_type === 'met_advance';

  try {
    if (isAdvance) {
      // Advance: keep it open, awaiting employee settlement after the trip.
      stmts.approveAdvanceRequest.run({ id, reviewed_by: req.user.email, review_note: (req.body && req.body.note) || '' });
      stmts.insertAudit.run({
        actor_email: req.user.email, action: 'APPROVE_ADVANCE', target_type: 'submission', target_id: id,
        meta_json: JSON.stringify({ ref: sub.reference }),
        ip_address: req.ip,
      });
      return res.json({ ok: true, advance_open: true, pdf_url: `/api/submissions/${id}/pdf` });
    }

    // Mark approved first (so the Excel row reflects it)
    stmts.approveSubmission.run({ id, reviewed_by: req.user.email, review_note: (req.body && req.body.note) || '' });

    // Build the base report PDF, then merge with bills + mirror to OneDrive
    const reportPdfPath = await buildReportPdf(stmts.getSubmission.get(id), { draft: false });
    const attachments = stmts.listAttachments.all(id);
    const employee = {
      name: sub.employee_name, email: sub.employee_email, employee_code: sub.employee_code,
      level: sub.level, designation: sub.designation, department: sub.department,
    };
    const result = await syncSvc.onApprove(stmts.getSubmission.get(id), employee, attachments, reportPdfPath);

    stmts.insertAudit.run({
      actor_email: req.user.email, action: 'APPROVE', target_type: 'submission', target_id: id,
      meta_json: JSON.stringify({ ref: sub.reference, od_synced: result.synced, reason: result.reason || null }),
      ip_address: req.ip,
    });

    res.json({ ok: true, od_synced: result.synced, od_reason: result.reason || null,
               pdf_url: `/api/submissions/${id}/pdf` });
  } catch (err) {
    console.error('[approve]', err);
    res.status(500).json({ error: err.message || 'Approval failed' });
  }
});

// ---- Approve a settlement (Travel Advance, second-stage approval) -----
//   Triggered after the employee has filed actuals + bills against an
//   open advance. Closes the advance (status='settled') and runs the
//   normal report/merge/OneDrive flow.
router.post('/submissions/:id/approve-settlement', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const sub = stmts.getSubmission.get(id);
  if (!sub) return res.status(404).json({ error: 'Submission not found.' });
  if (sub.form_type !== 'met_advance') {
    return res.status(400).json({ error: 'Settlement approval only applies to Travel Advance submissions.' });
  }
  if (sub.status !== 'settlement_pending') {
    return res.status(400).json({ error: `Cannot approve settlement from '${sub.status}' status.` });
  }
  try {
    stmts.approveSettlement.run({
      id, reviewed_by: req.user.email,
      settlement_note: (req.body && req.body.note) || '',
    });
    const fresh = stmts.getSubmission.get(id);
    const reportPdfPath = await buildReportPdf(fresh, { draft: false });
    const attachments = stmts.listAttachments.all(id);
    const employee = {
      name: sub.employee_name, email: sub.employee_email, employee_code: sub.employee_code,
      level: sub.level, designation: sub.designation, department: sub.department,
    };
    const result = await syncSvc.onApprove(fresh, employee, attachments, reportPdfPath);
    stmts.insertAudit.run({
      actor_email: req.user.email, action: 'APPROVE_SETTLEMENT', target_type: 'submission', target_id: id,
      meta_json: JSON.stringify({ ref: sub.reference, od_synced: result.synced }),
      ip_address: req.ip,
    });
    res.json({ ok: true, settled: true, od_synced: result.synced });
  } catch (err) {
    console.error('[approve-settlement]', err);
    res.status(500).json({ error: err.message || 'Settlement approval failed' });
  }
});

// ---- Reject a settlement (employee may re-file) ----------------------
router.post('/submissions/:id/reject-settlement', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const sub = stmts.getSubmission.get(id);
  if (!sub) return res.status(404).json({ error: 'Submission not found.' });
  if (sub.form_type !== 'met_advance') {
    return res.status(400).json({ error: 'Settlement rejection only applies to Travel Advance submissions.' });
  }
  if (sub.status !== 'settlement_pending') {
    return res.status(400).json({ error: `Cannot reject settlement from '${sub.status}' status.` });
  }
  stmts.rejectSettlement.run({
    id, reviewed_by: req.user.email,
    settlement_note: (req.body && req.body.note) || '',
  });
  stmts.insertAudit.run({
    actor_email: req.user.email, action: 'REJECT_SETTLEMENT', target_type: 'submission', target_id: id,
    meta_json: JSON.stringify({ ref: sub.reference, note: (req.body && req.body.note) || '' }),
    ip_address: req.ip,
  });
  res.json({ ok: true, rejected: true });
});

// ---- Reject a submission ------------------------------------------
router.post('/submissions/:id/reject', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const sub = stmts.getSubmission.get(id);
  if (!sub) return res.status(404).json({ error: 'Submission not found.' });

  try {
    stmts.rejectSubmission.run({ id, reviewed_by: req.user.email, review_note: (req.body && req.body.note) || '' });
    const employee = {
      name: sub.employee_name, email: sub.employee_email, employee_code: sub.employee_code,
      level: sub.level, designation: sub.designation, department: sub.department,
    };
    const result = await syncSvc.onReject(stmts.getSubmission.get(id), employee);

    stmts.insertAudit.run({
      actor_email: req.user.email, action: 'REJECT', target_type: 'submission', target_id: id,
      meta_json: JSON.stringify({ ref: sub.reference, note: (req.body && req.body.note) || '', od_synced: result.synced }),
      ip_address: req.ip,
    });

    res.json({ ok: true, od_synced: result.synced });
  } catch (err) {
    console.error('[reject]', err);
    res.status(500).json({ error: err.message || 'Rejection failed' });
  }
});

// ---- Employees: list ----------------------------------------------
router.get('/employees', requireAdmin, (req, res) => {
  const includeInactive = req.query.all === '1';
  const rows = includeInactive ? stmts.listEmployeesAll.all() : stmts.listEmployees.all();
  res.json({ employees: rows });
});

// ---- Employees: create --------------------------------------------
router.post('/employees', requireAdmin, (req, res) => {
  const e = req.body || {};
  const level = normalizeLevel(e.level);
  if (!e.email || !e.name) return res.status(400).json({ error: 'Name and email are required.' });
  if (!level) return res.status(400).json({ error: 'Level must be Junior, Senior, or Manager.' });

  const dup = stmts.findAllByEmail.all(e.email.toLowerCase())
    .find(r => r.name.toLowerCase() === e.name.toLowerCase());
  if (dup) return res.status(409).json({ error: 'An active employee with this name and email already exists.' });

  const email = e.email.toLowerCase().trim();
  // auth_method: explicit choice, else inferred from the email domain
  const method = (e.auth_method && ['microsoft', 'google', 'password'].includes(e.auth_method))
    ? e.auth_method : authMethodForEmail(email);

  const info = stmts.insertEmployee.run({
    email,
    name: e.name.trim(),
    employee_code: e.employee_code ? e.employee_code.trim() : null,
    company: 'metfraa',
    level,
    designation: e.designation ? e.designation.trim() : null,
    department: e.department ? e.department.trim() : null,
    manager_email: e.manager_email ? e.manager_email.toLowerCase().trim() : null,
    auth_method: method,
    password_hash: method === 'password' ? hashPassword('Metfraa@123') : null,
    must_change_pw: method === 'password' ? 1 : 0,
  });

  stmts.insertAudit.run({
    actor_email: req.user.email, action: 'EMPLOYEE_CREATE',
    target_type: 'employee', target_id: info.lastInsertRowid,
    meta_json: JSON.stringify({ email, name: e.name, level, auth_method: method }), ip_address: req.ip,
  });

  res.json({ ok: true, id: info.lastInsertRowid, auth_method: method,
             default_password: method === 'password' ? 'Metfraa@123' : null });
});

// ---- Employees: update --------------------------------------------
router.put('/employees/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const current = stmts.getEmployeeById.get(id);
  if (!current) return res.status(404).json({ error: 'Employee not found.' });

  const e = req.body || {};
  const level = normalizeLevel(e.level) || current.level;
  if (!e.email || !e.name) return res.status(400).json({ error: 'Name and email are required.' });

  const method = (e.auth_method && ['microsoft', 'google', 'password'].includes(e.auth_method))
    ? e.auth_method : current.auth_method;

  stmts.updateEmployee.run({
    id,
    email: e.email.toLowerCase().trim(),
    name: e.name.trim(),
    employee_code: e.employee_code != null ? String(e.employee_code).trim() : current.employee_code,
    company: 'metfraa',
    level,
    designation: e.designation != null ? String(e.designation).trim() : current.designation,
    department: e.department != null ? String(e.department).trim() : current.department,
    manager_email: e.manager_email ? e.manager_email.toLowerCase().trim() : current.manager_email,
    auth_method: method,
    is_active: e.is_active != null ? (e.is_active ? 1 : 0) : current.is_active,
  });

  // If switching TO password and they have no hash yet, set the default.
  if (method === 'password' && !current.password_hash) {
    stmts.setPassword.run({ id, hash: hashPassword('Metfraa@123'), must_change: 1 });
  }

  stmts.insertAudit.run({
    actor_email: req.user.email, action: 'EMPLOYEE_UPDATE',
    target_type: 'employee', target_id: id,
    meta_json: JSON.stringify({ email: e.email, name: e.name, level, auth_method: method }), ip_address: req.ip,
  });

  res.json({ ok: true });
});

// ---- Employees: reset password (admin) ----------------------------
router.post('/employees/:id/reset-password', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const emp = stmts.getEmployeeById.get(id);
  if (!emp) return res.status(404).json({ error: 'Employee not found.' });
  const newPw = (req.body && req.body.password) || 'Metfraa@123';
  if (String(newPw).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  stmts.setPassword.run({ id, hash: hashPassword(String(newPw)), must_change: 1 });
  stmts.insertAudit.run({
    actor_email: req.user.email, action: 'PASSWORD_RESET', target_type: 'employee', target_id: id,
    meta_json: JSON.stringify({ email: emp.email }), ip_address: req.ip,
  });
  res.json({ ok: true, password: newPw, note: 'User must change this on next login.' });
});

// ---- Employees: deactivate (soft delete) --------------------------
router.delete('/employees/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const current = stmts.getEmployeeById.get(id);
  if (!current) return res.status(404).json({ error: 'Employee not found.' });

  // Never hard-delete — submissions reference the employee row.
  stmts.deactivateEmployee.run(id);
  const subCount = stmts.countEmployeeSubmissions.get(id).n;

  stmts.insertAudit.run({
    actor_email: req.user.email, action: 'EMPLOYEE_DEACTIVATE',
    target_type: 'employee', target_id: id,
    meta_json: JSON.stringify({ email: current.email, name: current.name, submissions: subCount }), ip_address: req.ip,
  });

  res.json({ ok: true, submissions_retained: subCount });
});

// ---- Projects (admin-managed list referenced by submissions) -------
//   Drives the "Project" dropdown on every form.
//   Soft-delete (deactivate) when a project has submissions referencing
//   it; hard-delete only if it's never been used.
router.get('/projects', requireAdmin, (req, res) => {
  res.json({ projects: stmts.listProjectsAll.all() });
});

router.post('/projects', requireAdmin, (req, res) => {
  const { code, name } = req.body || {};
  const trimmedName = (name || '').trim();
  if (!trimmedName) return res.status(400).json({ error: 'Project name is required.' });
  if (trimmedName.length > 100) return res.status(400).json({ error: 'Project name is too long (max 100 chars).' });

  // De-dup on name (case-insensitive). If a row exists, reactivate it.
  const existing = stmts.findProjectByName.get(trimmedName);
  if (existing) {
    const full = stmts.getProject.get(existing.id);
    stmts.updateProject.run({ id: existing.id, code: (code || full.code || '').trim() || null, name: trimmedName, is_active: 1 });
    stmts.insertAudit.run({
      actor_email: req.user.email, action: 'PROJECT_REACTIVATE',
      target_type: 'project', target_id: existing.id,
      meta_json: JSON.stringify({ name: trimmedName }), ip_address: req.ip,
    });
    return res.json({ ok: true, project: stmts.getProject.get(existing.id), reactivated: true });
  }

  const result = stmts.insertProject.run({ code: (code || '').trim() || null, name: trimmedName, is_active: 1 });
  stmts.insertAudit.run({
    actor_email: req.user.email, action: 'PROJECT_CREATE',
    target_type: 'project', target_id: result.lastInsertRowid,
    meta_json: JSON.stringify({ name: trimmedName }), ip_address: req.ip,
  });
  res.json({ ok: true, project: stmts.getProject.get(result.lastInsertRowid) });
});

router.put('/projects/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const current = stmts.getProject.get(id);
  if (!current) return res.status(404).json({ error: 'Project not found.' });
  const { code, name, is_active } = req.body || {};
  const trimmedName = (name != null ? String(name) : current.name).trim();
  if (!trimmedName) return res.status(400).json({ error: 'Project name is required.' });
  stmts.updateProject.run({
    id,
    code: code != null ? (String(code).trim() || null) : current.code,
    name: trimmedName,
    is_active: is_active != null ? (is_active ? 1 : 0) : current.is_active,
  });
  stmts.insertAudit.run({
    actor_email: req.user.email, action: 'PROJECT_UPDATE',
    target_type: 'project', target_id: id,
    meta_json: JSON.stringify({ name: trimmedName }), ip_address: req.ip,
  });
  res.json({ ok: true, project: stmts.getProject.get(id) });
});

router.delete('/projects/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const current = stmts.getProject.get(id);
  if (!current) return res.status(404).json({ error: 'Project not found.' });
  const usageCount = stmts.projectUsageCount.get(id).n;
  if (usageCount > 0) {
    // Has historical submissions — deactivate instead of hard-deleting
    stmts.deactivateProject.run(id);
    stmts.insertAudit.run({
      actor_email: req.user.email, action: 'PROJECT_DEACTIVATE',
      target_type: 'project', target_id: id,
      meta_json: JSON.stringify({ name: current.name, used_in_submissions: usageCount }), ip_address: req.ip,
    });
    return res.json({ ok: true, deactivated: true, submissions_retained: usageCount });
  }
  stmts.deleteProject.run(id);
  stmts.insertAudit.run({
    actor_email: req.user.email, action: 'PROJECT_DELETE',
    target_type: 'project', target_id: id,
    meta_json: JSON.stringify({ name: current.name }), ip_address: req.ip,
  });
  res.json({ ok: true, deleted: true });
});

// ---- Dashboard (spend aggregation) ---------------------------------
//   GET /api/admin/dashboard?from=YYYY-MM-DD&to=YYYY-MM-DD&include_pending=0|1
//
//   Aggregates submission spend by category, project, and employee within
//   a date range. Three rules baked in:
//
//   1. By default, only 'approved' and 'settled' submissions count (true
//      actual spend). Setting include_pending=1 also includes 'pending',
//      'advance_approved', and 'settlement_pending' — useful for live
//      "committed spend" views.
//
//   2. Travel advances are special-cased:
//      - 'settled': counted at the actual amount spent (actuals_json.actual_amount)
//      - 'advance_approved' / 'settlement_pending': counted at total_amount
//         BUT only when include_pending=1
//      - 'pending': counted at total_amount only when include_pending=1
//
//   3. Outstation Travel splits its total_amount across its sub-categories
//      (travel / accommodation / food / local_conveyance / others) using
//      the payload. Other forms map 1:1 to a category bucket.
router.get('/dashboard', requireAdmin, (req, res) => {
  try {
    const from = (req.query.from || '').slice(0, 10);
    const to   = (req.query.to   || '').slice(0, 10);
    const includePending = req.query.include_pending === '1' || req.query.include_pending === 'true';

    // Status filter: approved/settled are always in; pending family only when requested
    const statuses = includePending
      ? ['approved', 'settled', 'pending', 'advance_approved', 'settlement_pending']
      : ['approved', 'settled'];
    const placeholders = statuses.map(() => '?').join(',');

    // Date filter on submitted_at; both bounds optional
    const conds = [`status IN (${placeholders})`];
    const params = [...statuses];
    if (from) { conds.push(`DATE(submitted_at) >= ?`); params.push(from); }
    if (to)   { conds.push(`DATE(submitted_at) <= ?`); params.push(to); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

    const rows = db.prepare(`
      SELECT s.id, s.form_type, s.status, s.total_amount, s.payload_json, s.actuals_json,
             s.project_id, s.purpose_category, s.client_name, s.submitted_at,
             e.id AS employee_id, e.name AS employee_name
      FROM submissions s
      LEFT JOIN employees e ON e.id = s.employee_id
      ${where}
      ORDER BY s.id DESC
    `).all(...params);

    // -- Aggregation buckets --
    const byCategory = {};   // 'Own Travel' → 12345
    const byProject  = {};   // projectId → { name, total }
    const byEmployee = {};   // empId → { name, total }
    const byStatus   = {};   // status → count
    let totalSpend = 0;
    let totalSubmissions = 0;
    const openAdvances = { count: 0, total_requested: 0 };

    // Category labels — what's shown on the chart
    const CAT_LABEL = {
      own_travel:   'Own Travel',
      cab:          'Cab Travel',
      accommodation:'Accommodation',
      food:         'Food',
      local_conv:   'Local Conveyance',
      out_travel:   'Outstation Travel',
      out_others:   'Outstation Others',
      misc:         'Miscellaneous',
      advance:      'Travel Advances',
    };
    const addCat = (key, amt) => { if (!(amt > 0)) return; const lbl = CAT_LABEL[key] || key; byCategory[lbl] = (byCategory[lbl] || 0) + amt; };

    // Project name lookup (we need names for the chart labels)
    const projectMap = new Map();
    for (const p of stmts.listProjectsAll.all()) {
      projectMap.set(p.id, p);
    }

    for (const r of rows) {
      byStatus[r.status] = (byStatus[r.status] || 0) + 1;

      // What amount counts as "spent" for THIS row?
      let amount = 0;
      if (r.form_type === 'met_advance') {
        if (r.status === 'settled') {
          // Use actual settlement amount (could be more or less than requested)
          try {
            const a = JSON.parse(r.actuals_json || '{}');
            amount = parseFloat(a.actual_amount) || 0;
          } catch (_) { amount = 0; }
        } else if (r.status === 'pending') {
          // Unsettled — count as committed only if include_pending
          amount = includePending ? (r.total_amount || 0) : 0;
          if (!includePending) {
            // Still surface it as an "open advance" tile (separate from spend)
            openAdvances.count++;
            openAdvances.total_requested += (r.total_amount || 0);
          }
        } else if (r.status === 'advance_approved' || r.status === 'settlement_pending') {
          openAdvances.count++;
          openAdvances.total_requested += (r.total_amount || 0);
          amount = includePending ? (r.total_amount || 0) : 0;
        }
      } else {
        amount = r.total_amount || 0;
      }

      if (amount <= 0) continue;
      totalSpend += amount;
      totalSubmissions++;

      // --- Category attribution ---
      if (r.form_type === 'met_local' || r.form_type === 'bsc_conveyance') {
        addCat('own_travel', amount);
      } else if (r.form_type === 'met_cab') {
        addCat('cab', amount);
      } else if (r.form_type === 'met_accommodation') {
        addCat('accommodation', amount);
      } else if (r.form_type === 'met_misc') {
        addCat('misc', amount);
      } else if (r.form_type === 'met_advance') {
        addCat('advance', amount);
      } else if (r.form_type === 'met_dtr') {
        // Daily commute — public transport / autos. Whole submission goes
        // into 'own_travel' (same conceptual bucket as Local Travel Allowance).
        addCat('own_travel', amount);
      } else if (r.form_type === 'met_outstation' || r.form_type === 'bsc_expense') {
        // Walk the payload's trips and split by category
        try {
          const payload = JSON.parse(r.payload_json || '{}');
          for (const trip of (payload.trips || [])) {
            const cats = trip.categories || {};
            for (const [catKey, items] of Object.entries(cats)) {
              const sum = (items || []).reduce((s, it) => s + (parseFloat(it.amount) || 0), 0);
              if (sum <= 0) continue;
              if (catKey === 'travel') addCat('out_travel', sum);
              else if (catKey === 'accommodation') addCat('accommodation', sum);
              else if (catKey === 'food') addCat('food', sum);
              else if (catKey === 'local_conveyance' || catKey === 'conveyance') addCat('local_conv', sum);
              else addCat('out_others', sum);
            }
          }
        } catch (_) {
          // Fallback: bucket the whole amount as outstation if payload is malformed
          addCat('out_travel', amount);
        }
      } else {
        addCat('misc', amount);
      }

      // --- Project attribution ---
      // DTR has per-entry projects (submission-level project_id is NULL).
      // Walk entries and credit each one's fare to its own project bucket.
      if (r.form_type === 'met_dtr') {
        try {
          const payload = JSON.parse(r.payload_json || '{}');
          for (const e of (payload.entries || [])) {
            const fare = parseFloat(e.fare) || 0;
            if (fare <= 0) continue;
            if (e.project_id) {
              const pj = projectMap.get(e.project_id);
              const name = pj ? (pj.code && pj.code !== pj.name ? `${pj.name} (${pj.code})` : pj.name) : `Project #${e.project_id}`;
              const cur = byProject[e.project_id] || { name, total: 0 };
              cur.total += fare;
              byProject[e.project_id] = cur;
            } else if (e.client_name) {
              const key = 'prospect:' + e.client_name.toLowerCase();
              const cur = byProject[key] || { name: e.client_name + ' (Prospect)', total: 0 };
              cur.total += fare;
              byProject[key] = cur;
            } else {
              const cur = byProject['_unspecified'] || { name: 'No Project', total: 0 };
              cur.total += fare;
              byProject['_unspecified'] = cur;
            }
          }
        } catch (_) {
          // Fall through — DTR with malformed payload counts as unspecified
          const cur = byProject['_unspecified'] || { name: 'No Project', total: 0 };
          cur.total += amount;
          byProject['_unspecified'] = cur;
        }
      } else if (r.project_id) {
        const p = projectMap.get(r.project_id);
        const name = p ? (p.code && p.code !== p.name ? `${p.name} (${p.code})` : p.name) : `Project #${r.project_id}`;
        const cur = byProject[r.project_id] || { name, total: 0 };
        cur.total += amount;
        byProject[r.project_id] = cur;
      } else if (r.client_name) {
        const key = 'prospect:' + r.client_name.toLowerCase();
        const cur = byProject[key] || { name: r.client_name + ' (Prospect)', total: 0 };
        cur.total += amount;
        byProject[key] = cur;
      } else {
        const cur = byProject['_unspecified'] || { name: 'No Project', total: 0 };
        cur.total += amount;
        byProject['_unspecified'] = cur;
      }

      // --- Employee attribution ---
      if (r.employee_id) {
        const cur = byEmployee[r.employee_id] || { name: r.employee_name || `#${r.employee_id}`, total: 0 };
        cur.total += amount;
        byEmployee[r.employee_id] = cur;
      }
    }

    res.json({
      filters: { from, to, include_pending: includePending },
      summary: {
        total_spend: +totalSpend.toFixed(2),
        total_submissions: totalSubmissions,
        active_employees: Object.keys(byEmployee).length,
        active_projects: Object.keys(byProject).filter(k => k !== '_unspecified' && !k.startsWith('prospect:')).length,
        open_advances: openAdvances,
      },
      by_category: Object.entries(byCategory).map(([label, total]) => ({ label, total: +total.toFixed(2) }))
        .sort((a, b) => b.total - a.total),
      by_project:  Object.values(byProject).map(p => ({ name: p.name, total: +p.total.toFixed(2) }))
        .sort((a, b) => b.total - a.total),
      by_employee: Object.values(byEmployee).map(e => ({ name: e.name, total: +e.total.toFixed(2) }))
        .sort((a, b) => b.total - a.total),
      by_status: byStatus,
    });
  } catch (err) {
    console.error('[dashboard]', err);
    res.status(500).json({ error: err.message || 'Dashboard failed' });
  }
});

// ---- Audit log -----------------------------------------------------
router.get('/audit', requireAdmin, (req, res) => {
  res.json({ audit: db.prepare(`SELECT * FROM audit_log ORDER BY id DESC LIMIT 500`).all() });
});

// ---- Is the current user an admin? (used by frontend to show the panel)
router.get('/whoami', (req, res) => {
  const admins = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const isAdmin = req.user && admins.includes(req.user.email.toLowerCase());
  res.json({ is_admin: !!isAdmin });
});

module.exports = router;
