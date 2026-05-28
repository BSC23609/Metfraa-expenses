// ====================================================================
//  ROUTES · /api/uploads
// ====================================================================
//  Two-phase upload model:
//   1) While filling the form, the user uploads bills. We store them
//      as `pending_uploads` keyed by a per-form `upload_token` (uuid
//      generated client-side on form open).
//   2) On submit, the client sends the upload_token along with the
//      form payload. We move pending uploads → permanent attachments
//      and link them to the new submission.
//
//   This decouples uploads from submission, so the user can attach
//   files at any time, in any order, and re-upload to replace.
// ====================================================================

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { stmts } = require('../db');
const { requireAuth } = require('../services/auth');
const { UPLOADS_DIR } = require('../config/paths');

const router = express.Router();

const UPLOAD_DIR = UPLOADS_DIR;
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const MAX_MB = parseInt(process.env.UPLOAD_MAX_MB || '10', 10);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '';
    const safe = crypto.randomBytes(8).toString('hex') + '_' + Date.now() + ext;
    cb(null, safe);
  },
});

const fileFilter = (req, file, cb) => {
  const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'];
  if (allowed.includes(file.mimetype.toLowerCase())) return cb(null, true);
  cb(new Error('Unsupported file type: ' + file.mimetype));
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_MB * 1024 * 1024 },
});

// POST /api/uploads — upload one or more files for a form-in-progress
router.post('/', requireAuth, upload.array('files', 20), (req, res) => {
  try {
    const uploadToken = (req.body.upload_token || '').trim();
    if (!uploadToken) return res.status(400).json({ error: 'upload_token required' });
    if (!req.files || !req.files.length) return res.status(400).json({ error: 'No files received' });

    const records = [];
    for (const f of req.files) {
      // Store the ABSOLUTE path. All resolvers handle absolute paths, so
      // this works whether uploads live in-repo or on a mounted disk.
      const info = stmts.insertPendingUpload.run({
        upload_token: uploadToken,
        employee_id: req.user.id,
        filename: f.originalname,
        stored_path: f.path,
        mime_type: f.mimetype,
        size_bytes: f.size,
      });
      records.push({
        id: info.lastInsertRowid,
        filename: f.originalname,
        mime_type: f.mimetype,
        size_bytes: f.size,
      });
    }

    res.json({ ok: true, uploads: records });
  } catch (err) {
    console.error('[upload]', err);
    res.status(500).json({ error: err.message || 'Upload failed' });
  }
});

// GET /api/uploads/:token — list pending uploads for a token (current user)
router.get('/:token', requireAuth, (req, res) => {
  const rows = stmts.listPendingByToken.all(req.params.token, req.user.id);
  res.json({ uploads: rows.map(r => ({
    id: r.id,
    filename: r.filename,
    mime_type: r.mime_type,
    size_bytes: r.size_bytes,
  })) });
});

// DELETE /api/uploads/:id — remove a pending upload (current user only)
router.delete('/:id', requireAuth, (req, res) => {
  const all = stmts.listPendingByToken.all(req.query.token || '', req.user.id);
  const target = all.find(r => r.id === parseInt(req.params.id, 10));
  if (!target) return res.status(404).json({ error: 'Not found' });
  try {
    const abs = path.isAbsolute(target.stored_path) ? target.stored_path : path.join(__dirname, '..', '..', target.stored_path);
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
  } catch (_) {}
  stmts.deletePending.run(target.id, req.user.id);
  res.json({ ok: true });
});

// Multer error handler
router.use((err, req, res, next) => {
  if (err) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `File too large. Max ${MAX_MB} MB per file.` });
    }
    return res.status(400).json({ error: err.message });
  }
  next();
});

module.exports = router;
