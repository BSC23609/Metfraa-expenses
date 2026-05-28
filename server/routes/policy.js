// ====================================================================
//  ROUTES · /api/policy
// ====================================================================

const express = require('express');
const { publicPolicy } = require('../services/policy');
const { requireAuth } = require('../services/auth');

const router = express.Router();

// Return the policy for the current user's company only.
router.get('/me', requireAuth, (req, res) => {
  const p = publicPolicy(req.user.company);
  if (!p) return res.status(404).json({ error: 'Policy not configured for company' });
  res.json({ policy: p, level: req.user.level });
});

// (Optional) full policy for the company the user is in — same as /me
// but more semantic for the "Check Eligibility" page.
router.get('/:company', requireAuth, (req, res) => {
  if (req.params.company !== req.user.company) {
    return res.status(403).json({ error: 'Cannot view another company\'s policy.' });
  }
  const p = publicPolicy(req.params.company);
  if (!p) return res.status(404).json({ error: 'Policy not configured' });
  res.json({ policy: p, level: req.user.level });
});

module.exports = router;
