# Lamiya — Telegram WebApp login bot

A single Node.js server that runs three things together:

1. a **Telegraf bot** (`/start`, `/login`, inline *Open App* button),
2. a **Telegram Mini App** that collects a phone number and the login code
   Telegram sends to that phone, and
3. a **GramJS login service** that exchanges the code for a reusable
   `StringSession`, stores it on disk, and then sends the user to
   `https://p9x9.com`.

No separate frontend host, no database, no queue: Express serves the static
WebApp, the API and the healthcheck from one process.

---

## How the login works

```
User                WebApp (browser)        Express API             GramJS / Telegram
 |                        |                      |                        |
 |-- opens bot ---------->|                      |                        |
 |                        |-- GET  /api/auth/status ------------------->  |
 |                        |                      |                        |
 |-- submits number ----->|-- POST /api/auth/start -------------------->  |
 |                        |                      |  (existing session?)    |
 |                        |                      |-- auth.sendCode ----->|
 |                        |<-- { attemptId, maskedPhone } ---------------|
 |                        |                      |                        |
 |-- enters OTP -------->|-- POST /api/auth/verify -------------------->  |
 |                        |                      |  auth.signIn --------->|
 |                        |                      |  (2FA? auth.checkPassword)
 |                        |                      |  writes data/sessions/<phone>.session
 |                        |<-- { redirectUrl } --------------------------|
 |                        |                      |                        |
 |========================|====== openLink(https://p9x9.com) ===========>|
```

If a working session for that phone number already exists, `/start` skips the
OTP entirely and redirects immediately.

Two Telegram identities are tracked separately and must not be confused:

| field                | meaning                                          |
| -------------------- | ------------------------------------------------ |
| `telegramUserId`     | the account that **owns the phone number**       |
| `ownerTelegramUserId`| the WebApp user who **started this login**       |

One operator signs in many different phone numbers, so the "have I already
connected a number?" lookup is keyed by the owner, not by the phone account.

---

## Requirements

- Node.js **20+** (Docker image uses `node:22-alpine`)
- A bot token from [@BotFather](https://t.me/BotFather)
- `api_id` / `api_hash` from <https://my.telegram.org>
- A public **HTTPS** domain (Telegram will not load a WebApp over plain HTTP)

---

## Configuration

Copy `.env.example` to `.env` and fill it in:

```ini
BOT_TOKEN=123456789:AA...
API_ID=1234567
API_HASH=0123456789abcdef0123456789abcdef

SERVER_URL=https://lamiya.p9x9.com   # public base URL of this server
REDIRECT_URL=https://p9x9.com         # where users land after login
PORT=3000

DATA_DIR=./data                       # session store location
TRUST_PROXY=1                         # 1 = behind one reverse proxy, 0 = direct
LOG_LEVEL=info
```

| variable       | required | notes                                                                   |
| -------------- | -------- | ----------------------------------------------------------------------- |
| `BOT_TOKEN`    | yes      | validated at boot with `getMe`; the server refuses to start without it    |
| `API_ID`       | yes      | integer, from my.telegram.org                                            |
| `API_HASH`     | yes      | exactly 32 hex characters                                               |
| `SERVER_URL`   | yes      | must be `https://` unless `ALLOW_INSECURE_SERVER_URL=1` (local dev only)  |
| `REDIRECT_URL` | no       | defaults to `SERVER_URL`                                                 |
| `PORT`         | no       | default `3000`                                                          |
| `DATA_DIR`     | no       | default `./data`                                                        |
| `TRUST_PROXY`  | no       | `1` behind exactly one proxy; never enable blindly                       |
| `OTP_TTL_MS`   | no       | default `600000` (10 min)                                                |
| `OTP_MAX_ATTEMPTS` | no   | default `5`                                                             |
| `RESEND_COOLDOWN_MS` | no | default `60000`                                                        |
| `LOG_LEVEL`    | no       | `error` \| `warn` \| `info` \| `debug`                                  |

`.env` is excluded from git **and** from the Docker build context. Never commit
it. `.env.example` contains placeholders only.

---

## Running locally

```bash
npm install
npm run dev            # node --watch src/index.js
```

The WebApp must be opened from inside Telegram — opening the URL in a normal
browser returns `init data required`, which is the intended behaviour.

## Running with Docker

```bash
docker compose up -d --build
docker compose logs -f app
```

Sessions live in the named volume `telegram-sessions`, mounted at `/app/data`,
so they survive `docker compose down` and image rebuilds. Back up with:

```bash
docker run --rm -v telegram-sessions:/data -v "$PWD":/backup alpine \
  tar czf /backup/sessions-$(date +%F).tgz -C /data .
```

### Behind a reverse proxy

Terminate TLS at the proxy and forward to the container. `TRUST_PROXY=1` makes
Express believe the last proxy hop, which is what makes rate limiting see real
client IPs. If you run two proxies in a chain, set it to `2`.

The Compose file publishes the port directly, so for a real deployment either
restrict `ports:` to `127.0.0.1:3000:3000` or drop the `ports` section and let
the proxy reach the container network.

---

## HTTP API

All `/api/*` routes require a signed `X-Telegram-Init-Data` header (or
`?initData=`) produced by the Telegram WebApp SDK. The signature is verified
with HMAC-SHA256 and the payload must be younger than 24 hours.

| method | path                 | body                          | success                                        |
| ------ | -------------------- | ----------------------------- | ---------------------------------------------- |
| `GET`  | `/healthz`           | –                             | `{ ok, uptimeSec, sessions }`                  |
| `GET`  | `/api/auth/status`   | –                             | `anonymous` \| `authenticated`                  |
| `POST` | `/api/auth/start`    | `{ phone, country? }`         | `redirect` \| `code_sent`                       |
| `POST` | `/api/auth/verify`   | `{ attemptId, code\|password }`| `success` \| `password_needed`                 |

Errors are always `{ ok: false, error, message }` with a stable machine
`error` code. Notable ones: `code_invalid`, `code_expired`, `password_needed`,
`signup_required`, `flow_expired`, `too_many_attempts`, `resend_too_soon`,
`session_owned_by_another_user`.

Rate limits are per Telegram user, not per IP: 8 code sends and 20 verifies per
10 minutes, 120 general requests per minute.

---

## Session storage

```
data/
├── index.json                    # version, byPhone, byOwner
└── sessions/
    └── 8801712345678.session     # "1" + base64 GramJS StringSession
```

Writes go to a temp file and are renamed into place, and all index mutations
are serialised through a promise chain, so a crash mid-write cannot corrupt
the store. Files are written with mode `0600`.

> **These files are full Telegram account credentials.** Anyone who can read
> `data/` can act as the signed-in account. Keep the volume off shared storage,
> never commit it, and treat a backup as a secret.

A session is deleted only when Telegram positively rejects it
(`AUTH_KEY_UNREGISTERED`, `USER_DEACTIVATED`, …) or the file is unreadable. A
network outage returns `unreachable` and the session is **kept** — otherwise a
Telegram hiccup would silently wipe every stored session.

## Security notes

- The WebApp validates the Telegram signature itself; it is not gated by a
  `WEBAPP` list check, so create a bot and a WebApp with the same token.
- `frame-ancestors` is restricted to `https://*.telegram.org` so the page
  cannot be framed anywhere else.
- 2FA is fully supported (`auth.checkPassword`); signup for unregistered
  numbers is deliberately not, this portal only signs in existing accounts.
- `telegram` (GramJS) is pinned to `2.26.22`; the package is deprecated
  upstream in favour of Teleproto, so the version is pinned rather than ranged.

---

## Tests

```bash
npm run check        # syntax check
npm run smoke        # 42 offline checks: phone rules, init-data HMAC, session store
npm run test:routes  # 19 route checks with a fake Telegram service (no network)
npm run test:http    # 17 checks against a running server
npm run test:live    # talks to real Telegram with a deliberately invalid number
```

`npm run smoke` and `npm run test:routes` run fully offline and need no
credentials — the latter mounts the real router, session store and attempt
store on a throwaway Express app and fakes only the GramJS service, which is
what covers ownership isolation, session reuse and 2FA recovery.

`npm run test:http` expects the server on `http://127.0.0.1:<PORT>`; start it
first with `npm start` and a throwaway `DATA_DIR`. `npm run test:live` performs
a real MTProto connect and `auth.sendCode` against `+10000000000` to prove error
mapping works; it cannot deliver a code to any real number.

The one thing that cannot be automated is a genuine end-to-end login, because
it needs a real phone number and a real code. Do one manually before going live.

---

## Project layout

```
src/
├── index.js                 boot, graceful shutdown
├── app.js                   Express app, helmet/CSP, static, /healthz
├── bot.js                   Telegraf commands and menu button
├── config.js                env parsing and validation
├── logger.js                console logger (GramJS is silenced)
├── middleware/              init-data auth, rate limits, error handler
├── routes/auth.js           /api/auth/*
├── services/
│   ├── telegram-auth.js     GramJS send/resend/sign-in/2FA/verify
│   ├── session-store.js     durable StringSession files + indexes
│   └── login-attempts.js    in-flight OTP state, TTL, per-phone lock
└── utils/                   phone normalisation, init-data HMAC
public/                      the WebApp (index.html, assets/)
shared/countries.json        ~190 countries, shared by server and browser
scripts/                     smoke, http and live test runners
```
