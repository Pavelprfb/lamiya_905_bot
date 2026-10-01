'use strict';

const { verifyInitData, InitDataError } = require('../utils/telegram-init-data');
const logger = require('../logger');

const HEADER = 'x-telegram-init-data';

/**
 * Rejects any request that does not carry a validly signed Telegram WebApp
 * initData payload, and exposes the trusted user as `req.telegramUser`.
 */
function requireTelegramAuth(config) {
  return function telegramAuth(req, res, next) {
    const raw =
      req.get(HEADER) ||
      req.query.__initData ||
      (req.get('authorization') || '').replace(/^Bearer\s+/i, '');

    if (!raw) {
      res.status(401).json({
        ok: false,
        error: 'unauthorized',
        message: 'This endpoint must be called from inside the Telegram Mini App.',
      });
      return;
    }

    try {
      const payload = verifyInitData(raw, config.botToken, { maxAgeSec: config.maxInitDataAgeSec });
      req.telegram = payload;
      req.telegramUser = payload.user;
      next();
    } catch (err) {
      const known = err instanceof InitDataError;
      if (known && err.details) {
        // Never the payload or hash: only the field names plus the owning
        // bot id, which is what makes a token mismatch diagnosable.
        const { fields, receiver, authDate, payloadBytes } = err.details;
        logger.warn(
          `Rejected a WebApp request: ${err.code} `
          + `(fields=${fields} receiver=${receiver ?? 'none'} `
          + `auth_date=${authDate ?? 'none'} bytes=${payloadBytes})`,
        );
      } else {
        logger.warn(`Rejected a WebApp request: ${known ? err.code : 'unknown_error'}`);
      }
      res.status(401).json({
        ok: false,
        error: known ? err.code : 'unauthorized',
        message: known ? err.message : 'Could not verify your Telegram session.',
      });
    }
  };
}

module.exports = { requireTelegramAuth, INIT_DATA_HEADER: HEADER };
