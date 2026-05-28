# Login Setup — Microsoft SSO + Google + Password

The portal supports three sign-in methods, picked automatically per employee by their email domain:

| Email domain | Method | Setup needed |
|---|---|---|
| `@metfraa.com` | **Microsoft 365 SSO** | Add a redirect URI + delegated permission to your Azure app (below) |
| `@gmail.com` | **Google SSO** | Google Cloud OAuth client (below) — skip if you have no Gmail users |
| anything else (Yahoo, etc.) | **Portal password** | Nothing — default `Metfraa@123`, user must change on first login |

Whichever method, the person must already exist in the employee list (seeded or added in the admin panel). The login page shows all three options; each employee just uses the one that applies to them.

---

## 1. Microsoft 365 SSO (for @metfraa.com staff)

You already created the **Metfraa-Reimbursements** app in Azure for OneDrive. It needs **two additions** to also handle login — you do NOT need a second app.

### a) Add the redirect URI

1. Azure Portal → **Microsoft Entra ID → App registrations → Metfraa-Reimbursements**.
2. Left menu → **Authentication → Add a platform → Web**.
3. **Redirect URI**:
   ```
   https://YOUR-RENDER-URL.onrender.com/auth/microsoft/callback
   ```
   (Later, when you switch to the custom domain, add `https://expenses.metfraa.com/auth/microsoft/callback` too — you can have both.)
4. Leave the other boxes unticked. **Save.**

### b) Add the sign-in permission

1. Same app → **API permissions → Add a permission → Microsoft Graph → Delegated permissions**.
2. Search and tick **`User.Read`** → Add.
3. Click **Grant admin consent for &lt;your org&gt;** so it shows a green check.

> Your app now has BOTH: the **application** `Files.ReadWrite.All` (OneDrive storage, app-only) and the **delegated** `User.Read` (employee sign-in). That's correct — they serve different purposes.

### c) Make sure the client secret is set

The same `MS_CLIENT_SECRET` you use for OneDrive is reused for login. If it's already in your environment, you're done. No new secret needed.

That's it — `@metfraa.com` staff can now click **Sign in with Microsoft**.

---

## 2. Google SSO (only if you have @gmail.com staff)

If you have no Gmail users, **skip this entirely** — leave `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` blank and the Google button just won't be used.

If you do:

1. **console.cloud.google.com** → create/select a project.
2. **APIs & Services → OAuth consent screen** → **External** (metfraa.com isn't Google Workspace) → fill app name + support email → save.
   - On the **Test users** step, add each Gmail address you'll allow (in testing mode Google only lets listed test users in — fine for a handful of people).
3. **APIs & Services → Credentials → Create Credentials → OAuth client ID → Web application**.
   - **Authorised JavaScript origins**: `https://YOUR-RENDER-URL.onrender.com`
   - **Authorised redirect URIs**: `https://YOUR-RENDER-URL.onrender.com/auth/google/callback`
4. Copy the Client ID + Secret → set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in Render.

---

## 3. Portal password (for everyone else)

Nothing to configure. When you seed employees or add a non-Microsoft/non-Google person:

- They get `auth_method = password` automatically.
- Their initial password is **`Metfraa@123`**.
- On first login they're **forced to set a new password** (min 8 chars, can't reuse the default).

### As an admin you can:

- **See each person's login method** as a badge in the Employees tab.
- **Reset a password** — Employees tab → "Reset PW" on a password user → it goes back to `Metfraa@123` and they must change it again next login.
- **Override the method** — in the Add/Edit employee form, the "Login Method" dropdown lets you force Microsoft / Google / Password instead of the auto choice. (Useful if, say, you give a Yahoo person a personal Gmail later — switch them to Google.)

---

## How employees experience it

The login page (`/login`) shows:
- **Sign in with Microsoft** button
- **Sign in with Google** button
- An **email + password** form below

Each person uses whichever matches their account. If a password user tries SSO (or vice-versa), they get a clear message telling them which button to use.

---

## Quick checklist before go-live

- [ ] Azure app: redirect URI `…/auth/microsoft/callback` added
- [ ] Azure app: delegated `User.Read` added + admin-consented
- [ ] `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET` set in Render
- [ ] (If Gmail users) Google OAuth client created, redirect URI set, creds in Render
- [ ] `APP_URL` in Render matches your actual URL exactly
- [ ] Seeded employees (`npm run seed`) — check a few have the right login method in the admin panel
- [ ] Test one of each: a Microsoft login, a password login (confirm the forced change works)
