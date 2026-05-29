// ====================================================================
//  ROUTES · /api/submissions
// ====================================================================

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { stmts, createSubmissionTx, db } = require('../db');
const { validate, FORM_META } = require('../services/validators');
const { getForm } = require('../services/policy');
const { generatePdf } = require('../services/pdf');
const { sendSubmissionEmail } = require('../services/email');
const syncSvc = require('../services/sync');
const { requireAuth } = require('../services/auth');

const router = express.Router();

const { REPORTS_DIR } = require('../config/paths');

function generateRef(company, formType) {
  const prefix = company === 'bsc' ? 'BSC' : 'MET';
  const typeMap = {
    bsc_conveyance: 'CV', bsc_expense: 'EX',
    met_local: 'LT', met_cab: 'CB',
    met_accommodation: 'AC', met_outstation: 'OT', met_misc: 'MS', met_advance: 'AD',
  };
  const t = typeMap[formType] || 'XX';
  const d = new Date();
  const stamp = `${d.getFullYear().toString().slice(-2)}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  const rnd = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `${prefix}-${t}-${stamp}-${rnd}`;
}

// POST /api/submissions — receive and process a form
router.post('/', requireAuth, async (req, res) => {
  try {
    const { form_type, upload_token, payload } = req.body || {};
    if (!form_type) return res.status(400).json({ error: 'form_type required' });

    const meta = FORM_META[form_type];
    if (!meta) return res.status(400).json({ error: 'Unknown form type' });

    // 1) Validate the payload
    const v = validate(form_type, payload || {}, req.user);
    if (!v.ok) return res.status(400).json({ error: v.error });

    // 2) Collect attachments from pending uploads
    const pending = upload_token ? stmts.listPendingByToken.all(upload_token, req.user.id) : [];
    console.log(`[submit] user=${req.user.email} form=${form_type} token=${upload_token} bills=${pending.length} files=${pending.map(p => p.filename).join('|')}`);
    const attachments = pending.map(p => ({
      filename: p.filename,
      stored_path: p.stored_path,
      mime_type: p.mime_type,
      size_bytes: p.size_bytes,
      category: 'general',
      label: '',
    }));

    // 3) Persist the submission + attachments (atomic)
    const reference = generateRef(meta.company, form_type);
    const period = (v.payload && v.payload.period) || null;
    const submission = {
      reference,
      employee_id: req.user.id,
      company: meta.company,
      form_type,
      period,
      payload_json: JSON.stringify(v.payload),
      total_amount: v.total,
      pdf_path: null,
    };
    const submissionId = createSubmissionTx(submission, attachments);

    // 4) Clean up pending uploads
    if (upload_token) {
      try { stmts.deletePendingByToken.run(upload_token); } catch (_) {}
    }

    // 5) Load back the linked rows + full submission
    const linkedAttachments = stmts.listAttachments.all(submissionId);
    const fullSubmission = stmts.getSubmission.get(submissionId);

    // 6) Mirror to OneDrive (fail-soft): push raw bills + append Excel log
    //    row as "Pending". NO report PDF is generated yet — that happens
    //    only on admin approval.
    let sync = { synced: false };
    try {
      sync = await syncSvc.onSubmit(fullSubmission, {
        name: req.user.name, email: req.user.email,
        employee_code: req.user.employee_code, level: req.user.level,
        designation: req.user.designation, department: req.user.department,
      }, linkedAttachments);
    } catch (e) {
      console.error('[sync.onSubmit]', e);
    }

    // 7) Audit
    stmts.insertAudit.run({
      actor_email: req.user.email,
      action: 'SUBMIT',
      target_type: 'submission',
      target_id: submissionId,
      meta_json: JSON.stringify({ form_type, total: v.total, ref: reference, od_synced: sync.synced }),
      ip_address: req.ip,
    });

    res.json({
      ok: true,
      submission: {
        id: submissionId,
        reference,
        total: v.total,
        status: 'pending',
        od_synced: sync.synced,
        message: 'Submitted for approval. You will be notified once an admin reviews it.',
        pdf_url: null, // no report until approved
      }
    });
  } catch (err) {
    console.error('[submit]', err);
    res.status(500).json({ error: err.message || 'Submission failed' });
  }
});

// GET /api/submissions — list current user's submissions
router.get('/', requireAuth, (req, res) => {
  const rows = stmts.listSubmissionsForEmployee.all(req.user.id);
  res.json({ submissions: rows });
});

// GET /api/submissions/open-advances — list user's open Travel Advances
//   (status = 'advance_approved' or 'settlement_rejected') so they can settle them.
router.get('/open-advances', requireAuth, (req, res) => {
  const rows = stmts.listOpenAdvancesForEmployee.all(req.user.id).map(r => ({
    ...r,
    payload: (() => { try { return JSON.parse(r.payload_json || '{}'); } catch (_) { return {}; } })(),
    payload_json: undefined,
  }));
  res.json({ advances: rows });
});

// POST /api/submissions/:id/settle — file the settlement for an open advance
//   Body: { upload_token, actuals: { actual_amount, notes? } }
//   - Requires status = 'advance_approved' or 'settlement_rejected' (re-file)
//   - Requires ownership (must be the original employee)
//   - Adds any pending uploads as attachments on the SAME submission
//   - Flips status to 'settlement_pending' (admin must approve)
router.post('/:id/settle', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const sub = stmts.getSubmission.get(id);
    if (!sub) return res.status(404).json({ error: 'Submission not found.' });
    if (sub.employee_id !== req.user.id) return res.status(403).json({ error: 'Not your submission.' });
    if (sub.form_type !== 'met_advance') {
      return res.status(400).json({ error: 'Only Travel Advance submissions can be settled.' });
    }
    if (!['advance_approved', 'settlement_rejected'].includes(sub.status)) {
      return res.status(400).json({ error: `Cannot settle from status '${sub.status}'.` });
    }

    const { upload_token, actuals } = req.body || {};
    const actualAmount = parseFloat(actuals && actuals.actual_amount);
    if (!(actualAmount >= 0)) {
      return res.status(400).json({ error: 'Actual amount spent is required (₹0 or more).' });
    }

    // 1) Claim pending uploads as attachments on this submission.
    const pending = upload_token ? stmts.listPendingByToken.all(upload_token, req.user.id) : [];
    if (pending.length === 0) {
      return res.status(400).json({ error: 'At least one bill is required to settle the advance.' });
    }

    // 2) Persist settlement: add attachments + update submission.
    const tx = db.transaction(() => {
      for (const p of pending) {
        stmts.insertAttachment.run({
          submission_id: id,
          filename: p.filename, stored_path: p.stored_path,
          mime_type: p.mime_type, size_bytes: p.size_bytes,
          category: 'settlement', label: '',
        });
      }
      stmts.fileSettlement.run({
        id,
        actuals_json: JSON.stringify({
          actual_amount: +actualAmount.toFixed(2),
          notes: (actuals.notes || '').trim() || null,
          advance_amount: sub.total_amount,
          difference: +(actualAmount - sub.total_amount).toFixed(2), // +ve = company owes more, -ve = employee returns
        }),
      });
      if (upload_token) stmts.deletePendingByToken.run(upload_token);
    });
    tx();

    console.log(`[settle] user=${req.user.email} sub=${id} ref=${sub.reference} actual=${actualAmount} advance=${sub.total_amount} bills=${pending.length}`);

    res.json({
      ok: true,
      submission: {
        id, reference: sub.reference, status: 'settlement_pending',
        advance_amount: sub.total_amount,
        actual_amount: +actualAmount.toFixed(2),
        difference: +(actualAmount - sub.total_amount).toFixed(2),
        message: 'Settlement filed. Awaiting admin approval.',
      },
    });
  } catch (err) {
    console.error('[settle]', err);
    res.status(500).json({ error: err.message || 'Settlement failed' });
  }
});

// Build a report PDF on-demand (used for draft preview of pending items)
const { buildReportPdf, buildMergedPreview } = require('../services/report-builder');

// GET /api/submissions/:id/pdf — stream the report (report + bills merged)
//   approved → the stored merged PDF
//   otherwise → a freshly-merged preview (report + all uploaded bills)
//   ?download=1 forces a download; default opens inline in the browser
router.get('/:id/pdf', requireAuth, async (req, res) => {
  const sub = stmts.getSubmission.get(parseInt(req.params.id, 10));
  if (!sub) return res.status(404).json({ error: 'Not found' });
  const admins = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase());
  const isAdmin = admins.includes(req.user.email.toLowerCase());
  if (sub.employee_id !== req.user.id && !isAdmin) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  // Lightweight diagnostic — single line, easy to grep in Render logs.
  try {
    const attRows = stmts.listAttachments.all(sub.id);
    console.log(`[pdf] sub=${sub.id} ref=${sub.reference} status=${sub.status} attachments=${attRows.length} files=${attRows.map(a => a.filename).join('|')}`);
  } catch (_) {}
  try {
    let filePath;
    if (sub.pdf_path && fs.existsSync(sub.pdf_path)) {
      filePath = sub.pdf_path;                 // approved: stored merged report
    } else {
      filePath = await buildMergedPreview(sub); // live: report + bills merged
    }
    const label = sub.status === 'approved' ? '' : '_PREVIEW';
    const disposition = req.query.download ? 'attachment' : 'inline';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${disposition}; filename="${sub.reference}${label}.pdf"`);
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    console.error('[pdf]', err);
    return res.status(500).json({ error: 'Could not produce PDF' });
  }
});

// GET /api/submissions/:id/attachment/:attId — serve a raw bill file (owner/admin)
router.get('/:id/attachment/:attId', requireAuth, (req, res) => {
  const sub = stmts.getSubmission.get(parseInt(req.params.id, 10));
  if (!sub) return res.status(404).json({ error: 'Not found' });
  const admins = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase());
  const isAdmin = admins.includes(req.user.email.toLowerCase());
  if (sub.employee_id !== req.user.id && !isAdmin) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const attId = parseInt(req.params.attId, 10);
  const att = stmts.listAttachments.all(sub.id).find(a => a.id === attId);
  if (!att) return res.status(404).json({ error: 'Attachment not found' });
  const abs = path.isAbsolute(att.stored_path)
    ? att.stored_path
    : path.join(__dirname, '..', '..', att.stored_path);
  if (!fs.existsSync(abs)) return res.status(404).json({ error: 'File missing on disk' });
  const disposition = req.query.download ? 'attachment' : 'inline';
  res.setHeader('Content-Type', att.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `${disposition}; filename="${att.filename.replace(/"/g, '')}"`);
  fs.createReadStream(abs).pipe(res);
});

// GET /api/submissions/:id — fetch one submission's details (owner / admin)
router.get('/:id', requireAuth, (req, res) => {
  const sub = stmts.getSubmission.get(parseInt(req.params.id, 10));
  if (!sub) return res.status(404).json({ error: 'Not found' });
  const admins = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase());
  if (sub.employee_id !== req.user.id && !admins.includes(req.user.email.toLowerCase())) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const attachments = stmts.listAttachments.all(sub.id);
  res.json({
    submission: {
      id: sub.id, reference: sub.reference, company: sub.company,
      form_type: sub.form_type, period: sub.period, total_amount: sub.total_amount,
      status: sub.status, submitted_at: sub.submitted_at, email_sent_at: sub.email_sent_at,
      reviewed_by: sub.reviewed_by, reviewed_at: sub.reviewed_at, review_note: sub.review_note,
      // Travel-advance settlement fields (null for non-advance submissions)
      actuals: sub.actuals_json ? JSON.parse(sub.actuals_json) : null,
      settled_at: sub.settled_at,
      settlement_reviewed_by: sub.settlement_reviewed_by,
      settlement_reviewed_at: sub.settlement_reviewed_at,
      settlement_note: sub.settlement_note,
      payload: JSON.parse(sub.payload_json || '{}'),
      employee: {
        name: sub.employee_name, email: sub.employee_email, code: sub.employee_code,
        designation: sub.designation, department: sub.department, level: sub.level,
      },
      attachments: attachments.map(a => ({
        id: a.id, filename: a.filename, mime_type: a.mime_type,
        size_bytes: a.size_bytes, category: a.category,
      })),
    }
  });
});

module.exports = router;
