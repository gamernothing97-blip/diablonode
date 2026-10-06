'use strict';
// Node agent. Runs on every extra server that hosts VMs.
// It dials OUT to the panel (PANEL_URL) and keeps one WebSocket open, so this machine needs no
// inbound port. The panel sends commands and opens console streams through that connection.
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const agentConfig = require('./agent-config');
agentConfig.load(); // must run before ./config reads the environment
const config = require('./config');
const host = require('./host');
const pkg = require('../package.json');

const { panelUrl, token } = config.agent;
if (!panelUrl || !token) {
  console.error(`PANEL_URL and NODE_TOKEN must be set, normally in ${agentConfig.FILE}. Create the node in the panel under Administration > Nodes and use its Configuration tab.`);
  process.exit(1);
}

const KNOWN_FILE = path.join(config.dataDir, 'known-vms.json');
// After these the agent reports its state first, so the panel's view is never a step behind.
const STATE_CHANGING = new Set(['start', 'stop', 'forceStop', 'reboot', 'destroy', 'provision',
  'downloadTemplate', 'deleteTemplate', 'downloadIso', 'deleteIso', 'attachIso', 'detachIso']);
let known = [];
try { known = JSON.parse(fs.readFileSync(KNOWN_FILE, 'utf8')); } catch { /* first run */ }

// VMs flagged for autostart come back after a reboot even if the panel is unreachable.
host.reconcile(known).catch((e) => console.error('reconcile failed:', e.message));

let backoff = 1000;
let ws = null;
const channels = new Map();
const send = (o) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); };

async function pushState() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    send({
      t: 'state',
      running: known.filter((vm) => host.isRunning(vm)).map((vm) => vm.id),
      stats: host.stats(),
      inventory: await host.inventory(),
    });
  } catch (e) { console.error('state push failed:', e.message); }
}

// The panel's sync can lag a few hundred ms behind a command. So any command that names a VM also
// registers it here, and the running-state report never misses a VM that was just created or started.
const VM_METHODS = new Set(['start', 'stop', 'forceStop', 'reboot', 'attachIso', 'detachIso', 'resizeDisk', 'provision', 'destroy']);
function persistKnown() { try { fs.writeFileSync(KNOWN_FILE, JSON.stringify(known)); } catch (e) { console.error('cannot save VM list:', e.message); } }
function rememberVm(method, vm) {
  if (!VM_METHODS.has(method) || !vm || !Number.isInteger(vm.id)) return;
  known = known.filter((k) => k.id !== vm.id);
  if (method !== 'destroy') known.push(vm);
  persistKnown();
}

async function handleReq({ id, method, args = [] }) {
  try {
    let result;
    if (method !== 'destroy') rememberVm(method, args[0]);
    if (method === 'sync') {
      known = Array.isArray(args[0]) ? args[0] : [];
      persistKnown();
      result = true;
    } else {
      const fn = host.methods[method];
      if (!fn) throw new Error(`Unknown operation ${method}`);
      result = await fn(...args);
      if (method === 'destroy') rememberVm(method, args[0]);
    }
    // Report the new state before the reply so the panel never shows a stale status.
    if (STATE_CHANGING.has(method) || method === 'sync') await pushState();
    send({ t: 'res', id, ok: true, result: result === undefined ? null : result });
  } catch (e) {
    if (STATE_CHANGING.has(method)) await pushState();
    send({ t: 'res', id, ok: false, error: e.message });
  }
}

async function handleOpen({ ch, kind, vm, opts }) {
  try {
    const s = await host.openStream(kind, vm, opts || {});
    channels.set(ch, s);
    s.on('data', (d) => {
      const head = Buffer.alloc(4);
      head.writeUInt32BE(ch, 0);
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(Buffer.concat([head, Buffer.isBuffer(d) ? d : Buffer.from(d)]));
    });
    s.on('event', (data) => send({ t: 'ch', ch, ev: 'event', data }));
    s.on('close', () => { channels.delete(ch); send({ t: 'ch', ch, ev: 'close' }); });
    send({ t: 'ch', ch, ev: 'opened' });
  } catch (e) {
    send({ t: 'ch', ch, ev: 'error', message: e.message });
  }
}

function connect() {
  const url = panelUrl.replace(/^http/i, 'ws') + '/ws/node';
  const sock = new WebSocket(url, { headers: { authorization: `Bearer ${token}` }, handshakeTimeout: 15000, maxPayload: 4 * 1024 * 1024 });
  ws = sock;
  let alive = Date.now();
  let tick = null;
  let watchdog = null;

  sock.on('open', () => {
    backoff = 1000;
    console.log(`connected to ${url}`);
    send({ t: 'hello', meta: { version: pkg.version, ...host.stats() } });
    pushState();
    tick = setInterval(pushState, 5000);
    // The panel pings every 30 s. Silence for over a minute means the link is dead.
    watchdog = setInterval(() => { if (Date.now() - alive > 75000) sock.terminate(); }, 15000);
  });
  sock.on('ping', () => { alive = Date.now(); });
  sock.on('message', (data, isBinary) => {
    alive = Date.now();
    if (isBinary) { channels.get(data.readUInt32BE(0))?.write(data.subarray(4)); return; }
    let m;
    try { m = JSON.parse(data.toString()); } catch { return; }
    if (m.t === 'req') handleReq(m);
    else if (m.t === 'open') handleOpen(m);
    else if (m.t === 'ctl') channels.get(m.ch)?.control(m.data);
    else if (m.t === 'close') channels.get(m.ch)?.close();
  });
  sock.on('unexpected-response', (req, res) => {
    console.error(res.statusCode === 401 ? 'The panel rejected the node token. Check NODE_TOKEN.' : `The panel answered HTTP ${res.statusCode}. Check PANEL_URL.`);
    res.resume();
    sock.terminate();
  });
  sock.on('error', (e) => { if (e && e.message && !/Unexpected server response/.test(e.message)) console.error('connection error:', e.message); });
  sock.on('close', () => {
    clearInterval(tick);
    clearInterval(watchdog);
    for (const [, s] of channels) s.close();
    channels.clear();
    ws = null;
    console.log(`disconnected, retrying in ${Math.round(backoff / 1000)}s`);
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30000);
  });
}

console.log(`Diablo node agent ${pkg.version}, data in ${config.dataDir}`);
connect();
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0)); // VMs are daemonized and keep running
