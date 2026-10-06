'use strict';
const os = require('os');
const fs = require('fs');
const config = require('../config');
const { HAS_KVM } = require('./vm');

function stats() {
  let disk = null;
  try { const s = fs.statfsSync(config.dataDir); disk = { free: s.bavail * s.bsize, total: s.blocks * s.bsize }; } catch { /* unsupported */ }
  return {
    hostname: os.hostname(),
    cpus: os.cpus().length,
    load: os.loadavg()[0],
    memTotal: os.totalmem(),
    memFree: os.freemem(),
    diskTotal: disk ? disk.total : 0,
    diskFree: disk ? disk.free : 0,
    uptime: os.uptime(),
    hasKvm: HAS_KVM,
  };
}
module.exports = { stats };
