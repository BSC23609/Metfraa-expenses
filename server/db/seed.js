// ====================================================================
//  SEED · loads Metfraa employees into the database
// ====================================================================
//  Usage:
//    1) Built-in Metfraa roster:   node server/db/seed.js
//    2) From a CSV:                node server/db/seed.js employees.csv
//
//  CSV columns (header row required, case-insensitive):
//    email, name, employee_code, company, level, designation, department, manager_email
//
//  - company: metfraa
//  - level:   JUNIOR | SENIOR | MANAGER  (mapped to L1 / L2 / L3)
//
//  NOTE: email is NOT unique (shared mailboxes are allowed). Re-running
//  this seed SKIPS rows whose (email + name) already exist, so it is
//  safe to run more than once without creating duplicates.
// ====================================================================

const fs = require('fs');
const path = require('path');
const { db, stmts } = require('./index');

// Junior/Senior/Manager → L1/L2/L3
const LEVEL_MAP = { JUNIOR: 'L1', SENIOR: 'L2', MANAGER: 'L3', L1: 'L1', L2: 'L2', L3: 'L3' };

// --------------------------------------------------------------------
// Built-in Metfraa roster.
//
// Format per row: [name, email, designation, level, auth_method?]
//
// The 5th column (auth_method) is OPTIONAL. If present it overrides the
// default domain-based assignment from authMethodForEmail():
//   'microsoft' | 'google' | 'password'
// Use the override when the per-person sheet disagrees with the domain
// rule (e.g. an @metfraa.com user who uses a local password instead of MS
// SSO, or a yahoo user who's been moved to Google login).
// --------------------------------------------------------------------
const METFRAA = [
  // Microsoft SSO (default for @metfraa.com)
  ['SUDHA.G',                        'admin@metfraa.com',                   'ADMIN',                                'JUNIOR'],
  ['THANAVEL',                       'thanavel@metfraa.com',                'PROJECT MANAGER',                      'MANAGER'],
  ['VIJAY.R',                        'vijay@metfraa.com',                   'PROJECT MANAGER',                      'SENIOR'],
  ['SATHIYASEELAN.S',                'sathya@metfraa.com',                  'GENERAL MANAGER - SALES',              'MANAGER'],
  ['KHAJA SHERIFF',                  'khajasheriff.m@metfraa.com',          'GENERAL MANAGER - DESIGN',             'MANAGER'],
  ['SALMA',                          'costing@metfraa.com',                 'COSTING AND ESTIMATION ENGINEER',      'JUNIOR'],
  ['SURESH KUMAR.R',                 'purchase@metfraa.com',                'MANAGER - PURCHASE',                   'SENIOR'],
  ['SURESH.S',                       'qaqc@metfraa.com',                    'QUALITY CONTROL ENGINEER',             'SENIOR'],
  ['P. THANGARAJ',                   'thangaraj@metfraa.com',               'PLANT HEAD OPERATIONS',                'MANAGER'],
  ['GOPI.M',                         'gopi@metfraa.com',                    'PRODUCTION MANAGER',                   'MANAGER'],
  ['SUMANA S',                       'sumana@metfraa.com',                  'PROJECT COORDINATOR',                  'SENIOR'],
  ['NIRMAL KUMAR',                   'nirmal@metfraa.com',                  'ASSISTANT GENERAL MANAGER - PROJECTS', 'MANAGER'],
  ['VANISHREE R',                    'sales@metfraa.com',                   'SALES COORDINATOR',                    'SENIOR'],
  ['AJOY KUMAR KHATUA',              'maintenance@metfraa.com',             'ASSISTANT MANAGER - MAINTENANCE',      'SENIOR'],
  ['SATHYA',                         'accounts@metfraa.com',                'ACCOUNTS ASSISTANT',                   'SENIOR'],
  ['C.SARANEESWARI',                 'saraneeswari@metfraa.com',            'SENIOR DESIGN ENGINEER',               'SENIOR'],
  ['VARATHARAJ NAVANEETHAN',         'varadharaj@metfraa.com',              'ASSISTANT MANAGER - EHS',              'SENIOR'],
  ['GOPI MAHENDIRAN M',              'm.gopi@metfraa.com',                  'DETAILER',                             'SENIOR'],
  ['MANSOOR',                        'mansoor@metfraa.com',                 'SENIOR CHECKER',                       'SENIOR'],

  // Explicit Custom Password login (overrides the @metfraa.com domain rule)
  ['BODAPATI SHEELA HEPSIBAH GRACE', 'hr@metfraa.com',                      'HR - ASSISTANT',                       'JUNIOR',  'password'],

  // Google SSO (default for @gmail.com)
  ['RAJASEKAR',                      'lrajasekar1984@gmail.com',            'SITE SUPERVISOR',                      'SENIOR'],
  ['VELAYUTHAM',                     'p.velu92@gmail.com',                  'SITE MANAGER',                         'SENIOR'],
  ['MOHAN KUMAR',                    'mohan2681@gmail.com',                 'JUNIOR ENGINEER CIVIL',                'JUNIOR'],
  ['A.SANTHOSHRAJ',                  'rajsathosh1@gmail.com',               'PRODUCTION ENGINEER',                  'JUNIOR'],
  ['NANDA KUMAR',                    'nandakumar250788@gmail.com',          'PROJECT ENGINEER CIVIL',               'SENIOR'],
  ['RENJITH S A',                    'renjithrj970@gmail.com',              'JUNIOR SAFETY EXECUTIVE',              'JUNIOR'],
  ['E.LOKESH',                       'lokeshel79@gmail.com',                'SITE ENGINEER',                        'JUNIOR'],
  ['DEENADHAYALAN RAMESH',           'stores@metfraa.com',                  'STORES EXECUTIVE',                     'JUNIOR'], // sheet says Gmail Login but this is @metfraa.com — kept on Microsoft SSO (Google won't auth a non-Gmail address). Flag if wrong.

  // Custom Password login (yahoo / no SSO available)
  ['THIRUMALAI',                     'thiru_rani07@yahoo.co.in',            'SAFETY OFFICER',                       'SENIOR'],
  ['ROBIN JAMES',                    'robinjkl84@yahoo.com',                'SITE ENGINEER',                        'JUNIOR'],

  // New joiners (no real email yet — placeholders chosen to land on the
  // password method by default; replace with real addresses when assigned).
  ['PRAWIN PAUL D',                  'prawin@metfraa.com',                  'SAFETY OFFICER',                       'SENIOR',  'password'],
  ['M POORNIMA',                     'poornima@metfraa.com',                'ADMIN & PURCHASE EXECUTIVE',           'JUNIOR',  'password'],
  ['GANESH RAJA P',                  'ganesh@metfraa.com',                  'PPC EXECUTIVE',                        'JUNIOR',  'password'],
  ['NAVENDRA PRATAP SINGH',          'navendra@metfraa.com',                'SITE MANAGER',                         'SENIOR',  'password'],
];

function parseCSV(text) {
  const rows = [];
  let cur = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { cur.push(field); field = ''; }
      else if (c === '\n') { cur.push(field); rows.push(cur); cur = []; field = ''; }
      else if (c === '\r') { /* skip */ }
      else field += c;
    }
  }
  if (field.length || cur.length) { cur.push(field); rows.push(cur); }
  return rows.filter(r => r.length && r.some(x => x.trim().length));
}

function recordsFromCSV(csvPath) {
  const text = fs.readFileSync(csvPath, 'utf8');
  const rows = parseCSV(text);
  if (rows.length < 2) { console.error('CSV has no data rows'); process.exit(1); }
  const headers = rows[0].map(h => h.trim().toLowerCase());
  return rows.slice(1).map(r => {
    const obj = {};
    headers.forEach((h, i) => obj[h] = (r[i] || '').trim());
    return {
      name: obj.name,
      email: (obj.email || '').toLowerCase(),
      designation: obj.designation || null,
      level: LEVEL_MAP[(obj.level || '').toUpperCase()] || (obj.level || '').toUpperCase(),
      company: (obj.company || 'metfraa').toLowerCase(),
      employee_code: obj.employee_code || null,
      department: obj.department || null,
      manager_email: obj.manager_email || null,
      auth_method: (obj.auth_method || '').toLowerCase() || null,  // optional override
    };
  });
}

function recordsFromBuiltIn() {
  return METFRAA.map(([name, email, designation, lvl, authOverride], idx) => ({
    name,
    email: email.toLowerCase(),
    designation,
    level: LEVEL_MAP[lvl] || 'L1',
    company: 'metfraa',
    employee_code: 'MET-' + String(idx + 1).padStart(3, '0'),
    department: null,
    manager_email: 'admin@metfraa.com',
    auth_method: authOverride || null,   // null → infer from email domain
  }));
}

const csvArg = process.argv[2];
const records = csvArg ? recordsFromCSV(path.resolve(csvArg)) : recordsFromBuiltIn();

console.log(`Seeding ${records.length} employees${csvArg ? ` from ${csvArg}` : ' (built-in Metfraa roster)'}…`);

const bcrypt = require('bcryptjs');
const { authMethodForEmail } = require('../services/auth');
const DEFAULT_PW_HASH = bcrypt.hashSync('Metfraa@123', 10);

let inserted = 0, updated = 0, skipped = 0, deactivated = 0;

// People removed from the active roster — deactivated when seeding the
// built-in list so prior production rows don't linger as active accounts.
// (Skipped when seeding from a CSV — that file is the source of truth.)
const REMOVED_EMAILS = csvArg ? [] : ['nainar@metfraa.com'];

const tx = db.transaction((rows) => {
  // 1) Deactivate anyone who has been removed from the roster
  for (const email of REMOVED_EMAILS) {
    for (const e of stmts.findAllByEmail.all(email)) {
      if (e.is_active) {
        stmts.deactivateEmployee.run(e.id);
        deactivated++;
      }
    }
  }

  // 2) Insert new rows / update changed rows
  const VALID = new Set(['microsoft', 'google', 'password']);
  for (const r of rows) {
    if (!r.email || !r.name || !r.company || !r.level) {
      console.warn('Skipping row, missing required fields:', r);
      continue;
    }
    const override = r.auth_method && VALID.has(r.auth_method) ? r.auth_method : null;
    const method = override || authMethodForEmail(r.email);

    // De-dupe on (email + name) so re-running is safe even without unique email.
    const existing = stmts.findAllByEmail.all(r.email).find(e => e.name.toLowerCase() === r.name.toLowerCase());
    if (existing) {
      // If level / designation / auth_method / employee_code changed,
      // update the row in place (the seed is the source of truth).
      const changed =
        existing.level !== r.level ||
        existing.auth_method !== method ||
        (existing.designation || '') !== (r.designation || '') ||
        (existing.employee_code || '') !== (r.employee_code || '') ||
        !existing.is_active;
      if (changed) {
        stmts.updateEmployee.run({
          id: existing.id,
          email: r.email,
          name: r.name,
          employee_code: r.employee_code || existing.employee_code,
          company: r.company,
          level: r.level,
          designation: r.designation || existing.designation,
          department: r.department || existing.department,
          manager_email: r.manager_email || existing.manager_email,
          auth_method: method,
          is_active: 1,
        });
        updated++;
      } else {
        skipped++;
      }
      continue;
    }

    stmts.insertEmployee.run({
      email: r.email,
      name: r.name,
      employee_code: r.employee_code || null,
      company: r.company,
      level: r.level,
      designation: r.designation || null,
      department: r.department || null,
      manager_email: r.manager_email || null,
      auth_method: method,
      // password users get the shared default + forced change on first login
      password_hash: method === 'password' ? DEFAULT_PW_HASH : null,
      must_change_pw: method === 'password' ? 1 : 0,
    });
    inserted++;
  }
});

tx(records);

console.log(`Done. Inserted: ${inserted}, Updated: ${updated}, Deactivated: ${deactivated}, Skipped (unchanged): ${skipped}.`);
console.log('');
console.log('Sign in: @metfraa.com → Microsoft, @gmail.com → Google, others → password (default Metfraa@123, must change on first login).');
console.log('Per-row auth_method overrides (e.g. HR password despite @metfraa.com) are honored.');
