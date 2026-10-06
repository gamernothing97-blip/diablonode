'use strict';
// Wings-style config file for the node agent: /etc/diablo-node/config.yml
//
//   panel_url: https://panel.example.com
//   token: knode_...
//   data_dir: /var/lib/kvmpanel-node
//
// Flat "key: value" lines with # comments. Environment variables still win, so a value set in the
// service environment overrides the file.
const fs = require('fs');

const FILE = process.env.CONFIG_FILE || '/etc/diablo-node/config.yml';
const ENV = { panel_url: 'PANEL_URL', token: 'NODE_TOKEN', data_dir: 'DATA_DIR' };

function parse(text) {
  const out = {};
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function load() {
  let text;
  try { text = fs.readFileSync(FILE, 'utf8'); } catch { return null; }
  const conf = parse(text);
  for (const [key, env] of Object.entries(ENV)) if (conf[key] && !process.env[env]) process.env[env] = conf[key];
  return conf;
}

module.exports = { load, parse, FILE };
