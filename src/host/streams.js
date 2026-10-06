'use strict';
// Console streams on THIS machine. Every kind (VNC, serial, log tail, SSH) exposes the same
// small interface, so the panel can bridge a browser to a local VM or, through a node's tunnel,
// to a VM on another server without caring which.
//
//   stream.write(buf)      data from the browser
//   stream.control(obj)    out-of-band commands, e.g. {type:'resize', cols, rows}
//   stream.close()
//   'data'  (Buffer)       data for the browser
//   'event' ({type, ...})  status such as ready / error / closed
//   'close'
const fs = require('fs');
const net = require('net');
const { EventEmitter } = require('events');
const { Client: SshClient } = require('ssh2');
const vmhost = require('./vm');

class Stream extends EventEmitter {
  constructor() { super(); this.closed = false; }
  write() {}
  control() {}
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this._destroy) this._destroy();
    this.emit('close');
  }
}

function socketStream(sockPath, failMessage) {
  const s = new Stream();
  const sock = net.createConnection(sockPath);
  sock.on('data', (d) => s.emit('data', d));
  sock.on('error', () => { s.emit('event', { type: 'error', message: failMessage }); s.close(); });
  sock.on('close', () => s.close());
  s.write = (d) => { if (sock.writable) sock.write(d); };
  s._destroy = () => sock.destroy();
  return s;
}

// Tails the serial log: sends the last 16 KB, then whatever is appended.
function logStream(vm) {
  const s = new Stream();
  const file = vmhost.paths(vm).serial;
  let pos = 0;
  const push = () => {
    let st;
    try { st = fs.statSync(file); } catch { return; }
    if (st.size < pos) pos = 0; // truncated by a restart
    if (st.size === pos) return;
    const fd = fs.openSync(file, 'r');
    try {
      const len = Math.min(st.size - pos, 256 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, pos);
      pos += len;
      s.emit('data', buf);
    } finally { fs.closeSync(fd); }
  };
  try { pos = Math.max(0, fs.statSync(file).size - 16 * 1024); } catch { /* not created yet */ }
  setImmediate(push);
  const timer = setInterval(push, 700);
  s._destroy = () => clearInterval(timer);
  return s;
}

// SSH from this machine to the VM (bridge VMs). The target is fixed by the VM record so the
// panel cannot be used as a jump host; the panel only passes opts.host for admins on DHCP VMs.
function sshStream(vm, opts) {
  const s = new Stream();
  const fail = (message) => setImmediate(() => { s.emit('event', { type: 'error', message }); });
  if (vm.net_mode === 'user') { fail('NAT VMs have no inbound SSH. Use the serial console instead.'); return s; }
  const host = vm.ip || String(opts.host || '');
  if (!host) { fail('This VM has no fixed IP address, so SSH cannot reach it.'); return s; }

  let size = { cols: Math.min(500, opts.cols | 0 || 80), rows: Math.min(200, opts.rows | 0 || 24) };
  let shell = null;
  const conn = new SshClient();
  conn.on('ready', () => {
    conn.shell({ term: 'xterm-256color', cols: size.cols, rows: size.rows }, (err, sh) => {
      if (err) return s.emit('event', { type: 'error', message: err.message });
      shell = sh;
      s.emit('event', { type: 'ready' });
      sh.on('data', (d) => s.emit('data', d));
      sh.stderr.on('data', (d) => s.emit('data', d));
      sh.on('close', () => { s.emit('event', { type: 'closed' }); conn.end(); });
    });
  });
  conn.on('error', (e) => s.emit('event', {
    type: 'error',
    message: e.level === 'client-authentication' ? 'Login failed. Check the username and password.' : `Connection failed: ${e.message}`,
  }));
  conn.connect({
    host, port: 22, username: String(opts.username || vm.guest_user || 'root').slice(0, 64), password: String(opts.password || ''),
    readyTimeout: 15000, hostVerifier: () => true, // guest host keys change on every reinstall
  });
  s.write = (d) => { if (shell) shell.write(d); };
  s.control = (o) => {
    if (o && o.type === 'resize') {
      size = { cols: Math.min(500, o.cols | 0 || 80), rows: Math.min(200, o.rows | 0 || 24) };
      if (shell) shell.setWindow(size.rows, size.cols, 0, 0);
    }
  };
  s._destroy = () => { try { if (shell) shell.end(); conn.end(); } catch { /* already closed */ } };
  return s;
}

async function openStream(kind, vm, opts = {}) {
  if (kind === 'logs') return logStream(vm);
  if (!vm || !vmhost.isRunning(vm)) throw new Error('The VM is not running');
  const p = vmhost.paths(vm);
  if (kind === 'vnc') return socketStream(p.vnc, 'Could not reach the VM display');
  if (kind === 'serial') return socketStream(p.console, 'Could not open the serial console');
  if (kind === 'ssh') return sshStream(vm, opts);
  throw new Error('Unknown stream type');
}

module.exports = { Stream, openStream };
