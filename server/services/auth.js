// ====================================================================
//  AUTH · Google Workspace SSO
// ====================================================================
//  Strategy:
//    1) User clicks "Sign in with Google" → /auth/google
//    2) Google redirects back to /auth/google/callback
//    3) We verify the hosted-domain (hd) against ALLOWED_HD_DOMAINS
//    4) We look up the employee by email in our DB. If they don't exist,
//       sign-in is refused. (HR must add them via the seed script or
//       admin panel.) This is critical: it prevents random Gmail
//       accounts from submitting expenses.
//    5) On success we cache the employee record in the session.
// ====================================================================

const passport = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const { stmts } = require('../db');

function buildStrategy() {
  const clientID = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const callbackURL = `${process.env.APP_URL || 'http://localhost:3000'}/auth/google/callback`;

  if (!clientID || !clientSecret) {
    console.warn('[auth] Google OAuth credentials missing. Sign-in will not work until they are set in .env.');
  }

  return new GoogleStrategy(
    {
      clientID: clientID || 'unset',
      clientSecret: clientSecret || 'unset',
      callbackURL,
      passReqToCallback: false,
    },
    (accessToken, refreshToken, profile, done) => {
      try {
        const email = (profile.emails && profile.emails[0] && profile.emails[0].value || '').toLowerCase();
        const hd    = profile._json && profile._json.hd; // Google Workspace hosted domain

        if (!email) return done(null, false, { message: 'No email on Google profile.' });

        // The employee database IS the allowlist. Many staff legitimately
        // use Gmail/Yahoo accounts, so we do NOT hard-block on domain.
        // ALLOWED_HD_DOMAINS is retained only as an optional advisory and
        // is not enforced here — registration in the DB is what grants access.
        const employee = stmts.findEmployeeByEmail.get(email);
        if (!employee) {
          return done(null, false, { message: `${email} is not registered. Contact HR/Admin to be added to the portal.` });
        }

        return done(null, {
          id: employee.id,
          email: employee.email,
          name: employee.name,
          company: employee.company,
          level: employee.level,
          employee_code: employee.employee_code,
          designation: employee.designation,
          department: employee.department,
          manager_email: employee.manager_email,
        });
      } catch (err) {
        return done(err);
      }
    }
  );
}

function init() {
  passport.use('google', buildStrategy());
  passport.serializeUser((user, done) => done(null, user.email));
  passport.deserializeUser((email, done) => {
    try {
      const employee = stmts.findEmployeeByEmail.get(email);
      if (!employee) return done(null, false);
      done(null, {
        id: employee.id,
        email: employee.email,
        name: employee.name,
        company: employee.company,
        level: employee.level,
        employee_code: employee.employee_code,
        designation: employee.designation,
        department: employee.department,
        manager_email: employee.manager_email,
      });
    } catch (err) {
      done(err);
    }
  });
}

// Middleware: require an authenticated employee
function requireAuth(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  if (req.accepts('html')) return res.redirect('/login');
  return res.status(401).json({ error: 'Not authenticated' });
}

// Middleware: admin only
function requireAdmin(req, res, next) {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const admins = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!admins.includes(req.user.email.toLowerCase())) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

module.exports = { init, requireAuth, requireAdmin };
