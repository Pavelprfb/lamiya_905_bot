'use strict';

const { Api, TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { computeCheck } = require('telegram/Password');

const logger = require('../logger');

/** GramJS talks to `baseLogger`; we keep it quiet and log on our own terms. */
const SILENT_LOGGER = {
  levels: ['error', 'warn', 'info', 'debug'],
  canSend: () => false,
  setLevel() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
};

class AuthError extends Error {
  constructor(code, message, { retryable = false, status = 400, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'AuthError';
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

function rpcCode(err) {
  return err && (err.errorMessage || (typeof err.message === 'string' ? err.message : '')) || '';
}

/** Map Telegram's raw RPC errors onto messages that are safe to show a user. */
const RPC_ERROR_MAP = {
  PHONE_NUMBER_INVALID: ['phone_invalid', 'Telegram does not recognise that phone number.'],
  PHONE_NUMBER_BANNED: ['phone_banned', 'That phone number is banned on Telegram.'],
  PHONE_NUMBER_FLOOD: ['phone_flood', 'Telegram is rate limiting this number, please try again later.'],
  PHONE_NUMBER_UNOCCUPIED: ['phone_unoccupied', 'That phone number is not registered on Telegram.'],
  PHONE_NUMBER_APP_SIGNUP_FORBIDDEN: ['phone_signup_forbidden', 'Telegram blocked sign-in for this number.'],
  PHONE_PASSWORD_FLOOD: ['password_flood', 'Too many 2FA attempts, please try again later.'],
  PHONE_CODE_EMPTY: ['code_empty', 'Please enter the code you received.'],
  PHONE_CODE_INVALID: ['code_invalid', 'That code is not correct, please check and try again.'],
  PHONE_CODE_EXPIRED: ['code_expired', 'That code has expired, please request a new one.'],
  PHONE_CODE_HASH_EMPTY: ['code_expired', 'Telegram no longer accepts this code, please request a new one.'],
  PHONE_NUMBER_MIGRATE: ['dc_migrate', 'Telegram asked us to use another data centre, please retry.'],
  USER_MIGRATE: ['dc_migrate', 'Telegram asked us to use another data centre, please retry.'],
  SESSION_PASSWORD_NEEDED: ['password_needed', 'This account has two-step verification.'],
  SESSION_PASSWORD_NOT_NEEDED: ['password_not_needed', 'This account does not use a 2FA password.'],
  PASSWORD_HASH_INVALID: ['password_invalid', 'That two-step verification password is not correct.'],
  PASSWORD_MISSING: ['password_invalid', 'Please enter your two-step verification password.'],
  AUTH_RESTART: ['auth_restart', 'Telegram asked to restart the login, please request a new code.'],
  FIRST_NAME_INVALID: ['signup_required', 'This number has no Telegram account yet.'],
  SESSION_REVOKED: ['session_revoked', 'Telegram revoked this session, please log in again.'],
  AUTH_KEY_UNREGISTERED: ['session_revoked', 'The saved session is no longer valid, please log in again.'],
  AUTH_KEY_DUPLICATED: ['transport_error', 'Telegram transport hiccup, please retry.'],
  // GramJS normalises FLOOD_WAIT_<n> to a FloodWaitError whose errorMessage
  // is the bare word "FLOOD", so the plain names are needed too.
  FLOOD: ['flood', 'Telegram asked us to slow down, please try again in a moment.'],
  FLOOD_PREMIUM: ['flood', 'Telegram asked us to slow down, please try again in a moment.'],
  FLOOD_WAIT: ['flood', 'Telegram asked us to slow down, please try again in a moment.'],
  SLOWMODE_WAIT: ['flood', 'Telegram asked us to slow down, please try again in a moment.'],
};

function toAuthError(err) {
  if (err instanceof AuthError) return err;

  const raw = rpcCode(err).toUpperCase();
  const known = RPC_ERROR_MAP[raw] || RPC_ERROR_MAP[raw.replace(/_\d+$/, '')];

  if (known) {
    const flood = /FLOOD|_WAIT_\d+$/.test(raw);
    return new AuthError(known[0], known[1], { retryable: flood, status: flood ? 429 : 400, cause: err });
  }

  if (err?.name === 'TimeoutError' || /timed? ?out|ETIMEDOUT|ECONNRESET|socket hang up/i.test(raw)) {
    return new AuthError('network', 'Could not reach Telegram, please try again.', { retryable: true, status: 502, cause: err });
  }

  logger.error('Unexpected Telegram error', { raw, stack: err?.stack });
  return new AuthError('telegram_error', 'Telegram rejected the request, please try again.', {
    retryable: true,
    status: 502,
    cause: err,
  });
}

class TelegramAuthService {
  #config;

  constructor(config) {
    this.#config = config;
  }

  get apiCredentials() {
    return { apiId: this.#config.apiId, apiHash: this.#config.apiHash };
  }

  #createClient(session = '') {
    // GramJS logs to stdout on its own; swap in a silent logger and route every
    // message we care about through src/logger.js instead.
    const client = new TelegramClient(new StringSession(session), this.#config.apiId, this.#config.apiHash, {
      connectionRetries: 2,
      retryDelay: 1000,
      autoRetry: true,
      maxRetries: 3,
      baseLogger: SILENT_LOGGER,
    });
    return client;
  }

  /** Ask Telegram to deliver a login code to `e164`. Keeps the client connected. */
  async requestLoginCode(attempt) {
    const client = this.#createClient('');
    try {
      await client.connect();
      const { phoneCodeHash, isCodeViaApp } = await client.sendCode(this.apiCredentials, attempt.e164, true);
      if (!phoneCodeHash) {
        throw new AuthError('code_missing', 'Telegram did not return a login code reference.');
      }
      attempt.client = client;
      attempt.phoneCodeHash = phoneCodeHash;
      attempt.delivery = isCodeViaApp ? 'in-app' : 'sms';
      return { delivery: attempt.delivery };
    } catch (err) {
      await client.disconnect().catch(() => {});
      throw toAuthError(err);
    }
  }

  /** Ask Telegram to re-deliver a code for an attempt that is already live. */
  async resendLoginCode(attempt) {
    const client = attempt.client;
    if (!client) {
      throw new AuthError('flow_expired', 'Your login session expired, please request a new code.', { status: 410 });
    }
    try {
      const result = await client.invoke(
        new Api.auth.ResendCode({ phoneNumber: attempt.e164, phoneCodeHash: attempt.phoneCodeHash }),
      );
      if (result instanceof Api.auth.SentCodeSuccess) {
        throw new AuthError('already_signed_in', 'Telegram signed this connection in without a code.');
      }
      if (!result.phoneCodeHash) {
        throw new AuthError('code_missing', 'Telegram did not return a login code reference.');
      }
      attempt.phoneCodeHash = result.phoneCodeHash;
      attempt.delivery = result.type instanceof Api.auth.SentCodeTypeApp ? 'in-app' : 'sms';
      return { delivery: attempt.delivery };
    } catch (err) {
      const authError = toAuthError(err);
      if (authError.code === 'auth_restart' || authError.code === 'code_missing') {
        // The hash is no longer usable; drop the old connection (or it leaks a
        // live MTProto socket) and fall back to a brand new code request.
        const stale = attempt.client;
        attempt.client = null;
        if (stale) await stale.disconnect().catch(() => {});
        return this.requestLoginCode(attempt);
      }
      throw authError;
    }
  }

  /** Exchange the OTP for an authorized GramJS session. */
  async completeLogin(attempt, { code, password } = {}) {
    const client = attempt.client;
    if (!client || !attempt.phoneCodeHash) {
      throw new AuthError('flow_expired', 'Your login session expired, please request a new code.', { status: 410 });
    }

    if (attempt.needsPassword) {
      return this.#submitPassword(attempt, password);
    }

    let result;
    try {
      result = await client.invoke(
        new Api.auth.SignIn({
          phoneNumber: attempt.e164,
          phoneCodeHash: attempt.phoneCodeHash,
          phoneCode: String(code || '').trim(),
        }),
      );
    } catch (err) {
      const authError = toAuthError(err);
      if (authError.code === 'password_needed') {
        attempt.needsPassword = true;
        attempt.hint = await this.#fetchPasswordHint(client);
        throw new AuthError('password_needed', 'This account uses two-step verification. Enter your password.', {
          status: 401,
          cause: err,
        });
      }
      throw authError;
    }

    if (result instanceof Api.auth.AuthorizationSignUpRequired) {
      // This portal only signs in existing accounts; never silently create one.
      throw new AuthError(
        'signup_required',
        'This phone number is not registered on Telegram yet. Open Telegram and sign up first.',
        { status: 400 },
      );
    }

    return this.#finish(attempt, client, result.user);
  }

  async #fetchPasswordHint(client) {
    try {
      const password = await client.invoke(new Api.account.GetPassword());
      return password?.hint || '';
    } catch (err) {
      logger.warn(`Could not read the 2FA hint: ${toAuthError(err).message}`);
      return '';
    }
  }

  async #submitPassword(attempt, password) {
    const client = attempt.client;
    const plain = String(password || '');
    if (!plain) {
      throw new AuthError('password_required', 'Please enter your two-step verification password.', { status: 400 });
    }

    let result;
    try {
      const passwordState = await client.invoke(new Api.account.GetPassword());
      const check = await computeCheck(passwordState, plain);
      result = await client.invoke(new Api.auth.CheckPassword({ password: check }));
    } catch (err) {
      // A wrong password invalidates the flow, so force a fresh code afterwards.
      attempt.needsPassword = false;
      attempt.passwordRejected = true;
      throw toAuthError(err);
    }

    return this.#finish(attempt, client, result.user);
  }

  async #finish(attempt, client, user) {
    if (!user?.id) {
      throw new AuthError('no_user', 'Telegram did not return a user for that session.');
    }
    const session = client.session.save();
    const profile = {
      telegramUserId: String(user.id),
      username: user.username || '',
      firstName: user.firstName || '',
      lastName: user.lastName || '',
    };

    await client.disconnect().catch((err) => {
      logger.debug(`Client disconnect after login failed: ${err.message}`);
    });
    attempt.client = null;

    return { session, ...profile };
  }

  /**
   * Check whether a stored StringSession is still usable by Telegram.
   *
   * Returns one of:
   *   { valid: true,  telegramUserId, … }
   *   { valid: false, reason: 'revoked' | 'corrupt' | 'no_user' }  -> delete it
   *   { valid: false, reason: 'unreachable' }                      -> keep it
   *
   * The 'unreachable' distinction matters: a Telegram outage or a dead network
   * must never delete a session that is still perfectly good.
   */
  async verifySession(sessionString) {
    let client;
    try {
      client = this.#createClient(sessionString);
    } catch (err) {
      // A truncated/garbage .session file makes StringSession throw on read.
      logger.warn(`Stored session is unreadable (${err.message})`);
      return { valid: false, reason: 'corrupt' };
    }

    try {
      await client.connect();
      const me = await client.invoke(new Api.users.GetUsers({ id: [new Api.InputUserSelf()] }));
      const user = Array.isArray(me) ? me[0] : me;
      if (!user?.id) return { valid: false, reason: 'no_user' };

      // Make sure the auth key is written back (DC migration, salt refresh, …).
      client.session.save();
      return {
        valid: true,
        telegramUserId: String(user.id),
        username: user.username || '',
        firstName: user.firstName || '',
        lastName: user.lastName || '',
      };
    } catch (err) {
      const raw = rpcCode(err).toUpperCase();
      const revoked = ['AUTH_KEY_UNREGISTERED', 'AUTH_KEY_PERM_EMPTY', 'SESSION_REVOKED',
        'USER_DEACTIVATED', 'USER_DEACTIVATED_BAN', 'USER_AUTH_REQUIRED',
        'AUTH_KEY_INVALID'].includes(raw);

      if (revoked) {
        logger.debug(`Stored session revoked by Telegram (${raw})`);
        return { valid: false, reason: 'revoked', telegramError: raw };
      }

      // Anything else (timeout, DNS, socket hang up, 5xx) is our problem or
      // Telegram's, not the session's. Keep the file and let the user re-login.
      const transient = err?.name === 'TimeoutError'
        || /timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|socket hang up|fetch failed/i.test(raw);
      if (transient) {
        logger.warn(`Could not verify a stored session (network): ${raw || err?.name}`);
        return { valid: false, reason: 'unreachable', telegramError: raw || err?.name };
      }

      logger.warn(`Stored session rejected unexpectedly (${raw || err?.name})`);
      return { valid: false, reason: 'unreachable', telegramError: raw || err?.name };
    } finally {
      await client.disconnect().catch(() => {});
    }
  }
}

module.exports = { TelegramAuthService, AuthError, toAuthError };
