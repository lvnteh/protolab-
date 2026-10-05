# Secure Authentication & Registration — Design (Admins + Viewers)

**Date:** 2026-08-02
**Status:** FUTURE / Deferred. Design captured at product request. No implementation
now — this is the target model and the reasoning behind it. SSO is the chosen
end-state for *both* audiences; the phased plan lives in
`docs/superpowers/plans/2026-08-02-future-secure-auth.md`.

---

## Summary

proto-share (ProtoLab) has two completely different classes of user that the
current code fuses onto the single word "email":

1. **Admins** — real accounts (`users` table, bcrypt password, org membership)
   that own and manage prototypes.
2. **Viewers / reviewers** — people who open a share link and **type an email**
   to enter. There is no account and no verification: the typed address is
   checked against a per-prototype `allowlist` and then trusted as identity.

This document defines a more secure model for both, with **corporate SSO
(OIDC — SAP IAS / Azure AD / Entra) as the target** for each. Because SSO
depends on IdP access and config that isn't available today, the design is
staged so the high-value, self-contained hardening lands first and SSO drops in
cleanly on top without a rewrite.

---

## Current state (as-built, traced 2026-08-02)

**Admin auth**
- `users.email TEXT UNIQUE NOT NULL`; email normalized `.trim().toLowerCase()`
  on signup + login (`src/routes/admin.js`).
- Passwords bcrypt cost 10 (`src/routes/admin.js:123`, `src/services/tokens.js`).
- Signup gated to `allowedEmailDomains = ['sap.com','emarsys.com']` (`src/config.js:34`).
- Session server-side in Postgres (connect-pg-simple); cookie `httpOnly` +
  `sameSite=lax` + `secure` in prod; `SESSION_SECRET` mandatory in prod
  (`src/server.js`, `src/config.js`).
- CSRF double-submit guard on all admin unsafe requests (`src/middleware/csrf.js`).
- Rate limits (shared Postgres store in prod): login 5/15min, signup 3/hr
  (`src/middleware/rateLimit.js`).
- `adminAuth` = "is `req.session.userId` set" (`src/middleware/adminAuth.js`);
  `requireOrg`/`requireAdmin` add org-scoped role checks.

**Viewer auth**
- `GET /p/:shareToken` → email-entry form; `POST /p/:shareToken/enter` checks the
  typed email against `allowlist(prototype_id, email)` and, on match, sets
  `req.session.customerEmail` + `prototypeId` (`src/routes/delivery.js`).
- `customerAuth` = "are those two session fields set" (`src/middleware/customerAuth.js`).
- Comments/access-log stamped with the typed email — plain `TEXT`, unverified.

**Known weaknesses this design closes**
1. **Viewer identity is spoofable** — anyone with the share link + a known/guessed
   allowlisted address enters as that person. (Highest risk.)
2. **No password reset & no email verification for admins** — a lockout needs
   manual DB surgery (done in July 2026); signup trusts the typed address.
3. **No MFA** anywhere — password alone is the whole admin gate.
4. **`magiclvnte` hardcoded client-side "lock"** in `src/views/landing.html:62` —
   a plaintext shared secret bypassable via devtools. Provides false confidence;
   should be removed or replaced with a real gate.
5. **No account lockout, session idle/absolute expiry, session-fixation
   rotation, or password-strength policy** beyond length ≥ 8.

---

## Design principles

- **Separate the two trust models explicitly.** Admins get real, verifiable
  identity (SSO or password+MFA). Viewers get *proof-of-email-ownership* at
  minimum — never bare trust of a typed string.
- **SSO is the destination, hardening is the road.** Every hardening step is
  useful on its own AND is a prerequisite or no-regret step toward SSO.
- **No new heavyweight deps without cause.** Prefer the platform (Postgres,
  Node crypto, the existing session/CSRF/rate-limit machinery). MFA (TOTP) and
  OIDC each justify one focused dependency.
- **Fail closed, log security events.** Lockouts, failed MFA, reset requests,
  and SSO denials are recorded (extend the existing `access_log` pattern or a
  new `auth_events` table).

---

## Target model — Admins

**End-state: OIDC SSO (SAP IAS / Azure AD / Entra).**
- `GET /admin/login` offers "Sign in with SAP/Azure". OIDC Authorization Code +
  PKCE flow. On callback, verify `id_token`, map the verified `email`/`sub` to a
  `users` row (create-on-first-login, gated by `allowedEmailDomains` and/or an
  IdP group claim), set `req.session.userId`.
- The domain gate (`allowedEmailDomains`) becomes belt-and-suspenders behind the
  IdP; group/role claims can drive org membership.
- Passwords, reset, and TOTP become unnecessary for SSO users — but remain for
  any break-glass local admin (env-seeded), so we keep the password path alive
  for that single account.

**Bridge state (before IdP access) — hardened passwords:**
- **Email verification on signup** — account inactive until a signed,
  time-boxed verification link is clicked. Requires a transactional email
  sender (see "Email delivery").
- **Self-serve password reset** — signed, single-use, time-boxed token by email;
  invalidates existing sessions on reset.
- **TOTP MFA** (authenticator app) — optional then required for admins. One
  focused dep (e.g. `otplib`); store per-user secret encrypted at rest; recovery
  codes.
- **Policy:** min length 12 + breach check (k-anonymity HIBP range API, optional),
  account lockout after N failures (augments per-IP limit with per-account),
  session absolute + idle expiry, `req.session.regenerate()` on login to prevent
  fixation.

---

## Target model — Viewers

**End-state: SSO for internal reviewers.**
- Because reviewers are `@sap.com`/`@emarsys.com`, the same OIDC IdP can identify
  them. A share link would route an unauthenticated viewer through OIDC; the
  verified email replaces the typed-email gate. Allowlist becomes an
  authorization list checked against the *verified* identity, not a login.
- External reviewers (non-corporate) fall back to the email-OTP path below.

**Bridge state (before IdP, and for external reviewers) — verified email:**
- **Magic-link or 6-digit OTP.** Viewer enters email → if allowlisted, send a
  one-time, time-boxed, single-use code/link → viewer proves ownership → session
  granted. Kills spoofing with minimal friction; no viewer passwords.
- **Per-recipient share tokens (optional).** Instead of one link for everyone,
  mint one token per invited email so a leaked link is attributable and
  individually revocable.
- **Link lifecycle.** Share links (and per-recipient tokens) get `expires_at`
  and a revoke action, so a leak is time- and scope-bounded even before
  verification ships.

---

## Cross-cutting: Email delivery

Both bridge states need transactional email (verification, reset, OTP,
magic-link). Today the app sends none. Options, in order of preference for an
internal SAP tool:
1. **SAP-approved SMTP relay / provider** if one is available to the project.
2. A managed API (Postmark/SendGrid/SES) behind a tiny `src/services/mailer.js`
   with a dev "console transport" (logs the link/code) so local/test never send
   real mail — mirrors the storage.js Supabase/local-fallback pattern.

The mailer is the true gate on the viewer-OTP and admin-verify/reset phases;
sequence it first within those phases.

---

## Data model additions (incremental, all `CREATE TABLE IF NOT EXISTS`)

- `email_verifications(user_id, token_hash, expires_at, consumed_at)` — admin signup verify.
- `password_resets(user_id, token_hash, expires_at, consumed_at)` — admin reset.
- `user_totp(user_id, secret_enc, confirmed_at)` + `user_recovery_codes(...)` — MFA.
- `viewer_otps(prototype_id, email, code_hash, expires_at, consumed_at, attempts)` — viewer OTP.
- `share_links` gains `expires_at`, `revoked_at`; optional
  `share_recipients(id, prototype_id, email, token, expires_at, revoked_at)`.
- `auth_events(id, kind, subject, ip, ua, meta, occurred_at)` — security log.
- `sso_identities(user_id, issuer, subject, email, created_at)` — OIDC subject mapping.

Tokens/codes stored **hashed** (bcrypt or SHA-256+salt), never plaintext —
mirrors the API-token design in `src/services/tokens.js`.

---

## Non-goals

- Replacing the org multi-tenancy model (it stays; SSO claims may *feed* it).
- Building our own password vault beyond bcrypt + standard hygiene.
- SCIM provisioning / directory sync (a later concern if SSO succeeds).
- Changing the API-token machine-auth path (`/api/v1`) — that's already a
  separate, sound bearer-token scheme.

---

## Sequencing rationale

Do the cheap, high-impact, self-contained things first (remove the fake lock,
password policy, session lifetime, session rotation, per-account lockout) — no
new infra. Then stand up the **mailer**, which unlocks both the **viewer OTP**
(closes the #1 spoofing risk) and **admin verify + reset**. Then **TOTP MFA**.
Finally **OIDC SSO** for admins, then viewers, once IdP access exists — at which
point SSO can supersede the bridge mechanisms while they remain as fallback.
