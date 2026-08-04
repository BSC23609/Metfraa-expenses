// ====================================================================
//  ROUTES · /api/admin   (ADMIN_EMAILS only)
// ====================================================================

const express = require('express');
const { stmts, db } = require('../db');
const { requireAdmin } = require('../services/auth');
const { hashPassword, authMethodForEmail } = require('../services/auth');
const syncSvc = require('../services/sync');
const { buildReportPdf } = require('../services/report-builder');
const { sendApprovalEmail } = require('../services/email');
const { FORM_META } = require('../services/validators');

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
  // Pending Approvals shows five in-flight review states:
  //   pending                — regular claims OR Stage 1 advance (HR verify)
  //   advance_hr_verified    — Stage 2 advance (awaiting Arasu)
  //   advance_mgmt_approved  — Stage 3 advance (awaiting Accounts payment)
  //   settlement_pending     — post-trip bills uploaded, awaiting HR settlement approval
  // Each has different action buttons in the UI. The counts are broken
  // out so the tab badge can show a total and per-stage numbers.
  const pending             = stmts.listSubmissionsByStatus.all('pending');
  const advanceHrVerified   = stmts.listSubmissionsByStatus.all('advance_hr_verified');
  const advanceMgmtApproved = stmts.listSubmissionsByStatus.all('advance_mgmt_approved');
  const settlementPending   = stmts.listSubmissionsByStatus.all('settlement_pending');
  res.json({
    submissions: [...pending, ...advanceHrVerified, ...advanceMgmtApproved, ...settlementPending],
    pending_count: pending.length,
    advance_hr_verified_count: advanceHrVerified.length,
    advance_mgmt_approved_count: advanceMgmtApproved.length,
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
      // TURN 4 CHANGE: HR "approve" on a Travel Advance is now
      // "verify" — Stage 1 of a three-step chain. Status goes to
      // advance_hr_verified (was: advance_approved). Then we email
      // Arasu for Stage 2 approval; Arasu's approval flips it to
      // advance_mgmt_approved and emails Accounts; Accounts records
      // payment via a dedicated endpoint and only THEN does the
      // status flip to advance_approved (unchanged from here).
      stmts.advanceHrVerify.run({
        id, reviewed_by: req.user.email,
        review_note: (req.body && req.body.note) || null,
      });
      // Regenerate the snapshot — signature row now shows HR VERIFIED,
      // MGMT APPROVED / ACCOUNTS PAID slots stay empty until later.
      try {
        const fresh = stmts.getSubmission.get(id);
        const reportPdfPath = await buildReportPdf(fresh, { draft: false });
        const attachments = stmts.listAttachments.all(id);
        await syncSvc.buildAndArchiveSnapshot(fresh, {
          name: sub.employee_name, email: sub.employee_email,
          employee_code: sub.employee_code, level: sub.level,
          designation: sub.designation, department: sub.department,
        }, attachments, reportPdfPath);
      } catch (e) {
        console.error('[advance-hr-verify snapshot]', e);
      }
      // Email Arasu with the individual advance PDF for Stage 2 approval.
      let advanceEmailErr = null;
      try {
        const { sendAdvanceForMgmtApproval } = require('../services/email');
        const fresh = stmts.getSubmission.get(id);
        await sendAdvanceForMgmtApproval({
          submission: fresh,
          employee: {
            name: sub.employee_name, email: sub.employee_email,
            employee_code: sub.employee_code, level: sub.level,
          },
          pdfPath: fresh.pdf_path,
        });
      } catch (e) {
        advanceEmailErr = e.message || String(e);
        console.error('[advance-hr-verify email]', e);
      }
      stmts.insertAudit.run({
        actor_email: req.user.email, action: 'ADVANCE_HR_VERIFY',
        target_type: 'submission', target_id: id,
        meta_json: JSON.stringify({ ref: sub.reference, email_err: advanceEmailErr }),
        ip_address: req.ip,
      });
      return res.json({
        ok: true, advance_stage: 'mgmt_review',
        email_ok: !advanceEmailErr, email_error: advanceEmailErr,
        pdf_url: `/api/submissions/${id}/pdf`,
      });
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

    // Email the employee a copy of the signed approved report (fail-soft)
    try {
      const freshSub = stmts.getSubmission.get(id);
      await sendApprovalEmail({
        submission: freshSub, employee,
        formMeta: FORM_META[freshSub.form_type] || { title: 'Reimbursement' },
        pdfPath: result.mergedPath,
      });
    } catch (e) {
      console.error('[approval-email]', e);
    }

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
    // TURN 4 CHANGE: compute differential = actual - advance and store it
    // on the row. The consolidated report will pick up this signed number
    // instead of the full actual, since the advance was already paid.
    const advanceAmount = Number(sub.total_amount) || 0;
    let actualAmount = 0;
    try {
      const actuals = JSON.parse(sub.actuals_json || '{}');
      actualAmount = Number(actuals.actual_amount) || 0;
    } catch (_) { actualAmount = 0; }
    const differential = +(actualAmount - advanceAmount).toFixed(2);

    stmts.approveSettlement.run({
      id, reviewed_by: req.user.email,
      settlement_note: (req.body && req.body.note) || '',
      differential_amount: differential,
    });
    const fresh = stmts.getSubmission.get(id);
    const reportPdfPath = await buildReportPdf(fresh, { draft: false });
    const attachments = stmts.listAttachments.all(id);
    const employee = {
      name: sub.employee_name, email: sub.employee_email, employee_code: sub.employee_code,
      level: sub.level, designation: sub.designation, department: sub.department,
    };
    const result = await syncSvc.onApprove(fresh, employee, attachments, reportPdfPath);

    // Email the employee the final closed-out report
    try {
      const freshSub = stmts.getSubmission.get(id);
      await sendApprovalEmail({
        submission: freshSub, employee,
        formMeta: FORM_META[freshSub.form_type] || { title: 'Travel Advance' },
        pdfPath: result.mergedPath, isSettlement: true,
      });
    } catch (e) {
      console.error('[settlement-approval-email]', e);
    }

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
  if (sub.status !== 'pending') {
    return res.status(400).json({ error: `Cannot send back from '${sub.status}' status.` });
  }

  // The new contract: HR must provide changes_required (the "what to fix"
  // message). Old clients may still send 'note' — accept that as the
  // changes_required if the new field is missing. The free-form internal
  // review_note is still available too.
  const body = req.body || {};
  const changesRequired = (body.changes_required || body.note || '').trim();
  if (!changesRequired) {
    return res.status(400).json({ error: 'Please describe what needs to change so the employee knows how to fix it.' });
  }
  if (changesRequired.length > 2000) {
    return res.status(400).json({ error: 'Changes-required message is too long (max 2000 chars).' });
  }
  const reviewNote = (body.note || '').trim();

  try {
    stmts.rejectSubmission.run({
      id, reviewed_by: req.user.email,
      review_note: reviewNote,
      changes_required: changesRequired,
    });
    const employee = {
      name: sub.employee_name, email: sub.employee_email, employee_code: sub.employee_code,
      level: sub.level, designation: sub.designation, department: sub.department,
    };
    const result = await syncSvc.onReject(stmts.getSubmission.get(id), employee);

    // Email the employee — "your submission was sent back, here's why"
    try {
      const { sendReturnedEmail } = require('../services/email');
      const freshSub = stmts.getSubmission.get(id);
      await sendReturnedEmail({
        submission: freshSub, employee,
        formMeta: FORM_META[freshSub.form_type] || { title: 'Reimbursement' },
        changesRequired,
      });
    } catch (e) {
      console.error('[returned-email]', e);
    }

    stmts.insertAudit.run({
      actor_email: req.user.email, action: 'RETURN_FOR_EDIT', target_type: 'submission', target_id: id,
      meta_json: JSON.stringify({ ref: sub.reference, changes_required: changesRequired.slice(0, 500), od_synced: result.synced }),
      ip_address: req.ip,
    });

    res.json({ ok: true, returned_for_edit: true, od_synced: result.synced });
  } catch (err) {
    console.error('[reject]', err);
    res.status(500).json({ error: err.message || 'Rejection failed' });
  }
});

// ---- Advance: Arasu approves (Stage 2 of the pre-trip chain) --------
// Called from the row's "Approve advance" button that appears on
// status='advance_hr_verified' rows. Flips to advance_mgmt_approved and
// emails Accounts (accounts@metfraa.com, CC admin@metfraa.com) with the
// signed advance PDF attached.
router.post('/submissions/:id/advance-mgmt-approve', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const sub = stmts.getSubmission.get(id);
  if (!sub) return res.status(404).json({ error: 'Submission not found.' });
  if (sub.form_type !== 'met_advance') {
    return res.status(400).json({ error: 'Only Travel Advance submissions have a management-approval step.' });
  }
  if (sub.status !== 'advance_hr_verified') {
    return res.status(400).json({ error: `Cannot mgmt-approve advance from '${sub.status}' status.` });
  }
  try {
    stmts.advanceMgmtApprove.run({ id, reviewed_by: req.user.email });
    // Regenerate the snapshot with the new signoff on it
    try {
      const fresh = stmts.getSubmission.get(id);
      const reportPdfPath = await buildReportPdf(fresh, { draft: false });
      const attachments = stmts.listAttachments.all(id);
      await syncSvc.buildAndArchiveSnapshot(fresh, {
        name: sub.employee_name, email: sub.employee_email,
        employee_code: sub.employee_code, level: sub.level,
        designation: sub.designation, department: sub.department,
      }, attachments, reportPdfPath);
    } catch (e) {
      console.error('[advance-mgmt-approve snapshot]', e);
    }
    // Email Accounts@ for payment
    let emailErr = null;
    try {
      const { sendAdvanceToAccounts } = require('../services/email');
      const fresh = stmts.getSubmission.get(id);
      await sendAdvanceToAccounts({
        submission: fresh,
        employee: {
          name: sub.employee_name, email: sub.employee_email,
          employee_code: sub.employee_code, level: sub.level,
        },
        pdfPath: fresh.pdf_path,
      });
    } catch (e) {
      emailErr = e.message || String(e);
      console.error('[advance-mgmt-approve email]', e);
    }
    stmts.insertAudit.run({
      actor_email: req.user.email, action: 'ADVANCE_MGMT_APPROVE',
      target_type: 'submission', target_id: id,
      meta_json: JSON.stringify({ ref: sub.reference, email_err: emailErr }),
      ip_address: req.ip,
    });
    res.json({
      ok: true, advance_stage: 'accounts_pay',
      email_ok: !emailErr, email_error: emailErr,
    });
  } catch (err) {
    console.error('[advance-mgmt-approve]', err);
    res.status(500).json({ error: err.message || 'Approval failed' });
  }
});

// ---- Advance: Record payment (Stage 3 of the pre-trip chain) --------
// Called from the row's "Record payment" button on rows in
// status='advance_mgmt_approved'. Accountant confirms the money has left,
// portal flips to advance_approved and the employee gets an email saying
// "advance is disbursed, upload bills within 72h of trip completion".
//
// HR clicks this on behalf of Accounts (there's no separate Accounts
// login yet — if that changes later, this endpoint's requireAdmin can be
// swapped for a role check).
router.post('/submissions/:id/advance-mark-paid', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const sub = stmts.getSubmission.get(id);
  if (!sub) return res.status(404).json({ error: 'Submission not found.' });
  if (sub.form_type !== 'met_advance') {
    return res.status(400).json({ error: 'Only Travel Advance submissions can be marked paid this way.' });
  }
  if (sub.status !== 'advance_mgmt_approved') {
    return res.status(400).json({ error: `Cannot mark paid from '${sub.status}' status.` });
  }
  try {
    stmts.advanceMarkPaid.run({ id, paid_by: req.user.email });
    // Regenerate snapshot with the Accounts signoff
    try {
      const fresh = stmts.getSubmission.get(id);
      const reportPdfPath = await buildReportPdf(fresh, { draft: false });
      const attachments = stmts.listAttachments.all(id);
      await syncSvc.buildAndArchiveSnapshot(fresh, {
        name: sub.employee_name, email: sub.employee_email,
        employee_code: sub.employee_code, level: sub.level,
        designation: sub.designation, department: sub.department,
      }, attachments, reportPdfPath);
    } catch (e) {
      console.error('[advance-mark-paid snapshot]', e);
    }
    // Email the employee: advance disbursed, 72h settlement window starts
    // after trip completion
    let emailErr = null;
    try {
      const { sendAdvancePaidToEmployee } = require('../services/email');
      const fresh = stmts.getSubmission.get(id);
      await sendAdvancePaidToEmployee({
        submission: fresh,
        employee: {
          name: sub.employee_name, email: sub.employee_email,
          employee_code: sub.employee_code, level: sub.level,
        },
      });
    } catch (e) {
      emailErr = e.message || String(e);
      console.error('[advance-mark-paid email]', e);
    }
    stmts.insertAudit.run({
      actor_email: req.user.email, action: 'ADVANCE_MARK_PAID',
      target_type: 'submission', target_id: id,
      meta_json: JSON.stringify({ ref: sub.reference, email_err: emailErr }),
      ip_address: req.ip,
    });
    res.json({
      ok: true, advance_stage: 'paid',
      email_ok: !emailErr, email_error: emailErr,
    });
  } catch (err) {
    console.error('[advance-mark-paid]', err);
    res.status(500).json({ error: err.message || 'Mark-paid failed' });
  }
});

// ---- Settle offline ------------------------------------------------
// HR marks a submission as already-paid outside the portal (e.g. cash
// advance handed over before the trip, or the employee got reimbursed
// separately and is filing after the fact). No PDF report is generated
// and no OneDrive sync happens — this is purely a record-keeping close.
// The submission gets status='settled_offline' so consolidation queries
// skip it.
router.post('/submissions/:id/settle-offline', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const sub = stmts.getSubmission.get(id);
  if (!sub) return res.status(404).json({ error: 'Submission not found.' });
  if (sub.status !== 'pending') {
    return res.status(400).json({ error: `Only pending submissions can be marked settled-already. This one is '${sub.status}'.` });
  }
  const note = ((req.body && req.body.note) || '').trim().slice(0, 500);
  try {
    stmts.settleOfflineSubmission.run({
      id, reviewed_by: req.user.email, review_note: note,
    });
    stmts.insertAudit.run({
      actor_email: req.user.email, action: 'SETTLE_OFFLINE',
      target_type: 'submission', target_id: id,
      meta_json: JSON.stringify({ ref: sub.reference, note }),
      ip_address: req.ip,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[settle-offline]', err);
    res.status(500).json({ error: err.message || 'Failed to mark settled.' });
  }
});

// ---- Un-approve (edit an approved submission) ----------------------
// Revert an approved submission back to 'pending' so HR can re-review.
// Only allowed when the submission isn't referenced by a consolidated
// report in status pending_mgmt or approved — those states mean either
// Arasu is currently reviewing it, or accounts@ has already been sent
// the money. In both cases un-approving is nonsensical/dangerous, so we
// tell HR to reject the consolidated report first (which returns all
// submissions to draft with deadline_bypass=1).
router.post('/submissions/:id/unapprove', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const sub = stmts.getSubmission.get(id);
  if (!sub) return res.status(404).json({ error: 'Submission not found.' });
  if (sub.status !== 'approved') {
    return res.status(400).json({ error: `Only approved submissions can be reopened. This one is '${sub.status}'.` });
  }
  const reason = ((req.body && req.body.reason) || '').trim();
  if (reason.length < 3) return res.status(400).json({ error: 'Please give a reason (3+ chars).' });
  if (reason.length > 1000) return res.status(400).json({ error: 'Reason too long (max 1000 chars).' });

  // Guard: is this submission locked by a live consolidated report?
  const lockedBy = stmts.submissionInLiveConsolidatedReport.get(id);
  if (lockedBy) {
    const label = lockedBy.status === 'approved'
      ? `an approved consolidated report for ${lockedBy.period} (accounts@ has already been notified)`
      : `a consolidated report for ${lockedBy.period} currently awaiting Arasu's approval`;
    return res.status(409).json({
      error: `Cannot reopen — this submission is part of ${label}. To make changes, ask Arasu to reject the consolidated report first (which returns every included submission to the employee as a draft), or wait for the current consolidated flow to complete.`,
    });
  }

  try {
    // Merge the old review_note (from the approval) with the reason for
    // un-approval, so the audit trail on the row itself keeps both.
    const combinedNote = (sub.review_note ? `${sub.review_note}\n---\n[Reopened] ` : '[Reopened] ') + reason;
    stmts.unapproveSubmission.run({
      id, reviewed_by: req.user.email,
      review_note: combinedNote.slice(0, 2000),
    });
    stmts.insertAudit.run({
      actor_email: req.user.email, action: 'UNAPPROVE',
      target_type: 'submission', target_id: id,
      meta_json: JSON.stringify({ ref: sub.reference, reason: reason.slice(0, 500) }),
      ip_address: req.ip,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[unapprove]', err);
    res.status(500).json({ error: err.message || 'Reopen failed' });
  }
});

// ---- Recall a sent-back (draft) submission -------------------------
// Undo an earlier "Send back" so the submission returns to pending and
// HR can re-decide (approve, send back again, or mark settled-already).
// Semantically distinct from unapprove — this pulls a draft OUT of the
// employee's queue rather than reverting an approval. Clears the
// changes_required marker so the "action required" flag disappears from
// the employee's hub.
router.post('/submissions/:id/recall', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const sub = stmts.getSubmission.get(id);
  if (!sub) return res.status(404).json({ error: 'Submission not found.' });
  if (sub.status !== 'draft') {
    return res.status(400).json({ error: `Only sent-back (draft) submissions can be recalled. This one is '${sub.status}'.` });
  }
  const reason = ((req.body && req.body.reason) || '').trim();
  if (reason.length < 3) return res.status(400).json({ error: 'Please give a reason (3+ chars).' });
  if (reason.length > 1000) return res.status(400).json({ error: 'Reason too long (max 1000 chars).' });

  try {
    // Preserve the original review note (which described what to fix)
    // and append the recall reason so the audit trail on the row has
    // both — the earlier send-back context AND why HR pulled it back.
    const combinedNote = (sub.review_note ? `${sub.review_note}\n---\n[Recalled] ` : '[Recalled] ') + reason;
    stmts.recallDraftSubmission.run({
      id, reviewed_by: req.user.email,
      review_note: combinedNote.slice(0, 2000),
    });
    stmts.insertAudit.run({
      actor_email: req.user.email, action: 'RECALL_SENT_BACK',
      target_type: 'submission', target_id: id,
      meta_json: JSON.stringify({ ref: sub.reference, reason: reason.slice(0, 500) }),
      ip_address: req.ip,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[recall]', err);
    res.status(500).json({ error: err.message || 'Recall failed' });
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

// ---- Monthly Payments -----------------------------------------------
//
//   GET  /api/admin/payments?year=YYYY&month=M
//     → { year, month, period, employees: [{ id, name, email,
//         total_payable, submission_count, submissions: [...], paid }] }
//     Lists every employee who has at least one approved/settled
//     submission for the given month, with their total payable and
//     itemised breakdown. Each row carries a `paid` block when the
//     month has been marked paid for that employee.
//
//   POST /api/admin/payments/mark
//     Body: { employee_id, year, month }
//     → marks the (employee, year, month) tuple as Paid using the
//     payable total computed server-side at THIS moment (HR can't
//     spoof the amount). Sends the employee a plain confirmation email
//     fail-soft.
//
//   POST /api/admin/payments/unmark
//     Body: { employee_id, year, month }
//     → removes the paid row (toggle-off).
// ---------------------------------------------------------------------

// Compute the payable amount for a submission row. Approved claims pay
// out at total_amount; settled travel advances pay out at the actuals
// (which may be more or less than the requested advance). Everything
// else returns 0 (caller should skip such rows).
function payableAmountForRow(s) {
  if (s.status === 'settled') {
    try {
      const a = JSON.parse(s.actuals_json || '{}');
      const v = parseFloat(a.actual_amount);
      return v > 0 ? v : 0;
    } catch (_) { return 0; }
  }
  if (s.status === 'approved') return parseFloat(s.total_amount) || 0;
  return 0;
}

// Compose the period stamp 'YYYY-MM' the same way the rest of the app
// uses it. Pads month to 2 digits so this matches the submission's
// stored period exactly.
function makePeriodStamp(year, month) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

router.get('/payments', requireAdmin, (req, res) => {
  try {
    const year = parseInt(req.query.year, 10);
    const month = parseInt(req.query.month, 10);
    if (!Number.isFinite(year) || year < 2000 || year > 2100)
      return res.status(400).json({ error: 'Valid year required (YYYY)' });
    if (!Number.isFinite(month) || month < 1 || month > 12)
      return res.status(400).json({ error: 'Valid month required (1–12)' });

    const period = makePeriodStamp(year, month);
    const rows = stmts.listApprovedSubmissionsForMonth.all(period);

    // Group by employee, computing total + submissions per group
    const buckets = new Map();
    for (const s of rows) {
      const amt = payableAmountForRow(s);
      if (amt <= 0) continue;
      let b = buckets.get(s.employee_id);
      if (!b) {
        b = {
          id: s.employee_id,
          name: s.employee_name,
          email: s.employee_email,
          total_payable: 0,
          submission_count: 0,
          submissions: [],
        };
        buckets.set(s.employee_id, b);
      }
      b.total_payable += amt;
      b.submission_count++;
      b.submissions.push({
        id: s.id,
        reference: s.reference,
        form_type: s.form_type,
        status: s.status,
        payable_amount: +amt.toFixed(2),
        submitted_at: s.submitted_at,
      });
    }

    // Overlay paid status for each employee
    const paidRows = stmts.listMonthlyPaymentsForMonth.all(year, month);
    const paidBy = new Map();
    for (const p of paidRows) paidBy.set(p.employee_id, p);

    const employees = Array.from(buckets.values()).map(b => ({
      id: b.id,
      name: b.name,
      email: b.email,
      total_payable: +b.total_payable.toFixed(2),
      submission_count: b.submission_count,
      submissions: b.submissions,
      paid: paidBy.has(b.id) ? {
        amount_paid: paidBy.get(b.id).amount_paid,
        paid_by: paidBy.get(b.id).paid_by,
        paid_at: paidBy.get(b.id).paid_at,
        email_sent_at: paidBy.get(b.id).email_sent_at,
      } : null,
    })).sort((a, b) => a.name.localeCompare(b.name));

    res.json({ year, month, period, employees });
  } catch (err) {
    console.error('[payments-list]', err);
    res.status(500).json({ error: err.message || 'Could not load payments' });
  }
});

router.post('/payments/mark', requireAdmin, async (req, res) => {
  try {
    const employeeId = parseInt(req.body && req.body.employee_id, 10);
    const year  = parseInt(req.body && req.body.year, 10);
    const month = parseInt(req.body && req.body.month, 10);
    if (!Number.isFinite(employeeId) || employeeId <= 0)
      return res.status(400).json({ error: 'Valid employee_id required' });
    if (!Number.isFinite(year) || year < 2000 || year > 2100)
      return res.status(400).json({ error: 'Valid year required' });
    if (!Number.isFinite(month) || month < 1 || month > 12)
      return res.status(400).json({ error: 'Valid month required (1–12)' });

    // Recompute the total server-side (don't trust a client-supplied amount).
    const period = makePeriodStamp(year, month);
    const rows = stmts.listApprovedSubmissionsForMonth.all(period)
      .filter(r => r.employee_id === employeeId);
    let total = 0;
    for (const r of rows) total += payableAmountForRow(r);
    if (!(total > 0)) return res.status(400).json({ error: 'No approved/settled submissions to pay for this employee × month.' });

    stmts.markMonthlyPaid.run({
      employee_id: employeeId, year, month,
      amount_paid: +total.toFixed(2),
      paid_by: req.user.email,
    });

    // Find the employee for the email
    const emp = stmts.getEmployeeById.get(employeeId);

    // Fire the confirmation email (fail-soft — payment status is recorded
    // regardless of whether the email actually went out).
    let emailErr = null;
    try {
      const { sendPaymentEmail } = require('../services/email');
      await sendPaymentEmail({
        employee: emp,
        year, month,
        amount: +total.toFixed(2),
        submissionCount: rows.length,
      });
      stmts.markPaymentEmailSent.run(employeeId, year, month);
    } catch (e) {
      emailErr = e.message || String(e);
      try { stmts.markPaymentEmailFailed.run(emailErr.slice(0, 480), employeeId, year, month); } catch (_) {}
      console.error('[payments-email]', e);
    }

    stmts.insertAudit.run({
      actor_email: req.user.email, action: 'MARK_PAID', target_type: 'monthly_payment',
      target_id: 0,
      meta_json: JSON.stringify({ employee_id: employeeId, year, month, amount: +total.toFixed(2), email_err: emailErr }),
      ip_address: req.ip,
    });

    res.json({ ok: true, employee_id: employeeId, year, month, amount_paid: +total.toFixed(2), email_sent: !emailErr, email_error: emailErr });
  } catch (err) {
    console.error('[payments-mark]', err);
    res.status(500).json({ error: err.message || 'Mark-paid failed' });
  }
});

router.post('/payments/unmark', requireAdmin, (req, res) => {
  try {
    const employeeId = parseInt(req.body && req.body.employee_id, 10);
    const year  = parseInt(req.body && req.body.year, 10);
    const month = parseInt(req.body && req.body.month, 10);
    if (!Number.isFinite(employeeId) || !Number.isFinite(year) || !Number.isFinite(month))
      return res.status(400).json({ error: 'employee_id, year, month all required' });

    const r = stmts.unmarkMonthlyPaid.run(employeeId, year, month);
    stmts.insertAudit.run({
      actor_email: req.user.email, action: 'UNMARK_PAID', target_type: 'monthly_payment',
      target_id: 0,
      meta_json: JSON.stringify({ employee_id: employeeId, year, month }),
      ip_address: req.ip,
    });
    res.json({ ok: true, removed: r.changes > 0 });
  } catch (err) {
    console.error('[payments-unmark]', err);
    res.status(500).json({ error: err.message || 'Unmark failed' });
  }
});

// ---- Period Overrides ---------------------------------------------
//
//   Manage exceptions to the "submit by the 2nd of the following month"
//   rule. An override is (employee_id | NULL, period, expires_at).
//
//   GET  /api/admin/period-overrides        → active overrides
//   GET  /api/admin/period-overrides/all    → last 200 (audit)
//   POST /api/admin/period-overrides        → grant
//        body: { employee_id | null, period, days_valid, reason? }
//   POST /api/admin/period-overrides/:id/revoke  → mark revoked now
// -------------------------------------------------------------------

router.get('/period-overrides', requireAdmin, (req, res) => {
  try {
    const rows = stmts.listActivePeriodOverrides.all();
    res.json({ overrides: rows });
  } catch (err) {
    console.error('[period-overrides list]', err);
    res.status(500).json({ error: err.message || 'Could not list overrides' });
  }
});

router.get('/period-overrides/all', requireAdmin, (req, res) => {
  try {
    const rows = stmts.listAllPeriodOverrides.all();
    res.json({ overrides: rows });
  } catch (err) {
    console.error('[period-overrides audit]', err);
    res.status(500).json({ error: err.message || 'Could not list overrides' });
  }
});

router.post('/period-overrides', requireAdmin, (req, res) => {
  try {
    const body = req.body || {};
    const period = (body.period || '').trim();
    if (!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: 'period must be YYYY-MM' });

    // employee_id: null → global override. Otherwise must be a real employee.
    let employeeId = null;
    if (body.employee_id != null && body.employee_id !== '') {
      const n = parseInt(body.employee_id, 10);
      if (!Number.isFinite(n) || n <= 0) return res.status(400).json({ error: 'invalid employee_id' });
      const emp = stmts.getEmployeeById.get(n);
      if (!emp) return res.status(400).json({ error: 'employee not found' });
      employeeId = n;
    }

    // Two ways to specify when the override expires:
    //   1. expires_at_ist: 'YYYY-MM-DDTHH:MM' — treated as wall-clock IST,
    //      converted to UTC for storage. This is the precise mode.
    //   2. days_valid: 1..30 — 'N days from now'. Quick mode. Kept for
    //      backward compatibility with the old modal.
    // If both are passed, expires_at_ist wins.
    let expiresAtUtc; // stored as 'YYYY-MM-DD HH:MM:SS' in SQLite datetime format (UTC)
    let mode; let daysValid = null;

    if (body.expires_at_ist && String(body.expires_at_ist).trim()) {
      // Parse as IST wall time. e.g. '2026-08-05T18:00' means Aug 5 6 PM IST.
      // Subtract 5:30 to get UTC.
      const raw = String(body.expires_at_ist).trim();
      const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(raw);
      if (!m) return res.status(400).json({ error: 'expires_at_ist must be YYYY-MM-DDTHH:MM' });
      const [_, y, mo, d, hh, mm, ss] = m;
      // Build the IST wall-time instant, then shift by -5:30 hours to get UTC
      const istMs = Date.UTC(+y, +mo - 1, +d, +hh, +mm, +(ss || 0));
      const utcMs = istMs - (5.5 * 60 * 60 * 1000);
      if (utcMs <= Date.now()) return res.status(400).json({ error: 'expires_at_ist must be in the future' });
      // Cap at 60 days out — anything longer is almost certainly a typo
      if (utcMs > Date.now() + 60 * 24 * 60 * 60 * 1000) {
        return res.status(400).json({ error: 'expires_at_ist cannot be more than 60 days from now' });
      }
      expiresAtUtc = new Date(utcMs).toISOString().slice(0, 19).replace('T', ' ');
      mode = 'expires_at_ist';
    } else {
      // Fall back to days_valid mode
      daysValid = 7;
      if (body.days_valid != null && body.days_valid !== '') {
        const n = parseInt(body.days_valid, 10);
        if (!Number.isFinite(n) || n < 1 || n > 30) return res.status(400).json({ error: 'days_valid must be 1–30' });
        daysValid = n;
      }
      expiresAtUtc = new Date(Date.now() + daysValid * 24 * 60 * 60 * 1000)
        .toISOString().slice(0, 19).replace('T', ' ');
      mode = 'days_valid';
    }

    const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : '';

    const info = stmts.insertPeriodOverride.run({
      employee_id: employeeId,
      period,
      expires_at: expiresAtUtc,
      granted_by: req.user.email,
      reason: reason || null,
    });

    stmts.insertAudit.run({
      actor_email: req.user.email, action: 'GRANT_PERIOD_OVERRIDE',
      target_type: 'period_override', target_id: info.lastInsertRowid,
      meta_json: JSON.stringify({ period, employee_id: employeeId, mode, days_valid: daysValid, expires_at: expiresAtUtc, reason }),
      ip_address: req.ip,
    });

    res.json({ ok: true, id: info.lastInsertRowid, expires_at: expiresAtUtc });
  } catch (err) {
    console.error('[period-overrides grant]', err);
    res.status(500).json({ error: err.message || 'Could not grant override' });
  }
});

router.post('/period-overrides/:id/revoke', requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
    const r = stmts.revokePeriodOverride.run(req.user.email, id);
    if (r.changes === 0) return res.status(404).json({ error: 'Override not found or already revoked.' });

    stmts.insertAudit.run({
      actor_email: req.user.email, action: 'REVOKE_PERIOD_OVERRIDE',
      target_type: 'period_override', target_id: id,
      meta_json: JSON.stringify({}),
      ip_address: req.ip,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('[period-overrides revoke]', err);
    res.status(500).json({ error: err.message || 'Could not revoke' });
  }
});

// ---- Consolidated Reports ------------------------------------------
//
//   GET  /api/admin/consolidated                       — all rows
//   GET  /api/admin/consolidated?period=YYYY-MM        — filtered by month
//   GET  /api/admin/consolidated/:id                   — one row
//   GET  /api/admin/consolidated/:id/pdf               — stream the PDF
//   GET  /api/admin/consolidated/monthly-summary       — per-employee rollup
//                                                        for one month
//   POST /api/admin/consolidated/send-for-approval     — {employee_id, period}
//                                                        HR: send an employee's
//                                                        report to Arasu once
//                                                        every submission is
//                                                        approved.
//   POST /api/admin/consolidated/:id/approve-mgmt      — Arasu approves
//   POST /api/admin/consolidated/:id/reject            — {note} (mgmt only)
//   POST /api/admin/consolidated/:id/resend-email      — idempotent resend
// -------------------------------------------------------------------

router.get('/consolidated', requireAdmin, (req, res) => {
  try {
    const period = (req.query.period || '').trim();
    const rows = period
      ? stmts.listConsolidatedReportsForPeriod.all(period)
      : stmts.listConsolidatedReports.all();
    res.json({ reports: rows });
  } catch (err) {
    console.error('[consolidated list]', err);
    res.status(500).json({ error: err.message || 'Could not list reports' });
  }
});

// Per-employee rollup for a period. Used by the Monthly Wrap-up tab so
// HR can see who's ready to send + who's still blocked by pending items.
// Also merges in any existing consolidated_reports state so the same
// UI shows both "not yet sent" and "already at Arasu" employees.
router.get('/consolidated/monthly-summary', requireAdmin, (req, res) => {
  try {
    const period = (req.query.period || '').trim();
    if (!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: 'period must be YYYY-MM' });
    const rollups = stmts.listMonthlySummaryForPeriod.all(period);
    const reports = stmts.listConsolidatedReportsForPeriod.all(period);
    const byEmp = new Map(reports.map(r => [r.employee_id, r]));
    const rows = rollups.map(r => ({
      ...r,
      consolidated_report: byEmp.get(r.employee_id) || null,
    }));
    res.json({ period, rows });
  } catch (err) {
    console.error('[monthly-summary]', err);
    res.status(500).json({ error: err.message || 'Fetch failed' });
  }
});

router.get('/consolidated/:id', requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const r = stmts.getConsolidatedReport.get(id);
    if (!r) return res.status(404).json({ error: 'Not found' });
    res.json({ report: r });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Fetch failed' });
  }
});

router.get('/consolidated/:id/pdf', requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const r = stmts.getConsolidatedReport.get(id);
    if (!r) return res.status(404).send('Not found');
    if (!r.pdf_path || !require('fs').existsSync(r.pdf_path)) {
      return res.status(404).send('PDF file missing on disk.');
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="consolidated-${r.period}-${(r.employee_name || 'employee').replace(/[^a-zA-Z0-9_-]+/g, '_')}.pdf"`);
    require('fs').createReadStream(r.pdf_path).pipe(res);
  } catch (err) {
    res.status(500).send(err.message || 'PDF stream failed');
  }
});

// HR clicks "Send for final approval" on a row in the Monthly Wrap-up.
router.post('/consolidated/send-for-approval', requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const employeeId = parseInt(body.employee_id, 10);
    const period = (body.period || '').trim();
    if (!Number.isFinite(employeeId) || employeeId <= 0) return res.status(400).json({ error: 'invalid employee_id' });
    if (!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: 'period must be YYYY-MM' });

    const { sendForApproval } = require('../services/consolidated-approval');
    const result = await sendForApproval(employeeId, period, req.user.email);
    res.json(result);
  } catch (err) {
    console.error('[send-for-approval]', err);
    res.status(400).json({ error: err.message || 'Send failed' });
  }
});

router.post('/consolidated/:id/approve-mgmt', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { approveMgmt } = require('../services/consolidated-approval');
    const result = await approveMgmt(id, req.user.email);
    res.json(result);
  } catch (err) {
    console.error('[approve-mgmt]', err);
    res.status(400).json({ error: err.message || 'Approval failed' });
  }
});

router.post('/consolidated/:id/reject', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const body = req.body || {};
    const { rejectReport } = require('../services/consolidated-approval');
    const result = rejectReport(id, body.note, req.user.email);
    res.json(result);
  } catch (err) {
    console.error('[reject-consolidated]', err);
    res.status(400).json({ error: err.message || 'Rejection failed' });
  }
});

// Regenerate the PDF for a pending_mgmt report — useful when the file
// on disk got lost (Render deploy wiping ephemeral state) or when HR
// wants to refresh a stale-looking report before Arasu reviews. Only
// works while the report is in pending_mgmt; approved reports are
// finalised, and rejected reports need to be re-sent from scratch.
router.post('/consolidated/:id/regenerate-pdf', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const r = stmts.getConsolidatedReport.get(id);
    if (!r) return res.status(404).json({ error: 'Not found' });
    if (!['pending_mgmt', 'approved'].includes(r.status)) {
      return res.status(400).json({ error: `Can only regenerate a report that's awaiting Arasu or already approved. This one is '${r.status}'.` });
    }
    const { generateForEmployeePeriod } = require('../services/consolidate-scheduler');
    const { signoffsFor } = require('../services/consolidated-approval');
    const employee = { id: r.employee_id, name: r.employee_name, email: r.employee_email, code: r.employee_code };
    const result = await generateForEmployeePeriod(r.employee_id, r.period, {
      generatedBy: req.user.email,
      employee,
      signoffs: signoffsFor(r),
      keepStatus: true,  // don't wipe approval columns
    });
    stmts.insertAudit.run({
      actor_email: req.user.email, action: 'REGENERATE_CONSOLIDATED_PDF',
      target_type: 'consolidated_report', target_id: id,
      meta_json: JSON.stringify({ period: r.period, employee_id: r.employee_id, ...result }),
      ip_address: req.ip,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[regenerate-pdf]', err);
    res.status(500).json({ error: err.message || 'Regeneration failed' });
  }
});

router.post('/consolidated/:id/resend-email', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const r = stmts.getConsolidatedReport.get(id);
    if (!r) return res.status(404).json({ error: 'Not found' });
    const { sendConsolidatedForReview, sendConsolidatedToAccounts } = require('../services/email');
    const emp = { id: r.employee_id, name: r.employee_name, email: r.employee_email, code: r.employee_code };
    let result;
    if (r.status === 'pending_mgmt')       result = await sendConsolidatedForReview({ report: r, employee: emp, stage: 'mgmt', pdfPath: r.pdf_path });
    else if (r.status === 'approved')      result = await sendConsolidatedToAccounts({ report: r, employee: emp, pdfPath: r.pdf_path });
    else return res.status(400).json({ error: `Nothing to resend for status '${r.status}'` });

    // Distinguish "email actually sent" from "email skipped because SMTP
    // isn't configured". The latter LOOKS like success but no message
    // actually went out — surface it so HR knows to check env vars.
    if (result && result.skipped) {
      return res.status(500).json({
        error: `Email not sent — reason: ${result.reason}. Check the SMTP_HOST / SMTP_USER / SMTP_PASS env vars on Render.`,
      });
    }
    res.json({ ok: true, message_id: result && result.messageId, recipients: result && result.recipients });
  } catch (err) {
    console.error('[resend]', err);
    // Surface the actual error to HR so they can diagnose (e.g. SMTP
    // authentication failed, connection refused, etc).
    res.status(500).json({ error: err.message || 'Resend failed' });
  }
});

// ---- SMTP diagnostics ----------------------------------------------
//
//   GET  /api/admin/smtp-test           — reports env-var health + does
//                                         a connection + AUTH handshake
//                                         via nodemailer.verify().
//   POST /api/admin/smtp-test/send      — {to: string} sends a real test
//                                         message so HR can confirm the
//                                         recipient side isn't filtering.
//
// -------------------------------------------------------------------
router.get('/smtp-test', requireAdmin, async (req, res) => {
  try {
    const { diagnoseSmtp } = require('../services/email');
    const result = await diagnoseSmtp();
    res.json(result);
  } catch (err) {
    console.error('[smtp-test]', err);
    res.status(500).json({ ok: false, error: err.message || 'diagnostics failed' });
  }
});
router.post('/smtp-test/send', requireAdmin, async (req, res) => {
  try {
    const to = ((req.body && req.body.to) || '').trim();
    if (!to || !/^[^@\s]+@[^@\s]+$/.test(to)) {
      return res.status(400).json({ error: 'Provide a valid recipient email in `to`.' });
    }
    const { sendSmtpTestMessage } = require('../services/email');
    const result = await sendSmtpTestMessage(to);
    stmts.insertAudit.run({
      actor_email: req.user.email, action: 'SMTP_TEST_SEND',
      target_type: 'system', target_id: 0,
      meta_json: JSON.stringify({ to, ...result }),
      ip_address: req.ip,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[smtp-test send]', err);
    res.status(500).json({ ok: false, error: err.message || 'send failed', code: err.code || null });
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
