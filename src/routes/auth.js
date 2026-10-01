'use strict';

const express = require('express');

const logger = require('../logger');
const { HttpError, asyncHandler } = require('../middleware/error-handler');
const { requireTelegramAuth } = require('../middleware/telegram-auth');
const { buildLimiters } = require('../middleware/rate-limit');
const { normalizePhone, PhoneError } = require('../utils/phone');

function maskPhone(e164) {
  const digits = e164.replace(/\D/g, '');
  if (digits.length <= 4) return `+${'*'.repeat(digits.length)}`;
  return `+${digits.slice(0, 3)}${'*'.repeat(digits.length - 5)}${digits.slice(-2)}`;
}

function createAuthRouter({ config, sessionStore, authService, attempts }) {
  const router = express.Router();
  const limiters = buildLimiters();
  const auth = requireTelegramAuth(config);

  /**
   * Resolve a stored session for `phoneDigits` and confirm Telegram still honours it.
   * Returns { state: 'valid' | 'dead' | 'unverified' | 'none', … }.
   *
   * A session is only ever deleted when Telegram positively rejects it. If
   * Telegram is unreachable we return 'unverified' and keep the file, otherwise
   * a network outage would wipe every stored session on the server.
   */
  async function resolveStoredSession(phoneDigits) {
    const stored = sessionStore.read(phoneDigits);
    if (!stored) {
      // Index entry without a usable session file: forget it so it stops
      // shadowing a fresh login.
      if (sessionStore.getByPhone(phoneDigits)) {
        await sessionStore.remove(phoneDigits);
        logger.warn(`Removed an index entry with no readable session for ${maskPhone(`+${phoneDigits}`)}`);
      }
      return { state: 'none' };
    }

    const result = await authService.verifySession(stored.session);
    if (result.valid) {
      return { state: 'valid', session: stored.session, meta: stored.meta, telegramUserId: result.telegramUserId };
    }

    if (result.reason === 'unreachable') {
      return { state: 'unverified', meta: stored.meta, reason: result.reason };
    }

    await sessionStore.remove(phoneDigits);
    logger.info(`Dropped a stored session for ${maskPhone(`+${phoneDigits}`)} (${result.reason})`);
    return { state: 'dead', reason: result.reason };
  }

  /** May this WebApp user act on an existing session for this number? */
  function assertOwner(resolved, req) {
    const owner = resolved.meta?.ownerTelegramUserId;
    if (owner && owner !== req.telegramUser.id) {
      throw new HttpError(
        409,
        'session_owned_by_another_user',
        'This phone number is already connected to a different Telegram account.',
      );
    }
  }

  // Already authenticated? Lets the WebApp skip the form entirely.
  router.get('/status', auth, limiters.general, asyncHandler(async (req, res) => {
    const meta = sessionStore.getByTelegramUser(req.telegramUser.id);
    if (!meta) {
      res.json({ ok: true, status: 'anonymous' });
      return;
    }

    const resolved = await resolveStoredSession(meta.phoneDigits);
    if (resolved.state !== 'valid') {
      res.json({ ok: true, status: 'anonymous' });
      return;
    }

    await sessionStore.touchVerified(meta.phoneDigits);
    res.json({
      ok: true,
      status: 'authenticated',
      phone: `+${meta.phoneDigits}`,
      redirectUrl: config.redirectUrl,
    });
  }));

  // Step 1: phone number -> Telegram sends the login code.
  router.post('/start', auth, limiters.sendCode, asyncHandler(async (req, res) => {
    const { phone, country } = req.body || {};

    let parsed;
    try {
      parsed = normalizePhone(phone, { iso: country });
    } catch (err) {
      if (err instanceof PhoneError) throw new HttpError(400, err.code, err.message);
      throw err;
    }

    // Existing-session auto-check: no OTP if we already hold a working session.
    const resolved = await resolveStoredSession(parsed.digits);
    if (resolved.state === 'valid' || resolved.state === 'unverified') {
      assertOwner(resolved, req);
      if (resolved.state === 'valid') {
        await sessionStore.touchVerified(parsed.digits);
        logger.info(`Reused the stored session for ${maskPhone(parsed.e164)}`);
        res.json({
          ok: true,
          status: 'redirect',
          reusedSession: true,
          phone: parsed.e164,
          redirectUrl: config.redirectUrl,
        });
        return;
      }
      // 'unverified' falls through to a fresh code so the operator is never
      // stuck behind a session we could not confirm.
    }

    await attempts.lock.run(parsed.digits, async () => {
      const existing = attempts.getByPhone(parsed.digits);
      if (existing) {
        if (existing.telegramUserId !== req.telegramUser.id) {
          throw new HttpError(403, 'attempt_owner_mismatch', 'This login attempt belongs to someone else.');
        }
        const cooldown = attempts.resendCooldownRemaining(parsed.digits);
        if (cooldown > 0) {
          throw new HttpError(429, 'resend_too_soon', 'Please wait a moment before requesting another code.', {
            retryAfterSec: Math.ceil(cooldown / 1000),
          });
        }
        // Mark as sent only once Telegram actually accepted the resend, so a
        // failed resend does not burn the cooldown for the real one.
        const { delivery } = await authService.resendLoginCode(existing);
        attempts.markSent(existing);
        logger.info(`Resent a login code for ${maskPhone(parsed.e164)}`);

        res.json({
          ok: true,
          status: 'code_sent',
          resend: true,
          attemptId: existing.id,
          phone: parsed.e164,
          maskedPhone: maskPhone(parsed.e164),
          delivery,
          expiresInSec: Math.floor(config.otpTtlMs / 1000),
          remainingAttempts: existing.remainingAttempts,
        });
        return;
      }

      const attempt = attempts.create({
        phoneDigits: parsed.digits,
        e164: parsed.e164,
        telegramUserId: req.telegramUser.id,
      });
      let delivery;
      try {
        ({ delivery } = await authService.requestLoginCode(attempt));
      } catch (err) {
        attempts.destroy(attempt.id);
        throw err;
      }
      logger.info(`Sent a login code for ${maskPhone(parsed.e164)} to Telegram user ${req.telegramUser.id}`);

      res.json({
        ok: true,
        status: 'code_sent',
        attemptId: attempt.id,
        phone: parsed.e164,
        maskedPhone: maskPhone(parsed.e164),
        delivery,
        expiresInSec: Math.floor(config.otpTtlMs / 1000),
        remainingAttempts: attempt.remainingAttempts,
      });
    });
  }));

  // Step 2: the OTP (and, when 2FA is on, the password) -> a stored MTProto session.
  router.post('/verify', auth, limiters.verifyCode, asyncHandler(async (req, res) => {
    const { attemptId, code, password } = req.body || {};
    if (!attemptId || typeof attemptId !== 'string') {
      throw new HttpError(400, 'attempt_id_required', 'Missing login attempt id.');
    }

    const attempt = attempts.get(attemptId);
    if (!attempt) {
      throw new HttpError(410, 'flow_expired', 'Your login session expired, please request a new code.');
    }
    if (attempt.telegramUserId !== req.telegramUser.id) {
      throw new HttpError(403, 'attempt_owner_mismatch', 'This login attempt belongs to someone else.');
    }

    // A rejected 2FA password invalidates the whole flow, and the attempt is
    // back to expecting a code. If the client still only has a password to
    // offer, make it start over instead of failing with a confusing 400.
    if (attempt.passwordRejected && !code) {
      attempts.destroy(attempt.id);
      throw new HttpError(
        400,
        'restart_required',
        'That two-step verification password was not accepted. Please request a new code.',
      );
    }

    const wantsPassword = attempt.needsPassword;
    if (wantsPassword ? !password : !code) {
      throw new HttpError(
        400,
        wantsPassword ? 'password_required' : 'code_required',
        wantsPassword ? 'Please enter your two-step verification password.' : 'Please enter the code from Telegram.',
      );
    }

    let result;
    try {
      result = await authService.completeLogin(attempt, { code, password });
    } catch (err) {
      if (err.code === 'password_needed') {
        res.status(401).json({
          ok: false,
          status: 'password_needed',
          error: 'password_needed',
          message: 'This account uses two-step verification. Enter your password to continue.',
          hint: attempt.hint || '',
        });
        return;
      }

      if (!wantsPassword && ['code_invalid', 'code_empty'].includes(err.code)) {
        const stillValid = attempts.consumeAttempt(attempt);
        if (!stillValid) {
          attempts.destroy(attempt.id);
          throw new HttpError(429, 'too_many_attempts', 'Too many wrong codes. Please request a new one.', {
            retryAfterSec: Math.ceil(config.resendCooldownMs / 1000),
          });
        }
        res.status(400).json({
          ok: false,
          error: err.code,
          message: err.message,
          remainingAttempts: attempt.remainingAttempts,
        });
        return;
      }

      if (err.code === 'flow_expired') attempts.destroy(attempt.id);
      throw err;
    }

    await attempts.lock.run(attempt.phoneDigits, async () => {
      // `ownerTelegramUserId` is the WebApp user who ran this login;
      // `telegramUserId` is whoever that phone number belongs to.
      await sessionStore.save({
        phoneDigits: attempt.phoneDigits,
        session: result.session,
        telegramUserId: result.telegramUserId,
        ownerTelegramUserId: attempt.telegramUserId,
        username: result.username,
        firstName: result.firstName,
        lastName: result.lastName,
      });
      attempts.destroy(attempt.id);
    });

    logger.info(`Stored a Telegram session for ${maskPhone(attempt.e164)} (Telegram user ${result.telegramUserId})`);

    res.json({
      ok: true,
      status: 'success',
      phone: attempt.e164,
      redirectUrl: config.redirectUrl,
    });
  }));

  return router;
}

module.exports = { createAuthRouter, maskPhone };
