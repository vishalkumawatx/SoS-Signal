# Signal — personal SOS

A single-server web app for sending personal SOS messages to verified, consenting contacts. React + TypeScript, Express, SQLite, and Twilio SMS. Designed with warm neutral surfaces, restrained red emergency actions, serif headings, and compact, responsive navigation.

**This is not an emergency dispatch service.** It does not notify emergency responders, provide monitoring, or guarantee message delivery. Call your local emergency number in immediate danger.

## Local setup

Requires **Node.js 24** (uses the built-in `node:sqlite` module) and npm.

```powershell
npm install
Copy-Item .env.example .env
npm run dev
```

Open **http://localhost:5173**. The API runs on port 3001; Vite proxies `/api`. Use the configured origin exactly, including hostname and port. Do not put secrets in `VITE_*` variables or client code.

If you see **“Request origin is not allowed.”**, set `APP_ORIGIN` in `.env` to the browser’s exact origin (scheme, hostname, and port, without a trailing slash), then restart the API. For the built frontend at `http://127.0.0.1:3001/`, use `APP_ORIGIN=http://127.0.0.1:3001`. For Vite at `http://127.0.0.1:5173/`, use `APP_ORIGIN=http://127.0.0.1:5173`. `localhost` and `127.0.0.1` are different origins; switching between them or changing ports requires updating this setting. Keep the origin check enabled.

Without Twilio configuration, account creation and sign-in work, but SMS verification and alerts are unavailable. The interface shows this explicitly; it never simulates real delivery.

### Enable SMS delivery

Set these values in the project-root `.env` file and restart the API server. The server loads that file explicitly, regardless of the terminal’s working directory; already-set process environment variables take precedence. Changes to `.env` alone do not restart Node’s development watcher. If configuration still appears missing, make sure an older API process is not occupying port 3001. Refresh the browser after restarting.

Required values:

- `TWILIO_ACCOUNT_SID`: your Twilio account SID.
- `TWILIO_AUTH_TOKEN`: your Twilio auth token.
- `TWILIO_FROM_NUMBER`: an SMS-capable Twilio number in E.164 format, such as `+14155550123`.

Use your own account. SMS charges and Twilio/carrier policies apply. Trial accounts may send only to destinations verified in the Twilio console. Destination permissions and local sender registration (including applicable A2P or country-specific requirements) must be configured with Twilio. Having environment variables present does **not** establish that credentials, balance, number capabilities, or carrier routing are valid.

1. Create an account with a unique password of at least 12 characters.
2. Ask someone for permission before adding their mobile number, including its country code.
3. Have them share the six-digit verification code received by SMS.
4. Optionally request your browser location. Permission is required; HTTPS is required outside localhost.
5. Select **SOS**, review the message and recipients, then explicitly confirm sending.
6. Check **Alert history** and use **Refresh** to retrieve current provider statuses. An accepted/queued/sent message is not a confirmed delivery. Even delivery does not confirm it was read.

A location is a one-time snapshot, not live tracking. A snapshot older than five minutes must be refreshed or excluded before sending. SMS messages with a location include a Google Maps link; opening it contacts Google. Location coordinates are shared with the SMS provider and recipients only when included in an alert.

## When SMS does not arrive

A configured environment means credentials are present, not that Twilio accepted a message. Verification failures now show a safe Twilio error code and next steps in the verification dialog; SOS submission and delivery failures show them per recipient in alert history. Raw provider error messages are not displayed because they may contain account or recipient information.

- **20003:** check the Account SID and current Auth Token; restart the API after changing configuration.
- **21608:** on a trial account, verify the destination number in Twilio Console. This is separate from the app’s six-digit contact verification.
- **21408:** enable the destination under Twilio Messaging Geographic Permissions, subject to country restrictions.
- **21606:** use an SMS-capable sender belonging to this Twilio account.
- **21610:** the recipient opted out; do not bypass this restriction.
- **30007 / 30034:** review carrier filtering or applicable sender registration in Twilio Console.
- **572006 or another unmapped code:** the app has no verified explanation for this code. The account owner must inspect the failed message’s error details in Twilio Console; if unexplained, contact Twilio support with the code. Do not assume a balance, geographic-permission, or recipient problem without the provider’s diagnosis. Waiting 60 seconds only clears the app’s resend cooldown; it does not resolve a provider rejection.

The verification dialog does not claim that an SMS was sent or delivered. It includes a Twilio Console link for the account owner to investigate failed or missing codes. Verification is still required; no provider failure bypasses it.

If a verification submission is accepted but no code arrives, inspect **Twilio Console → Monitor → Logs → Messaging** for delivery status. The app does not poll verification-message delivery. Correct the reported cause before requesting another code; do not repeatedly resend. Existing pending contacts can be recovered with **Verify → Send a new code**, subject to the 60-second cooldown and daily quotas. Do not delete/re-add contacts to bypass these limits.

Rotate any Auth Token exposed in a chat, screenshot, or repository before further real delivery tests. Tests in this project never use your live credentials.

## Behavior and limits

- Up to five contacts per account; only verified contacts receive SOS messages.
- Explicit contact consent acknowledgement, expiring codes, limited verification attempts, and resend limits.
- Server-enforced alert cooldown and abuse controls. A timed-out request must not be blindly retried; inspect history first.
- Accounts use password hashing and cookie sessions. Contacts and history are isolated by account.
- SMS submission failures and ambiguous outcomes are recorded per recipient, not presented as successful delivery.
- No automatic alert retries, emergency dispatch, background location monitoring, email verification, or password recovery.
- Contact deletion stops future sends to that contact; existing alert records remain in history.

## Build and run

```powershell
npm run build
$env:NODE_ENV = 'production'
$env:APP_ORIGIN = 'https://your-domain.example'
npm start
```

The Express server serves the built frontend. In production, put it behind an HTTPS reverse proxy. Production session cookies are secure and require HTTPS. Keep API and frontend on the same origin. The configured `APP_ORIGIN` must match the browser origin for mutating requests.

Persist the database directory on disk and restrict filesystem access. Back up the SQLite database safely, including its WAL state when applicable. Do not use an ephemeral filesystem or multiple server replicas with independent databases. Contact phone numbers, messages, and location snapshots are sensitive personal data: establish a retention policy, backup policy, access controls, and user deletion procedure before any public deployment. There is no built-in encryption at rest or automated account/history deletion workflow.

This implementation is a starting point for a configured single-server deployment, **not a certified life-safety system**. A public launch needs operational monitoring, tested restore procedures, privacy/legal review, stronger signup abuse prevention, and real carrier delivery checks.

## Validation

```powershell
npm test
npm run test:ui
npm run build
```

Backend tests use temporary databases and a fake SMS transport. Browser tests cover mocked API responses as well as the real frontend/API integration with an isolated in-memory database and fake SMS transport. They **do not send real SMS**. The browser test command automatically builds the frontend first. They cover onboarding, contact verification/removal, explicit alert confirmation/cancellation, honest delivery statuses, missing configuration, location denial, keyboard focus, automated WCAG checks on the overview/sign-in dialog, and overflow checks at 320, 390, 768, and 1024 pixels. Desktop and mobile screenshots are written to `test-results` for inspection.

Browser tests use installed Google Chrome through Playwright. If it is unavailable, install Chrome or update `playwright.config.ts` to use an installed browser channel. Automated accessibility checks are not a replacement for a full accessibility audit.

**Real Twilio delivery must be tested separately with your own credentials and a consenting recipient.** No credential-free test can establish real-world delivery.
