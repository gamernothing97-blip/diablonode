'use strict';
const crypto = require('crypto');
const { execFile } = require('child_process');

const HOSTNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
const LINUX_USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const PANEL_USER_RE = /^[a-zA-Z0-9_.-]{3,32}$/;
// Origin of an sshx server, e.g. https://sshx.io (no path, no credentials). It ends up in a systemd unit
// inside the guest, so it is kept to a strict character set.
const SSHX_SERVER_RE = /^https?:\/\/[A-Za-z0-9.-]{1,253}(:\d{1,5})?$/;
const SSHX_DEFAULT_SERVER = 'https://sshx.io';

function isIPv4(s) {
  if (typeof s !== 'string') return false;
  const p = s.split('.');
  return p.length === 4 && p.every((x) => /^\d{1,3}$/.test(x) && +x <= 255);
}
const isPrefix = (n) => Number.isInteger(n) && n >= 1 && n <= 32;
const isSshKey = (s) => /^(ssh-(rsa|ed25519)|ecdsa-sha2-nistp\d+|sk-ssh-ed25519@openssh\.com) [A-Za-z0-9+/=]+( .*)?$/.test(s.trim());

function randomMac() {
  const b = crypto.randomBytes(3);
  return '52:54:00:' + [...b].map((x) => x.toString(16).padStart(2, '0')).join(':');
}
const randomToken = (n = 32) => crypto.randomBytes(n).toString('hex');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ---- Port forwards -------------------------------------------------------------------------
// A forward maps a public host address to a port inside a NAT VM. Stored as JSON on the VM row so
// it travels to whichever node runs the VM. Everything is validated here because the value is
// turned into a QEMU command-line argument.
const isPort = (n) => Number.isInteger(n) && n >= 1 && n <= 65535;
const isHostIp = (s) => !s || s === '0.0.0.0' || isIPv4(s);

function parseForwards(raw) {
  let list = raw;
  if (typeof raw === 'string') {
    if (!raw.trim()) return [];
    try { list = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const f of list) {
    if (!f || typeof f !== 'object') continue;
    const proto = f.proto === 'udp' ? 'udp' : 'tcp';
    if (!isPort(Number(f.host_port)) || !isPort(Number(f.vm_port))) continue;
    if (!isHostIp(String(f.host_ip || ''))) continue;
    out.push({
      id: String(f.id || randomToken(4)).slice(0, 16),
      host_ip: String(f.host_ip || '').trim(),
      host_port: Number(f.host_port),
      vm_port: Number(f.vm_port),
      proto,
      label: String(f.label || '').slice(0, 40),
    });
  }
  return out;
}
// QEMU hostfwd option for one forward, e.g. hostfwd=tcp:203.0.113.5:2222-:22
const forwardArg = (f) => `hostfwd=${f.proto}:${f.host_ip || '0.0.0.0'}:${f.host_port}-:${f.vm_port}`;

function formatBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return (n / 1024 ** i).toFixed(i ? 1 : 0) + ' ' + u[i];
}
function formatMb(mb) { return mb >= 1024 ? (mb / 1024).toFixed(mb % 1024 ? 1 : 0) + ' GB' : mb + ' MB'; }

// Promise wrapper around execFile that keeps stderr in the error message.
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 60000, maxBuffer: 8 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) {
        const detail = (stderr || stdout || err.message || '').toString().trim().split('\n').slice(-3).join(' ');
        const e = new Error(`${cmd} failed: ${detail}`);
        e.code = err.code;
        return reject(e);
      }
      resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = {
  HOSTNAME_RE, LINUX_USER_RE, PANEL_USER_RE, SSHX_SERVER_RE, SSHX_DEFAULT_SERVER,
  isIPv4, isPrefix, isSshKey, randomMac, randomToken, sha256, formatBytes, formatMb, run, sleep,
  isPort, isHostIp, parseForwards, forwardArg,
};
