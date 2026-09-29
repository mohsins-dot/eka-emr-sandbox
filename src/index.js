#!/usr/bin/env node
'use strict';
const config = require('./config');
const { createServer } = require('./server');

const server = createServer();
server.listen(config.port, config.host, () => {
  const base = `http://localhost:${config.port}`;
  console.log(`
  Eka Doc Tool Sandbox is running
  ─────────────────────────────────────────────
  Base URL       ${base}      (use instead of https://api.eka.care)
  Dashboard      ${base}/
  client_id      ${config.clientId}
  client_secret  ${config.clientSecret}
  Data file      ${config.persist ? config.dataFile : '(in-memory only)'}
  `);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    require('./store').flush();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
