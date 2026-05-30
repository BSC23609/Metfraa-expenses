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
const { mergeReportWithBills } = require('./pdf-merge');
const { REPORTS_DIR } = require('../config/paths');

// sub = row from stmts.getSubmission (joined with employee fields)
async function buildReportPdf(sub, { draft = true } = {}) {
  const meta = FORM_META[sub.form_type];
  const attachments = stmts.listAttachments.all(sub.id);
  const outPath = path.join(REPORTS_DIR, `${sub.reference}${draft ? '__draft' : '__report'}.pdf`);
  // Resolve linked project (if any) so the PDF can show it
  const project = sub.project_id ? stmts.getProject.get(sub.project_id) : null;
  await generatePdf({
    submission: {
      reference: sub.reference, form_type: sub.form_type, company: sub.company,
      period: sub.period, total_amount: sub.total_amount, submitted_at: sub.submitted_at,
      purpose_category: sub.purpose_category || null,
      project: project ? { id: project.id, code: project.code, name: project.name } : null,
      client_name: sub.client_name || null,
    },
    employee: {
      name: sub.employee_name, email: sub.employee_email, employee_code: sub.employee_code,
      designation: sub.designation, department: sub.department, level: sub.level,
    },
    payload: JSON.parse(sub.payload_json || '{}'),
    attachments,
    formMeta: { title: meta.title, subtitle: meta.subtitle },
    outPath,
    suppressAttachments: true,
  });
  return outPath;
}

// Build report + merge the uploaded bills into one PDF, for on-demand
// PREVIEW (so admins can review everything before approving). Same artifact
// that gets archived on approval, just generated live.
async function buildMergedPreview(sub) {
  const reportPath = await buildReportPdf(sub, { draft: true });
  const attachments = stmts.listAttachments.all(sub.id);
  const outPath = path.join(REPORTS_DIR, `${sub.reference}__preview.pdf`);
  await mergeReportWithBills(reportPath, attachments, outPath);
  return outPath;
}

module.exports = { buildReportPdf, buildMergedPreview, REPORTS_DIR };
