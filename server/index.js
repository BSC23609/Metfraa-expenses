// ====================================================================
//  BHARAT STEEL GROUP — EXPENSE PORTAL · server entry
// ====================================================================

require('dotenv').config();

const express      = require('express');
const session      = require('express-session');
const SQLiteStore  = require('connect-sqlite3')(session);
const passport     = require('passport');
const path         = require('path');
const fs           = require('fs');

const { db, stmts } = require('./db');
const authService   = require('./services/auth');
const { DATA_DIR }  = require('./config/paths');

// Init passport
authService.init();

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

// --- middleware -----------------------------------------------------
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// --- session store --------------------------------------------------
app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: DATA_DIR }),
  secret: process.env.SESSION_SECRET || 'dev-only-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
  },
}));
app.use(passport.initialize());
app.use(passport.session());

// --- static (public) ------------------------------------------------
app.use(express.static(path.join(__dirname, '..', 'public'), {
  index: false, // we serve index.html ourselves to gate on auth
  setHeaders: (res, p) => {
    if (/\.(html|css|js)$/.test(p)) res.set('Cache-Control', 'no-cache');
    else if (/\.(png|jpg|jpeg|webp|svg)$/.test(p)) res.set('Cache-Control', 'public, max-age=86400');
  },
}));

// --- routes ---------------------------------------------------------
app.use('/auth',             require('./routes/auth'));
app.use('/api/uploads',      require('./routes/uploads'));
app.use('/api/submissions',  require('./routes/submissions'));
app.use('/api/projects',     require('./routes/projects'));
app.use('/api/policy',       require('./routes/policy'));
app.use('/api/admin',        require('./routes/admin'));

// Login page — public
app.get('/login', (req, res) => {
  const authed = req.isAuthenticated && req.isAuthenticated();
  // Authenticated users normally bounce to the app — EXCEPT when they must
  // change their password (the change form lives on the login page).
  if (authed && !(req.user && req.user.must_change_pw)) return res.redirect('/');
  res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
});

// Root → gated
app.get('/', (req, res) => {
  if (!req.isAuthenticated || !req.isAuthenticated()) return res.redirect('/login');
  if (req.user && req.user.must_change_pw) return res.redirect('/login?change=1');
  res.sendFile(path.join(__dirname, '..', 'public', 'app.html'));
});

// Health check
app.get('/health', (req, res) => res.json({
  ok: true,
  uptime: process.uptime(),
  time: new Date().toISOString(),
}));

// 404 for /api
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Generic 404
app.use((req, res) => res.redirect('/'));

// Error handler
app.use((err, req, res, next) => {
  console.error('[error]', err);
  if (res.headersSent) return next(err);
  if (req.path.startsWith('/api')) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
  res.status(500).send('Server error');
});

// Cleanup old pending uploads daily
setInterval(() => {
  try { stmts.cleanupOldPending.run(); } catch (_) {}
}, 1000 * 60 * 60 * 24).unref();

// Background OneDrive retry: re-attempt any submission whose log/uploads/report
// didn't sync (e.g. Microsoft was briefly unreachable). Fail-soft.
const onedrive = require('./services/onedrive');
const syncSvc  = require('./services/sync');
const { buildReportPdf } = require('./services/report-builder');
const RETRY_MIN = parseInt(process.env.ONEDRIVE_RETRY_MINUTES || '15', 10);

async function retryUnsynced() {
  if (!onedrive.isConfigured()) return;
  try {
    const rows = db.prepare(`
      SELECT s.*, e.name AS employee_name, e.email AS employee_email, e.employee_code,
             e.designation, e.department, e.level
      FROM submissions s JOIN employees e ON e.id = s.employee_id
      WHERE (s.od_log_synced = 0 OR s.od_uploads_synced = 0
             OR (s.status='approved' AND s.od_report_synced = 0))
      ORDER BY s.id DESC LIMIT 25
    `).all();
    for (const sub of rows) {
      const employee = {
        name: sub.employee_name, email: sub.employee_email, employee_code: sub.employee_code,
        level: sub.level, designation: sub.designation, department: sub.department,
      };
      const attachments = stmts.listAttachments.all(sub.id);
      if (sub.status === 'approved' && sub.od_report_synced === 0) {
        const reportPdf = await buildReportPdf(sub, { draft: false });
        await syncSvc.onApprove(sub, employee, attachments, reportPdf);
      } else {
        await syncSvc.onSubmit(sub, employee, attachments);
      }
    }
    if (rows.length) console.log(`[onedrive-retry] re-attempted ${rows.length} submission(s)`);
  } catch (e) {
    console.error('[onedrive-retry]', e.message);
  }
}
setInterval(retryUnsynced, RETRY_MIN * 60 * 1000).unref();
// also run once shortly after boot
setTimeout(retryUnsynced, 30 * 1000).unref();

const PORT = parseInt(process.env.PORT || '3000', 10);
app.listen(PORT, () => {
  console.log('');
  console.log('═══════════════════════════════════════════════════');
  console.log('  BHARAT STEEL GROUP · EXPENSE PORTAL');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Listening on:  http://localhost:${PORT}`);
  console.log(`  Public URL:    ${process.env.APP_URL || `http://localhost:${PORT}`}`);
  console.log(`  Environment:   ${process.env.NODE_ENV || 'development'}`);
  console.log('═══════════════════════════════════════════════════');
  console.log('');
});
