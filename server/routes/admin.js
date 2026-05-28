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
router.get('/pending', requireAdmin, (req, res) => {
  res.json({ submissions: stmts.listSubmissionsByStatus.all('pending') });
});

// ---- Approve a submission -----------------------------------------
//  Generates the merged report (report + bills), stores it on OneDrive
//  under <Employee>/Reports/, flips status to approved, updates Excel.
router.post('/submissions/:id/approve', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const sub = stmts.getSubmission.get(id);
  if (!sub) return res.status(404).json({ error: 'Submission not found.' });
  if (sub.status === 'approved') return res.status(400).json({ error: 'Already approved.' });

  try {
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
