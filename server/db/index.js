// ====================================================================
//  DATABASE · SQLite via better-sqlite3
// ====================================================================
//  Single source of truth for the schema. Idempotent — running it
//  multiple times is safe; existing tables/columns are preserved.
// ====================================================================

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { DB_PATH } = require('../config/paths');

const db = new Database(DB_PATH);

// Better SQLite settings for production
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');

// ====================================================================
//  SCHEMA
// ====================================================================

db.exec(`
  -- Employees: master record. Loaded by HR/admin. Levels drive policy
  -- entitlements (rates, daily caps).
  -- NOTE: email is intentionally NOT unique. Several Metfraa staff
  -- genuinely share a mailbox (e.g. accounts@, admin@). SSO login
  -- resolves to the first active employee row matching that email.
  CREATE TABLE IF NOT EXISTS employees (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT NOT NULL COLLATE NOCASE,
    name          TEXT NOT NULL,
    employee_code TEXT,
    company       TEXT NOT NULL,                    -- 'bsc' or 'metfraa'
    level         TEXT NOT NULL,                    -- L1 / L2 / L3 (Metfraa) or CAT1/CAT2 (BSC)
    designation   TEXT,
    department    TEXT,
    manager_email TEXT,
    -- login method: 'microsoft' (M365 SSO) | 'google' (Gmail SSO) | 'password' (portal login)
    auth_method   TEXT NOT NULL DEFAULT 'microsoft',
    password_hash TEXT,                             -- bcrypt hash, only for auth_method='password'
    must_change_pw INTEGER NOT NULL DEFAULT 0,      -- force password change on next login
    is_active     INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_employees_company ON employees(company);
  CREATE INDEX IF NOT EXISTS idx_employees_email   ON employees(email);

  -- Submissions: every form an employee fills. Header row.
  CREATE TABLE IF NOT EXISTS submissions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    reference       TEXT UNIQUE NOT NULL,           -- e.g. MET-OT-260528-A4F7
    employee_id     INTEGER NOT NULL REFERENCES employees(id),
    company         TEXT NOT NULL,
    form_type       TEXT NOT NULL,                  -- 'met_local' | 'met_cab' | 'met_accommodation' | 'met_outstation' | (bsc_* retained)
    period          TEXT,                           -- YYYY-MM (most forms) or specific dates
    payload_json    TEXT NOT NULL,                  -- full form data (denormalised, source of truth)
    total_amount    REAL NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'pending',    -- pending | approved | draft (returned for edit) | rejected (legacy) | advance_approved | settlement_pending | settled | settlement_rejected
    pdf_path        TEXT,                           -- final merged report path (set ON APPROVAL)
    email_sent_at   TEXT,
    email_error     TEXT,
    -- approval workflow
    reviewed_by     TEXT,                           -- admin email who approved/rejected
    reviewed_at     TEXT,
    review_note     TEXT,                           -- optional rejection reason / note
    -- OneDrive sync tracking
    od_log_synced   INTEGER NOT NULL DEFAULT 0,     -- excel log row written?
    od_uploads_synced INTEGER NOT NULL DEFAULT 0,   -- raw bills pushed?
    od_report_synced  INTEGER NOT NULL DEFAULT 0,   -- final report pushed (on approval)?
    od_error        TEXT,                           -- last OneDrive sync error, if any
    submitted_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_subs_employee ON submissions(employee_id);
  CREATE INDEX IF NOT EXISTS idx_subs_company  ON submissions(company);
  CREATE INDEX IF NOT EXISTS idx_subs_period   ON submissions(period);
  CREATE INDEX IF NOT EXISTS idx_subs_status   ON submissions(status);

  -- Bill attachments: photos / PDFs uploaded with a submission.
  CREATE TABLE IF NOT EXISTS attachments (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
    filename      TEXT NOT NULL,                    -- original filename
    stored_path   TEXT NOT NULL,                    -- relative path on disk
    mime_type     TEXT NOT NULL,
    size_bytes    INTEGER NOT NULL,
    category      TEXT,                             -- accommodation | food | conveyance | other | general
    label         TEXT,                             -- user-supplied caption
    uploaded_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_att_submission ON attachments(submission_id);

  -- Pending uploads: bills uploaded BEFORE the form is submitted (drag-drop UX).
  -- These get linked to a submission on submit, or garbage-collected if stale.
  CREATE TABLE IF NOT EXISTS pending_uploads (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    upload_token  TEXT NOT NULL,                    -- groups uploads for a single in-progress form
    employee_id   INTEGER NOT NULL REFERENCES employees(id),
    filename      TEXT NOT NULL,
    stored_path   TEXT NOT NULL,
    mime_type     TEXT NOT NULL,
    size_bytes    INTEGER NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_pending_token ON pending_uploads(upload_token);

  -- Audit log: every meaningful action
  CREATE TABLE IF NOT EXISTS audit_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_email   TEXT,
    action        TEXT NOT NULL,                    -- LOGIN, SUBMIT, APPROVE, REJECT, etc.
    target_type   TEXT,                             -- submission, employee, etc.
    target_id     INTEGER,
    meta_json     TEXT,
    ip_address    TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_audit_actor  ON audit_log(actor_email);
  CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);

  -- Projects (sites / clients) referenced from submissions.
  -- Managed by admin via the Projects tab; employees pick from active ones.
  CREATE TABLE IF NOT EXISTS projects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    code        TEXT,                              -- short tag, e.g. 'AMNS'
    name        TEXT NOT NULL,                     -- display name
    is_active   INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_projects_active ON projects(is_active);
`);

// --------------------------------------------------------------------
//  Lightweight migration: add columns introduced after first release
//  (safe to run every boot — only adds what's missing).
// --------------------------------------------------------------------
(function migrate() {
  const cols = db.prepare(`PRAGMA table_info(submissions)`).all().map(c => c.name);
  const add = (name, ddl) => { if (!cols.includes(name)) db.exec(`ALTER TABLE submissions ADD COLUMN ${ddl}`); };
  add('reviewed_by',       `reviewed_by TEXT`);
  add('reviewed_at',       `reviewed_at TEXT`);
  add('review_note',       `review_note TEXT`);
  add('od_log_synced',     `od_log_synced INTEGER NOT NULL DEFAULT 0`);
  add('od_uploads_synced', `od_uploads_synced INTEGER NOT NULL DEFAULT 0`);
  add('od_report_synced',  `od_report_synced INTEGER NOT NULL DEFAULT 0`);
  add('od_error',          `od_error TEXT`);
  // Advance-settlement workflow columns (added after Travel Advance form launch).
  // Statuses possible on submissions:
  //   pending             — newly submitted, awaiting first review
  //   approved            — non-advance forms: final approved state
  //   rejected            — final rejected state
  //   advance_approved    — Travel Advance: first approval done, advance is open, awaiting settlement
  //   settlement_pending  — Travel Advance: employee has submitted settlement, awaiting second review
  //   settled             — Travel Advance: settlement approved, advance closed
  //   settlement_rejected — Travel Advance: settlement rejected, employee may resubmit
  add('actuals_json',            `actuals_json TEXT`);
  add('settled_at',              `settled_at TEXT`);
  add('settlement_reviewed_by',  `settlement_reviewed_by TEXT`);
  add('settlement_reviewed_at',  `settlement_reviewed_at TEXT`);
  add('settlement_note',         `settlement_note TEXT`);

  // Reject-to-draft lifecycle (turn 2). When HR rejects, the row goes
  // back to status='draft' with the "what needs to change" message in
  // changes_required and the timestamp in returned_at. The employee can
  // edit and resubmit, flipping the row back to 'pending'.
  add('changes_required',        `changes_required TEXT`);
  add('returned_at',             `returned_at TEXT`);
  // Categorization columns for the dashboard (purpose + project link).
  add('purpose_category',        `purpose_category TEXT`);   // 'project_visit' | 'site_visit' | 'sales_visit' | 'metfraa_office' | 'metfraa_factory' | 'purchase_visit'
  add('project_id',              `project_id INTEGER`);      // FK to projects.id, nullable for Sales Visits with no project
  add('client_name',             `client_name TEXT`);        // free-text alternative when no project (sales prospect)
  // Normalise any legacy 'submitted' status to 'pending'
  db.exec(`UPDATE submissions SET status='pending' WHERE status='submitted'`);

  // Employee auth columns (added after first release)
  const ecols = db.prepare(`PRAGMA table_info(employees)`).all().map(c => c.name);
  const eadd = (name, ddl) => { if (!ecols.includes(name)) db.exec(`ALTER TABLE employees ADD COLUMN ${ddl}`); };
  eadd('auth_method',    `auth_method TEXT NOT NULL DEFAULT 'microsoft'`);
  eadd('password_hash',  `password_hash TEXT`);
  eadd('must_change_pw', `must_change_pw INTEGER NOT NULL DEFAULT 0`);

  // Per-row uploads (Daily Travel Reimbursement attaches one bill per
  // entry, not one per submission). row_idx is nullable — older
  // submissions and other forms keep it NULL.
  const acols = db.prepare(`PRAGMA table_info(attachments)`).all().map(c => c.name);
  if (!acols.includes('row_idx')) db.exec(`ALTER TABLE attachments ADD COLUMN row_idx INTEGER`);
  const pcols = db.prepare(`PRAGMA table_info(pending_uploads)`).all().map(c => c.name);
  if (!pcols.includes('row_idx')) db.exec(`ALTER TABLE pending_uploads ADD COLUMN row_idx INTEGER`);

  // Seed starter projects if the table is empty. Once admin starts managing
  // them this block does nothing (we only seed when count is zero, not when
  // a specific code is missing — so the admin can delete defaults safely).
  const row = db.prepare(`SELECT COUNT(*) AS n FROM projects`).get();
  const projectCount = row && typeof row.n === 'number' ? row.n : 0;
  if (projectCount === 0) {
    const seed = db.prepare(`INSERT INTO projects (code, name) VALUES (?, ?)`);
    [
      ['AMNS',     'AMNS'],
      ['KGISL',    'KGISL'],
      ['Patanjali','Patanjali'],
      ['Apollo',   'Apollo Tyres'],
    ].forEach(([c, n]) => seed.run(c, n));
  }
})();

// ====================================================================
//  HELPER STATEMENTS (prepared once, reused)
// ====================================================================

const stmts = {
  // SSO resolves to the most recently-updated active row for an email.
  // (Shared mailboxes map to one portal identity by design.)
  findEmployeeByEmail: db.prepare(`SELECT * FROM employees WHERE email = ? COLLATE NOCASE AND is_active = 1 ORDER BY updated_at DESC, id ASC LIMIT 1`),
  findAllByEmail: db.prepare(`SELECT * FROM employees WHERE email = ? COLLATE NOCASE AND is_active = 1 ORDER BY id`),
  getEmployeeById: db.prepare(`SELECT * FROM employees WHERE id = ?`),
  insertEmployee: db.prepare(`
    INSERT INTO employees (email, name, employee_code, company, level, designation, department, manager_email, auth_method, password_hash, must_change_pw)
    VALUES (@email, @name, @employee_code, @company, @level, @designation, @department, @manager_email, @auth_method, @password_hash, @must_change_pw)
  `),
  updateEmployee: db.prepare(`
    UPDATE employees SET
      email = @email, name = @name, employee_code = @employee_code,
      company = @company, level = @level, designation = @designation,
      department = @department, manager_email = @manager_email,
      auth_method = @auth_method, is_active = @is_active, updated_at = datetime('now')
    WHERE id = @id
  `),
  setPassword: db.prepare(`UPDATE employees SET password_hash = @hash, must_change_pw = @must_change, auth_method='password', updated_at = datetime('now') WHERE id = @id`),
  clearMustChange: db.prepare(`UPDATE employees SET must_change_pw = 0, updated_at = datetime('now') WHERE id = ?`),
  deactivateEmployee: db.prepare(`UPDATE employees SET is_active = 0, updated_at = datetime('now') WHERE id = ?`),
  listEmployees: db.prepare(`SELECT * FROM employees WHERE is_active = 1 ORDER BY company, name`),
  listEmployeesAll: db.prepare(`SELECT * FROM employees ORDER BY is_active DESC, company, name`),
  countEmployeeSubmissions: db.prepare(`SELECT COUNT(*) AS n FROM submissions WHERE employee_id = ?`),

  createSubmission: db.prepare(`
    INSERT INTO submissions (reference, employee_id, company, form_type, period, payload_json, total_amount, pdf_path,
                             purpose_category, project_id, client_name)
    VALUES (@reference, @employee_id, @company, @form_type, @period, @payload_json, @total_amount, @pdf_path,
            @purpose_category, @project_id, @client_name)
  `),
  updateSubmissionPdf: db.prepare(`UPDATE submissions SET pdf_path = ? WHERE id = ?`),
  markEmailSent: db.prepare(`UPDATE submissions SET email_sent_at = datetime('now'), email_error = NULL WHERE id = ?`),
  markEmailFailed: db.prepare(`UPDATE submissions SET email_error = ? WHERE id = ?`),

  // approval workflow
  approveSubmission: db.prepare(`
    UPDATE submissions SET status='approved', reviewed_by=@reviewed_by,
      reviewed_at=datetime('now'), review_note=@review_note WHERE id=@id
  `),
  // HR returning a submission for edit. Status goes to 'draft' (not the
  // legacy 'rejected') so the employee can fix the issues and resubmit.
  // The "what to fix" text goes into changes_required so the edit page
  // can surface it prominently; reviewed_by + reviewed_at record WHO
  // sent it back and WHEN.
  rejectSubmission: db.prepare(`
    UPDATE submissions SET status='draft', reviewed_by=@reviewed_by,
      reviewed_at=datetime('now'), returned_at=datetime('now'),
      review_note=@review_note, changes_required=@changes_required
    WHERE id=@id
  `),
  // Employee resubmitting an edited draft. Clears the "needs to change"
  // marker but keeps reviewed_by/reviewed_at as the audit of the LAST
  // rejection (overwritten if HR sends it back again).
  resubmitFromDraft: db.prepare(`
    UPDATE submissions SET status='pending',
      payload_json=@payload_json, total_amount=@total_amount,
      purpose_category=@purpose_category, project_id=@project_id, client_name=@client_name,
      submitted_at=datetime('now'),
      changes_required=NULL, returned_at=NULL
    WHERE id=@id
  `),
  // Replace ALL attachments of a submission (used on resubmit, where the
  // employee may have added/removed bills). The pending uploads are then
  // re-linked via the normal attachment-insertion path.
  deleteAttachmentsForSubmission: db.prepare(`DELETE FROM attachments WHERE submission_id = ?`),
  // -- Travel Advance settlement lifecycle ---------------------------
  // Used by admin approve when the form is met_advance — keeps the advance
  // OPEN (status='advance_approved') instead of closing it as 'approved'.
  approveAdvanceRequest: db.prepare(`
    UPDATE submissions SET status='advance_approved', reviewed_by=@reviewed_by,
      reviewed_at=datetime('now'), review_note=@review_note WHERE id=@id
  `),
  // Employee files the settlement: attaches actuals + bills, status flips to
  // 'settlement_pending' (awaiting second admin approval).
  fileSettlement: db.prepare(`
    UPDATE submissions SET status='settlement_pending', actuals_json=@actuals_json,
      settled_at=datetime('now') WHERE id=@id
  `),
  // Admin approves the settlement: status -> 'settled' (closed).
  approveSettlement: db.prepare(`
    UPDATE submissions SET status='settled', settlement_reviewed_by=@reviewed_by,
      settlement_reviewed_at=datetime('now'), settlement_note=@settlement_note WHERE id=@id
  `),
  // Admin rejects the settlement: status -> 'settlement_rejected'. Employee
  // may re-file (which will flip back to 'settlement_pending').
  rejectSettlement: db.prepare(`
    UPDATE submissions SET status='settlement_rejected', settlement_reviewed_by=@reviewed_by,
      settlement_reviewed_at=datetime('now'), settlement_note=@settlement_note WHERE id=@id
  `),
  // Employees see all their in-flight advances:
  //   pending             — awaiting first approval (no Settle button shown)
  //   advance_approved    — disbursed, ready to be settled
  //   settlement_rejected — settlement was rejected, employee can re-file
  listOpenAdvancesForEmployee: db.prepare(`
    SELECT id, reference, period, total_amount, status, submitted_at, reviewed_at, payload_json
    FROM submissions
    WHERE employee_id = ? AND form_type = 'met_advance'
      AND status IN ('pending', 'advance_approved', 'settlement_rejected')
    ORDER BY submitted_at DESC
  `),
  // OneDrive sync flags
  markLogSynced:     db.prepare(`UPDATE submissions SET od_log_synced=1, od_error=NULL WHERE id=?`),
  markUploadsSynced: db.prepare(`UPDATE submissions SET od_uploads_synced=1 WHERE id=?`),
  markReportSynced:  db.prepare(`UPDATE submissions SET od_report_synced=1 WHERE id=?`),
  markOdError:       db.prepare(`UPDATE submissions SET od_error=? WHERE id=?`),

  getSubmission: db.prepare(`
    SELECT s.*, e.name AS employee_name, e.email AS employee_email, e.employee_code, e.designation, e.department, e.level
    FROM submissions s
    JOIN employees e ON e.id = s.employee_id
    WHERE s.id = ?
  `),
  listSubmissionsForEmployee: db.prepare(`
    SELECT id, reference, company, form_type, period, total_amount, status,
           submitted_at, reviewed_at, changes_required, returned_at
    FROM submissions
    WHERE employee_id = ?
    ORDER BY submitted_at DESC
    LIMIT 100
  `),
  listAllSubmissions: db.prepare(`
    SELECT s.id, s.reference, s.company, s.form_type, s.period, s.total_amount, s.status,
           s.submitted_at, s.reviewed_at, s.reviewed_by, s.pdf_path,
           s.od_report_synced,
           e.name AS employee_name, e.email AS employee_email, e.level
    FROM submissions s
    JOIN employees e ON e.id = s.employee_id
    ORDER BY s.submitted_at DESC
    LIMIT 500
  `),
  listSubmissionsByStatus: db.prepare(`
    SELECT s.id, s.reference, s.company, s.form_type, s.period, s.total_amount, s.status,
           s.submitted_at, s.reviewed_at, s.reviewed_by, s.pdf_path,
           e.name AS employee_name, e.email AS employee_email, e.level
    FROM submissions s
    JOIN employees e ON e.id = s.employee_id
    WHERE s.status = ?
    ORDER BY s.submitted_at DESC
    LIMIT 500
  `),

  insertAttachment: db.prepare(`
    INSERT INTO attachments (submission_id, filename, stored_path, mime_type, size_bytes, category, label, row_idx)
    VALUES (@submission_id, @filename, @stored_path, @mime_type, @size_bytes, @category, @label, @row_idx)
  `),
  listAttachments: db.prepare(`SELECT * FROM attachments WHERE submission_id = ? ORDER BY id`),

  insertPendingUpload: db.prepare(`
    INSERT INTO pending_uploads (upload_token, employee_id, filename, stored_path, mime_type, size_bytes, row_idx)
    VALUES (@upload_token, @employee_id, @filename, @stored_path, @mime_type, @size_bytes, @row_idx)
  `),
  // Look up one pending upload by ID (used to verify ownership when an
  // entry references its bill via the pending upload's id).
  getPendingUpload: db.prepare(`SELECT * FROM pending_uploads WHERE id = ?`),
  listPendingByToken: db.prepare(`SELECT * FROM pending_uploads WHERE upload_token = ? AND employee_id = ?`),
  deletePending: db.prepare(`DELETE FROM pending_uploads WHERE id = ? AND employee_id = ?`),
  deletePendingByToken: db.prepare(`DELETE FROM pending_uploads WHERE upload_token = ?`),
  cleanupOldPending: db.prepare(`DELETE FROM pending_uploads WHERE created_at < datetime('now', '-7 days')`),

  insertAudit: db.prepare(`
    INSERT INTO audit_log (actor_email, action, target_type, target_id, meta_json, ip_address)
    VALUES (@actor_email, @action, @target_type, @target_id, @meta_json, @ip_address)
  `),

  // ---- Projects (admin-managed list referenced by submissions) ------
  listProjectsActive: db.prepare(`SELECT id, code, name FROM projects WHERE is_active = 1 ORDER BY name COLLATE NOCASE`),
  listProjectsAll:    db.prepare(`SELECT id, code, name, is_active, created_at, updated_at FROM projects ORDER BY is_active DESC, name COLLATE NOCASE`),
  getProject:         db.prepare(`SELECT id, code, name, is_active FROM projects WHERE id = ?`),
  findProjectByName:  db.prepare(`SELECT id FROM projects WHERE name = ? COLLATE NOCASE LIMIT 1`),
  insertProject:      db.prepare(`INSERT INTO projects (code, name, is_active) VALUES (@code, @name, @is_active)`),
  updateProject:      db.prepare(`UPDATE projects SET code=@code, name=@name, is_active=@is_active, updated_at=datetime('now') WHERE id=@id`),
  deactivateProject:  db.prepare(`UPDATE projects SET is_active=0, updated_at=datetime('now') WHERE id=?`),
  // True delete only allowed if no submission references it; the admin
  // route checks this and falls back to deactivation otherwise.
  deleteProject:      db.prepare(`DELETE FROM projects WHERE id = ?`),
  projectUsageCount:  db.prepare(`SELECT COUNT(*) AS n FROM submissions WHERE project_id = ?`),
};

// Wrap as a transactional helper for submission creation
const createSubmissionTx = db.transaction((submission, attachments) => {
  const result = stmts.createSubmission.run(submission);
  const submissionId = result.lastInsertRowid;
  for (const att of attachments) {
    // row_idx defaults to null for callers that haven't set it (older
    // submit paths). better-sqlite3 fails the bind if any named param
    // is missing — this guard keeps the helper backward-compatible.
    stmts.insertAttachment.run({
      submission_id: submissionId,
      row_idx: null,
      ...att,
    });
  }
  return submissionId;
});

module.exports = {
  db,
  stmts,
  createSubmissionTx,
};
