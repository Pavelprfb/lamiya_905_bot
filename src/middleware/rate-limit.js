'use strict';

const rateLimit = require('express-rate-limit');
const logger = require('../logger');

function buildLimiters() {
  const common = {
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) => {
      logger.warn(`Rate limit hit on ${req.method} ${req.path}`);
      res.status(429).json({
        ok: false,
        error: 'rate_limited',
        message: 'Too many attempts. Please wait a moment and try again.',
      });
    },
  };

  return {
    // Requesting a login code: the expensive, abuse-prone step.
    sendCode: rateLimit({
      ...common,
      windowMs: 10 * 60 * 1000,
      limit: 8,
      keyGenerator: (req) => `code:${req.telegramUser?.id || req.ip}`,
    }),

    // Submitting a code: a few tries are normal, a burst is not.
    verifyCode: rateLimit({
      ...common,
      windowMs: 10 * 60 * 1000,
      limit: 20,
      keyGenerator: (req) => `verify:${req.telegramUser?.id || req.ip}`,
    }),

    // Everything else.
    general: rateLimit({
      ...common,
      windowMs: 60 * 1000,
      limit: 120,
    }),
  };
}

module.exports = { buildLimiters };
