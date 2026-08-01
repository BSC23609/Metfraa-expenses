// ====================================================================
//  Consolidation orchestrator
// ====================================================================
//   Ties together the pieces:
//    - schedules the monthly job (setTimeout-based, IST-aware)
//    - drives buildConsolidatedReport for every eligible employee
//    - persists a consolidated_reports row per employee via UPSERT
//
//   Timing: runs at 00:15 IST on the 1st of every month for the month
//   that just ended. The 15-min buffer past midnight gives room for any
//   last-second submissions on the last day to fully commit.
//
//   Turn 2 will add: email dispatch (to admin@), status transitions,
//   sign-off overlays on the PDF, rejection → deadline_bypass propagation.
// ====================================================================

const fs = require('fs');
const path = require('path');
const { stmts } = require('../db');
const { buildConsolidatedReport } = require('./consolidated-report');
const { istParts } = require('./period-lock');

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// Where consolidated PDFs are written on disk. Falls back to DATA_DIR
// when set (persistent volume on Render).
function outputsDir() {
  const base = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
  const dir = path.join(base, 'consolidated');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Given a base date, compute the previous IST calendar month as 'YYYY-MM'.
function previousMonthPeriod(baseDate = new Date()) {
  const { year, month } = istParts(baseDate);
  const prevY = month === 1 ? year - 1 : year;
  const prevM = month === 1 ? 12 : month - 1;
  return `${prevY}-${String(prevM).padStart(2, '0')}`;
}

// Compute when the next scheduled run should fire (UTC ms since epoch).
// Rule: 00:15 IST on the 1st of the next month. That's 18:45 UTC on the
// last day of the current IST month.
function nextRunUtcMs(now = new Date()) {
  const nowIst = istParts(now);
  // The 1st of NEXT IST month at 00:15 IST
  const nextMonthYear = nowIst.month === 12 ? nowIst.year + 1 : nowIst.year;
  const nextMonthNum  = nowIst.month === 12 ? 1 : nowIst.month + 1;
  // Construct UTC moment for 00:15 IST = 18:45 UTC the day BEFORE (i.e.
  // the last day of the current month). We express it directly:
  const targetIstYmd = new Date(Date.UTC(nextMonthYear, nextMonthNum - 1, 1, 0, 15));
  // Subtract IST offset to get the UTC instant
  return targetIstYmd.getTime() - IST_OFFSET_MS;
}

// Generate consolidated reports for one specific period. Returns a
// summary object.
async function generateForPeriod(period, { generatedBy = 'cron' } = {}) {
  const employees = stmts.listEmployeesWithApprovedForPeriod.all(period);
  const results = [];
  for (const emp of employees) {
    try {
      const result = await generateForEmployeePeriod(emp.id, period, { generatedBy, employee: emp });
      results.push({ employee_id: emp.id, employee_name: emp.name, ok: true, ...result });
    } catch (e) {
      console.error(`[consolidate] failed for ${emp.name} ${period}:`, e);
      results.push({ employee_id: emp.id, employee_name: emp.name, ok: false, error: e.message });
    }
  }
  return { period, generated: results.length, results };
}

// Generate for one specific (employee, period). Skips if no approved
// submissions found. Called from generateForPeriod and from a manual
// regenerate endpoint.
async function generateForEmployeePeriod(employeeId, period, { generatedBy = 'cron', employee = null } = {}) {
  const submissions = stmts.listApprovedForConsolidation.all(employeeId, period);
  if (!submissions.length) return { skipped: true, reason: 'no-approved-submissions' };

  const emp = employee || (() => {
    const e = stmts.getEmployeeById.get(employeeId);
    if (!e) throw new Error(`Employee ${employeeId} not found`);
    return e;
  })();

  // Load attachments per submission — callback keeps this file decoupled
  // from the db statements module.
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
  });

  const totalAmount = submissions.reduce((acc, s) => {
    if (s.status === 'settled' && s.actuals_json) {
      try { return acc + (parseFloat(JSON.parse(s.actuals_json).actual_amount) || 0); }
      catch (_) { return acc; }
    }
    return acc + (parseFloat(s.total_amount) || 0);
  }, 0);

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

  return { skipped: false, pdf_path: writtenPath, page_count: pageCount, total_amount: +totalAmount.toFixed(2) };
}

// -----------------------------------------------------------------
// Scheduler. Node lives forever on Render web services (until restart);
// we schedule the next run via setTimeout and reschedule after the job
// completes. On process start we log the next run time so it's visible
// in the Render logs.
//
// If somehow we START past the intended run time (e.g. the server was
// down at 00:15 IST), we DO NOT catch up automatically — that job's
// window is missed and admins can manually regenerate via the API.
// Auto-catch-up is risky (could generate reports from stale/deleted data
// or run days after the fact); manual is safer.
// -----------------------------------------------------------------
let _timer = null;

function startScheduler() {
  if (_timer) clearTimeout(_timer);
  const nowMs = Date.now();
  const runAt = nextRunUtcMs(new Date());
  const delay = runAt - nowMs;
  const runAtIso = new Date(runAt).toISOString();
  console.log(`[consolidate] next auto-run at ${runAtIso} (${Math.round(delay / 1000 / 60)} min from now)`);

  // setTimeout's max delay is ~24.8 days (2^31 - 1 ms). If the target is
  // further out (shouldn't be with monthly cadence), cap and reschedule.
  const MAX = 2 ** 31 - 1;
  const capped = Math.min(delay, MAX);

  _timer = setTimeout(async () => {
    if (delay > MAX) {
      // Not time yet; just reschedule to keep chipping through.
      startScheduler();
      return;
    }
    try {
      const period = previousMonthPeriod();
      console.log(`[consolidate] auto-run starting for period ${period}`);
      const summary = await generateForPeriod(period, { generatedBy: 'cron' });
      console.log(`[consolidate] auto-run done for ${period}: ${summary.generated} generated`);
    } catch (e) {
      console.error('[consolidate] auto-run failed:', e);
    } finally {
      // Reschedule for next month
      startScheduler();
    }
  }, capped);
}

module.exports = {
  startScheduler,
  generateForPeriod,
  generateForEmployeePeriod,
  previousMonthPeriod,
  nextRunUtcMs,
};
