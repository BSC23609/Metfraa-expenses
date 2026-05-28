// ====================================================================
//  REPORT BUILDER · generates the base report PDF for a submission
// ====================================================================
//  Shared by the submissions route (draft preview) and the admin
//  approval route (base for the merged archival PDF). Kept standalone
//  to avoid circular imports between route modules.
// ====================================================================

const path = require('path');
const fs = require('fs');
const { stmts } = require('../db');
const { FORM_META } = require('./validators');
const { generatePdf } = require('./pdf');
const { REPORTS_DIR } = require('../config/paths');

// sub = row from stmts.getSubmission (joined with employee fields)
async function buildReportPdf(sub, { draft = true } = {}) {
  const meta = FORM_META[sub.form_type];
  const attachments = stmts.listAttachments.all(sub.id);
  const outPath = path.join(REPORTS_DIR, `${sub.reference}${draft ? '__draft' : '__report'}.pdf`);
  await generatePdf({
    submission: {
      reference: sub.reference, form_type: sub.form_type, company: sub.company,
      period: sub.period, total_amount: sub.total_amount, submitted_at: sub.submitted_at,
    },
    employee: {
      name: sub.employee_name, email: sub.employee_email, employee_code: sub.employee_code,
      designation: sub.designation, department: sub.department, level: sub.level,
    },
    payload: JSON.parse(sub.payload_json || '{}'),
    attachments,
    formMeta: { title: meta.title, subtitle: meta.subtitle },
    outPath,
  });
  return outPath;
}

module.exports = { buildReportPdf, REPORTS_DIR };
