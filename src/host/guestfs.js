'use strict';
// Guest filesystem browser. Reads the VM's own disk image (not the host-side VM folder) with
// libguestfs, so users can see and download the real files inside their VM without booting it or
// opening a terminal. Everything runs read-only. If libguestfs is not installed the panel degrades
// gracefully: the browser reports that the node needs libguestfs-tools.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run } = require('../util');
const vmMod = require('./vm');

const TMP = () => path.join(os.tmpdir(), `kvmp-gf-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);

async function available() {
  try { await run('guestfish', ['--version']); return true; } catch { return false; }
}

function diskOf(vm) {
  const p = vmMod.paths(vm).disk;
  if (!fs.existsSync(p)) throw new Error('This VM has no disk yet. Start it once so the disk is created.');
  return p;
}

// Run a short guestfish script against the VM disk, read-only, with inspection (auto-mount).
async function runScript(disk, lines) {
  const file = TMP() + '.sh';
  fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
  try {
    const { stdout } = await run('guestfish', ['--ro', '-a', disk, '-i', '-f', file], {
      timeout: 180000,
      env: { ...process.env, LIBGUESTFS_BACKEND: 'direct' },
    });
    return stdout;
  } finally { fs.rmSync(file, { force: true }); }
}

// Parse the long listing that guestfish's `ll` command prints (like `ls -l`).
function parseLong(out) {
  const items = [];
  for (const raw of out.split('\n')) {
    const line = raw.replace(/\r$/, '').trimEnd();
    if (!line.trim() || /^total\b/i.test(line.trim())) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 9) continue;
    const mode = parts[0];
    if (!/^[-dlbcps]/.test(mode)) continue;
    let name = parts.slice(8).join(' ');
    let link = null;
    const arrow = name.indexOf(' -> ');
    if (arrow >= 0) { link = name.slice(arrow + 4); name = name.slice(0, arrow); }
    if (name === '.' || name === '..') continue;
    const size = parseInt(parts[4], 10);
    items.push({ name, dir: mode[0] === 'd', link, size: Number.isFinite(size) ? size : 0, mode });
  }
  // Directories first, then alphabetical.
  items.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  return items;
}

async function list(vm, dir) {
  const d = String(dir || '/');
  if (!d.startsWith('/')) throw new Error('Path must be absolute.');
  const out = await runScript(diskOf(vm), [`ll ${JSON.stringify(d)}`]);
  return parseLong(out);
}

// Read a file from inside the guest (read-only), capped so a huge file cannot exhaust memory.
async function readFile(vm, guestPath, maxBytes = 2 * 1024 * 1024) {
  const p = String(guestPath || '');
  if (!p.startsWith('/')) throw new Error('Path must be absolute.');
  const local = TMP() + '.bin';
  try {
    await runScript(diskOf(vm), [`download ${JSON.stringify(p)} ${JSON.stringify(local)}`]);
    const size = fs.statSync(local).size;
    const len = Math.min(size, maxBytes);
    const fd = fs.openSync(local, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    fs.closeSync(fd);
    return { data: buf.toString('base64'), size, truncated: size > len };
  } finally { fs.rmSync(local, { force: true }); }
}

module.exports = { available, list, readFile };
