// ====================================================================
//  PATHS · central location config
// ====================================================================
//  Lets the data directory and uploads directory be relocated to a
//  persistent disk (e.g. Render's /var/data) via env vars, while
//  defaulting to the in-repo folders for local development.
//
//    DATA_DIR     → where portal.db + sessions.db live
//    UPLOADS_DIR  → where bill uploads + generated reports live
// ====================================================================

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..', '..');

const DATA_DIR    = process.env.DATA_DIR    || path.join(ROOT, 'data');
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(ROOT, 'uploads');
const REPORTS_DIR = path.join(UPLOADS_DIR, 'reports');

function ensure(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
ensure(DATA_DIR);
ensure(UPLOADS_DIR);
ensure(REPORTS_DIR);

module.exports = {
  ROOT,
  DATA_DIR,
  UPLOADS_DIR,
  REPORTS_DIR,
  DB_PATH: path.join(DATA_DIR, 'portal.db'),
};
