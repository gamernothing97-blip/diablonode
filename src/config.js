'use strict';
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dataDir = path.resolve(process.env.DATA_DIR || '/var/lib/kvmpanel');
// Everything under DATA_DIR holds secrets and host-level sockets (VM disks, the QEMU monitor,
// the console/VNC Unix sockets). Create it 0700 so only the panel's own user can reach them.
for (const d of [dataDir, path.join(dataDir, 'vms'), path.join(dataDir, 'templates'), path.join(dataDir, 'isos'), path.join(dataDir, 'branding'), path.join(dataDir, 'uploads')]) {
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(d, 0o700); } catch { /* best effort */ }
}

// Session secret: from env, otherwise generated once and stored beside the database.
function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const f = path.join(dataDir, '.session_secret');
  try { return fs.readFileSync(f, 'utf8').trim(); } catch { /* generate below */ }
  const s = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(f, s, { mode: 0o600 });
  return s;
}

module.exports = {
  port: parseInt(process.env.PORT, 10) || 8080,
  host: process.env.HOST || '0.0.0.0',
  dataDir,
  dbFile: path.join(dataDir, 'panel.sqlite'),
  vmDir: path.join(dataDir, 'vms'),
  tplDir: path.join(dataDir, 'templates'),
  isoDir: path.join(dataDir, 'isos'),
  brandingDir: path.join(dataDir, 'branding'),
  uploadDir: path.join(dataDir, 'uploads'),
  getSessionSecret: sessionSecret,
  secureCookies: process.env.SECURE_COOKIES === 'true',
  trustProxy: process.env.TRUST_PROXY === 'true',
  qemuBin: process.env.QEMU_BIN || 'qemu-system-x86_64',
  qemuImg: process.env.QEMU_IMG || 'qemu-img',
  adminUser: process.env.ADMIN_USERNAME || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  adminEmail: process.env.ADMIN_EMAIL || '',
  agent: {
    panelUrl: (process.env.PANEL_URL || '').replace(/\/+$/, ''),
    token: process.env.NODE_TOKEN || '',
  },
  discord: {
    clientId: process.env.DISCORD_CLIENT_ID || '',
    clientSecret: process.env.DISCORD_CLIENT_SECRET || '',
    redirectUri: process.env.DISCORD_REDIRECT_URI || '',
  },
};
