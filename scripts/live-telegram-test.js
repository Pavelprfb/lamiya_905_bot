'use strict';

/**
 * Opt-in integration check against the real Telegram MTProto servers.
 *
 *   node scripts/live-telegram-test.js
 *
 * It proves the GramJS wiring works (connect -> auth.sendCode -> error mapping)
 * without ever delivering a login code to anybody: the number below is rejected
 * by Telegram as invalid.
 */

const assert = require('node:assert/strict');

const { getConfig } = require('../src/config');
const logger = require('../src/logger');
const { TelegramAuthService, AuthError } = require('../src/services/telegram-auth');
const { LoginAttemptStore } = require('../src/services/login-attempts');

const IMPOSSIBLE_NUMBER = process.env.LIVE_TEST_PHONE || '+10000000000';

(async () => {
  const config = getConfig();
  logger.setLevel('info');

  const authService = new TelegramAuthService(config);
  const attempts = new LoginAttemptStore({
    ttlMs: config.otpTtlMs,
    maxAttempts: config.otpMaxAttempts,
    resendCooldownMs: config.resendCooldownMs,
  });

  let failed = 0;
  const ok = (name) => console.log(`  ok  ${name}`);
  const bad = (name, err) => {
    failed += 1;
    console.error(`FAIL  ${name}\n      ${err.stack || err.message}`);
  };

  console.log(`\nlive Telegram check (number ${IMPOSSIBLE_NUMBER})`);

  // 1. A fresh, unauthorized client must be able to request a code, which means
  //    connect() + auth.sendCode work against the real API.
  const attempt = attempts.create({
    phoneDigits: '10000000000',
    e164: IMPOSSIBLE_NUMBER,
    telegramUserId: '1',
  });

  try {
    await authService.requestLoginCode(attempt);
    bad('requestLoginCode reaches Telegram', new Error('Telegram accepted an impossible number'));
  } catch (err) {
    if (err instanceof AuthError && ['phone_invalid', 'phone_unoccupied', 'dial_unknown'].includes(err.code)) {
      ok(`requestLoginCode reaches Telegram and maps the reply (${err.code})`);
    } else {
      bad('requestLoginCode reaches Telegram', err);
    }
  }

  // 2. verifySession must reject a garbage session instead of throwing.
  try {
    const result = await authService.verifySession('1AeAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    assert.equal(result.valid, false);
    ok(`verifySession rejects a bad session (${result.reason})`);
  } catch (err) {
    bad('verifySession rejects a bad session', err);
  }

  attempts.stop();

  console.log(failed ? `\n${failed} live check(s) failed\n` : '\nall live checks passed\n');
  process.exitCode = failed ? 1 : 0;
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
