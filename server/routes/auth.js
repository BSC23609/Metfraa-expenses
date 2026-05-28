// ====================================================================
//  ROUTES · /auth
// ====================================================================

const express = require('express');
const passport = require('passport');
const { stmts } = require('../db');
const { hashPassword } = require('../services/auth');
const router = express.Router();

function auditLogin(req, user) {
  try {
    stmts.insertAudit.run({
      actor_email: user.email, action: 'LOGIN',
      target_type: null, target_id: null,
      meta_json: JSON.stringify({ method: user.auth_method }), ip_address: req.ip,
    });
  } catch (_) {}
}

function finishLogin(req, res, user) {
  req.logIn(user, (err) => {
    if (err) return res.redirect('/login?error=' + encodeURIComponent('Login failed'));
    auditLogin(req, user);
    if (user.must_change_pw) return res.redirect('/login?change=1');
    res.redirect('/');
  });
}

// ---- Google SSO ----
router.get('/google', passport.authenticate('google', { scope: ['profile', 'email'], prompt: 'select_account' }));
router.get('/google/callback', (req, res, next) => {
  passport.authenticate('google', (err, user, info) => {
    if (err) return next(err);
    if (!user) return res.redirect('/login?error=' + encodeURIComponent(info && info.message || 'Login failed'));
    finishLogin(req, res, user);
  })(req, res, next);
});

// ---- Microsoft SSO ----
router.get('/microsoft', passport.authenticate('microsoft', { prompt: 'select_account' }));
router.get('/microsoft/callback', (req, res, next) => {
  passport.authenticate('microsoft', (err, user, info) => {
    if (err) return next(err);
    if (!user) return res.redirect('/login?error=' + encodeURIComponent(info && info.message || 'Login failed'));
    finishLogin(req, res, user);
  })(req, res, next);
});

// ---- Local password login ----
router.post('/local', (req, res, next) => {
  passport.authenticate('local', (err, user, info) => {
    if (err) return next(err);
    if (!user) return res.status(401).json({ error: info && info.message || 'Login failed' });
    req.logIn(user, (loginErr) => {
      if (loginErr) return res.status(500).json({ error: 'Login failed' });
      auditLogin(req, user);
      res.json({ ok: true, must_change_pw: !!user.must_change_pw });
    });
  })(req, res, next);
});

// ---- Change own password (for password-auth users) ----
router.post('/change-password', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  const { new_password } = req.body || {};
  if (req.user.auth_method !== 'password') {
    return res.status(400).json({ error: 'Your account uses SSO; there is no portal password to change.' });
  }
  if (!new_password || String(new_password).length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  if (String(new_password) === 'Metfraa@123') {
    return res.status(400).json({ error: 'Please choose a password different from the default.' });
  }
  stmts.setPassword.run({ id: req.user.id, hash: hashPassword(String(new_password)), must_change: 0 });
  stmts.clearMustChange.run(req.user.id);
  // refresh session copy
  req.user.must_change_pw = 0;
  try {
    stmts.insertAudit.run({ actor_email: req.user.email, action: 'PASSWORD_CHANGE', target_type: 'employee', target_id: req.user.id, meta_json: null, ip_address: req.ip });
  } catch (_) {}
  res.json({ ok: true });
});

router.post('/logout', (req, res, next) => {
  req.logout(err => {
    if (err) return next(err);
    req.session.destroy(() => res.redirect('/login'));
  });
});

router.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ authenticated: false });
  res.json({
    authenticated: true,
    user: {
      name: req.user.name, email: req.user.email, company: req.user.company,
      level: req.user.level, employee_code: req.user.employee_code,
      designation: req.user.designation, department: req.user.department,
      auth_method: req.user.auth_method, must_change_pw: !!req.user.must_change_pw,
    }
  });
});

module.exports = router;
