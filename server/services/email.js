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

// Plain "your reimbursement has been paid" confirmation. Goes to the
// employee with the month's total — that's it. No PDF attachments;
// they can pull individual reports from the portal.
async function sendPaymentEmail({ employee, year, month, amount, submissionCount }) {
  if (!employee || !employee.email) return { skipped: true, reason: 'no-employee-email' };

  const fromName  = process.env.SMTP_FROM_NAME  || 'Bharat Steel Group Portal';
  const fromEmail = process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER;
  if (!fromEmail || !process.env.SMTP_HOST) return { skipped: true, reason: 'smtp-not-configured' };

  const monthName = new Date(year, month - 1, 1).toLocaleString('en-IN', { month: 'long' });
  const portalUrl = process.env.APP_URL || '';

  const subject = `Reimbursement Paid · ${monthName} ${year}`;
  const html = `
<!doctype html>
<html><head><meta charset="utf-8"><title>${subject}</title></head>
<body style="font-family: Arial, sans-serif; color: #1a2332; max-width: 640px; margin: 0 auto; padding: 24px;">
  <div style="border-top: 4px solid #059669; padding-top: 16px;">
    <div style="font-family: monospace; font-size: 11px; letter-spacing: 0.2em; color: #6b7689; text-transform: uppercase;">Bharat Steel Group · Expense Portal</div>
    <h2 style="margin: 8px 0 0; font-size: 22px; color: #0d1421; text-transform: uppercase;">Payment Made</h2>
  </div>

  <p style="font-size: 14px; line-height: 1.6;">Hi ${(employee.name || '').split(' ')[0] || 'there'},</p>
  <p style="font-size: 14px; line-height: 1.6;">
    Your reimbursement for <strong>${monthName} ${year}</strong> has been paid.
  </p>

  <div style="background: #ecfdf5; border-left: 4px solid #059669; padding: 18px 22px; margin: 22px 0; border-radius: 3px;">
    <div style="font-size: 11px; font-family: monospace; letter-spacing: 0.1em; color: #065f46; text-transform: uppercase; margin-bottom: 6px;">Amount paid</div>
    <div style="font-size: 28px; color: #0d1421; font-weight: 700;">₹ ${fmt(amount)}</div>
    <div style="font-size: 12px; color: #6b7689; margin-top: 6px;">Covers ${submissionCount} ${submissionCount === 1 ? 'claim' : 'claims'} for ${monthName} ${year}.</div>
  </div>

  <p style="font-size: 13px; color: #6b7689; margin-top: 24px; line-height: 1.6;">
    If you don't see the credit in your bank account within a couple of working days, please reach out to HR.
  </p>

  ${portalUrl ? `<p style="margin: 24px 0;"><a href="${portalUrl}" style="color: #2563eb; text-decoration: none; font-size: 13px;">Open the portal →</a></p>` : ''}

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

// ============================================================
// Consolidated report emails (Turn 2)
// ============================================================
//   sendConsolidatedForReview  → HR (admin@) or Mgmt (arasu@)
//   sendConsolidatedToAccounts → accounts@ with admin@ on CC + PDF attached
//   sendConsolidatedRejected   → employee (uses existing sendReturnedEmail
//                                pattern; kept as its own function since
//                                the framing is different and it also
//                                CC's HR for visibility)

// Recipients for HR / Management review stages. Env vars let ops rewire
// these without a code change (e.g. staging → dev inbox).
function hrReviewer()    { return process.env.CONSOLIDATED_HR_EMAIL   || 'admin@metfraa.com'; }
function mgmtReviewer()  { return process.env.CONSOLIDATED_MGMT_EMAIL || 'arasu@metfraa.com'; }
function accountsInbox() { return process.env.CONSOLIDATED_ACCOUNTS_EMAIL || 'accounts@metfraa.com'; }

// Review email — sent to HR when a report is generated, sent to Mgmt
// once HR approves. Frames "please review + approve/reject" with a link
// to the portal review page (login required).
async function sendConsolidatedForReview({ report, employee, stage /* 'hr' | 'mgmt' */ }) {
  const fromName  = process.env.SMTP_FROM_NAME  || 'Metfraa Expense Portal';
  const fromEmail = process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER;
  if (!fromEmail || !process.env.SMTP_HOST) return { skipped: true, reason: 'smtp-not-configured' };

  const to = stage === 'hr' ? hrReviewer() : mgmtReviewer();
  const stageLabel = stage === 'hr' ? 'HR VERIFICATION' : 'MANAGEMENT APPROVAL';
  const stageMsg   = stage === 'hr'
    ? 'A new consolidated report is ready for HR verification.'
    : 'HR has verified this consolidated report. It now needs management approval before it can be sent to accounts.';

  const portalUrl = process.env.APP_URL || '';
  const reviewUrl = portalUrl ? `${portalUrl}/app.html?admin=consolidated&open=${report.id}` : '';

  const monthName = new Date(report.period + '-01').toLocaleString('en-IN', {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  });

  const subject = `[Metfraa · Action needed] ${monthName} · ${employee.name} · ${stageLabel}`;
  const html = `
<!doctype html>
<html><head><meta charset="utf-8"><title>${subject}</title></head>
<body style="font-family: Arial, sans-serif; color: #1a2332; max-width: 640px; margin: 0 auto; padding: 24px;">
  <div style="border-top: 4px solid #2563eb; padding-top: 16px;">
    <div style="font-family: monospace; font-size: 11px; letter-spacing: 0.2em; color: #6b7689; text-transform: uppercase;">Metfraa · Expense Portal</div>
    <h2 style="margin: 8px 0 0; font-size: 22px; color: #0d1421; text-transform: uppercase;">${stageLabel}</h2>
  </div>

  <p style="font-size: 14px; line-height: 1.6;">${stageMsg}</p>

  <div style="background: #f6f8fa; border-left: 4px solid #2563eb; padding: 18px 22px; margin: 22px 0; border-radius: 3px;">
    <div style="font-size: 11px; font-family: monospace; letter-spacing: 0.1em; color: #4b5563; text-transform: uppercase; margin-bottom: 6px;">Report</div>
    <div style="font-size: 16px; color: #0d1421; font-weight: 700;">${employee.name}</div>
    <div style="font-size: 12px; color: #6b7689; margin-top: 2px;">${employee.email || ''}</div>
    <table style="width: 100%; margin-top: 14px; font-size: 13px; border-collapse: collapse;">
      <tr><td style="color:#6b7689;padding:3px 0;">Period</td><td style="text-align:right;font-weight:600;">${monthName}</td></tr>
      <tr><td style="color:#6b7689;padding:3px 0;">Claims</td><td style="text-align:right;font-weight:600;">${report.submission_count}</td></tr>
      <tr><td style="color:#6b7689;padding:3px 0;">Total</td><td style="text-align:right;font-weight:700;font-size:15px;">INR ${fmt(report.total_amount)}</td></tr>
    </table>
  </div>

  ${reviewUrl ? `
  <div style="margin: 28px 0; text-align: center;">
    <a href="${reviewUrl}" style="display: inline-block; background: #2563eb; color: #fff; text-decoration: none; padding: 12px 28px; border-radius: 4px; font-weight: 600; font-size: 14px;">
      Open in portal to review
    </a>
    <div style="font-size: 11px; color: #6b7689; margin-top: 10px;">You'll be asked to sign in with Microsoft before you land on the report.</div>
  </div>
  ` : ''}

  <p style="font-size: 12px; color: #6b7689; line-height: 1.6;">
    You can approve to move the report forward, or reject with a note — rejected reports return each submission to the employee as a draft so they can fix and resubmit (the monthly deadline is bypassed for those specific claims).
  </p>

  <hr style="border: none; border-top: 1px dashed #d6dde6; margin: 32px 0 16px;" />
  <p style="font-size: 11px; color: #6b7689; font-family: monospace; letter-spacing: 0.05em;">
    METFRAA · EXPENSE PORTAL · AUTOMATED MESSAGE
  </p>
</body></html>
  `.trim();

  const info = await getTransporter().sendMail({
    from: `"${fromName}" <${fromEmail}>`,
    to,
    subject,
    html,
  });
  return { messageId: info.messageId, recipients: [to] };
}

// Final email to accounts@ with the approved PDF attached + admin@ CCd.
async function sendConsolidatedToAccounts({ report, employee, pdfPath }) {
  const fromName  = process.env.SMTP_FROM_NAME  || 'Metfraa Expense Portal';
  const fromEmail = process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER;
  if (!fromEmail || !process.env.SMTP_HOST) return { skipped: true, reason: 'smtp-not-configured' };

  const to = accountsInbox();
  const cc = hrReviewer();
  const monthName = new Date(report.period + '-01').toLocaleString('en-IN', {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  });

  const subject = `[Metfraa] Reimbursement Approved · ${monthName} · ${employee.name} · INR ${fmt(report.total_amount)}`;
  const html = `
<!doctype html>
<html><head><meta charset="utf-8"><title>${subject}</title></head>
<body style="font-family: Arial, sans-serif; color: #1a2332; max-width: 640px; margin: 0 auto; padding: 24px;">
  <div style="border-top: 4px solid #059669; padding-top: 16px;">
    <div style="font-family: monospace; font-size: 11px; letter-spacing: 0.2em; color: #6b7689; text-transform: uppercase;">Metfraa · Expense Portal</div>
    <h2 style="margin: 8px 0 0; font-size: 22px; color: #0d1421; text-transform: uppercase;">Approved for Payment</h2>
  </div>

  <p style="font-size: 14px; line-height: 1.6;">Please process reimbursement for the following consolidated claim.</p>

  <div style="background: #ecfdf5; border-left: 4px solid #059669; padding: 18px 22px; margin: 22px 0; border-radius: 3px;">
    <div style="font-size: 11px; font-family: monospace; letter-spacing: 0.1em; color: #065f46; text-transform: uppercase; margin-bottom: 6px;">Payment</div>
    <div style="font-size: 16px; color: #0d1421; font-weight: 700;">${employee.name}</div>
    <div style="font-size: 12px; color: #6b7689;">${employee.email || ''}${employee.code ? ' · ' + employee.code : ''}</div>
    <table style="width: 100%; margin-top: 14px; font-size: 13px; border-collapse: collapse;">
      <tr><td style="color:#6b7689;padding:3px 0;">Period</td><td style="text-align:right;font-weight:600;">${monthName}</td></tr>
      <tr><td style="color:#6b7689;padding:3px 0;">Claims</td><td style="text-align:right;font-weight:600;">${report.submission_count}</td></tr>
      <tr><td style="color:#6b7689;padding:3px 0;">Total to pay</td><td style="text-align:right;font-weight:700;font-size:15px;">INR ${fmt(report.total_amount)}</td></tr>
    </table>
  </div>

  <p style="font-size: 13px; color: #6b7689; line-height: 1.6;">
    The full consolidated report (with all bills + approval sign-offs) is attached. Every claim is clickable from the table of contents on page 2.
  </p>

  <hr style="border: none; border-top: 1px dashed #d6dde6; margin: 32px 0 16px;" />
  <p style="font-size: 11px; color: #6b7689; font-family: monospace; letter-spacing: 0.05em;">
    METFRAA · EXPENSE PORTAL · AUTOMATED MESSAGE
  </p>
</body></html>
  `.trim();

  const mailOpts = {
    from: `"${fromName}" <${fromEmail}>`,
    to, cc, subject, html,
  };
  // Attach the signed PDF. This email is meaningless without it — the
  // whole point is to send Accounts what to pay from. If the file is
  // missing on disk (Render's ephemeral filesystem lost it during a
  // deploy, or the path is stale), fail loud with a specific error so
  // HR knows to regenerate the report.
  const fsMod = require('fs');
  if (!pdfPath) {
    throw new Error('accounts@ email skipped: no pdf_path recorded on the consolidated report. Regenerate the report and try again.');
  }
  if (!fsMod.existsSync(pdfPath)) {
    throw new Error(`accounts@ email skipped: PDF file not found on disk at ${pdfPath}. It may have been lost during a deploy — try Regenerate on the row and then approve again.`);
  }
  try {
    const stat = fsMod.statSync(pdfPath);
    if (stat.size === 0) {
      throw new Error(`accounts@ email skipped: PDF file at ${pdfPath} is 0 bytes.`);
    }
  } catch (e) {
    if (e.message.includes('accounts@ email skipped')) throw e;
    throw new Error(`accounts@ email skipped: could not stat PDF file at ${pdfPath}: ${e.message}`);
  }
  const safeName = String(employee.name || 'employee').replace(/[^a-zA-Z0-9_-]+/g, '_');
  mailOpts.attachments = [{
    filename: `${report.period}_${safeName}_consolidated.pdf`,
    path: pdfPath,
    contentType: 'application/pdf',
  }];

  const info = await getTransporter().sendMail(mailOpts);
  return { messageId: info.messageId, recipients: [to, cc] };
}

// SMTP diagnostics — verify the connection is up + return a plain
// object describing what's configured and what nodemailer says. Used
// by the /api/admin/smtp-test endpoint so HR can see why email isn't
// working without digging into Render logs.
async function diagnoseSmtp() {
  const rawPass = process.env.SMTP_PASS || '';
  const rawUser = process.env.SMTP_USER || '';
  const rawHost = process.env.SMTP_HOST || '';
  const config = {
    host:      rawHost || null,
    host_length: rawHost.length,
    host_has_whitespace: rawHost !== rawHost.trim(),
    port:      parseInt(process.env.SMTP_PORT || '587', 10),
    secure:    String(process.env.SMTP_SECURE || 'false') === 'true',
    user:      rawUser || null,
    user_length: rawUser.length,
    user_has_whitespace: rawUser !== rawUser.trim(),
    // These reveal the two most common Render env-var mistakes without
    // exposing the actual password: pasted with trailing spaces, or a
    // control character got included during copy from the Microsoft UI.
    pass_set:  !!rawPass,
    pass_length: rawPass.length,
    pass_has_whitespace: rawPass !== rawPass.trim(),
    pass_first_char_code: rawPass.charCodeAt(0) || null,   // to spot BOM / hidden chars
    pass_last_char_code:  rawPass.charCodeAt(rawPass.length - 1) || null,
    from_name: process.env.SMTP_FROM_NAME || null,
    from_email:process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER || null,
  };

  const missing = [];
  if (!config.host)       missing.push('SMTP_HOST');
  if (!config.user)       missing.push('SMTP_USER');
  if (!config.pass_set)   missing.push('SMTP_PASS');
  if (!config.from_email) missing.push('SMTP_FROM_EMAIL (or SMTP_USER)');
  if (missing.length) {
    return { ok: false, config, error: 'Missing env vars: ' + missing.join(', ') };
  }

  try {
    // nodemailer's .verify() opens a connection and runs the EHLO / AUTH
    // handshake without actually sending a message. This catches the
    // three most common problems: hostname bad, port blocked, credentials
    // rejected.
    await getTransporter().verify();
    return { ok: true, config, message: 'SMTP connection + authentication succeeded' };
  } catch (err) {
    return {
      ok: false, config,
      error: err.message || String(err),
      code: err.code || null,
      response: err.response || null,
    };
  }
}

// Send a plain test message — useful when .verify() passes but real
// mail still isn't arriving (usually a filtering / spam issue on the
// recipient side).
async function sendSmtpTestMessage(to) {
  const fromName  = process.env.SMTP_FROM_NAME  || 'Metfraa Expense Portal';
  const fromEmail = process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER;
  if (!fromEmail || !process.env.SMTP_HOST) {
    throw new Error('SMTP not configured — cannot send test message.');
  }
  const info = await getTransporter().sendMail({
    from: `"${fromName}" <${fromEmail}>`,
    to,
    subject: '[Metfraa Portal] SMTP test — please ignore',
    text: `This is an SMTP test message sent from the Metfraa Expense Portal at ${new Date().toISOString()}. If you received this, SMTP is working correctly.`,
  });
  return { messageId: info.messageId, accepted: info.accepted, rejected: info.rejected, response: info.response };
}

module.exports = {
  sendSubmissionEmail, sendApprovalEmail, sendReturnedEmail, sendPaymentEmail,
  sendConsolidatedForReview, sendConsolidatedToAccounts,
  diagnoseSmtp, sendSmtpTestMessage,
};
