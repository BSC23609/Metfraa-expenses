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

// Build the merged report locally + push to OneDrive Reports/. ALWAYS overwrites
// any existing copy with the same name (so the latest lifecycle state is what's
// archived). Used by onSubmit, onApprove, and the advance-lifecycle hooks.
//   sub             – fresh row from getSubmission (joined with employee)
//   employee        – { name, email, employee_code, level, designation, department }
//   attachments     – rows from listAttachments
//   reportPdfPath   – path to the base report PDF (already built by report-builder)
// Returns { mergedPath, syncedToOneDrive, reason }.
async function buildAndArchiveSnapshot(sub, employee, attachments, reportPdfPath) {
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const mergedPath = path.join(REPORTS_DIR, `${sub.reference}.pdf`);
  await mergeReportWithBills(reportPdfPath, attachments, mergedPath);
  stmts.updateSubmissionPdf.run(mergedPath, sub.id);

  if (!od.isConfigured()) {
    return { mergedPath, syncedToOneDrive: false, reason: 'not_configured' };
  }
  try {
    const folder = reportsFolder(employee);
    await od.ensureFolder(folder);
    const buf = fs.readFileSync(mergedPath);
    await od.uploadFile(folder, `${sub.reference}.pdf`, buf, 'application/pdf');
    stmts.markReportSynced.run(sub.id);
    return { mergedPath, syncedToOneDrive: true };
  } catch (e) {
    return { mergedPath, syncedToOneDrive: false, reason: e.message };
  }
}

// -- ON SUBMIT -------------------------------------------------------
//   1. Mirror raw bills to <Employee>/Uploads/
//   2. Build the draft snapshot report (overwrites file in <Employee>/Reports/)
//   3. Append the Excel log row (status: Pending)
async function onSubmit(sub, employee, attachments, reportPdfPath) {
  if (!od.isConfigured()) {
    stmts.markOdError.run('OneDrive not configured', sub.id);
    // Still build the merged PDF locally so the app can serve View/Download
    if (reportPdfPath) {
      try { await buildAndArchiveSnapshot(sub, employee, attachments, reportPdfPath); }
      catch (e) { /* swallow — local-only fallback */ }
    }
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

  // 2) Build + archive the draft snapshot to <Employee>/Reports/
  //    (overwrites on every subsequent lifecycle change)
  if (reportPdfPath) {
    try {
      const r = await buildAndArchiveSnapshot(sub, employee, attachments, reportPdfPath);
      if (!r.syncedToOneDrive && r.reason) {
        anyError = (anyError ? anyError + ' | ' : '') + `report: ${r.reason}`;
      }
    } catch (e) {
      anyError = (anyError ? anyError + ' | ' : '') + `report: ${e.message}`;
    }
  }

  // 3) Excel log row (status Pending)
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
//  Generates the merged report locally, OVERWRITES the OneDrive copy with
//  the post-approval snapshot, updates Excel.
async function onApprove(sub, employee, attachments, reportPdfPath) {
  const r = await buildAndArchiveSnapshot(sub, employee, attachments, reportPdfPath);
  let anyError = null;
  if (!r.syncedToOneDrive && r.reason) anyError = `report: ${r.reason}`;

  // Update Excel row → Approved / Settled / etc.
  if (od.isConfigured()) {
    try {
      const fresh = stmts.getSubmission.get(sub.id);
      await excel.updateEntryStatus(fresh, employee);
      stmts.markLogSynced.run(sub.id);
    } catch (e) {
      anyError = (anyError ? anyError + ' | ' : '') + `log: ${e.message}`;
    }
  }

  if (anyError) { stmts.markOdError.run(anyError.slice(0, 480), sub.id); return { synced: false, mergedPath: r.mergedPath, reason: anyError }; }
  return { synced: true, mergedPath: r.mergedPath };
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

module.exports = { onSubmit, onApprove, onReject, buildAndArchiveSnapshot, uploadsFolder, reportsFolder };
