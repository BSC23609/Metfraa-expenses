// ====================================================================
//  ROUTES · /auth
// ====================================================================

const express = require('express');
const passport = require('passport');
const { stmts } = require('../db');
const router = express.Router();

router.get('/google',
  passport.authenticate('google', { scope: ['profile', 'email'], prompt: 'select_account' })
);

router.get('/google/callback', (req, res, next) => {
  passport.authenticate('google', (err, user, info) => {
    if (err) return next(err);
    if (!user) {
      const reason = info && info.message ? info.message : 'Login failed';
      return res.redirect('/login?error=' + encodeURIComponent(reason));
    }
    req.logIn(user, (loginErr) => {
      if (loginErr) return next(loginErr);
      try {
        stmts.insertAudit.run({
          actor_email: user.email,
          action: 'LOGIN',
          target_type: null,
          target_id: null,
          meta_json: null,
          ip_address: req.ip,
        });
      } catch (_) {}
      res.redirect('/');
    });
  })(req, res, next);
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
      name: req.user.name,
      email: req.user.email,
      company: req.user.company,
      level: req.user.level,
      employee_code: req.user.employee_code,
      designation: req.user.designation,
      department: req.user.department,
    }
  });
});

module.exports = router;
