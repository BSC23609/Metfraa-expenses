// ====================================================================
//  ROUTES · /api/projects
//  Read-only list of ACTIVE projects, available to any authenticated
//  employee. Used to populate the Project dropdown on every form.
// ====================================================================
const express = require('express');
const { stmts } = require('../db');
const { requireAuth } = require('../services/auth');

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  res.json({ projects: stmts.listProjectsActive.all() });
});

module.exports = router;
