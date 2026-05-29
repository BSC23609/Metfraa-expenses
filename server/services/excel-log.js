// ====================================================================
//  EXCEL LOG SERVICE · per-employee workbook on OneDrive (Graph Excel API)
// ====================================================================
//  Each employee gets one workbook: <Employee>_Log.xlsx in their folder.
//  It contains a single table ("Entries"). We append one row per
//  submission (any status) and can update that row's status later
//  (on approval/rejection) by matching the Reference column.
//
//  We use the Graph *Excel* API (workbook/tables/rows) so we never
//  download or parse the file — Graph mutates it server-side. The first
//  time, we create the workbook with headers + a named table.
//
//  Columns:
//    Reference | Submitted | Employee | Email | Level | Form |
//    Period | Amount (INR) | Status | Reviewed By | Reviewed At | Note
// ====================================================================

const od = require('./onedrive');

const HEADERS = [
  'Reference', 'Submitted', 'Employee', 'Email', 'Level', 'Form',
  'Period', 'Amount (INR)', 'Status', 'Reviewed By', 'Reviewed At', 'Note',
];
const TABLE_NAME = 'Entries';
const SHEET_NAME = 'Log';

function logFileName(employee) {
  return `${od.safeName(employee.name)}_Log.xlsx`;
}
function logItemPath(employee) {
  return `${od.employeeFolder(employee)}/${logFileName(employee)}`;
}

// Minimal empty .xlsx with one sheet named "Log" — created via Graph by
// uploading a tiny valid workbook, then adding headers + table through
// the Excel API. Simplest robust path: create the file with a blank
// upload, then use the workbook API to write headers and define a table.

// A pre-built minimal XLSX (one empty sheet "Log") encoded as base64.
// Generated once; contains [Content_Types].xml, workbook, one sheet.
const BLANK_XLSX_B64 = require('./blank-xlsx');

async function ensureWorkbook(employee) {
  const folder = od.employeeFolder(employee);
  await od.ensureFolder(folder);
  const itemPath = logItemPath(employee);

  // Does it already exist?
  try {
    await od.graph('GET', `${od.driveRoot()}/root:/${od.encodePath(itemPath)}`);
    return itemPath; // exists
  } catch (e) {
    if (e.status !== 404) throw e;
  }

  // Create from the blank template
  const buf = Buffer.from(BLANK_XLSX_B64, 'base64');
  await od.uploadFile(folder, logFileName(employee), buf,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

  // Write headers into row 1 of the "Log" sheet
  const addr = `${SHEET_NAME}!A1:${colLetter(HEADERS.length)}1`;
  await od.graph('PATCH',
    `${od.driveRoot()}/root:/${od.encodePath(itemPath)}:/workbook/worksheets/${encodeURIComponent(SHEET_NAME)}/range(address='${addr}')`,
    { json: { values: [HEADERS] } });

  // Define a table over the header (with headers)
  await od.graph('POST',
    `${od.driveRoot()}/root:/${od.encodePath(itemPath)}:/workbook/tables/add`,
    { json: { address: `${SHEET_NAME}!A1:${colLetter(HEADERS.length)}1`, hasHeaders: true } });

  // Rename the table to a stable name
  const tables = await od.graph('GET', `${od.driveRoot()}/root:/${od.encodePath(itemPath)}:/workbook/tables`);
  if (tables.value && tables.value[0]) {
    await od.graph('PATCH',
      `${od.driveRoot()}/root:/${od.encodePath(itemPath)}:/workbook/tables/${tables.value[0].id}`,
      { json: { name: TABLE_NAME } });
  }

  return itemPath;
}

function rowFor(sub, employee) {
  const LEVEL = { L1: 'Junior', L2: 'Senior', L3: 'Managerial' };
  return [
    sub.reference,
    fmtDate(sub.submitted_at),
    employee.name,
    employee.email,
    `${employee.level} · ${LEVEL[employee.level] || ''}`.trim(),
    formTitle(sub.form_type),
    sub.period || '',
    Number(sub.total_amount || 0),
    cap(sub.status || 'pending'),
    sub.reviewed_by || '',
    sub.reviewed_at ? fmtDate(sub.reviewed_at) : '',
    sub.review_note || '',
  ];
}

// Append a new row for a submission
async function appendEntry(sub, employee) {
  const itemPath = await ensureWorkbook(employee);
  await od.graph('POST',
    `${od.driveRoot()}/root:/${od.encodePath(itemPath)}:/workbook/tables/${TABLE_NAME}/rows/add`,
    { json: { values: [rowFor(sub, employee)] } });
  return itemPath;
}

// Update the Status / Reviewed columns for an existing reference
async function updateEntryStatus(sub, employee) {
  const itemPath = await ensureWorkbook(employee);
  // Pull table rows, find the one whose Reference matches
  const rows = await od.graph('GET',
    `${od.driveRoot()}/root:/${od.encodePath(itemPath)}:/workbook/tables/${TABLE_NAME}/rows`);
  const list = rows.value || [];
  const idx = list.findIndex(r => (r.values && r.values[0] && r.values[0][0]) === sub.reference);
  if (idx === -1) {
    // Not found (older entry) — just append fresh
    return appendEntry(sub, employee);
  }
  // Update just the row's full values (simplest: rewrite the row)
  await od.graph('PATCH',
    `${od.driveRoot()}/root:/${od.encodePath(itemPath)}:/workbook/tables/${TABLE_NAME}/rows/itemAt(index=${idx})`,
    { json: { values: [rowFor(sub, employee)] } });
  return itemPath;
}

// ---- helpers -------------------------------------------------------
function colLetter(n) { // 1->A
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s);
  return isNaN(d) ? s : d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}
function cap(s) { return String(s).charAt(0).toUpperCase() + String(s).slice(1); }
function formTitle(t) {
  return ({
    met_local: 'Local Travel Allowance',
    met_cab: 'Cab Reimbursement',
    met_accommodation: 'Monthly Accommodation',
    met_outstation: 'Outstation Travel',
    met_misc: 'Miscellaneous Reimbursement',
    bsc_conveyance: 'Local Conveyance',
    bsc_expense: 'Travel Expense',
  })[t] || t;
}

module.exports = { ensureWorkbook, appendEntry, updateEntryStatus, logItemPath, logFileName };
