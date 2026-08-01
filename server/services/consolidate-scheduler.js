// ====================================================================
//  Consolidation service (on-demand)
// ====================================================================
//   Previously ran on a monthly cron; now purely on-demand — HR clicks
//   "Send for final approval" from the portal, and this file's helpers
//   generate the PDF + persist the row.
//
//   Filename kept as consolidate-scheduler.js only to avoid churning
//   the four require() paths that already point here. No scheduler
//   logic remains.
// ====================================================================

const fs = require('fs');
const path = require('path');
const { stmts } = require('../db');
const { buildConsolidatedReport } = require('./consolidated-report');

// Where consolidated PDFs are written on disk. Falls back to DATA_DIR
// when set (persistent volume on Render).
function outputsDir() {
  const base = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
  const dir = path.join(base, 'consolidated');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Generate a consolidated PDF for one (employee, period) and persist
 * a consolidated_reports row (or update an existing one).
 *
 * @param {number} employeeId
 * @param {string} period    - 'YYYY-MM'
 * @param {object} opts
 * @param {string} opts.generatedBy - email of the actor (HR when sending, or 'system')
 * @param {object} opts.employee    - optional pre-fetched employee row
 * @param {object} opts.signoffs    - optional {hr:{by,at},mgmt:{by,at}} for cover overlay
 * @param {boolean} opts.keepStatus - if true, only swap the PDF file/pages
 *                                    without wiping approval columns (used on
 *                                    approval regen after Mgmt signs off).
 */
async function generateForEmployeePeriod(employeeId, period, { generatedBy = 'system', employee = null, signoffs = null, keepStatus = false } = {}) {
  const submissions = stmts.listApprovedForConsolidation.all(employeeId, period);
  if (!submissions.length) return { skipped: true, reason: 'no-approved-submissions' };

  const emp = employee || (() => {
    const e = stmts.getEmployeeById.get(employeeId);
    if (!e) throw new Error(`Employee ${employeeId} not found`);
    // getEmployeeById returns the raw column `employee_code`; the PDF
    // builder reads `.code`. Normalise so both callers see the same shape.
    if (e.code == null && e.employee_code != null) e.code = e.employee_code;
    return e;
  })();

  async function loadAttachments(subId) {
    return stmts.listAttachments.all(subId) || [];
  }

  const outDir = outputsDir();
  const safeName = String(emp.name || `emp-${emp.id}`).replace(/[^a-zA-Z0-9_-]+/g, '_');
  const outPath = path.join(outDir, `${period}__${safeName}__${emp.id}.pdf`);

  const { path: writtenPath, pageCount } = await buildConsolidatedReport({
    employee: emp,
    period,
    submissions,
    loadAttachments,
    outPath,
    signoffs,
  });

  const totalAmount = submissions.reduce((acc, s) => {
    if (s.status === 'settled' && s.actuals_json) {
      try { return acc + (parseFloat(JSON.parse(s.actuals_json).actual_amount) || 0); }
      catch (_) { return acc; }
    }
    return acc + (parseFloat(s.total_amount) || 0);
  }, 0);

  if (keepStatus) {
    // In-place re-render — used after Mgmt approval to bake sign-offs
    // into the PDF without wiping the report's approval columns.
    stmts.updateConsolidatedReportPdf.run({
      employee_id: emp.id, period,
      pdf_path: writtenPath, pdf_page_count: pageCount,
    });
  } else {
    stmts.upsertConsolidatedReport.run({
      employee_id: emp.id,
      period,
      total_amount: +totalAmount.toFixed(2),
      submission_count: submissions.length,
      submission_ids: JSON.stringify(submissions.map(s => s.id)),
      pdf_path: writtenPath,
      pdf_page_count: pageCount,
      generated_by: generatedBy,
    });
  }

  return {
    skipped: false,
    pdf_path: writtenPath,
    page_count: pageCount,
    total_amount: +totalAmount.toFixed(2),
    submission_count: submissions.length,
  };
}

module.exports = { generateForEmployeePeriod };
