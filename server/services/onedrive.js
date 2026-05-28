// ====================================================================
//  ONEDRIVE SERVICE · Microsoft Graph (app-only / client credentials)
// ====================================================================
//  Stores files under a target user's OneDrive:
//
//    Reimbursements and Conveyance/
//      <Employee Name>/
//        <Employee>_Log.xlsx      (entry log — every submission, any status)
//        Uploads/                 (raw bills, on submit)
//        Reports/                 (final merged PDF, on approval)
//
//  Auth: client-credentials flow. Requires an Azure app registration with
//  APPLICATION permission Files.ReadWrite.All (admin-consented). All calls
//  target the drive of ONEDRIVE_TARGET_USER (e.g. admin@metfraa.com).
//
//  This module is intentionally fail-soft: if OneDrive is unreachable, the
//  caller logs the error against the submission and the app keeps working.
//  A background retry (server/index.js) re-attempts unsynced items.
// ====================================================================

const https = require('https');

const TENANT       = () => process.env.MS_TENANT_ID;
const CLIENT_ID    = () => process.env.MS_CLIENT_ID;
const CLIENT_SECRET= () => process.env.MS_CLIENT_SECRET;
const TARGET_USER  = () => process.env.ONEDRIVE_TARGET_USER || 'admin@metfraa.com';
const ROOT_FOLDER  = () => process.env.ONEDRIVE_ROOT_FOLDER || 'Reimbursements and Conveyance';

const GRAPH = 'https://graph.microsoft.com/v1.0';

function isConfigured() {
  return !!(TENANT() && CLIENT_ID() && CLIENT_SECRET());
}

// ---- token cache ---------------------------------------------------
let _token = null;
let _tokenExpiry = 0;

async function getToken() {
  if (_token && Date.now() < _tokenExpiry - 60000) return _token;
  if (!isConfigured()) throw new Error('OneDrive not configured (MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET missing)');

  const body = new URLSearchParams({
    client_id: CLIENT_ID(),
    client_secret: CLIENT_SECRET(),
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  }).toString();

  const res = await rawRequest({
    method: 'POST',
    host: 'login.microsoftonline.com',
    path: `/${TENANT()}/oauth2/v2.0/token`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
  }, body);

  const json = JSON.parse(res.body);
  if (!json.access_token) throw new Error('Graph token error: ' + (json.error_description || res.body).slice(0, 200));
  _token = json.access_token;
  _tokenExpiry = Date.now() + (json.expires_in || 3600) * 1000;
  return _token;
}

// ---- low-level HTTPS helper ---------------------------------------
function rawRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ---- Graph request wrapper ----------------------------------------
async function graph(method, path, { json, buffer, contentType, query } = {}) {
  const token = await getToken();
  let body = null, headers = { Authorization: `Bearer ${token}` };
  if (json !== undefined) { body = JSON.stringify(json); headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(body); }
  else if (buffer !== undefined) { body = buffer; headers['Content-Type'] = contentType || 'application/octet-stream'; headers['Content-Length'] = body.length; }

  const fullPath = path.startsWith('http') ? path : `/v1.0${path}${query ? '?' + query : ''}`;
  const host = 'graph.microsoft.com';

  const res = await rawRequest({ method, host, path: fullPath, headers }, body);
  const text = res.body.toString('utf8');
  if (res.status >= 200 && res.status < 300) {
    return text ? JSON.parse(text) : {};
  }
  // 404 is meaningful (folder/file not found) — let caller decide
  const err = new Error(`Graph ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  err.status = res.status;
  throw err;
}

// Build the Graph "drive path" prefix for the target user
function driveRoot() {
  return `/users/${encodeURIComponent(TARGET_USER())}/drive`;
}

// Encode a OneDrive item path for the :/path: addressing scheme
function encodePath(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}

// ---- folder management --------------------------------------------
// Ensure a nested folder path exists (creates each segment as needed).
async function ensureFolder(relPath) {
  const segments = relPath.split('/').filter(Boolean);
  let parentPath = ''; // relative to drive root
  for (const seg of segments) {
    const tryPath = parentPath ? `${parentPath}/${seg}` : seg;
    try {
      await graph('GET', `${driveRoot()}/root:/${encodePath(tryPath)}`);
    } catch (e) {
      if (e.status === 404) {
        // create under parent
        const parentRef = parentPath
          ? `${driveRoot()}/root:/${encodePath(parentPath)}:/children`
          : `${driveRoot()}/root/children`;
        await graph('POST', parentRef, {
          json: { name: seg, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' },
        }).catch(err => { if (err.status !== 409) throw err; }); // 409 = already exists (race)
      } else if (e.status !== 409) {
        throw e;
      }
    }
    parentPath = tryPath;
  }
  return parentPath;
}

// Sanitize a name for use as a OneDrive folder (no \ / : * ? " < > |)
function safeName(name) {
  return String(name || 'Unknown').replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function employeeFolder(employee) {
  const label = `${safeName(employee.name)}${employee.employee_code ? ' (' + safeName(employee.employee_code) + ')' : ''}`;
  return `${ROOT_FOLDER()}/${label}`;
}

// ---- file upload (simple, <4MB) and chunked (large) ---------------
async function uploadFile(relFolder, filename, buffer, contentType) {
  await ensureFolder(relFolder);
  const itemPath = `${relFolder}/${safeName(filename)}`;
  if (buffer.length <= 4 * 1024 * 1024) {
    return graph('PUT', `${driveRoot()}/root:/${encodePath(itemPath)}:/content`, { buffer, contentType });
  }
  // Large file → upload session
  const session = await graph('POST', `${driveRoot()}/root:/${encodePath(itemPath)}:/createUploadSession`, {
    json: { item: { '@microsoft.graph.conflictBehavior': 'replace' } },
  });
  const uploadUrl = session.uploadUrl;
  const CHUNK = 5 * 1024 * 1024;
  for (let start = 0; start < buffer.length; start += CHUNK) {
    const end = Math.min(start + CHUNK, buffer.length);
    const slice = buffer.slice(start, end);
    const u = new URL(uploadUrl);
    const res = await rawRequest({
      method: 'PUT', host: u.host, path: u.pathname + u.search,
      headers: {
        'Content-Length': slice.length,
        'Content-Range': `bytes ${start}-${end - 1}/${buffer.length}`,
      },
    }, slice);
    if (res.status >= 400) throw new Error(`Chunk upload failed: ${res.status}`);
  }
  return { ok: true };
}

// ---- shareable link (read-only) for a stored item -----------------
async function createViewLink(itemPath) {
  try {
    const res = await graph('POST', `${driveRoot()}/root:/${encodePath(itemPath)}:/createLink`, {
      json: { type: 'view', scope: 'organization' },
    });
    return res.link ? res.link.webUrl : null;
  } catch (_) { return null; }
}

module.exports = {
  isConfigured,
  ensureFolder,
  uploadFile,
  createViewLink,
  employeeFolder,
  safeName,
  graph,
  driveRoot,
  encodePath,
  TARGET_USER,
  ROOT_FOLDER,
};
