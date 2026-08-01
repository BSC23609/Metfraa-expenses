// ====================================================================
//  Consolidated Report Approval Workflow (Turn 2)
// ====================================================================
//   Owns the state machine transitions + email side-effects + rollback
//   on rejection.
//
//     draft (post-generation)
//        └─▶ notifyHr()      → email admin@, status='pending_hr'
//     pending_hr
//        ├─▶ approveHr()     → email arasu@, status='pending_mgmt',
//        │                    regenerate PDF with HR sign-off overlay
//        └─▶ rejectAtHr()    → propagate reject-with-note to submissions,
//                              status='rejected'
//     pending_mgmt
//        ├─▶ approveMgmt()   → email accounts@ CC admin@, status='approved',
//        │                    regenerate PDF with both sign-offs overlaid
//        └─▶ rejectAtMgmt()  → same as rejectAtHr but attributed to Mgmt
//
//   All email failures are fail-soft — the state transition sticks and
//   the error is logged in the report row for HR to see.
// ====================================================================

const { stmts, db } = require('../db');
const {
  sendConsolidatedForReview,
  sendConsolidatedToAccounts,
} = require('./email');
const { generateForEmployeePeriod } = require('./consolidate-scheduler');

// Look up the report + hydrate employee info.
function loadReportAndEmployee(reportId) {
  const report = stmts.getConsolidatedReport.get(reportId);
  if (!report) throw new Error(`Consolidated report ${reportId} not found`);
  const employee = {
    id: report.employee_id,
    name: report.employee_name,
    email: report.employee_email,
    code: report.employee_code,
  };
  return { report, employee };
}

// Extract signoffs (name + timestamp) as a plain object suitable for the
// PDF overlay. Only includes filled tiers.
function signoffsFor(report) {
  const out = {};
  if (report.hr_approved_by)   out.hr   = { by: report.hr_approved_by,   at: report.hr_approved_at };
  if (report.mgmt_approved_by) out.mgmt = { by: report.mgmt_approved_by, at: report.mgmt_approved_at };
  return out;
}

// -----------------------------------------------------------------
// notifyHr — called immediately after a consolidated report is
// generated. Fires the HR review email + flips status to pending_hr.
// Idempotent: if the report is already pending_hr, resending the email
// is fine (the SQL guard filters draft/pending_hr).
// -----------------------------------------------------------------
async function notifyHr(reportId) {
  const { report, employee } = loadReportAndEmployee(reportId);
  if (!['draft', 'pending_hr'].includes(report.status)) {
    return { skipped: true, reason: `report is ${report.status}` };
  }
  let emailResult = null;
  let emailErr = null;
  try {
    emailResult = await sendConsolidatedForReview({ report, employee, stage: 'hr' });
  } catch (e) {
    emailErr = e.message || String(e);
    console.error(`[consolidate.notifyHr] email failed for report ${reportId}:`, e);
  }
  // Flip state regardless — HR can still open the report in the portal
  // even if the notification bounced.
  stmts.markConsolidatedPendingHr.run(reportId);
  return { ok: true, email_ok: !emailErr, email_error: emailErr, email_result: emailResult };
}

// -----------------------------------------------------------------
// approveHr — HR clicks "Approve" on the review page. Records who/when,
// regenerates the PDF so the HR sign-off appears on the cover, then
// notifies Management.
// -----------------------------------------------------------------
async function approveHr(reportId, actorEmail) {
  const { report: pre, employee } = loadReportAndEmployee(reportId);
  if (pre.status !== 'pending_hr') throw new Error(`Cannot HR-approve: report is ${pre.status}`);

  // Transactional: state flip is atomic
  stmts.markConsolidatedHrApproved.run(actorEmail, reportId);

  // Refresh + regenerate PDF with HR sign-off overlay
  const { report } = loadReportAndEmployee(reportId);
  try {
    await generateForEmployeePeriod(report.employee_id, report.period, {
      generatedBy: actorEmail,
      employee,
      signoffs: signoffsFor(report),
      keepStatus: true,   // don't reset approval state
    });
  } catch (e) {
    console.error(`[consolidate.approveHr] PDF regen failed for report ${reportId}:`, e);
    // Non-fatal — the state is already flipped; PDF just won't show HR sig
  }

  // Notify Mgmt
  let emailErr = null;
  try {
    await sendConsolidatedForReview({ report, employee, stage: 'mgmt' });
  } catch (e) {
    emailErr = e.message || String(e);
    console.error(`[consolidate.approveHr] mgmt email failed for report ${reportId}:`, e);
  }

  stmts.insertAudit.run({
    actor_email: actorEmail,
    action: 'CONSOLIDATED_HR_APPROVE',
    target_type: 'consolidated_report',
    target_id: reportId,
    meta_json: JSON.stringify({ period: report.period, employee_id: report.employee_id, email_err: emailErr }),
    ip_address: null,
  });

  return { ok: true, next_stage: 'pending_mgmt', email_ok: !emailErr };
}

// -----------------------------------------------------------------
// approveMgmt — Management clicks "Approve" on the review page.
// Regenerates the PDF with BOTH sign-offs, then emails accounts@ with
// the finalized PDF attached (admin@ on CC).
// -----------------------------------------------------------------
async function approveMgmt(reportId, actorEmail) {
  const { report: pre, employee } = loadReportAndEmployee(reportId);
  if (pre.status !== 'pending_mgmt') throw new Error(`Cannot Mgmt-approve: report is ${pre.status}`);

  stmts.markConsolidatedMgmtApproved.run(actorEmail, reportId);

  // Refresh + regenerate with both sign-offs
  const { report } = loadReportAndEmployee(reportId);
  try {
    await generateForEmployeePeriod(report.employee_id, report.period, {
      generatedBy: actorEmail,
      employee,
      signoffs: signoffsFor(report),
      keepStatus: true,
    });
  } catch (e) {
    console.error(`[consolidate.approveMgmt] PDF regen failed:`, e);
  }

  // Re-load to get the up-to-date pdf_path
  const { report: refreshed } = loadReportAndEmployee(reportId);
  const pdfPath = refreshed.pdf_path;

  // Send to accounts@
  let emailErr = null;
  try {
    await sendConsolidatedToAccounts({ report: refreshed, employee, pdfPath });
  } catch (e) {
    emailErr = e.message || String(e);
    console.error(`[consolidate.approveMgmt] accounts email failed:`, e);
    try {
      db.prepare(`UPDATE consolidated_reports SET accounts_email_error = ? WHERE id = ?`)
        .run(emailErr.slice(0, 480), reportId);
    } catch (_) {}
  }

  stmts.insertAudit.run({
    actor_email: actorEmail,
    action: 'CONSOLIDATED_MGMT_APPROVE',
    target_type: 'consolidated_report',
    target_id: reportId,
    meta_json: JSON.stringify({ period: refreshed.period, employee_id: refreshed.employee_id, email_err: emailErr }),
    ip_address: null,
  });

  return { ok: true, final_status: 'approved', email_ok: !emailErr };
}

// -----------------------------------------------------------------
// reject — shared HR + Mgmt rejection path. Level is 'hr' | 'mgmt'.
//
//   1. Flip the report row to status='rejected' + store the note.
//   2. For every submission in the report:
//        - status → 'draft'
//        - deadline_bypass → 1  (lets them resubmit past the cutoff)
//        - changes_required → the rejection note
//   3. Employee's next login shows the "Action required" hub card.
//   4. Audit log records the rejection.
//
// We do NOT send a per-submission email; the employee will notice on
// their next visit. (Turn 3 could add an email if you want it.)
// -----------------------------------------------------------------
function rejectReport(reportId, level, note, actorEmail) {
  if (!['hr', 'mgmt'].includes(level)) throw new Error('invalid level');
  const { report } = loadReportAndEmployee(reportId);
  if (!['pending_hr', 'pending_mgmt'].includes(report.status)) {
    throw new Error(`Cannot reject: report is ${report.status}`);
  }
  const trimmed = String(note || '').trim();
  if (trimmed.length < 3) throw new Error('Rejection note is required (3+ chars).');
  if (trimmed.length > 2000) throw new Error('Rejection note is too long (max 2000 chars).');

  // Guard mismatched level vs state — HR can't reject at mgmt level
  if (level === 'hr'   && report.status !== 'pending_hr')   throw new Error('Report is not pending HR review.');
  if (level === 'mgmt' && report.status !== 'pending_mgmt') throw new Error('Report is not pending management review.');

  // Do the state changes in one atomic transaction
  const tx = db.transaction(() => {
    stmts.markConsolidatedRejected.run({ id: reportId, level, reason: trimmed });
    // Return each included submission to the employee as a draft with
    // deadline_bypass=1 and the rejection note in changes_required.
    let ids = [];
    try { ids = JSON.parse(report.submission_ids || '[]'); } catch (_) {}
    const noteWithAttribution =
      (level === 'hr' ? '[HR rejection] ' : '[Management rejection] ') + trimmed;
    for (const sid of ids) {
      stmts.bypassSubmissionForResubmit.run(noteWithAttribution, sid);
    }
    return ids.length;
  });
  const returnedCount = tx();

  stmts.insertAudit.run({
    actor_email: actorEmail,
    action: level === 'hr' ? 'CONSOLIDATED_HR_REJECT' : 'CONSOLIDATED_MGMT_REJECT',
    target_type: 'consolidated_report',
    target_id: reportId,
    meta_json: JSON.stringify({
      period: report.period,
      employee_id: report.employee_id,
      returned_submissions: returnedCount,
      note: trimmed.slice(0, 500),
    }),
    ip_address: null,
  });

  return { ok: true, returned_submissions: returnedCount };
}

module.exports = {
  notifyHr,
  approveHr,
  approveMgmt,
  rejectReport,
  signoffsFor,
};
