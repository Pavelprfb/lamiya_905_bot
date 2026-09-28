'use strict';

/**
 * Route-level tests for /api/auth/*.
 *
 * The real SessionStore and LoginAttemptStore are used against a temp
 * directory; only the Telegram service is faked, so ownership rules, session
 * reuse and 2FA recovery are exercised without touching the network.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const express = require('express');
const { createAuthRouter } = require('../src/routes/auth');
const { SessionStore } = require('../src/services/session-store');
const { LoginAttemptStore } = require('../src/services/login-attempts');
const { AuthError } = require('../src/services/telegram-auth');

const BOT_TOKEN = '1234567890:AAHtesttesttesttesttesttesttesttesttesttest';
const OPERATOR = '777000111'; // the WebApp user running the logins
const CLIENT_ACCOUNT = '555123999'; // whoever owns the phone number
const PHONE = '+8801712345678';
const DIGITS = '8801712345678';
const SESSION = '1' + Buffer.alloc(274, 0x2a).toString('base64');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}

function signInitData(userId, extra = {}) {
  const fields = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: Number(userId), first_name: 'Op' }),
    ...extra,
  };
  const dataCheckString = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

/** Fake Telegram: records calls and returns whatever the test asked for. */
function makeAuthService(overrides = {}) {
  return {
    calls: [],
    async requestLoginCode(attempt) {
      this.calls.push('sendCode');
      return { delivery: 'sms' };
    },
    async resendLoginCode() {
      this.calls.push('resend');
      return { delivery: 'sms' };
    },
    async completeLogin(attempt) {
      this.calls.push('completeLogin');
      return {
        session: SESSION,
        telegramUserId: CLIENT_ACCOUNT,
        username: 'client',
        firstName: 'Client',
        lastName: '',
      };
    },
    async verifySession(session) {
      this.calls.push('verify');
      return overrides.verify ? overrides.verify(session) : { valid: true, telegramUserId: CLIENT_ACCOUNT };
    },
    ...overrides.methods,
  };
}

/** Mount a router on a throwaway Express app, the same way app.js does. */
async function serve(router) {
  const app = express();
  app.set('trust proxy', 0);
  app.use(express.json({ limit: '16kb' }));
  app.use('/api/auth', router);
  app.use((err, req, res, _next) => { // eslint-disable-line no-unused-vars
    res.status(err.status || 500).json({ ok: false, error: err.code || 'internal', message: err.message });
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

(async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lamiya-routes-'));
  const sessionStore = new SessionStore({ dataDir: dir });
  await sessionStore.init();

  const config = {
    botToken: BOT_TOKEN,
    redirectUrl: 'https://p9x9.com',
    otpTtlMs: 600000,
    resendCooldownMs: 60000,
    maxInitDataAgeSec: 86400,
  };

  /**
   * Every block gets its own attempt store, rate limiters and number, so a
   * resend cooldown or a 429 in one block cannot leak into the next.
   */
  const blocks = [];
  async function setup(authService = makeAuthService(), phoneDigits = DIGITS, phone = PHONE) {
    const attempts = new LoginAttemptStore({ ttlMs: 60000, maxAttempts: 3, resendCooldownMs: 60000 });
    const app = await serve(createAuthRouter({ config, sessionStore, authService, attempts }));
    blocks.push({ app, attempts });
    const call = async (path, { userId = OPERATOR, method = 'GET', body } = {}) => {
      const res = await fetch(app.base + path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Init-Data': signInitData(userId),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, body: await res.json() };
    };
    return { call, attempts, authService, phone, phoneDigits };
  }

  console.log('\nexisting session reuse');
  {
    // Pre-seed a session owned by the operator.
    await sessionStore.save({
      phoneDigits: DIGITS,
      session: SESSION,
      telegramUserId: CLIENT_ACCOUNT,
      ownerTelegramUserId: OPERATOR,
    });
    const { call } = await setup();

    const start = await call('/api/auth/start', { method: 'POST', body: { phone: PHONE, country: 'BD' } });
    check('a working session skips the OTP', () => {
      assert.equal(start.status, 200);
      assert.equal(start.body.status, 'redirect');
      assert.equal(start.body.reusedSession, true);
      assert.equal(start.body.redirectUrl, 'https://p9x9.com');
    });

    const status = await call('/api/auth/status');
    check('status reports authenticated for the owner', () => {
      assert.equal(status.status, 200);
      assert.equal(status.body.status, 'authenticated');
      assert.equal(status.body.phone, PHONE);
    });
  }

  console.log('\nownership isolation');
  {
    const { call } = await setup();
    // A different WebApp user must not be able to claim the stored session.
    const res = await call('/api/auth/start', { method: 'POST', body: { phone: PHONE, country: 'BD' }, userId: '999888777' });
    check('another WebApp user gets 409, not the redirect', () => {
      assert.equal(res.status, 409);
      assert.equal(res.body.error, 'session_owned_by_another_user');
    });

    const res2 = await call('/api/auth/status', { userId: '999888777' });
    check('another WebApp user sees anonymous status', () => {
      assert.equal(res2.body.status, 'anonymous');
    });
  }

  console.log('\nsessions survive an unreachable Telegram');
  {
    const offline = makeAuthService({
      verify: () => ({ valid: false, reason: 'unreachable', telegramError: 'ETIMEDOUT' }),
    });
    const { call } = await setup(offline);
    const res = await call('/api/auth/start', { method: 'POST', body: { phone: PHONE, country: 'BD' } });

    check('an unverifiable session falls through to a new code', () => {
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'code_sent');
    });
    check('the stored session file is NOT deleted on a network error', () => {
      assert.ok(sessionStore.read(DIGITS), 'session should still exist');
    });
  }

  console.log('\nrevoked sessions are dropped');
  {
    const revoked = makeAuthService({
      verify: () => ({ valid: false, reason: 'revoked', telegramError: 'AUTH_KEY_UNREGISTERED' }),
    });
    const { call } = await setup(revoked);
    const res = await call('/api/auth/status');

    check('a revoked session is removed and reported anonymous', () => {
      assert.equal(res.body.status, 'anonymous');
      assert.equal(sessionStore.read(DIGITS), null);
    });
  }

  console.log('\nlogin and storage');
  {
    const { call } = await setup();
    const start = await call('/api/auth/start', { method: 'POST', body: { phone: PHONE, country: 'BD' } });
    check('a fresh number sends a code', () => {
      assert.equal(start.status, 200);
      assert.equal(start.body.status, 'code_sent');
      assert.equal(start.body.delivery, 'sms');
      assert.ok(start.body.attemptId);
      assert.equal(start.body.remainingAttempts, 3);
    });

    const { attemptId } = start.body;
    const verify = await call('/api/auth/verify', { method: 'POST', body: { attemptId, code: '12345' } });
    check('the OTP stores a session and returns the redirect', () => {
      assert.equal(verify.status, 200);
      assert.equal(verify.body.status, 'success');
      assert.equal(verify.body.redirectUrl, 'https://p9x9.com');
    });

    const saved = sessionStore.read(DIGITS);
    check('the session is stored with the right owner', () => {
      assert.equal(saved.session, SESSION);
      assert.equal(saved.meta.telegramUserId, CLIENT_ACCOUNT, 'phone account');
      assert.equal(saved.meta.ownerTelegramUserId, OPERATOR, 'WebApp owner');
    });
  }

  console.log('\n2FA recovery');
  {
    let passwordCalls = 0;
    const twoFa = makeAuthService({
      methods: {
        // Mirrors TelegramAuthService: the code step reports password_needed,
        // and a wrong password flips the attempt back to expecting a code.
        async completeLogin(attempt, { password } = {}) {
          if (attempt.needsPassword) {
            if (password === 'correct-horse') {
              return { session: SESSION, telegramUserId: CLIENT_ACCOUNT, username: '', firstName: '', lastName: '' };
            }
            passwordCalls += 1;
            attempt.needsPassword = false;
            attempt.passwordRejected = true;
            throw new AuthError('password_invalid', 'That two-step verification password is not correct.');
          }
          attempt.needsPassword = true;
          attempt.hint = 'my first pet';
          throw new AuthError('password_needed', 'This account uses two-step verification. Enter your password.', { status: 401 });
        },
        async requestLoginCode() { return { delivery: 'in-app' }; },
      },
    });
    const { call, attempts } = await setup(twoFa);
    await sessionStore.remove(DIGITS);

    const start = await call('/api/auth/start', { method: 'POST', body: { phone: PHONE, country: 'BD' } });
    const verify = (body) => call('/api/auth/verify', { method: 'POST', body });

    // First call reports that 2FA is needed.
    const needsPassword = await verify({ attemptId: start.body.attemptId, code: '12345' });
    check('a 2FA account reports password_needed', () => {
      assert.equal(needsPassword.status, 401);
      assert.equal(needsPassword.body.error, 'password_needed');
    });

    // Wrong password kills the flow; the client must be told to start over.
    const wrong = await verify({ attemptId: start.body.attemptId, password: 'nope' });
    check('a wrong password is reported as password_invalid', () => {
      assert.equal(wrong.status, 400);
      assert.equal(wrong.body.error, 'password_invalid');
    });

    const stuck = await verify({ attemptId: start.body.attemptId, password: 'nope-again' });
    check('retrying with only a password returns restart_required, not a confusing 400', () => {
      assert.equal(stuck.status, 400);
      assert.equal(stuck.body.error, 'restart_required');
    });
    check('the dead attempt is discarded', () => {
      assert.equal(attempts.get(start.body.attemptId), null);
    });

    const retry = await call('/api/auth/start', { method: 'POST', body: { phone: PHONE, country: 'BD' } });
    check('a fresh code can be requested after restart_required', () => {
      assert.equal(retry.status, 200);
      assert.equal(retry.body.status, 'code_sent');
    });

    const good = await verify({ attemptId: retry.body.attemptId, code: '12345' });
    check('a restarted flow still reaches the 2FA step', () => {
      assert.equal(good.status, 401);
      assert.equal(good.body.error, 'password_needed');
    });
    const okRes = await verify({ attemptId: retry.body.attemptId, password: 'correct-horse' });
    check('the right password signs the user in', () => {
      assert.equal(okRes.status, 200);
      assert.equal(okRes.body.status, 'success');
      assert.equal(okRes.body.redirectUrl, 'https://p9x9.com');
    });
    check('the second bad password never reaches Telegram again', () => {
      // The route short-circuits on restart_required, so the service is only
      // called once for the first rejection.
      assert.equal(passwordCalls, 1, `expected 1 rejection, saw ${passwordCalls}`);
    });
  }

  console.log('\nrate limiting');
  {
    const { call } = await setup();
    let limited = 0;
    for (let i = 0; i < 12; i += 1) {
      const res = await call('/api/auth/start', {
        method: 'POST',
        body: { phone: PHONE, country: 'BD' },
        userId: '424242424',
      });
      if (res.status === 429) limited += 1;
    }
    check('the send-code limiter kicks in for one Telegram user', () => {
      assert.ok(limited > 0, `expected a 429, got none in 12 requests (limited=${limited})`);
    });
  }

  for (const { app, attempts } of blocks) {
    await app.close();
    attempts.stop();
  }
  await fsp.rm(dir, { recursive: true, force: true });

  console.log(failures ? `\n${failures} route check(s) failed` : '\nall route checks passed');
  process.exit(failures ? 1 : 0);
})();
