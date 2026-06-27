// ====================================================================
//  EMAIL SERVICE · sends submission to HR with PDF + raw bill files
// ====================================================================

const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const { getRecipients, getCompany } = require('./policy');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: String(process.env.SMTP_SECURE || 'false') === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  return transporter;
}

function fmt(n) {
  return Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function buildHtml({ submission, employee, formMeta, company }) {
  return `
<!doctype html>
<html><head><meta charset="utf-8"><title>${formMeta.title}</title></head>
<body style="font-family: Arial, sans-serif; color: #1a2332; max-width: 640px; margin: 0 auto; padding: 24px;">
  <div style="border-top: 4px solid #0d1421; padding-top: 16px;">
    <div style="font-family: monospace; font-size: 11px; letter-spacing: 0.2em; color: #6b7689; text-transform: uppercase;">${company.name}</div>
    <h2 style="margin: 8px 0 0; font-size: 22px; color: #0d1421; text-transform: uppercase;">${formMeta.title}</h2>
  </div>

  <p style="font-size: 14px; line-height: 1.6;">Dear HR Team,</p>
  <p style="font-size: 14px; line-height: 1.6;">A new ${formMeta.title.toLowerCase()} submission has been filed via the portal. The signed PDF report and all supporting bills are attached.</p>

  <table style="width: 100%; border-collapse: collapse; margin: 18px 0; font-size: 13px;">
    <tr><td style="padding: 6px 0; color: #6b7689; width: 140px;">Reference</td><td style="padding: 6px 0; font-weight: 600;">${submission.reference}</td></tr>
    <tr><td style="padding: 6px 0; color: #6b7689;">Employee</td><td style="padding: 6px 0;">${employee.name} &lt;${employee.email}&gt;</td></tr>
    <tr><td style="padding: 6px 0; color: #6b7689;">Employee ID</td><td style="padding: 6px 0;">${employee.employee_code || '—'}</td></tr>
    <tr><td style="padding: 6px 0; color: #6b7689;">Designation</td><td style="padding: 6px 0;">${employee.designation || '—'}</td></tr>
    <tr><td style="padding: 6px 0; color: #6b7689;">Level</td><td style="padding: 6px 0;">${employee.level || '—'}</td></tr>
    <tr><td style="padding: 6px 0; color: #6b7689;">Period</td><td style="padding: 6px 0;">${submission.period || '—'}</td></tr>
    <tr><td style="padding: 6px 0; color: #6b7689;">Submitted</td><td style="padding: 6px 0;">${new Date(submission.submitted_at || Date.now()).toLocaleString('en-IN')}</td></tr>
  </table>

  <div style="background: #1F7CCB; color: white; padding: 16px 20px; border-radius: 4px; display: flex; justify-content: space-between; align-items: center;">
    <span style="font-size: 12px; letter-spacing: 0.15em; text-transform: uppercase;">Total Claim</span>
    <strong style="font-size: 22px; float: right;">₹ ${fmt(submission.total_amount)}</strong>
  </div>

  <p style="font-size: 13px; color: #6b7689; margin-top: 24px; line-height: 1.6;">
    Please review the attached report. The original bill files are also included as separate attachments for verification.
  </p>

  <hr style="border: none; border-top: 1px dashed #d6dde6; margin: 32px 0 16px;" />
  <p style="font-size: 11px; color: #6b7689; font-family: monospace; letter-spacing: 0.05em;">
    THE BHARAT STEEL GROUP · EXPENSE PORTAL · AUTOMATED MESSAGE
  </p>
</body></html>
  `.trim();
}

async function sendSubmissionEmail({ submission, employee, formMeta, attachments = [], pdfPath }) {
  const company = getCompany(submission.company);
  const to = getRecipients(submission.company);
  if (!to.length) throw new Error('No recipients configured for company ' + submission.company);

  const fromName  = process.env.SMTP_FROM_NAME  || 'Bharat Steel Group Portal';
  const fromEmail = process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER;

  const mailAttachments = [];
  // Always attach the generated PDF first
  if (pdfPath && fs.existsSync(pdfPath)) {
    mailAttachments.push({
      filename: `${submission.reference}.pdf`,
      path: pdfPath,
      contentType: 'application/pdf',
    });
  }
  // Plus the raw bills, so HR has the originals
  for (const att of attachments) {
    const absPath = path.isAbsolute(att.stored_path)
      ? att.stored_path
      : path.join(__dirname, '..', '..', att.stored_path);
    if (fs.existsSync(absPath)) {
      mailAttachments.push({
        filename: att.filename,
        path: absPath,
        contentType: att.mime_type,
      });
    }
  }

  const subject = `[${company.short}] ${formMeta.title} · ${employee.name} · ${submission.period || ''} · ${submission.reference}`;

  const info = await getTransporter().sendMail({
    from: `"${fromName}" <${fromEmail}>`,
    to: to.join(', '),
    replyTo: employee.email,
    subject,
    html: buildHtml({ submission, employee, formMeta, company }),
    attachments: mailAttachments,
  });

  return { messageId: info.messageId, recipients: to };
}

// Sends the approved report to the EMPLOYEE so they have a copy of the
// final signed-off PDF (with "Checked & approved by ..." on it). Sent
// after admin clicks Approve; for travel-advance settlement it's sent
// when the settlement is approved (the final closure).
async function sendApprovalEmail({ submission, employee, formMeta, pdfPath, isSettlement = false }) {
  if (!employee.email) return { skipped: true, reason: 'no-employee-email' };

  const fromName  = process.env.SMTP_FROM_NAME  || 'Bharat Steel Group Portal';
  const fromEmail = process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER;
  if (!fromEmail || !process.env.SMTP_HOST) return { skipped: true, reason: 'smtp-not-configured' };

  const mailAttachments = [];
  if (pdfPath && fs.existsSync(pdfPath)) {
    mailAttachments.push({
      filename: `${submission.reference}.pdf`,
      path: pdfPath,
      contentType: 'application/pdf',
    });
  }

  const company = getCompany(submission.company);
  const subject = isSettlement
    ? `[${company.short}] Settlement Approved · ${submission.reference}`
    : `[${company.short}] ${formMeta.title} Approved · ${submission.reference}`;

  const reviewer  = isSettlement ? (submission.settlement_reviewed_by || 'HR') : (submission.reviewed_by || 'HR');
  const reviewedAt = isSettlement ? submission.settlement_reviewed_at : submission.reviewed_at;
  const formattedAt = reviewedAt
    ? new Date(reviewedAt.length === 19 && reviewedAt[10] === ' ' ? reviewedAt.replace(' ', 'T') + 'Z' : reviewedAt).toLocaleString('en-IN')
    : 'now';

  const note = isSettlement ? (submission.settlement_note || '') : (submission.review_note || '');

  const html = `
<!doctype html>
<html><head><meta charset="utf-8"><title>${formMeta.title} approved</title></head>
<body style="font-family: Arial, sans-serif; color: #1a2332; max-width: 640px; margin: 0 auto; padding: 24px;">
  <div style="border-top: 4px solid #0d1421; padding-top: 16px;">
    <div style="font-family: monospace; font-size: 11px; letter-spacing: 0.2em; color: #6b7689; text-transform: uppercase;">${company.name}</div>
    <h2 style="margin: 8px 0 0; font-size: 22px; color: #0d1421; text-transform: uppercase;">${isSettlement ? 'Settlement Approved' : 'Approved'}</h2>
  </div>

  <p style="font-size: 14px; line-height: 1.6;">Hi ${(employee.name || '').split(' ')[0] || 'there'},</p>
  <p style="font-size: 14px; line-height: 1.6;">
    Your ${formMeta.title.toLowerCase()} <strong>${submission.reference}</strong> has been
    ${isSettlement ? 'settled and closed' : 'approved'} by <strong>${reviewer}</strong> on
    <strong>${formattedAt}</strong>. The final signed PDF is attached for your records.
  </p>

  <table style="width: 100%; border-collapse: collapse; margin: 18px 0; font-size: 13px;">
    <tr><td style="padding: 6px 0; color: #6b7689; width: 140px;">Reference</td><td style="padding: 6px 0; font-weight: 600;">${submission.reference}</td></tr>
    <tr><td style="padding: 6px 0; color: #6b7689;">Form</td><td style="padding: 6px 0;">${formMeta.title}</td></tr>
    <tr><td style="padding: 6px 0; color: #6b7689;">Amount</td><td style="padding: 6px 0;">₹ ${fmt(submission.total_amount)}</td></tr>
    <tr><td style="padding: 6px 0; color: #6b7689;">Period</td><td style="padding: 6px 0;">${submission.period || '—'}</td></tr>
    <tr><td style="padding: 6px 0; color: #6b7689;">Approver</td><td style="padding: 6px 0;">${reviewer}</td></tr>
    <tr><td style="padding: 6px 0; color: #6b7689;">Decided</td><td style="padding: 6px 0;">${formattedAt}</td></tr>
    ${note ? `<tr><td style="padding: 6px 0; color: #6b7689;">Note</td><td style="padding: 6px 0; font-style: italic;">${note}</td></tr>` : ''}
  </table>

  <p style="font-size: 13px; color: #6b7689; margin-top: 24px; line-height: 1.6;">
    The full report (with all bills merged) is attached. You can also view and download it any time from the portal.
  </p>

  <hr style="border: none; border-top: 1px dashed #d6dde6; margin: 32px 0 16px;" />
  <p style="font-size: 11px; color: #6b7689; font-family: monospace; letter-spacing: 0.05em;">
    THE BHARAT STEEL GROUP · EXPENSE PORTAL · AUTOMATED MESSAGE
  </p>
</body></html>
  `.trim();

  const info = await getTransporter().sendMail({
    from: `"${fromName}" <${fromEmail}>`,
    to: employee.email,
    subject,
    html,
    attachments: mailAttachments,
  });
  return { messageId: info.messageId, recipients: [employee.email] };
}

// Sent when HR returns a submission for edit. The employee gets a clear
// explanation of what needs to change + a portal link. No PDF attached
// (the draft snapshot lives in the portal, and the report will change
// when they resubmit anyway).
async function sendReturnedEmail({ submission, employee, formMeta, changesRequired }) {
  if (!employee.email) return { skipped: true, reason: 'no-employee-email' };

  const fromName  = process.env.SMTP_FROM_NAME  || 'Bharat Steel Group Portal';
  const fromEmail = process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER;
  if (!fromEmail || !process.env.SMTP_HOST) return { skipped: true, reason: 'smtp-not-configured' };

  const company = getCompany(submission.company);
  const subject = `[${company.short}] Action needed · ${submission.reference}`;
  const portalUrl = process.env.APP_URL || '';
  const reviewer = submission.reviewed_by || 'HR';

  const html = `
<!doctype html>
<html><head><meta charset="utf-8"><title>Action needed</title></head>
<body style="font-family: Arial, sans-serif; color: #1a2332; max-width: 640px; margin: 0 auto; padding: 24px;">
  <div style="border-top: 4px solid #d97706; padding-top: 16px;">
    <div style="font-family: monospace; font-size: 11px; letter-spacing: 0.2em; color: #6b7689; text-transform: uppercase;">${company.name}</div>
    <h2 style="margin: 8px 0 0; font-size: 22px; color: #0d1421; text-transform: uppercase;">Action Needed</h2>
  </div>

  <p style="font-size: 14px; line-height: 1.6;">Hi ${(employee.name || '').split(' ')[0] || 'there'},</p>
  <p style="font-size: 14px; line-height: 1.6;">
    Your ${formMeta.title.toLowerCase()} <strong>${submission.reference}</strong> needs some changes before it can be approved.
    <strong>${reviewer}</strong> sent it back with the following note:
  </p>

  <div style="background: #fef3c7; border-left: 4px solid #d97706; padding: 14px 18px; margin: 18px 0; border-radius: 3px;">
    <div style="font-size: 11px; font-family: monospace; letter-spacing: 0.1em; color: #92400e; text-transform: uppercase; margin-bottom: 6px;">What needs to change</div>
    <div style="font-size: 14px; color: #1a2332; line-height: 1.6; white-space: pre-wrap;">${escapeHtml(changesRequired)}</div>
  </div>

  <p style="font-size: 14px; line-height: 1.6;">
    Open the portal, edit your submission, and resubmit it. You don't need to re-upload bills that were already attached — they're still there.
  </p>

  ${portalUrl ? `<p style="margin: 24px 0;"><a href="${portalUrl}" style="background: #1F7CCB; color: white; padding: 12px 22px; text-decoration: none; border-radius: 4px; font-weight: 600; font-size: 14px;">Open the portal →</a></p>` : ''}

  <table style="width: 100%; border-collapse: collapse; margin: 18px 0; font-size: 13px;">
    <tr><td style="padding: 6px 0; color: #6b7689; width: 140px;">Reference</td><td style="padding: 6px 0; font-weight: 600;">${submission.reference}</td></tr>
    <tr><td style="padding: 6px 0; color: #6b7689;">Form</td><td style="padding: 6px 0;">${formMeta.title}</td></tr>
    <tr><td style="padding: 6px 0; color: #6b7689;">Amount</td><td style="padding: 6px 0;">₹ ${fmt(submission.total_amount)}</td></tr>
    <tr><td style="padding: 6px 0; color: #6b7689;">Sent back by</td><td style="padding: 6px 0;">${reviewer}</td></tr>
  </table>

  <hr style="border: none; border-top: 1px dashed #d6dde6; margin: 32px 0 16px;" />
  <p style="font-size: 11px; color: #6b7689; font-family: monospace; letter-spacing: 0.05em;">
    THE BHARAT STEEL GROUP · EXPENSE PORTAL · AUTOMATED MESSAGE
  </p>
</body></html>
  `.trim();

  const info = await getTransporter().sendMail({
    from: `"${fromName}" <${fromEmail}>`,
    to: employee.email,
    subject,
    html,
  });
  return { messageId: info.messageId, recipients: [employee.email] };
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = { sendSubmissionEmail, sendApprovalEmail, sendReturnedEmail };
