// ====================================================================
//  Consolidated Report Approval Workflow
// ====================================================================
//   Purely on-demand now — HR clicks "Send for final approval" from the
//   Monthly Summary view once every submission for an employee/month is
//   approved/settled.
//
//     (no row yet)
//        └─▶ sendForApproval()  → generate PDF (with HR sign-off on
//                                 cover), UPSERT row, transition to
//                                 pending_mgmt, email arasu@ CC admin@
//     pending_mgmt
//        ├─▶ approveMgmt()  → regen PDF with both sign-offs, mark
//        │                    approved, email accounts@ CC admin@ with
//        │                    the finalized PDF attached
//        └─▶ rejectReport() → mark rejected, return every submission to
//                             the employee (status='draft',
//                             deadline_bypass=1, note in changes_required)
//
//   Email failures are fail-soft — the state transition sticks, and
//   the error is logged. HR can use "Resend email" from the portal.
// ====================================================================

const { stmts, db } = require('../db');
const {
  sendConsolidatedForReview,
  sendConsolidatedToAccounts,
} = require('./email');
const { generateForEmployeePeriod } = require('./consolidate-scheduler');

// Load report + hydrate employee.
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

// Extract sign-offs (name + timestamp) for the PDF cover overlay. Only
// includes tiers that have been filled.
function signoffsFor(report) {
  const out = {};
  if (report.hr_approved_by)   out.hr   = { by: report.hr_approved_by,   at: report.hr_approved_at };
  if (report.mgmt_approved_by) out.mgmt = { by: report.mgmt_approved_by, at: report.mgmt_approved_at };
  return out;
}

// -----------------------------------------------------------------
// sendForApproval — the entry point. HR calls this after they've
// individually verified (approved) every submission for the given
// (employee, period). Precondition check: no pending/draft submissions
// remain for that (employee, period).
//
//   1. Guard: refuse if any submission is still pending/draft/rejected.
//   2. Guard: refuse if a report is already pending_mgmt/approved.
//   3. Generate PDF (via generateForEmployeePeriod). This UPSERTs a
//      consolidated_reports row in status='draft'.
//   4. Overlay HR sign-off (actorEmail + now) and re-emit PDF.
//   5. Flip status draft → pending_mgmt, recording HR identity.
//   6. Email arasu@metfraa.com (CC admin@).
// -----------------------------------------------------------------
async function sendForApproval(employeeId, period, actorEmail) {
  // 1) Precondition: every submission for this (employee, period) is in
  // a terminal-good state (approved or settled). Anything else — pending,
  // draft, rejected, advance_approved — blocks the send.
  const rollup = stmts.listMonthlySummaryForPeriod.all(period).find(r => r.employee_id === employeeId);
  if (!rollup) throw new Error('No submissions found for that employee in that month.');
  const blockers = [];
  if (rollup.pending_count > 0)                blockers.push(`${rollup.pending_count} pending`);
  if (rollup.draft_count > 0)                  blockers.push(`${rollup.draft_count} draft`);
  if (rollup.advance_hr_verified_count > 0)    blockers.push(`${rollup.advance_hr_verified_count} advance awaiting Arasu`);
  if (rollup.advance_mgmt_approved_count > 0)  blockers.push(`${rollup.advance_mgmt_approved_count} advance awaiting Accounts payment`);
  if (rollup.advance_approved_count > 0)       blockers.push(`${rollup.advance_approved_count} advance awaiting settlement`);
  if (rollup.rejected_count > 0)               blockers.push(`${rollup.rejected_count} rejected (must be re-submitted & approved, or excluded)`);
  if (blockers.length) {
    throw new Error(`Cannot send yet — ${blockers.join(', ')}. All submissions must be approved/settled first.`);
  }
  if ((rollup.approved_count + rollup.settled_count) === 0) {
    throw new Error('Nothing to send — this employee has no approved/settled submissions for that month.');
  }

  // 2) If a report already exists, block from re-sending unless it's
  // been rejected (which allows a fresh send).
  const existing = stmts.getConsolidatedReportByEmpPeriod.get(employeeId, period);
  if (existing) {
    if (existing.status === 'pending_mgmt') {
      throw new Error('A report has already been sent for approval. Use "Resend email" if Arasu didn\'t receive it.');
    }
    if (existing.status === 'approved') {
      throw new Error('This report is already approved. Payment has been sent to accounts.');
    }
    // 'rejected' → allowed to re-send. Fall through.
    // 'draft' → weird intermediate state (interrupted send); fall through, we'll re-overwrite.
  }

  // 3) Generate PDF + upsert (status='draft' at this point)
  await generateForEmployeePeriod(employeeId, period, {
    generatedBy: actorEmail,
    // No sign-offs yet — we lay in HR's after the UPSERT so the persisted
    // hr_approved_by column drives the overlay from a single source of truth.
  });

  // 4) Re-fetch, overlay HR signature, re-render. We do this in two
  // passes so the cover PDF and the DB row agree on the timestamp.
  const cr = stmts.getConsolidatedReportByEmpPeriod.get(employeeId, period);
  if (!cr) throw new Error('Report generation produced no row — this is a bug.');

  // 5) State flip + HR identity
  stmts.markConsolidatedSentForApproval.run(actorEmail, cr.id);

  // 6) Re-render PDF with HR sign-off
  const { report: signedReport, employee } = loadReportAndEmployee(cr.id);
  try {
    await generateForEmployeePeriod(signedReport.employee_id, signedReport.period, {
      generatedBy: actorEmail,
      employee,
      signoffs: signoffsFor(signedReport),
      keepStatus: true,
    });
  } catch (e) {
    console.error(`[sendForApproval] PDF signoff overlay failed:`, e);
    // Non-fatal — state is already correct, PDF is just missing the
    // signature visual (row has the data).
  }

  // 7) Email arasu@ (CC admin@) with the signed PDF attached
  let emailErr = null;
  try {
    await sendConsolidatedForReview({
      report: signedReport, employee, stage: 'mgmt',
      pdfPath: signedReport.pdf_path,
    });
  } catch (e) {
    emailErr = e.message || String(e);
    console.error(`[sendForApproval] arasu email failed:`, e);
  }

  stmts.insertAudit.run({
    actor_email: actorEmail,
    action: 'CONSOLIDATED_SEND_FOR_APPROVAL',
    target_type: 'consolidated_report',
    target_id: cr.id,
    meta_json: JSON.stringify({
      employee_id: employeeId, period,
      submission_count: signedReport.submission_count,
      total_amount: signedReport.total_amount,
      email_err: emailErr,
    }),
    ip_address: null,
  });

  return { ok: true, report_id: cr.id, email_ok: !emailErr, email_error: emailErr };
}

// -----------------------------------------------------------------
// approveMgmt — Arasu clicks Approve. Regenerates PDF with both
// sign-offs stamped, marks approved, emails accounts@ (CC admin@)
// with the finalized PDF attached.
// -----------------------------------------------------------------
async function approveMgmt(reportId, actorEmail) {
  const { report: pre, employee } = loadReportAndEmployee(reportId);
  if (pre.status !== 'pending_mgmt') throw new Error(`Cannot Mgmt-approve: report is ${pre.status}`);

  stmts.markConsolidatedMgmtApproved.run(actorEmail, reportId);

  // Refresh to capture the mgmt sign-off timestamps
  const { report } = loadReportAndEmployee(reportId);
  try {
    await generateForEmployeePeriod(report.employee_id, report.period, {
      generatedBy: actorEmail,
      employee,
      signoffs: signoffsFor(report),
      keepStatus: true,
    });
  } catch (e) {
    console.error(`[approveMgmt] PDF regen failed:`, e);
  }

  // Re-load to get the up-to-date pdf_path
  const { report: refreshed } = loadReportAndEmployee(reportId);
  const pdfPath = refreshed.pdf_path;

  // Send to accounts@ (CC admin@)
  let emailErr = null;
  try {
    await sendConsolidatedToAccounts({ report: refreshed, employee, pdfPath });
  } catch (e) {
    emailErr = e.message || String(e);
    console.error(`[approveMgmt] accounts email failed:`, e);
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
    meta_json: JSON.stringify({
      period: refreshed.period,
      employee_id: refreshed.employee_id,
      email_err: emailErr,
    }),
    ip_address: null,
  });

  return { ok: true, final_status: 'approved', email_ok: !emailErr, email_error: emailErr };
}

// -----------------------------------------------------------------
// rejectReport — Arasu clicks Reject with a note. All submissions in the
// report are returned to the employee as drafts with deadline_bypass=1
// and the rejection note in changes_required. Only Management can reject
// at the consolidated level now (HR effectively pre-approved by sending).
// -----------------------------------------------------------------
function rejectReport(reportId, note, actorEmail) {
  const { report } = loadReportAndEmployee(reportId);
  if (report.status !== 'pending_mgmt') {
    throw new Error(`Cannot reject: report is ${report.status}`);
  }
  const trimmed = String(note || '').trim();
  if (trimmed.length < 3) throw new Error('Rejection note is required (3+ chars).');
  if (trimmed.length > 2000) throw new Error('Rejection note is too long (max 2000 chars).');

  const tx = db.transaction(() => {
    stmts.markConsolidatedRejected.run({ id: reportId, reason: trimmed });
    let ids = [];
    try { ids = JSON.parse(report.submission_ids || '[]'); } catch (_) {}
    const noteWithAttribution = '[Management rejection] ' + trimmed;
    // TURN 4 CHANGE: settled advances are NOT returned to draft on
    // rejection — the advance money has already left Accounts, so
    // reverting the row would create an accounting mess. Only the
    // regular reimbursement claims are returned. The rejection note
    // is still stamped onto the advance's settlement_note field for
    // audit trail, but the row stays as 'settled'.
    let returnedRegular = 0;
    let touchedAdvances = 0;
    for (const sid of ids) {
      const sub = stmts.getSubmissionById.get(sid);
      if (!sub) continue;
      if (sub.status === 'settled' && sub.form_type === 'met_advance') {
        // Stamp a note but leave status='settled'. HR follows up in the
        // next cycle if there's a real issue.
        db.prepare(`
          UPDATE submissions
             SET settlement_note = COALESCE(settlement_note, '') || ?
           WHERE id = ?
        `).run(`\n[Consolidated rejected on ${new Date().toISOString().slice(0,10)}: ${trimmed.slice(0,200)}]`, sid);
        touchedAdvances++;
      } else {
        stmts.bypassSubmissionForResubmit.run(noteWithAttribution, sid);
        returnedRegular++;
      }
    }
    return { returnedRegular, touchedAdvances };
  });
  const { returnedRegular, touchedAdvances } = tx();

  stmts.insertAudit.run({
    actor_email: actorEmail,
    action: 'CONSOLIDATED_MGMT_REJECT',
    target_type: 'consolidated_report',
    target_id: reportId,
    meta_json: JSON.stringify({
      period: report.period,
      employee_id: report.employee_id,
      returned_regular: returnedRegular,
      touched_advances: touchedAdvances,
      note: trimmed.slice(0, 500),
    }),
    ip_address: null,
  });

  return { ok: true, returned_submissions: returnedRegular, advances_flagged: touchedAdvances };
}

module.exports = {
  sendForApproval,
  approveMgmt,
  rejectReport,
  signoffsFor,
};
