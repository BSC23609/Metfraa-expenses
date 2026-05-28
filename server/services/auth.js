// ====================================================================
//  AUTH · Microsoft SSO + Google SSO + portal password
// ====================================================================
//  Three ways an employee can sign in — all resolve to a row in the
//  employees table (the DB is the allowlist):
//
//    • Microsoft 365  → @metfraa.com staff (reuses the existing Azure
//                       "Metfraa-Reimbursements" app registration)
//    • Google         → @gmail.com staff
//    • Password       → anyone who can't SSO (e.g. Yahoo users). Admin
//                       sets the password; bcrypt-hashed; first login
//                       forces a change off the shared default.
//
//  Whichever method is used, we match the verified email against the
//  employee list and cache that record in the session.
// ====================================================================

const passport = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const { Strategy: MicrosoftStrategy } = require('passport-microsoft');
const { Strategy: LocalStrategy } = require('passport-local');
const bcrypt = require('bcryptjs');
const { stmts } = require('../db');

const APP_URL = () => (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');

// Pick the default sign-in method for an email by its domain.
function authMethodForEmail(email) {
  const d = (email.split('@')[1] || '').toLowerCase();
  if (d === 'gmail.com' || d === 'googlemail.com') return 'google';
  if (d === 'metfraa.com') return 'microsoft';
  // everything else (yahoo, etc.) defaults to password
  return 'password';
}

// Shape the employee row into the session user object.
function toSessionUser(e) {
  return {
    id: e.id,
    email: e.email,
    name: e.name,
    company: e.company,
    level: e.level,
    employee_code: e.employee_code,
    designation: e.designation,
    department: e.department,
    manager_email: e.manager_email,
    auth_method: e.auth_method,
    must_change_pw: e.must_change_pw,
  };
}

// Resolve a verified email to an employee, enforcing the allowlist.
function resolveEmployee(email, done, expectedMethods) {
  const e = stmts.findEmployeeByEmail.get(email);
  if (!e) return done(null, false, { message: `${email} is not registered. Contact Admin to be added to the portal.` });
  // Optional: ensure the SSO method matches what's configured for them.
  if (expectedMethods && !expectedMethods.includes(e.auth_method)) {
    // Allow it anyway (don't lock people out over a method mismatch), but
    // SSO is only reachable for matching domains in practice.
  }
  return done(null, toSessionUser(e));
}

// ---- Google ----
function googleStrategy() {
  return new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID || 'unset',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || 'unset',
      callbackURL: `${APP_URL()}/auth/google/callback`,
    },
    (accessToken, refreshToken, profile, done) => {
      try {
        const email = (profile.emails && profile.emails[0] && profile.emails[0].value || '').toLowerCase();
        if (!email) return done(null, false, { message: 'No email on Google profile.' });
        return resolveEmployee(email, done, ['google']);
      } catch (err) { return done(err); }
    }
  );
}

// ---- Microsoft ----
function microsoftStrategy() {
  return new MicrosoftStrategy(
    {
      clientID: process.env.MS_CLIENT_ID || 'unset',
      clientSecret: process.env.MS_CLIENT_SECRET || 'unset',
      callbackURL: `${APP_URL()}/auth/microsoft/callback`,
      // Use the tenant-specific authority so only your org can sign in.
      tenant: process.env.MS_TENANT_ID || 'common',
      authorizationURL: `https://login.microsoftonline.com/${process.env.MS_TENANT_ID || 'common'}/oauth2/v2.0/authorize`,
      tokenURL: `https://login.microsoftonline.com/${process.env.MS_TENANT_ID || 'common'}/oauth2/v2.0/token`,
      scope: ['user.read'],
    },
    (accessToken, refreshToken, profile, done) => {
      try {
        const email = (
          (profile.emails && profile.emails[0] && profile.emails[0].value) ||
          (profile._json && (profile._json.mail || profile._json.userPrincipalName)) || ''
        ).toLowerCase();
        if (!email) return done(null, false, { message: 'No email on Microsoft profile.' });
        return resolveEmployee(email, done, ['microsoft']);
      } catch (err) { return done(err); }
    }
  );
}

// ---- Local (email + password) ----
function localStrategy() {
  return new LocalStrategy(
    { usernameField: 'email', passwordField: 'password' },
    (email, password, done) => {
      try {
        const e = stmts.findEmployeeByEmail.get((email || '').toLowerCase());
        if (!e) return done(null, false, { message: 'No account found for that email.' });
        if (e.auth_method !== 'password' || !e.password_hash) {
          const how = e.auth_method === 'google' ? 'Sign in with Google' : 'Sign in with Microsoft';
          return done(null, false, { message: `This account uses SSO. Use "${how}" instead.` });
        }
        if (!bcrypt.compareSync(password, e.password_hash)) {
          return done(null, false, { message: 'Incorrect password.' });
        }
        return done(null, toSessionUser(e));
      } catch (err) { return done(err); }
    }
  );
}

function init() {
  passport.use('google', googleStrategy());
  passport.use('microsoft', microsoftStrategy());
  passport.use('local', localStrategy());

  passport.serializeUser((user, done) => done(null, user.id));
  passport.deserializeUser((id, done) => {
    try {
      const e = stmts.getEmployeeById.get(id);
      if (!e || !e.is_active) return done(null, false);
      done(null, toSessionUser(e));
    } catch (err) { done(err); }
  });
}

// ---- password helpers (used by admin routes) ----
function hashPassword(plain) { return bcrypt.hashSync(plain, 10); }

// ---- middleware ----
function requireAuth(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) {
    // Force password change before allowing any other action.
    if (req.user.must_change_pw && !req.path.startsWith('/auth')) {
      if (req.accepts('html')) return res.redirect('/login?change=1');
      return res.status(403).json({ error: 'password_change_required' });
    }
    return next();
  }
  if (req.accepts('html')) return res.redirect('/login');
  return res.status(401).json({ error: 'Not authenticated' });
}

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

module.exports = { init, requireAuth, requireAdmin, hashPassword, authMethodForEmail, toSessionUser };
