# Bharat Steel Group · Expense & Conveyance Portal

A multi-company employee expense submission portal for **The Bharat Steel Group**, covering:

- **Bharat Steel (Chennai) Pvt. Ltd.** — Local conveyance, outstation expense reimbursement
- **Metfraa Steel Buildings Pvt. Ltd.** — Local travel, cab pre-approval, monthly accommodation, outstation travel

Employees sign in with their company Google Workspace account, fill out the appropriate form, attach bills, and submit. The portal then:

1. Validates the submission against the policy (rates, daily caps, eligible modes)
2. Generates a polished, branded PDF report with every bill embedded as preview pages
3. Emails the PDF + original bill files to the company's HR mailbox
4. Stores everything in a local SQLite database (audit trail + employee history)

---

## What's in the box

```
bsg-portal/
├─ server/                    Node.js + Express backend
│  ├─ index.js                Entry point
│  ├─ db/                     SQLite schema, prepared statements, seed script
│  ├─ services/               Auth (Google OAuth), policy, PDF, email, validators
│  └─ routes/                 /auth, /api/policy, /api/uploads, /api/submissions, /api/admin
├─ public/                    Frontend (vanilla JS, no build step)
│  ├─ login.html
│  ├─ app.html
│  ├─ css/app.css
│  ├─ js/app.js
│  ├─ js/policy-renderer.js
│  └─ assets/                 Group + company logos
├─ data/                      SQLite databases (created at runtime)
├─ uploads/                   Bill uploads + generated PDF reports
├─ package.json
└─ .env.example               Copy to .env and fill in
```

---

## Deployment guide

### 1. Requirements

- **Node.js ≥ 18** (LTS is recommended; tested on Node 18, 20)
- A server / VPS reachable on a public HTTPS URL (Render, Railway, DigitalOcean droplet, Hetzner, etc.)
- A Google Cloud project for OAuth 2.0 credentials
- An SMTP provider for outbound email (Gmail with app password, Resend, SendGrid, Postmark, your own server)

### 2. Install

```bash
git clone <this repo> bsg-portal
cd bsg-portal
npm install
cp .env.example .env
# Edit .env with your real values (see "Configuration" below)
```

> If `npm install` fails on `better-sqlite3` with a native-build error, ensure you have `build-essential` (Debian/Ubuntu) or `xcode-select --install` (macOS). On most managed hosts (Render/Railway) this Just Works.

### 3. Configure (`.env`)

Open `.env` and fill in:

| Key | What it is | How to get it |
|---|---|---|
| `APP_URL` | Public URL of the portal (no trailing slash) | e.g. `https://expenses.bharatsteels.in` |
| `SESSION_SECRET` | Random secret for signing session cookies | Run `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | OAuth 2.0 credentials | See Google OAuth section below |
| `ALLOWED_HD_DOMAINS` | Comma-separated list of allowed Workspace domains | `bharatsteels.in,metfraa.com` |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | SMTP server details | See "Email setup" below |
| `SMTP_FROM_NAME` / `SMTP_FROM_EMAIL` | Sender shown in HR's inbox | `Bharat Steel Group Portal` / `portal@bharatsteels.in` |
| `BSC_HR_EMAIL` / `BSC_EA_EMAIL` | Bharat Steel HR routing | `hr@bharatsteels.in`, `ea@bharatsteels.in` |
| `METFRAA_HR_EMAIL` | Metfraa HR routing | `admin@metfraa.com` |
| `ADMIN_EMAILS` | Comma-separated emails that can access `/api/admin/*` | `admin@metfraa.com,hr@metfraa.com,info@metfraa.com,arasu@metfraa.com` |

### 4. Google OAuth credentials

1. Open <https://console.cloud.google.com/apis/credentials>
2. Create a project (or pick an existing one)
3. **OAuth consent screen** → Internal (if both your domains are in one Workspace org) or External
   - App name: `Bharat Steel Group Expense Portal`
   - Authorized domains: `bharatsteels.in`, `metfraa.com`
   - Scopes: `userinfo.email`, `userinfo.profile`
4. **Credentials** → Create credentials → **OAuth client ID** → Web application
   - Authorised JavaScript origin: `https://expenses.bharatsteels.in`
   - Authorised redirect URI: `https://expenses.bharatsteels.in/auth/google/callback` (must match `APP_URL` exactly)
5. Copy the **Client ID** and **Client Secret** into `.env`

### 5. Email setup (SMTP)

Pick one of:

**Option A — Gmail / Google Workspace** (easiest for small teams)
- Enable 2-factor authentication on the sender account
- Create an [App Password](https://myaccount.google.com/apppasswords)
- Use:
  ```
  SMTP_HOST=smtp.gmail.com
  SMTP_PORT=587
  SMTP_SECURE=false
  SMTP_USER=portal@bharatsteels.in
  SMTP_PASS=<16-char app password>
  ```

**Option B — Resend** (recommended for production)
- Sign up at [resend.com](https://resend.com), verify your domain
- Create an API key
- Use:
  ```
  SMTP_HOST=smtp.resend.com
  SMTP_PORT=587
  SMTP_SECURE=false
  SMTP_USER=resend
  SMTP_PASS=<your-resend-api-key>
  ```

**Option C — Office 365 / your own server**
- Use the host/port/user/pass your IT team provides

### 6. Load employees

The portal only allows sign-ins by employees who exist in its database. You have two options:

**Option A — Demo data (for testing)**
```bash
npm run seed
```
This adds 6 dummy employees (3 BSC, 3 Metfraa) so you can verify the flow.

**Option B — Real employees (CSV)**

Create a CSV with this header row:
```
email,name,employee_code,company,level,designation,department,manager_email
```

Example:
```csv
email,name,employee_code,company,level,designation,department,manager_email
rajesh.kumar@bharatsteels.in,Rajesh Kumar,BSC-0001,bsc,CAT1,General Manager,Sales,hr@bharatsteels.in
priya.shankar@bharatsteels.in,Priya Shankar,BSC-0042,bsc,CAT2,Site Supervisor,Operations,hr@bharatsteels.in
vikram.iyer@metfraa.com,Vikram Iyer,MET-0007,metfraa,L3,Project Manager,PEB Projects,admin@metfraa.com
deepa.menon@metfraa.com,Deepa Menon,MET-0024,metfraa,L2,Site Engineer,Engineering,admin@metfraa.com
suresh.babu@metfraa.com,Suresh Babu,MET-0089,metfraa,L1,Junior Technician,Fabrication,admin@metfraa.com
```

Valid values:

- `company`: `bsc` | `metfraa`
- `level` (BSC): `CAT1` (remuneration > ₹50k) | `CAT2` (remuneration ≤ ₹50k)
- `level` (Metfraa): `L1` | `L2` | `L3`

Load it:
```bash
npm run seed -- /path/to/employees.csv
```

Re-running the seed is safe — existing employees are updated (matched by email), new ones are inserted.

### 7. Run

```bash
npm start
# or, for auto-reload during development:
npm run dev
```

The server starts on `PORT` (default 3000). Reverse-proxy it through Nginx/Caddy/Traefik so it's reachable at your `APP_URL` over HTTPS.

**Example Caddy config:**
```
expenses.bharatsteels.in {
  reverse_proxy localhost:3000
}
```

### 8. Verify

1. Open `https://expenses.bharatsteels.in`
2. Click "Sign in with Google" and use a seeded employee's Google account
3. You should land on the portal home page with your company tile enabled
4. Submit a test form with a few line items and a bill image
5. Check that HR receives the email with PDF + raw files attached

---

## Admin panel

Admins (the emails in `ADMIN_EMAILS`) see an **Admin Panel** link in the user menu (top-right). It lets you:

- **View** all employees (active + inactive toggle), with search by name/email/designation/code
- **Add** a new employee — name, email, level (Junior/Senior/Manager), designation, department, code, manager email
- **Edit** any employee's details or level
- **Deactivate** an employee (soft delete — they can no longer sign in, but all their past submissions are retained). Deactivated employees can be reactivated anytime.

Currently the four admin accounts are: `admin@metfraa.com`, `hr@metfraa.com`, `info@metfraa.com`, `arasu@metfraa.com`. Change the list in `.env` → `ADMIN_EMAILS` and restart.

Every add/edit/deactivate is written to the audit log.

> **On levels:** the UI uses Junior / Senior / Manager, which map to the policy tiers **L1 / L2 / L3** respectively. Entitlements: Junior (L1) ₹1000/day accommodation, Sleeper, ₹250/day food · Senior (L2) ₹1250/day, Sleeper, ₹350/day · Manager (L3) ₹1500/day, 3AC, ₹500/day.

> **On shared mailboxes:** several Metfraa accounts share a mailbox (e.g. `admin@`, `accounts@`, `hr@`). The portal allows this — login resolves to the registered employee for that email. If two different people genuinely share one address, only one portal identity exists for it, and submissions attribute to that record. Give people distinct emails if you need separate attribution.

> **Sign-in is gated by the employee database, not by email domain.** Staff on Gmail/Yahoo (e.g. `lrajasekar1984@gmail.com`) can sign in fine, as long as they're in the employee list. Anyone not in the list is refused at login with a "contact HR/Admin" message.

---

## Loading the Metfraa employees

The roster is built in. Just run:

```bash
npm run seed
```

This loads all 31 Metfraa employees (PALANINATHAL was removed — shared `accounts@` with SATHYA). Re-running is safe; existing employees are skipped.

To load from the editable CSV instead (e.g. after you update it):

```bash
npm run seed -- metfraa-employees.csv
```

The CSV's `level` column accepts `JUNIOR` / `SENIOR` / `MANAGER` (or `L1`/`L2`/`L3` directly).

---

All rates, caps, and eligibility rules live in **one file**: `server/services/policy.js`.

If HR revises the policy:
1. Edit the values in `policy.js`
2. Restart the server
3. The frontend pulls fresh policy data on every login

No code changes elsewhere are needed — the validators, PDF generator, and "Check Eligibility" page all read from the same module.

---

## Adding new employees

After deployment, you have three options:

1. Re-run the seed with an updated CSV (`npm run seed -- employees.csv`)
2. Use the admin API:
   ```bash
   curl -X POST https://expenses.bharatsteels.in/api/admin/employees \
        -H "Cookie: connect.sid=…" \
        -H "Content-Type: application/json" \
        -d '{"email":"new@bharatsteels.in","name":"New Hire","company":"bsc","level":"CAT2","designation":"Executive","department":"Sales"}'
   ```
3. (Future) Build an admin UI on top of `/api/admin/*` if you want a click-through interface.

---

## OneDrive storage + approval workflow

This portal mirrors everything to OneDrive under `admin@metfraa.com` and runs an admin approval step.

### How a claim flows

1. **Employee submits** → validated → saved to the database as **Pending** → raw bills pushed to OneDrive, and a row appended to the employee's Excel log. **No report PDF yet.**
2. **Admin opens the panel** → sees the claim under **Pending Approvals** → can **View** a draft report (generated on demand).
3. **Admin approves** → the final report PDF is generated, the uploaded bills are **merged into that same PDF** (images as pages, uploaded PDFs appended in full), and it's stored in the employee's `Reports/` folder. Status flips to **Approved** and the Excel row updates.
4. **Admin rejects** → status becomes **Rejected**, the Excel row updates with the optional reason. No report is stored.

Excel logs are written in **either** case (pending, approved, rejected). The merged report PDF is produced **only on approval**.

### OneDrive folder structure (under `admin@metfraa.com`)

```
Reimbursements and Conveyance/
└─ <Employee Name> (<Code>)/
   ├─ <Employee>_Log.xlsx      <- every entry, any status
   ├─ Uploads/                 <- raw bills (named <Reference>__<original filename>)
   └─ Reports/                 <- <Reference>.pdf (report + bills merged), on approval
```

### Azure app registration (one-time)

The server writes to OneDrive using **application** (app-only) Graph permissions — no interactive Microsoft login at runtime.

1. **Azure Portal → Microsoft Entra ID → App registrations → New registration**. Name it e.g. "Metfraa Expense Portal". Single tenant is fine.
2. Copy the **Application (client) ID** and **Directory (tenant) ID** → `MS_CLIENT_ID` and `MS_TENANT_ID`.
3. **Certificates & secrets → New client secret** → copy the **Value** (not the ID) → `MS_CLIENT_SECRET`.
4. **API permissions → Add a permission → Microsoft Graph → Application permissions → `Files.ReadWrite.All`**, then **Grant admin consent**. (Application permission, not delegated — this lets the server write files with no user signed in.)
5. Set `ONEDRIVE_TARGET_USER=admin@metfraa.com` and `ONEDRIVE_ROOT_FOLDER=Reimbursements and Conveyance` in `.env`.

> **Scope note:** `Files.ReadWrite.All` is broad (all users' drives in the tenant). To limit it, apply an **application access policy** scoping the app to `admin@metfraa.com` only. The portal only ever touches the `ONEDRIVE_TARGET_USER` drive, so scoping won't break anything.

### Fail-soft behaviour

If OneDrive is briefly unreachable (expired token, outage, throttling), submissions and approvals **still succeed** — the database is the source of truth. Each item tracks whether its log/uploads/report synced, and a **background retry** (every `ONEDRIVE_RETRY_MINUTES`, default 15) re-attempts anything that didn't.

If `MS_*` credentials are left blank, the portal runs normally with OneDrive disabled — handy for testing before Azure is set up.

---

## Database

SQLite, file-based at `data/portal.db`. To inspect:

```bash
sqlite3 data/portal.db
sqlite> .tables
sqlite> SELECT reference, total_amount, status, submitted_at FROM submissions ORDER BY id DESC LIMIT 10;
```

**Backup strategy:** just back up the `data/` folder. The DB uses WAL mode, so copying it while the server runs is safe — but for a clean backup, run `sqlite3 data/portal.db ".backup data/portal.backup.db"`.

To migrate to PostgreSQL later: write a small script that reads from SQLite via `better-sqlite3` and writes to PG. Schema is already normalised for that.

---

## Security checklist

- [x] HTTPS only (handled by your reverse proxy / hosting platform)
- [x] Sessions are HTTP-only, SameSite=Lax cookies
- [x] All form submissions are re-validated server-side (rates are NEVER trusted from the client)
- [x] Sign-in restricted to whitelisted Workspace domains AND to employees who exist in the DB
- [x] PDF generation is sandboxed — no user-supplied HTML rendering
- [x] File uploads filtered by MIME (JPG/PNG/WEBP/HEIC/PDF) and size-capped
- [x] Audit log of every login + submission

---

## Folder structure quick-reference

| Path | Purpose |
|---|---|
| `server/index.js` | Express bootstrap |
| `server/db/index.js` | DB schema + prepared statements |
| `server/db/seed.js` | Employee bootstrap (CSV or demo) |
| `server/services/policy.js` | **Single source of truth** for rates/caps |
| `server/services/auth.js` | Passport + Google OAuth |
| `server/services/validators.js` | Per-form validation |
| `server/services/pdf.js` | PDF generation with bill previews |
| `server/services/email.js` | Nodemailer wrapper |
| `server/routes/*.js` | HTTP endpoints |
| `public/login.html` | Sign-in page |
| `public/app.html` | Main SPA shell |
| `public/js/app.js` | Frontend app logic |
| `public/js/policy-renderer.js` | "Check Eligibility" page |
| `public/css/app.css` | Design system |

---

## Future enhancements you might want

These are intentionally out of scope of v1 but the codebase is structured to make them easy:

- **HR approval workflow** — currently submissions are emailed but stay `status='submitted'`. Add an HR-facing UI that calls `/api/admin/submissions` and lets HR mark approved/rejected.
- **Slack / Teams notifications** — drop a webhook call into `routes/submissions.js` after email dispatch.
- **S3 / R2 storage** — swap `multer-disk-storage` for `multer-s3` in `routes/uploads.js`, and update `services/pdf.js` to stream images via signed URLs.
- **Postgres migration** — change `db/index.js` to use `pg` instead of `better-sqlite3`. Schema is portable.
- **Multi-currency / branch offices** — extend the policy module to be keyed by `(company, branch)` instead of just `company`.
- **Mobile app** — the API is REST-clean and could be consumed by a React Native or Flutter app with very little change.

---

## License

Internal use only — The Bharat Steel Group.
