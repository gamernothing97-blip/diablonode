'use strict';
// Per-VM file storage on THIS machine. Every VM gets a folder beside its disk
// (DATA_DIR/vms/<id>/) and users can browse and upload files into it, up to 1 GB each.
// The panel calls these directly for its Local node; the node agent exposes the same
// functions over its tunnel, so the file manager works on any node.
//
// Large uploads travel in chunks so they work over the node tunnel as well as locally:
//   begin(vm, name, size) -> token, then chunk(token, base64) repeatedly, then finish(token).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vmhost = require('./vm');

const MAX_FILE = 1024 * 1024 * 1024; // 1 GB, per the panel's upload limit
// A conservative file name: no slashes, no leading dot, no "..".
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._()\[\]{}@+-]{0,127}$/;
// Files the panel itself owns inside the VM folder. Never listed, never overwritten.
const RESERVED = new Set(['disk.qcow2', 'seed.iso', 'qemu.pid', 'qmp.sock', 'serial.log', 'vnc.sock', 'console.sock', 'seed']);

function vmDir(vm) {
  return vmhost.paths(vm).dir;
}

function safeName(name) {
  const n = String(name == null ? '' : name).trim();
  if (!NAME_RE.test(n) || n.includes('..') || n.includes('/') || n.includes('\\')) throw new Error('That file name is not allowed.');
  if (RESERVED.has(n)) throw new Error('That name is managed by the panel.');
  return n;
}

// Newest first, so a fresh upload shows up at the top of the list.
function list(vm) {
  const dir = vmDir(vm);
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (RESERVED.has(e.name) || e.name.startsWith('.upload-')) continue;
    let st;
    try { st = fs.statSync(path.join(dir, e.name)); } catch { continue; }
    out.push({ name: e.name, size: st.size, mtime: st.mtimeMs, dir: e.isDirectory() });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

function stat(vm, name) {
  const n = safeName(name);
  const full = path.join(vmDir(vm), n);
  const st = fs.statSync(full);
  if (st.isDirectory()) throw new Error('Folders cannot be downloaded.');
  return { name: n, size: st.size };
}

function remove(vm, name) {
  const n = safeName(name);
  fs.rmSync(path.join(vmDir(vm), n), { recursive: true, force: true });
  return true;
}

// Read a slice of a file as base64, so the panel can stream a download from any node.
function readChunk(vm, name, offset, length) {
  const n = safeName(name);
  const full = path.join(vmDir(vm), n);
  const size = fs.statSync(full).size;
  const start = Math.max(0, offset | 0);
  const len = Math.min(Math.max(1, length | 0), 1024 * 1024, size - start);
  if (len <= 0) return { data: '', eof: true, size };
  const fd = fs.openSync(full, 'r');
  try {
    const buf = Buffer.alloc(len);
    const read = fs.readSync(fd, buf, 0, len, start);
    return { data: buf.subarray(0, read).toString('base64'), eof: start + read >= size, size };
  } finally { fs.closeSync(fd); }
}

// ---- chunked upload sessions ----
const sessions = new Map();

function begin(vm, name, size) {
  const n = safeName(name);
  const total = Number(size) || 0;
  if (total > MAX_FILE) throw new Error('Files are limited to 1 GB.');
  const dir = vmDir(vm);
  fs.mkdirSync(dir, { recursive: true });
  const token = crypto.randomBytes(12).toString('hex');
  const dest = path.join(dir, n);
  const tmp = path.join(dir, `.upload-${token}`);
  const fd = fs.openSync(tmp, 'w');
  sessions.set(token, { dest, tmp, fd, written: 0, name: n });
  return token;
}

function chunk(token, b64) {
  const s = sessions.get(token);
  if (!s) throw new Error('The upload session expired. Try again.');
  const buf = Buffer.from(String(b64 || ''), 'base64');
  s.written += buf.length;
  if (s.written > MAX_FILE) {
    try { fs.closeSync(s.fd); } catch { /* already closed */ }
    fs.rmSync(s.tmp, { force: true });
    sessions.delete(token);
    throw new Error('File exceeds the 1 GB limit.');
  }
  fs.writeSync(s.fd, buf);
  return s.written;
}

function finish(token) {
  const s = sessions.get(token);
  if (!s) throw new Error('The upload session expired. Try again.');
  try { fs.closeSync(s.fd); } catch { /* already closed */ }
  fs.renameSync(s.tmp, s.dest);
  sessions.delete(token);
  return { name: s.name, size: s.written };
}

function abort(token) {
  const s = sessions.get(token);
  if (!s) return true;
  try { fs.closeSync(s.fd); } catch { /* already closed */ }
  fs.rmSync(s.tmp, { force: true });
  sessions.delete(token);
  return true;
}

module.exports = { MAX_FILE, list, stat, remove, readChunk, begin, chunk, finish, abort, vmDir };
