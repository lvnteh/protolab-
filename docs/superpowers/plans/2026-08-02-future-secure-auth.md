# FUTURE: Secure Authentication & Registration (Admins + Viewers)

> **Status:** Deferred. Captured 2026-08-02 at product request. Design doc:
> `docs/superpowers/specs/2026-08-02-secure-auth-design.md`. SSO (OIDC) is the
> chosen end-state for both admins and viewers; the phases below land
> self-contained hardening first so SSO drops in without a rewrite.
>
> **For agentic workers:** Use `superpowers:subagent-driven-development` or
> `superpowers:executing-plans` when this is picked up. Each phase is
> independently shippable and ordered by (risk reduced ÷ effort). Steps use
> checkbox syntax. Re-verify every file:line against current code first — this
> plan was written against the 2026-08-02 tree.

**Goal:** Move both audiences from "typed email = identity" (viewers) and
"password only" (admins) to verified, SSO-ready authentication.

**Prerequisite context:** org multi-tenancy shipped; sessions in Postgres; CSRF
+ shared rate-limiters live. See design doc for the full as-built trace.

---

## Phase 0 — No-infra hardening (do first; no email, no IdP)

### Task 0.1: Remove the fake client-side lock
**Files:** Modify `src/views/landing.html` (~line 50-73, the `magiclvnte` script + overlay).
- [ ] Delete the `__lock-overlay` markup and the inline `magiclvnte` script. It is
  a plaintext shared secret in client JS (bypassable via devtools) that provides
  false confidence. If a gate on the landing page is genuinely wanted, it must be
  server-side (defer to Phase 4 SSO or a simple server basic-auth env gate).
- [ ] Manually verify the landing page renders with no overlay.
- [ ] Commit: `chore(landing): remove bypassable client-side magiclvnte lock`.

### Task 0.2: Password strength policy
**Files:** Modify `src/routes/admin.js` (POST `/signup`, ~line 108-110); Test `tests/admin.test.js`.
- [ ] Failing test: signup with an 8-char weak password is rejected once policy is min 12.
- [ ] Raise min length 8 → 12; reject passwords equal to the email local-part or
  containing "protolab"/"password". (Optional, later: HIBP k-anonymity range check
  behind a config flag + `mailer`-style dev bypass.)
- [ ] Test passes; commit: `feat(auth): stronger password policy on signup`.

### Task 0.3: Session hardening — rotation, idle + absolute expiry
**Files:** Modify `src/server.js` (sessionOptions, ~line 41-47); `src/routes/admin.js` (login, ~line 77).
- [ ] On successful login, call `req.session.regenerate()` before setting
  `userId`/`activeOrgId` (prevents session fixation). Note: logout already
  destroys + clears cookie (shipped 2026-07-30, `POST /admin/logout`).
- [ ] Set `cookie.maxAge` (absolute, e.g. 12h) and enable `rolling: true` for
  idle-timeout semantics. Confirm connect-pg-simple prunes expired rows.
- [ ] Test: session cookie carries `Max-Age`; a regenerated session id differs
  from the pre-login id. Commit: `feat(auth): rotate session on login, add expiry`.

### Task 0.4: Per-account lockout (augments per-IP limit)
**Files:** New `auth_events` table in `src/db.js`; modify login handler; Test `tests/admin.test.js`.
- [ ] Schema: `auth_events(id SERIAL, kind TEXT, subject TEXT, ip TEXT, occurred_at TEXT)`.
- [ ] Record `login_fail`/`login_ok` per email. After N (e.g. 10) fails in a
  window for one email, return a lockout response regardless of IP (defeats
  distributed brute force the per-IP limiter misses).
- [ ] Tests: N fails locks the account; a success within limit resets. Commit.

---

## Phase 1 — Mailer service (gates all of Phases 2–3)

### Task 1.1: `src/services/mailer.js`
**Files:** Create `src/services/mailer.js`; Test `tests/mailer.test.js`; config additions in `src/config.js`.
- [ ] Interface: `sendMail({ to, subject, text, html })`. In prod use the chosen
  provider (SAP SMTP relay preferred; else Postmark/SendGrid/SES via one dep).
  In dev/test use a **console transport** that logs the link/code and records it
  to an in-memory outbox for assertions — mirrors the Supabase/local-fallback
  split in `src/services/storage.js`.
- [ ] Config: `MAIL_TRANSPORT`, provider creds, `MAIL_FROM`. Fail-fast in prod if
  transport unset (same pattern as storage.js Supabase fail-fast).
- [ ] Tests: console transport captures a sent message; prod path selects provider.
- [ ] Commit: `feat(mailer): transactional email service with dev console transport`.

---

## Phase 2 — Viewer email verification (closes the #1 spoofing risk)

### Task 2.1: Viewer OTP schema + issue
**Files:** `src/db.js` (`viewer_otps`); `src/routes/delivery.js` (`POST /:shareToken/enter`); `tests/delivery.test.js`.
- [ ] Schema: `viewer_otps(prototype_id, email, code_hash, expires_at, consumed_at, attempts)`.
- [ ] Change `/enter`: on allowlist match, DON'T grant the session. Instead
  generate a 6-digit code, store `code_hash` (bcrypt) + 10-min `expires_at`,
  `mailer.sendMail` it, and render a "enter your code" view.
- [ ] Rate-limit issuance per (prototype,email) to prevent mail bombing (reuse
  `rateLimit.js` with a new limiter).
- [ ] Test: valid allowlisted email → code row created + mail captured; session
  NOT yet set.

### Task 2.2: Viewer OTP verify
**Files:** New `POST /:shareToken/verify`; modify `customerAuth` usage; `tests/delivery.test.js`.
- [ ] Verify code: match hash, unexpired, unconsumed, attempts < cap. On success
  mark consumed, `req.session.regenerate()`, set `customerEmail` + `prototypeId`.
- [ ] Wrong/expired code increments `attempts`; too many → invalidate + require re-issue.
- [ ] Tests: correct code grants view; expired/used/over-attempt codes 403.
- [ ] Commit: `feat(viewer): verify email ownership via OTP before granting access`.

### Task 2.3: Share-link lifecycle (expiry + revoke)
**Files:** `src/db.js` (add `expires_at`, `revoked_at` to prototypes/share); `src/routes/admin.js` (revoke action + UI); `src/routes/delivery.js` (reject expired/revoked).
- [ ] Add columns (nullable; NULL = no expiry). `GET /:shareToken` returns 404/410
  when expired or revoked.
- [ ] Admin UI: show link status + a "Revoke / set expiry" control on the
  prototype detail page (`src/views/admin-prototype-detail.html`), CSRF-guarded.
- [ ] Tests: expired link blocked; revoked link blocked; admin revoke works.
- [ ] Commit: `feat(share): expirable + revocable share links`.

### Task 2.4 (OPTIONAL): Per-recipient share tokens
**Files:** `src/db.js` (`share_recipients`); admin invite UI; delivery resolution.
- [ ] One token per invited email → leaked link is attributable + individually
  revocable. Defer unless per-recipient attribution is required.

---

## Phase 3 — Admin email verification, reset, and MFA

### Task 3.1: Email verification on signup
**Files:** `src/db.js` (`email_verifications`); `src/routes/admin.js` (signup + new verify route); `tests/admin.test.js`.
- [ ] Signup creates the user as **unverified** (add `users.verified_at` nullable,
  or gate via the verifications table). Send a signed, single-use, 24h link.
- [ ] `GET /admin/verify/:token` consumes the token → marks verified → logs in.
- [ ] Login refuses unverified accounts with a "resend verification" affordance.
- [ ] Tests: unverified can't log in; verify link activates; token single-use.
- [ ] Commit: `feat(auth): require verified email before admin login`.

### Task 3.2: Self-serve password reset
**Files:** `src/db.js` (`password_resets`); `src/routes/admin.js` (forgot + reset routes + views); `tests/admin.test.js`.
- [ ] `GET/POST /admin/forgot` — always responds success (no account enumeration),
  sends a signed single-use 1h reset link only if the account exists.
- [ ] `GET/POST /admin/reset/:token` — validates token, enforces password policy,
  updates hash, **invalidates all existing sessions** for that user, consumes token.
- [ ] Rate-limit forgot requests per email + per IP.
- [ ] Tests: reset changes password + kills old sessions; enumeration-safe response;
  expired/used token rejected. Commit: `feat(auth): self-serve password reset`.

### Task 3.3: TOTP MFA
**Files:** `src/db.js` (`user_totp`, `user_recovery_codes`); `src/routes/admin.js` (enroll/verify/challenge); one dep (`otplib`); `tests/mfa.test.js`.
- [ ] Enrollment: generate secret, show otpauth QR, confirm with a live code
  before enabling. Store secret **encrypted at rest** (Node `crypto`, key from env).
- [ ] Login: after password success, if MFA enabled, require a TOTP (or recovery
  code) before setting `userId`. Recovery codes single-use, hashed.
- [ ] Config flag: MFA optional → required-for-admins.
- [ ] Tests: enroll→challenge→pass; wrong code denies; recovery code works once.
- [ ] Commit: `feat(auth): TOTP MFA for admin accounts`.

---

## Phase 4 — OIDC SSO (target end-state; needs IdP access)

> **Blocked on:** SAP IAS / Azure AD (Entra) app registration — client id/secret,
> redirect URI, allowed domains/groups. Cannot start until the project has these.

### Task 4.1: OIDC for admins
**Files:** New `src/services/oidc.js` + `src/routes/sso.js`; `src/db.js` (`sso_identities`); one dep (`openid-client`); config; `tests/sso.test.js`.
- [ ] Authorization Code + PKCE. `GET /admin/sso/start` → IdP; `GET /admin/sso/callback`
  → verify `id_token`, map verified `email`/`sub` to a `users` row
  (create-on-first-login, gated by `allowedEmailDomains` and/or a group claim),
  `req.session.regenerate()`, set `userId` + `activeOrgId`.
- [ ] Keep the env-seeded local admin password path as **break-glass** only.
- [ ] "Sign in with SAP/Azure" button on `admin-login.html`.
- [ ] Tests (mock IdP / stub token): callback with valid token logs in + creates
  identity mapping; disallowed domain denied; state/nonce/PKCE validated.
- [ ] Commit: `feat(auth): OIDC SSO login for admins`.

### Task 4.2: OIDC / OTP fallback for viewers
**Files:** `src/routes/delivery.js`; reuse `oidc.js`; `tests/delivery.test.js`.
- [ ] Internal (corporate-domain) viewers: route the share-link entry through
  OIDC; the verified email is checked against the allowlist (authorization, not
  login). External viewers: fall back to the Phase 2 OTP path.
- [ ] Tests: corporate viewer via SSO granted iff allowlisted; external viewer via OTP.
- [ ] Commit: `feat(viewer): SSO for internal reviewers, OTP fallback for external`.

### Task 4.3: Supersede bridge mechanisms (cleanup)
- [ ] Once SSO is the default and stable, decide the fate of password signup
  (keep for break-glass? disable public signup?), and document the final matrix.
- [ ] Keep reset/MFA only for any surviving local accounts.

---

## Open questions for when this is picked up
- Which email provider is approved for an internal SAP tool? (Gates Phases 2–3.)
- Which IdP, and who owns the app registration? (Gates Phase 4.)
- Do external (non-corporate) reviewers need to be supported at all, or is the
  audience purely internal? If internal-only, viewer OTP (Phase 2) can be a pure
  bridge and SSO (4.2) can be the sole end-state.
- MFA: optional-then-required, or required-for-admins from day one?
- Should public signup remain once SSO lands, or become invite-only
  (ties into `2026-07-29-future-self-serve-org-signup.md`)?
