// ====================================================================
//  SYNC ORCHESTRATOR · OneDrive mirror of submissions
// ====================================================================
//  Coordinates the three OneDrive side-effects, all fail-soft:
//    onSubmit(sub, employee, attachments)
//       → push raw bills to <Employee>/Uploads/
//       → append a row to <Employee>_Log.xlsx (status: Pending)
//    onApprove(sub, employee, attachments, reportPdfPath)
//       → build merged PDF (report + bills)
//       → store in <Employee>/Reports/
//       → update the Excel row (status: Approved)
//    onReject(sub, employee)
//       → update the Excel row (status: Rejected)
//
//  Each step records success/failure flags on the submission so a
//  background retry can re-attempt anything that didn't sync.
// ====================================================================

const fs = require('fs');
const path = require('path');
const od = require('./onedrive');
const excel = require('./excel-log');
const { mergeReportWithBills } = require('./pdf-merge');
const { stmts } = require('../db');
const { REPORTS_DIR } = require('../config/paths');

function uploadsFolder(employee) { return `${od.employeeFolder(employee)}/Uploads`; }
function reportsFolder(employee) { return `${od.employeeFolder(employee)}/Reports`; }

function resolveLocal(p) {
  return path.isAbsolute(p) ? p : path.join(__dirname, '..', '..', p);
}

// -- ON SUBMIT -------------------------------------------------------
async function onSubmit(sub, employee, attachments) {
  if (!od.isConfigured()) {
    stmts.markOdError.run('OneDrive not configured', sub.id);
    return { synced: false, reason: 'not_configured' };
  }
  let anyError = null;

  // 1) Raw bills → Uploads/
  try {
    if (attachments.length) {
      const folder = uploadsFolder(employee);
      await od.ensureFolder(folder);
      for (const att of attachments) {
        const abs = resolveLocal(att.stored_path);
        if (!fs.existsSync(abs)) continue;
        const buf = fs.readFileSync(abs);
        // prefix with reference so bills group by submission
        const name = `${sub.reference}__${att.filename}`;
        await od.uploadFile(folder, name, buf, att.mime_type);
      }
    }
    stmts.markUploadsSynced.run(sub.id);
  } catch (e) {
    anyError = `uploads: ${e.message}`;
  }

  // 2) Excel log row (status Pending)
  try {
    await excel.appendEntry(sub, employee);
    stmts.markLogSynced.run(sub.id);
  } catch (e) {
    anyError = (anyError ? anyError + ' | ' : '') + `log: ${e.message}`;
  }

  if (anyError) { stmts.markOdError.run(anyError.slice(0, 480), sub.id); return { synced: false, reason: anyError }; }
  return { synced: true };
}

// -- ON APPROVE ------------------------------------------------------
//  Generates the merged report locally, stores it on OneDrive, updates Excel.
async function onApprove(sub, employee, attachments, reportPdfPath) {
  // Always build the merged report locally first (so it's downloadable
  // even if OneDrive is momentarily down).
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const mergedPath = path.join(REPORTS_DIR, `${sub.reference}.pdf`);
  await mergeReportWithBills(reportPdfPath, attachments, mergedPath);
  stmts.updateSubmissionPdf.run(mergedPath, sub.id);

  if (!od.isConfigured()) {
    stmts.markOdError.run('OneDrive not configured', sub.id);
    return { synced: false, mergedPath, reason: 'not_configured' };
  }

  let anyError = null;

  // Store merged report → Reports/
  try {
    const folder = reportsFolder(employee);
    await od.ensureFolder(folder);
    const buf = fs.readFileSync(mergedPath);
    await od.uploadFile(folder, `${sub.reference}.pdf`, buf, 'application/pdf');
    stmts.markReportSynced.run(sub.id);
  } catch (e) {
    anyError = `report: ${e.message}`;
  }

  // Update Excel row → Approved
  try {
    const fresh = stmts.getSubmission.get(sub.id);
    await excel.updateEntryStatus(fresh, employee);
    stmts.markLogSynced.run(sub.id);
  } catch (e) {
    anyError = (anyError ? anyError + ' | ' : '') + `log: ${e.message}`;
  }

  if (anyError) { stmts.markOdError.run(anyError.slice(0, 480), sub.id); return { synced: false, mergedPath, reason: anyError }; }
  return { synced: true, mergedPath };
}

// -- ON REJECT -------------------------------------------------------
async function onReject(sub, employee) {
  if (!od.isConfigured()) return { synced: false, reason: 'not_configured' };
  try {
    const fresh = stmts.getSubmission.get(sub.id);
    await excel.updateEntryStatus(fresh, employee);
    stmts.markLogSynced.run(sub.id);
    return { synced: true };
  } catch (e) {
    stmts.markOdError.run(`log: ${e.message}`.slice(0, 480), sub.id);
    return { synced: false, reason: e.message };
  }
}

module.exports = { onSubmit, onApprove, onReject, uploadsFolder, reportsFolder };
