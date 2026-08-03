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
  add('purpose_category',        `purpose_category TEXT`);   // 'project_visit' | 'site_visit' | 'sales_visit' | 'metfraa_office' | 'metfraa_factory' | 'purchase_visit' | 'other'
  add('purpose_other_reason',    `purpose_other_reason TEXT`); // free-text when purpose='other'
  add('deadline_bypass',         `deadline_bypass INTEGER DEFAULT 0`); // 1 = period lock waived for this row (set by consolidated-report rejection, Turn 2)
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

  // Monthly payments — one row per (employee, year, month) when HR marks
  // the payout complete. Absence of a row = unpaid.
  db.exec(`
    CREATE TABLE IF NOT EXISTS monthly_payments (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id    INTEGER NOT NULL,
      year           INTEGER NOT NULL,
      month          INTEGER NOT NULL,           -- 1..12
      amount_paid    REAL NOT NULL,              -- ₹ total at the moment of marking
      paid_by        TEXT NOT NULL,              -- admin email
      paid_at        TEXT NOT NULL DEFAULT (datetime('now')),
      email_sent_at  TEXT,
      email_error    TEXT,
      UNIQUE (employee_id, year, month),
      FOREIGN KEY (employee_id) REFERENCES employees(id)
    );
    CREATE INDEX IF NOT EXISTS idx_monthly_payments_employee ON monthly_payments(employee_id);
    CREATE INDEX IF NOT EXISTS idx_monthly_payments_period   ON monthly_payments(year, month);
  `);

  // Period overrides — HR-granted exceptions to the monthly submission
  // deadline. Every submission's period must satisfy the "2nd of the
  // following month" cutoff UNLESS a matching override exists.
  //
  // An override matches when: (period == submission's period) AND
  // (employee_id == submitter's id OR employee_id IS NULL for global) AND
  // (expires_at > now).
  //
  // Rows are never deleted for audit — revoke sets expires_at into the past.
  db.exec(`
    CREATE TABLE IF NOT EXISTS period_overrides (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id   INTEGER,                          -- NULL = global (applies to everyone)
      period        TEXT NOT NULL,                    -- 'YYYY-MM'
      expires_at    TEXT NOT NULL,                    -- ISO string; row is inactive once now() >= this
      granted_by    TEXT NOT NULL,                    -- admin email
      granted_at    TEXT NOT NULL DEFAULT (datetime('now')),
      revoked_at    TEXT,                             -- set when HR revokes early
      revoked_by    TEXT,
      reason        TEXT,
      FOREIGN KEY (employee_id) REFERENCES employees(id)
    );
    CREATE INDEX IF NOT EXISTS idx_period_overrides_lookup ON period_overrides(period, employee_id, expires_at);
  `);

  // Consolidated monthly reports — one row per (employee, period).
  // Generated automatically at 00:15 IST on the 1st of each month for the
  // month that just ended. Each row aggregates the employee's APPROVED
  // submissions into a single navigable PDF (TOC + bill attachments +
  // internal navigation links). The approval chain (HR → Mgmt) lives in
  // Turn 2 — for now every generated row starts in status 'draft'.
  //
  //   status flow (Turn 2):
  //     draft         → generated, no email yet
  //     pending_hr    → emailed to admin@ for review
  //     pending_mgmt  → HR approved, emailed to arasu@
  //     approved      → both approved, sent to accounts@
  //     rejected      → HR or Mgmt rejected; underlying submissions
  //                     returned to employee as draft with deadline_bypass=1
  db.exec(`
    CREATE TABLE IF NOT EXISTS consolidated_reports (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id        INTEGER NOT NULL,
      period             TEXT NOT NULL,                -- 'YYYY-MM'
      status             TEXT NOT NULL DEFAULT 'draft', -- see above
      total_amount       REAL NOT NULL DEFAULT 0,
      submission_count   INTEGER NOT NULL DEFAULT 0,
      submission_ids     TEXT,                          -- JSON array of ids included in the report
      pdf_path           TEXT,                          -- absolute path on disk
      pdf_page_count     INTEGER,
      generated_at       TEXT NOT NULL DEFAULT (datetime('now')),
      generated_by       TEXT,                          -- 'cron' or admin email if manual
      -- Approval + email bookkeeping
      hr_emailed_at      TEXT,
      hr_approved_by     TEXT,
      hr_approved_at     TEXT,
      hr_rejected_reason TEXT,
      mgmt_emailed_at    TEXT,
      mgmt_approved_by   TEXT,
      mgmt_approved_at   TEXT,
      mgmt_rejected_reason TEXT,
      accounts_sent_at   TEXT,
      accounts_email_error TEXT,
      UNIQUE (employee_id, period),
      FOREIGN KEY (employee_id) REFERENCES employees(id)
    );
    CREATE INDEX IF NOT EXISTS idx_consolidated_period ON consolidated_reports(period);
    CREATE INDEX IF NOT EXISTS idx_consolidated_status ON consolidated_reports(status);
  `);

  // Idempotent add-column migration for consolidated_reports — the
  // Turn 1 CREATE TABLE above evolved during Turn 2 to add
  // hr_emailed_at / mgmt_emailed_at / accounts_email_error. Existing
  // deployments will run this to catch up.
  const consolidatedCols = db.prepare(`PRAGMA table_info(consolidated_reports)`).all().map(c => c.name);
  const addToConsolidated = (name, ddl) => {
    if (!consolidatedCols.includes(name)) {
      try { db.exec(`ALTER TABLE consolidated_reports ADD COLUMN ${ddl}`); }
      catch (_) { /* concurrent boot — safe to ignore */ }
    }
  };
  addToConsolidated('hr_emailed_at',        'hr_emailed_at TEXT');
  addToConsolidated('mgmt_emailed_at',      'mgmt_emailed_at TEXT');
  addToConsolidated('accounts_email_error', 'accounts_email_error TEXT');

  // Backfill 'period' for older submissions that were created BEFORE the
  // validators derived a period from travel/cab/misc dates. Walks every
  // row with NULL period, parses payload_json, picks a sensible date
  // based on form_type, and writes 'YYYY-MM'. Idempotent — only touches
  // NULL rows, so re-running is a no-op.
  try {
    const rows = db.prepare(`
      SELECT id, form_type, payload_json
      FROM submissions
      WHERE period IS NULL OR period = ''
    `).all();
    const updateStmt = db.prepare(`UPDATE submissions SET period = ? WHERE id = ?`);
    const monthOf = (iso) => {
      if (typeof iso !== 'string') return null;
      const m = /^(\d{4})-(\d{2})/.exec(iso.trim());
      return m ? `${m[1]}-${m[2]}` : null;
    };
    let backfilled = 0;
    for (const r of rows) {
      let pl;
      try { pl = JSON.parse(r.payload_json || '{}'); } catch (_) { continue; }
      let p = null;
      switch (r.form_type) {
        case 'met_advance':
          p = monthOf(pl.travel_from);
          break;
        case 'met_cab': {
          const dates = (pl.rides || []).map(x => x.date).filter(Boolean).sort();
          p = dates.length ? monthOf(dates[0]) : null;
          break;
        }
        case 'met_misc': {
          const dates = (pl.items || []).map(x => x.date).filter(Boolean).sort();
          p = dates.length ? monthOf(dates[0]) : null;
          break;
        }
        case 'met_dtr': {
          // DTR sets period on the payload but if it's missing, use earliest entry
          if (pl.period) { p = pl.period; break; }
          const dates = (pl.entries || []).map(x => x.date).filter(Boolean).sort();
          p = dates.length ? monthOf(dates[0]) : null;
          break;
        }
        default:
          // Other forms (local, accommodation, outstation) already set period
          // explicitly. If they're NULL, try the payload's own period field.
          if (pl.period) p = pl.period;
      }
      if (p) { updateStmt.run(p, r.id); backfilled++; }
    }
    if (backfilled) console.log(`[migration] backfilled period on ${backfilled} submission(s)`);
  } catch (e) {
    console.error('[migration] period backfill failed:', e.message);
  }

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
                             purpose_category, purpose_other_reason, project_id, client_name)
    VALUES (@reference, @employee_id, @company, @form_type, @period, @payload_json, @total_amount, @pdf_path,
            @purpose_category, @purpose_other_reason, @project_id, @client_name)
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
  // HR marking a submission as already paid outside the portal (e.g.
  // cash advance handed over, or payment cleared before the employee got
  // around to filing). Uses a distinct status so consolidation queries
  // ignore it — it's not going into any consolidated report; the money
  // moved already.
  settleOfflineSubmission: db.prepare(`
    UPDATE submissions SET status='settled_offline', reviewed_by=@reviewed_by,
      reviewed_at=datetime('now'), review_note=@review_note
    WHERE id=@id
  `),
  // Un-approve an already-approved submission — reverts to 'pending' so
  // HR can then choose Approve / Send back / Settled already again. The
  // review_note keeps the reason for the un-approve; reviewed_by/at get
  // overwritten so the audit trail shows who un-approved.
  unapproveSubmission: db.prepare(`
    UPDATE submissions SET status='pending', reviewed_by=@reviewed_by,
      reviewed_at=datetime('now'), review_note=@review_note
    WHERE id=@id
  `),
  // HR pulling back a sent-back (draft) submission. Same effect as
  // unapprove — status flips to 'pending' so HR can re-decide — but
  // must also CLEAR the changes_required + returned_at markers set by
  // the original send-back, otherwise the pending row keeps showing
  // the "action required" flag and confuses the review UI.
  recallDraftSubmission: db.prepare(`
    UPDATE submissions SET status='pending', reviewed_by=@reviewed_by,
      reviewed_at=datetime('now'), review_note=@review_note,
      changes_required=NULL, returned_at=NULL
    WHERE id=@id
  `),
  // Check if a submission is currently locked by a non-rejected
  // consolidated report — if so, un-approval must be blocked (the money
  // has either already moved to accounts, or Arasu's mid-review).
  //
  // Uses JSON1 to test membership in the submission_ids JSON array on
  // each consolidated_reports row.
  submissionInLiveConsolidatedReport: db.prepare(`
    SELECT cr.id, cr.status, cr.period FROM consolidated_reports cr
    WHERE cr.status IN ('pending_mgmt','approved')
      AND EXISTS (
        SELECT 1 FROM json_each(cr.submission_ids)
        WHERE CAST(json_each.value AS INTEGER) = ?
      )
    LIMIT 1
  `),
  // Employee resubmitting an edited draft. Clears the "needs to change"
  // marker but keeps reviewed_by/reviewed_at as the audit of the LAST
  // rejection (overwritten if HR sends it back again).
  resubmitFromDraft: db.prepare(`
    UPDATE submissions SET status='pending',
      payload_json=@payload_json, total_amount=@total_amount,
      purpose_category=@purpose_category, purpose_other_reason=@purpose_other_reason,
      project_id=@project_id, client_name=@client_name,
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

// ---- Monthly payments statements ----------------------------------
//  Augments the stmts object with payment-tracking queries. Kept here
//  (after the main block) just for readability — they all touch the
//  monthly_payments table which is created by the migration above.
Object.assign(stmts, {
  getMonthlyPayment: db.prepare(`
    SELECT * FROM monthly_payments WHERE employee_id = ? AND year = ? AND month = ?
  `),
  listMonthlyPaymentsForMonth: db.prepare(`
    SELECT mp.*, e.name AS employee_name, e.email AS employee_email
    FROM monthly_payments mp
    JOIN employees e ON e.id = mp.employee_id
    WHERE mp.year = ? AND mp.month = ?
  `),
  // Mark an employee × month as PAID. UPSERT so toggling off + on
  // refreshes paid_by / paid_at to the latest action.
  markMonthlyPaid: db.prepare(`
    INSERT INTO monthly_payments (employee_id, year, month, amount_paid, paid_by)
    VALUES (@employee_id, @year, @month, @amount_paid, @paid_by)
    ON CONFLICT(employee_id, year, month)
    DO UPDATE SET amount_paid = excluded.amount_paid, paid_by = excluded.paid_by,
                  paid_at = datetime('now'), email_error = NULL
  `),
  // Undo: remove the payment row entirely so the month is unpaid again.
  unmarkMonthlyPaid: db.prepare(`
    DELETE FROM monthly_payments WHERE employee_id = ? AND year = ? AND month = ?
  `),
  markPaymentEmailSent:   db.prepare(`UPDATE monthly_payments SET email_sent_at = datetime('now'), email_error = NULL WHERE employee_id = ? AND year = ? AND month = ?`),
  markPaymentEmailFailed: db.prepare(`UPDATE monthly_payments SET email_error = ? WHERE employee_id = ? AND year = ? AND month = ?`),

  // List approved/settled submissions for a given month — used to
  // compute each employee's payable total. Settled travel advances use
  // the actual amount (not the originally-requested advance).
  listApprovedSubmissionsForMonth: db.prepare(`
    SELECT s.id, s.reference, s.employee_id, s.form_type, s.period,
           s.total_amount, s.status, s.actuals_json, s.submitted_at,
           e.name AS employee_name, e.email AS employee_email
    FROM submissions s
    JOIN employees e ON e.id = s.employee_id
    WHERE s.period = ?
      AND s.status IN ('approved', 'settled')
    ORDER BY e.name ASC, s.submitted_at DESC
  `),

  // ---- Period overrides ----------------------------------------
  // Find any ACTIVE override matching (period, employee OR global).
  // Ordered so per-employee overrides win over global ones (rarely
  // matters, but per-employee is more specific).
  findActivePeriodOverride: db.prepare(`
    SELECT * FROM period_overrides
    WHERE period = ?
      AND (employee_id = ? OR employee_id IS NULL)
      AND (revoked_at IS NULL)
      AND expires_at > datetime('now')
    ORDER BY employee_id IS NULL, id DESC
    LIMIT 1
  `),
  insertPeriodOverride: db.prepare(`
    INSERT INTO period_overrides (employee_id, period, expires_at, granted_by, reason)
    VALUES (@employee_id, @period, @expires_at, @granted_by, @reason)
  `),
  revokePeriodOverride: db.prepare(`
    UPDATE period_overrides
    SET revoked_at = datetime('now'), revoked_by = ?
    WHERE id = ? AND revoked_at IS NULL
  `),
  listActivePeriodOverrides: db.prepare(`
    SELECT po.*, e.name AS employee_name, e.email AS employee_email
    FROM period_overrides po
    LEFT JOIN employees e ON e.id = po.employee_id
    WHERE po.revoked_at IS NULL
      AND po.expires_at > datetime('now')
    ORDER BY po.period DESC, po.granted_at DESC
  `),
  // Historical list — includes revoked + expired, for audit
  listAllPeriodOverrides: db.prepare(`
    SELECT po.*, e.name AS employee_name, e.email AS employee_email
    FROM period_overrides po
    LEFT JOIN employees e ON e.id = po.employee_id
    ORDER BY po.granted_at DESC
    LIMIT 200
  `),

  // ---- Consolidated reports ------------------------------------
  //  Fetch approved (and settled — advances count once settled) submissions
  //  for a given period. Ordered oldest-first so TOC reads chronologically.
  listApprovedForConsolidation: db.prepare(`
    SELECT s.id, s.reference, s.form_type, s.period, s.total_amount, s.status,
           s.actuals_json, s.submitted_at, s.reviewed_by, s.reviewed_at,
           s.pdf_path, s.purpose_category, s.purpose_other_reason,
           s.project_id, s.client_name
    FROM submissions s
    WHERE s.employee_id = ?
      AND s.period = ?
      AND s.status IN ('approved', 'settled')
    ORDER BY s.submitted_at ASC
  `),
  // Employees who have at least one approved/settled submission for a period.
  listEmployeesWithApprovedForPeriod: db.prepare(`
    SELECT DISTINCT e.id, e.name, e.email, e.employee_code AS code, e.company, e.level
    FROM submissions s
    JOIN employees e ON e.id = s.employee_id
    WHERE s.period = ?
      AND s.status IN ('approved', 'settled')
    ORDER BY e.name
  `),
  // UPSERT — on conflict, replaces the PDF and stats. Row id stays stable.
  upsertConsolidatedReport: db.prepare(`
    INSERT INTO consolidated_reports (
      employee_id, period, status, total_amount, submission_count,
      submission_ids, pdf_path, pdf_page_count, generated_by
    )
    VALUES (
      @employee_id, @period, 'draft', @total_amount, @submission_count,
      @submission_ids, @pdf_path, @pdf_page_count, @generated_by
    )
    ON CONFLICT(employee_id, period) DO UPDATE SET
      status='draft', total_amount=excluded.total_amount,
      submission_count=excluded.submission_count,
      submission_ids=excluded.submission_ids,
      pdf_path=excluded.pdf_path,
      pdf_page_count=excluded.pdf_page_count,
      generated_at=datetime('now'),
      generated_by=excluded.generated_by,
      hr_approved_by=NULL, hr_approved_at=NULL, hr_rejected_reason=NULL,
      mgmt_approved_by=NULL, mgmt_approved_at=NULL, mgmt_rejected_reason=NULL,
      accounts_sent_at=NULL
  `),
  getConsolidatedReport: db.prepare(`
    SELECT cr.*, e.name AS employee_name, e.email AS employee_email, e.employee_code AS employee_code
    FROM consolidated_reports cr
    JOIN employees e ON e.id = cr.employee_id
    WHERE cr.id = ?
  `),
  getConsolidatedReportByEmpPeriod: db.prepare(`
    SELECT * FROM consolidated_reports WHERE employee_id = ? AND period = ?
  `),
  listConsolidatedReports: db.prepare(`
    SELECT cr.*, e.name AS employee_name, e.email AS employee_email
    FROM consolidated_reports cr
    JOIN employees e ON e.id = cr.employee_id
    ORDER BY cr.period DESC, e.name ASC
  `),
  listConsolidatedReportsForPeriod: db.prepare(`
    SELECT cr.*, e.name AS employee_name, e.email AS employee_email
    FROM consolidated_reports cr
    JOIN employees e ON e.id = cr.employee_id
    WHERE cr.period = ?
    ORDER BY e.name ASC
  `),

  // ---- Consolidated report status transitions (Turn 2) ------------
  // In-place PDF file swap (used after HR/Mgmt approval so the file
  // carries the sign-off overlay without wiping approval state).
  updateConsolidatedReportPdf: db.prepare(`
    UPDATE consolidated_reports
    SET pdf_path = @pdf_path, pdf_page_count = @pdf_page_count
    WHERE employee_id = @employee_id AND period = @period
  `),
  // draft → pending_hr (after HR notification email queued)
  // draft → pending_mgmt — HR clicks "Send for final approval". The
  // report goes STRAIGHT to Management (no separate HR review step at
  // the consolidated level; HR effectively pre-approved by clicking Send).
  //   hr_approved_by/at   = who sent + when
  //   mgmt_emailed_at     = when Arasu's email went out
  //   Guard on status='draft' so we don't accidentally re-fire from a
  //   later state (idempotency at the SQL layer).
  markConsolidatedSentForApproval: db.prepare(`
    UPDATE consolidated_reports
    SET status = 'pending_mgmt',
        hr_approved_by = ?, hr_approved_at = datetime('now'),
        mgmt_emailed_at = COALESCE(mgmt_emailed_at, datetime('now'))
    WHERE id = ? AND status = 'draft'
  `),
  // pending_mgmt → approved
  markConsolidatedMgmtApproved: db.prepare(`
    UPDATE consolidated_reports
    SET status = 'approved',
        mgmt_approved_by = ?, mgmt_approved_at = datetime('now'),
        accounts_sent_at = COALESCE(accounts_sent_at, datetime('now'))
    WHERE id = ? AND status = 'pending_mgmt'
  `),
  // pending_mgmt → rejected
  markConsolidatedRejected: db.prepare(`
    UPDATE consolidated_reports
    SET status = 'rejected',
        mgmt_rejected_reason = @reason
    WHERE id = @id AND status = 'pending_mgmt'
  `),

  // Add columns used by Turn 2's email bookkeeping (safe on top of the
  // Turn 1 schema — they might already be present if the migration was
  // updated in-place; we ALTER-ADD idempotently in the migration block).

  // Return submissions in a rejected consolidated report to draft, with
  // deadline_bypass=1 so the employee can resubmit past the cutoff. The
  // rejection note gets stored in changes_required (existing hub UI
  // already surfaces it).
  bypassSubmissionForResubmit: db.prepare(`
    UPDATE submissions
    SET status = 'draft',
        deadline_bypass = 1,
        changes_required = ?,
        returned_at = datetime('now')
    WHERE id = ?
  `),
  // Look up submissions in a consolidated report by JSON array of ids
  // (deserialised at the callsite; SQLite doesn't like binding a JSON
  // array as a parameter, so callers loop and use this simpler getter).
  getSubmissionById: db.prepare(`SELECT * FROM submissions WHERE id = ?`),

  // ---- Monthly summary (per-employee rollup for a period) ---------
  //  For every employee who has ≥1 submission in the given period,
  //  count how many are in each status. Used to decide whether HR can
  //  click "Send for final approval" — the button is enabled only when
  //  there are no pending/draft rows left.
  //
  //  Note: 'submitted' is our shorthand — sum of pending / approved /
  //  settled / draft / rejected. Only counts submissions that have a
  //  real period value; anything with NULL period is invisible here.
  listMonthlySummaryForPeriod: db.prepare(`
    SELECT
      e.id                                                              AS employee_id,
      e.name                                                            AS employee_name,
      e.email                                                           AS employee_email,
      e.employee_code                                                   AS employee_code,
      COUNT(*)                                                          AS total,
      SUM(CASE WHEN s.status = 'pending'          THEN 1 ELSE 0 END)    AS pending_count,
      SUM(CASE WHEN s.status = 'approved'         THEN 1 ELSE 0 END)    AS approved_count,
      SUM(CASE WHEN s.status = 'settled'          THEN 1 ELSE 0 END)    AS settled_count,
      SUM(CASE WHEN s.status = 'settled_offline'  THEN 1 ELSE 0 END)    AS settled_offline_count,
      SUM(CASE WHEN s.status = 'draft'            THEN 1 ELSE 0 END)    AS draft_count,
      SUM(CASE WHEN s.status = 'rejected'         THEN 1 ELSE 0 END)    AS rejected_count,
      SUM(CASE WHEN s.status = 'advance_approved' THEN 1 ELSE 0 END)    AS advance_approved_count,
      SUM(CASE WHEN s.status IN ('approved','settled')
             THEN COALESCE(
                   CASE WHEN s.status = 'settled'
                        THEN json_extract(s.actuals_json, '$.actual_amount')
                        ELSE NULL END,
                   s.total_amount, 0)
             ELSE 0 END)                                                AS approved_total
    FROM submissions s
    JOIN employees e ON e.id = s.employee_id
    WHERE s.period = ?
    GROUP BY e.id, e.name, e.email, e.employee_code
    ORDER BY e.name ASC
  `),
});

module.exports = {
  db,
  stmts,
  createSubmissionTx,
};
