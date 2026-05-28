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
// Built-in Metfraa roster (PALANINATHAL removed; shares accounts@ with SATHYA)
// --------------------------------------------------------------------
const METFRAA = [
  ['SUDHA.G',                        'admin@metfraa.com',           'ADMIN',                                'JUNIOR'],
  ['THANAVEL',                       'thanavel@metfraa.com',        'PROJECT MANAGER',                      'MANAGER'],
  ['VIJAY.R',                        'vijay@metfraa.com',           'PROJECT MANAGER',                      'MANAGER'],
  ['SATHIYASEELAN.S',                'sathya@metfraa.com',          'GENERAL MANAGER - SALES',              'MANAGER'],
  ['BODAPATI SHEELA HEPSIBAH GRACE', 'hr@metfraa.com',              'HR - ASSISTANT',                       'JUNIOR'],
  ['N.NAINAR',                       'nainar@metfraa.com',          'PROJECT MANAGER',                      'MANAGER'],
  ['KHAJA SHERIFF',                  'khajasheriff.m@metfraa.com',  'GENERAL MANAGER - DESIGN',             'MANAGER'],
  ['SALMA',                          'costing@metfraa.com',         'COSTING AND ESTIMATION ENGINEER',      'JUNIOR'],
  ['SURESH KUMAR.R',                 'purchase@metfraa.com',        'MANAGER - PURCHASE',                   'MANAGER'],
  ['RAJASEKAR',                      'lrajasekar1984@gmail.com',    'SITE SUPERVISOR',                      'SENIOR'],
  ['VELAYUTHAM',                     'p.velu92@gmail.com',          'SITE MANAGER',                         'MANAGER'],
  ['SURESH.S',                       'qaqc@metfraa.com',            'QUALITY CONTROL ENGINEER',             'SENIOR'],
  ['MOHAN KUMAR',                    'mohan2681@gmail.com',         'JUNIOR ENGINEER CIVIL',                'JUNIOR'],
  ['THIRUMALAI',                     'thiru_rani07@yahoo.co.in',    'SAFETY OFFICER',                       'SENIOR'],
  ['P. THANGARAJ',                   'thangaraj@metfraa.com',       'PLANT HEAD OPERATIONS',                'MANAGER'],
  ['A.SANTHOSHRAJ',                  'rajsathosh1@gmail.com',       'PRODUCTION ENGINEER',                  'JUNIOR'],
  ['GOPI.M',                         'gopi@metfraa.com',            'PRODUCTION MANAGER',                   'MANAGER'],
  ['SUMANA S',                       'sumana@metfraa.com',          'PROJECT COORDINATOR',                  'SENIOR'],
  ['NANDA KUMAR',                    'nandakumar250788@gmail.com',  'PROJECT ENGINEER CIVIL',               'SENIOR'],
  ['RENJITH S A',                    'renjithrj970@gmail.com',      'JUNIOR SAFETY EXECUTIVE',              'JUNIOR'],
  ['NIRMAL KUMAR',                   'nirmal@metfraa.com',          'ASSISTANT GENERAL MANAGER - PROJECTS', 'MANAGER'],
  ['VANISHREE R',                    'sales@metfraa.com',           'SALES COORDINATOR',                    'JUNIOR'],
  ['ROBIN JAMES',                    'robinjkl84@yahoo.com',        'SITE ENGINEER',                        'JUNIOR'],
  ['E.LOKESH',                       'lokeshel79@gmail.com',        'SITE ENGINEER',                        'JUNIOR'],
  ['AJOY KUMAR KHATUA',              'maintenance@metfraa.com',     'ASSISTANT MANAGER - MAINTENANCE',      'SENIOR'],
  ['DEENADHAYALAN RAMESH',           'stores@metfraa.com',          'STORES EXECUTIVE',                     'JUNIOR'],
  ['SATHYA',                         'accounts@metfraa.com',        'ACCOUNTS ASSISTANT',                   'JUNIOR'],
  ['C.SARANEESWARI',                 'saraneeswari@metfraa.com',    'SENIOR DESIGN ENGINEER',               'SENIOR'],
  ['VARATHARAJ NAVANEETHAN',         'varadharaj@metfraa.com',      'ASSISTANT MANAGER - EHS',              'SENIOR'],
  ['GOPI MAHENDIRAN M',              'm.gopi@metfraa.com',          'DETAILER',                             'SENIOR'],
  ['MANSOOR',                        'mansoor@metfraa.com',         'SENIOR CHECKER',                       'SENIOR'],
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
    };
  });
}

function recordsFromBuiltIn() {
  return METFRAA.map(([name, email, designation, lvl], idx) => ({
    name,
    email: email.toLowerCase(),
    designation,
    level: LEVEL_MAP[lvl] || 'L1',
    company: 'metfraa',
    employee_code: 'MET-' + String(idx + 1).padStart(3, '0'),
    department: null,
    manager_email: 'admin@metfraa.com',
  }));
}

const csvArg = process.argv[2];
const records = csvArg ? recordsFromCSV(path.resolve(csvArg)) : recordsFromBuiltIn();

console.log(`Seeding ${records.length} employees${csvArg ? ` from ${csvArg}` : ' (built-in Metfraa roster)'}…`);

const bcrypt = require('bcryptjs');
const { authMethodForEmail } = require('../services/auth');
const DEFAULT_PW_HASH = bcrypt.hashSync('Metfraa@123', 10);

let inserted = 0, skipped = 0;
const tx = db.transaction((rows) => {
  for (const r of rows) {
    if (!r.email || !r.name || !r.company || !r.level) {
      console.warn('Skipping row, missing required fields:', r);
      continue;
    }
    // De-dupe on (email + name) so re-running is safe even without unique email.
    const existing = stmts.findAllByEmail.all(r.email).find(e => e.name.toLowerCase() === r.name.toLowerCase());
    if (existing) { skipped++; continue; }
    const method = authMethodForEmail(r.email);
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

console.log(`Done. Inserted: ${inserted}, Skipped (already present): ${skipped}.`);
console.log('');
console.log('Sign in with any listed Google account. Shared mailboxes (admin@, accounts@,');
console.log('hr@) map to one portal identity — submissions attribute to that record.');
