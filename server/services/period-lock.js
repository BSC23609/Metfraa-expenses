// ====================================================================
//  Period-lock service
// ====================================================================
//   Enforces the strict monthly submission deadline.
//
//   RULE: submissions for period 'YYYY-MM' must be filed by 23:59 IST
//   on the LAST DAY of that month. On the 1st of the following month,
//   the period is locked. The only way to submit past that point is via
//   an active period_overrides row, OR via a per-submission deadline
//   bypass (set by consolidated-report rejection, Turn 2).
//
//   SPECIAL CASE: July 2026 is extended to Aug 1 2026 23:59 IST. This
//   is a one-off transition to give employees an extra day when this
//   new stricter rule ships. Hardcoded here so no manual override grant
//   is needed. Drops off automatically once Aug 2 rolls around.
//
//   The IST anchor matters: Render's servers run in UTC, but the
//   deadline is calendar-based in Chennai time. Everything below works
//   in IST (UTC+5:30) to match how the business team thinks about it.
// ====================================================================

const { stmts } = require('../db');

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// Special-case cutoffs keyed by period. Value is the local IST cutoff
// as a UTC Date (i.e. the moment the period locks, in UTC). Anything
// on or after this instant is locked.
//   Jul 2026: extended to Aug 1 2026 23:59:59 IST = Aug 1 2026 18:29:59 UTC
const SPECIAL_CUTOFFS = {
  '2026-07': new Date('2026-08-01T18:29:59Z'),  // Aug 1 23:59:59 IST
};

// Convert a Date (usually 'now') into IST calendar fields.
function istParts(d = new Date()) {
  const t = new Date(d.getTime() + IST_OFFSET_MS);
  return {
    year:  t.getUTCFullYear(),
    month: t.getUTCMonth() + 1,   // 1..12
    day:   t.getUTCDate(),
    period: `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}`,
  };
}

// Compute the last day of a given month (in that month's own calendar).
function lastDayOfMonth(year, month /* 1..12 */) {
  // Day 0 of NEXT month = last day of THIS month
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// The cutoff instant (as UTC Date) for a given period. Default rule:
// 23:59:59 IST on the last day of the period. Overridden per SPECIAL_CUTOFFS.
function cutoffInstantForPeriod(period) {
  const m = /^(\d{4})-(\d{2})$/.exec(period || '');
  if (!m) return null;
  if (SPECIAL_CUTOFFS[period]) return SPECIAL_CUTOFFS[period];
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  const lastDay = lastDayOfMonth(y, mo);
  // 23:59:59 IST on lastDay of that month = (23:59:59 - 5:30) UTC on lastDay
  // = 18:29:59 UTC.
  return new Date(Date.UTC(y, mo - 1, lastDay, 18, 29, 59));
}

// Human-friendly deadline label for a period (used in error messages).
function deadlineLabel(period) {
  const cutoff = cutoffInstantForPeriod(period);
  if (!cutoff) return '(unknown)';
  // Show the IST-local date + time so the message matches employee
  // expectations. e.g. "31 Aug 2026 11:59 PM IST".
  const ist = new Date(cutoff.getTime() + IST_OFFSET_MS);
  const datePart = ist.toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
  const timePart = ist.toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'UTC',
  });
  return `${datePart} ${timePart} IST`;
}

// Is the period locked by pure calendar (no override consideration)?
// Locked === now > cutoff.
function isPeriodLockedByCalendar(period, today = new Date()) {
  const cutoff = cutoffInstantForPeriod(period);
  if (!cutoff) return { locked: false, reason: 'invalid-period' };
  const nowMs = today.getTime();
  const cutMs = cutoff.getTime();
  // Future periods (cutoff in the future) are never locked.
  if (nowMs <= cutMs) return { locked: false };
  return { locked: true };
}

// The primary check. Returns:
//   { allowed: true }                                    — cutoff hasn't passed
//   { allowed: true, via_override: {...} }               — locked but override matches
//   { allowed: false, deadline, message }                — locked, no override
//
// Special case: existingSubmission.deadline_bypass = 1 (from consolidated-
// report rejection, Turn 2) lets a specific submission through even when
// the period is otherwise locked. Callers pass this along explicitly so
// this function stays pure w.r.t. submission-id lookups.
function checkPeriod(period, employeeId, opts = {}) {
  if (!period) {
    // Forms without a period sail through — the validator will complain
    // separately if a period was required.
    return { allowed: true, no_period: true };
  }
  const calendar = isPeriodLockedByCalendar(period);
  if (!calendar.locked) return { allowed: true };

  // Per-submission deadline bypass (Turn 2 flag)
  if (opts.deadline_bypass) {
    return {
      allowed: true,
      via_bypass: true,
    };
  }

  // (employee, period) override lookup
  if (employeeId != null) {
    const override = stmts.findActivePeriodOverride.get(period, employeeId);
    if (override) {
      return {
        allowed: true,
        via_override: {
          id: override.id,
          scope: override.employee_id == null ? 'global' : 'employee',
          granted_by: override.granted_by,
          granted_at: override.granted_at,
          expires_at: override.expires_at,
          reason: override.reason,
        },
      };
    }
  }

  const deadline = deadlineLabel(period);
  return {
    allowed: false,
    deadline,
    message: `${period} is closed for new submissions (the deadline was ${deadline}). Please contact HR to request a temporary override.`,
  };
}

module.exports = {
  checkPeriod,
  isPeriodLockedByCalendar,
  deadlineLabel,
  cutoffInstantForPeriod,
  istParts,
  lastDayOfMonth,
};

