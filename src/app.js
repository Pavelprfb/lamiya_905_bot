'use strict';

const path = require('node:path');
const express = require('express');
const helmet = require('helmet');

const logger = require('./logger');
const { createAuthRouter } = require('./routes/auth');
const { notFound, errorHandler } = require('./middleware/error-handler');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SHARED_DIR = path.join(__dirname, '..', 'shared');

function createApp({ config, sessionStore, authService, attempts }) {
  const app = express();

  app.set('trust proxy', config.trustProxy);
  app.set('x-powered-by', false);
  app.set('etag', 'strong');

  app.use(
    helmet({
      // The WebApp is rendered inside Telegram's iframe, so X-Frame-Options would
      // break it; frame-ancestors pins the allowed parents instead.
      frameguard: false,
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", 'https://telegram.org'],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'https:'],
          connectSrc: ["'self'"],
          frameAncestors: ['https://web.telegram.org', 'https://*.telegram.org', 'https://telegram.org'],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          objectSrc: ["'none'"],
        },
      },
    }),
  );

  app.use(express.json({ limit: '16kb' }));

  // Liveness probe for Docker / the load balancer.
  app.get('/healthz', (req, res) => {
    res.json({
      ok: true,
      uptimeSec: Math.round(process.uptime()),
      sessions: sessionStore.count(),
      pendingLogins: attempts.attempts.size,
    });
  });

  // Country list shared by the server-side validator and the WebApp country picker.
  app.use(
    '/shared',
    express.static(SHARED_DIR, {
      maxAge: '1h',
      setHeaders: (res) => res.setHeader('Content-Type', 'application/json; charset=utf-8'),
    }),
  );

  app.use('/api/auth', createAuthRouter({ config, sessionStore, authService, attempts }));

  app.use(
    express.static(PUBLIC_DIR, {
      index: 'index.html',
      maxAge: '5m',
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
      },
    }),
  );

  app.use('/api', notFound);

  // Anything else renders the single-page WebApp shell.
  app.get('*', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  app.use(errorHandler);

  app.locals.config = config;
  logger.debug(`Express app ready (public: ${PUBLIC_DIR})`);

  return app;
}

module.exports = { createApp };
