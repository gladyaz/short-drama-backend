# WhatsApp Login — external setup

Everything in this document happens **outside this repository**, in Meta's
dashboards. The backend code is complete and tested; it cannot start
delivering codes until a real WhatsApp Business sender exists and its four
identifiers are supplied as environment variables.

> **Nothing here has been done.** This project holds no Meta account, no
> WhatsApp Business Account, no phone number and no access token. No WhatsApp
> message has ever been sent by this code, to any number. This document is
> the work list, not a record of completed work.

---

## 1. What you need, in order

| # | Thing to obtain | Where | Becomes |
|---|---|---|---|
| 1 | Meta developer account | developers.facebook.com | — |
| 2 | Meta **App** (type: Business) | Meta App Dashboard | — |
| 3 | **WhatsApp Business Account** (WABA) | App → Add product → WhatsApp | — |
| 4 | **Sender phone number**, verified | WhatsApp → API Setup | `WHATSAPP_CLOUD_API_PHONE_NUMBER_ID` |
| 5 | **System User access token** | Business Settings → System Users | `WHATSAPP_CLOUD_API_ACCESS_TOKEN` |
| 6 | **Approved authentication template** | WhatsApp Manager → Message Templates | `WHATSAPP_CLOUD_API_TEMPLATE_NAME` + `..._TEMPLATE_LANGUAGE` |

Steps 4–6 are the ones that take real time: number verification is minutes,
template review is typically minutes to a few hours, and business
verification (needed to raise sending limits beyond the trial tier) can take
days. **Start template approval early** — it is the usual thing that delays a
release.

---

## 2. The sender phone number

A WhatsApp Business sender number **cannot be a number already registered to
the consumer WhatsApp app or to the WhatsApp Business app.** If you plan to
use a number you already use personally, you must delete that WhatsApp
account first, which is disruptive and irreversible. Use a fresh number.

After adding and verifying the number, the API Setup page shows a **Phone
number ID** — a long integer, distinct from the phone number itself. That id
is what the backend needs:

```
WHATSAPP_CLOUD_API_PHONE_NUMBER_ID=<the numeric id, not the phone number>
```

Meta also offers a **test number** on new apps. It works for proving the
integration, but it can only message a short allowlist of recipients you
register by hand, so it is for your own end-to-end check — never for release.

---

## 3. The access token

The API Setup page offers a **temporary token that expires in 24 hours.** Do
not ship it. When it expires, every WhatsApp login stops, and the failure
surfaces as `503 WHATSAPP_PROVIDER_UNAVAILABLE` on every request.

Create a permanent token instead:

1. Business Settings → **System Users** → create a system user (role: Admin
   or Employee).
2. **Add Assets** → assign the App and the WhatsApp Business Account.
3. **Generate New Token** → select the app → grant
   **`whatsapp_business_messaging`** (and `whatsapp_business_management` if
   you want to manage templates through the API).
4. Copy the token once — Meta will not show it again.

```
WHATSAPP_CLOUD_API_ACCESS_TOKEN=<system user token>
```

**Handling rules.** This is the only secret in the WhatsApp configuration.
Put it in the deployment's secret store, never in git, never in a ticket,
never in a screenshot. The backend reads it once at boot into a prebuilt
`Authorization` header and never logs it, echoes it in an error, or returns
it from any endpoint — but nothing in the code can protect it from being
pasted somewhere. If it is ever exposed, revoke and regenerate it in Business
Settings; no code change is needed.

---

## 4. The authentication template

Meta **requires an AUTHENTICATION-category template** for one-time passcodes.
A utility or marketing template will be rejected at send time, and the
backend will answer `503` loudly rather than pretend the code went out.

Create it in **WhatsApp Manager → Message Templates → Create → Authentication**:

- **Category:** Authentication (not Utility, not Marketing)
- **Language:** the language you will ship. For Red Panda's Indonesian
  audience, `id` is the natural choice; `en_US` is fine if you prefer.
- **Button:** authentication templates must carry a one-time-password button.
  Either **Copy code** or **One-tap autofill** works — the backend sends the
  identical payload for both, because the distinction is made when the
  template is created, not when a message is sent. One-tap requires
  additional Android app-signature configuration in Meta's dashboard and only
  works on Android; **Copy code is the simpler choice and works everywhere.**
- **Expiry text:** optional; the code's real lifetime is five minutes
  (`OTP_TTL_MS`), so say five minutes if you show a number.

The template body is largely fixed by Meta for this category — you choose the
language and a few options, not free text.

Once it shows **Approved**:

```
WHATSAPP_CLOUD_API_TEMPLATE_NAME=<exact template name>
WHATSAPP_CLOUD_API_TEMPLATE_LANGUAGE=<exact language code, e.g. id>
```

Both must match **exactly**. A wrong name, or a language the template was not
approved in, is a send failure — not a fallback.

> If — and only if — you deliberately use a template with **no** button, also
> set `WHATSAPP_CLOUD_API_TEMPLATE_HAS_OTP_BUTTON=false`. Leave it unset
> otherwise; the default matches what Meta requires.

---

## 5. Wiring it up

```bash
WHATSAPP_AUTH_ENABLED=true
WHATSAPP_OTP_PROVIDER_DRIVER=cloud-api
WHATSAPP_CLOUD_API_PHONE_NUMBER_ID=...
WHATSAPP_CLOUD_API_ACCESS_TOKEN=...        # secret store, not git
WHATSAPP_CLOUD_API_TEMPLATE_NAME=...
WHATSAPP_CLOUD_API_TEMPLATE_LANGUAGE=id
```

Then check the configuration **before** deploying:

```bash
npm run production:preflight
```

It reports a named `WhatsApp sign-in` line: `READY` when all four values are
present, or a `BLOCKER` naming exactly which variable is missing. It never
prints a value.

**What preflight cannot tell you**, and says so itself: whether the token is
valid, whether the template is approved and un-paused, and whether the number
can actually send. Those facts live only in Meta's systems.

---

## 6. Proving it actually works

Preflight and the test suite prove the code is correct. **Only a real message
proves delivery.** Before release, do this once:

1. Deploy with the configuration above.
2. `POST /auth/whatsapp/otp/request` with a phone number you control.
3. Confirm the WhatsApp message **arrives on that handset**.
4. `POST /auth/whatsapp/otp/verify` with the code from the message.
5. Confirm you receive an `accessToken` / `refreshToken` pair.

If step 3 fails, the request will have returned `503
WHATSAPP_PROVIDER_UNAVAILABLE` and the server log will carry the HTTP status
and Meta's numeric error code (never the OTP, never the full number). Look
that error code up in Meta's Cloud API error reference — the common ones are
`132001` (template does not exist), `132015` (template paused), `190` (token
expired) and `131026` (recipient not reachable on WhatsApp).

---

## 7. Sending limits and cost

- New WABAs start in a **trial tier** with a low daily limit on unique
  recipients. Limits rise with sending quality once the business is verified.
- Authentication-category conversations are **billed per message** in
  Indonesia. Budget for it: every OTP request is a paid message, which is
  precisely why the backend enforces a 60-second per-number cooldown and a
  five-per-hour rolling cap on top of the per-IP rate limit.
- Template quality can be **paused** by Meta if users report the messages.
  A paused template is a total login outage for WhatsApp users, surfaced as
  `503`. Keep an eye on template quality in WhatsApp Manager.

---

## 8. What the backend does NOT need

Stated so nobody goes looking for it:

- **No webhook.** This integration only *sends*. The user types the code back
  into the app, so nothing needs to receive inbound WhatsApp messages, and no
  callback URL or verify token is configured anywhere.
- **No app secret** and **no OAuth flow.** The System User token is the only
  credential.
- **No WhatsApp-specific public URL.** (The backend has its own HTTPS
  requirements — see `docs/PRODUCTION_HTTPS.md` — but they are not imposed by
  this integration.)
