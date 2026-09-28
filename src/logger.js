'use strict';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold = LEVELS.info;

function setLevel(level) {
  if (LEVELS[level]) threshold = LEVELS[level];
}

function write(level, message, meta) {
  if (LEVELS[level] < threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}`;
  const stream = LEVELS[level] >= LEVELS.error ? console.error : console.log;
  if (meta === undefined) stream(line);
  else stream(line, meta);
}

const logger = {
  setLevel,
  debug: (message, meta) => write('debug', message, meta),
  info: (message, meta) => write('info', message, meta),
  warn: (message, meta) => write('warn', message, meta),
  error: (message, meta) => write('error', message, meta),
};

module.exports = logger;
