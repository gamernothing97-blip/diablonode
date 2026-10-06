'use strict';
// OS templates and ISOs stored on THIS machine (the panel host or a node). No database here:
// the panel keeps template metadata, each host only knows which files it has.
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const config = require('../config');
const { run } = require('../util');

const TPL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.(qcow2|img|raw)$/;
const ISO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.iso$/;

// Progress of downloads, keyed "tpl:<file>" or "iso:<file>". Kept in memory.
const jobs = new Map();

function tplPath(filename) {
  if (!TPL_RE.test(String(filename))) throw new Error('Invalid template file name');
  return path.join(config.tplDir, filename);
}

const infoCache = new Map();
async function imageInfo(file) {
  const st = fs.statSync(file);
  const key = `${file}:${st.mtimeMs}:${st.size}`;
  if (infoCache.has(key)) return infoCache.get(key);
  const { stdout } = await run(config.qemuImg, ['info', '--output=json', file]);
  const j = JSON.parse(stdout);
  const info = { format: j.format, virtualSize: j['virtual-size'] };
  infoCache.set(key, info);
  return info;
}

async function templateFormat(filename) {
  const file = tplPath(filename);
  if (!fs.existsSync(file)) throw new Error('That OS image has not been downloaded to this node yet.');
  try { return JSON.parse(fs.readFileSync(file + '.meta.json', 'utf8')).format; } catch { /* no sidecar */ }
  return (await imageInfo(file)).format;
}

async function download(url, dest, key) {
  const job = { received: 0, total: 0, status: 'running', error: null };
  jobs.set(key, job);
  const tmp = dest + '.part';
  try {
    if (!/^https?:\/\//i.test(url)) throw new Error('Only http and https URLs are supported');
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`Server answered ${res.status} ${res.statusText}`);
    job.total = parseInt(res.headers.get('content-length'), 10) || 0;
    const body = Readable.fromWeb(res.body);
    body.on('data', (c) => { job.received += c.length; });
    await pipeline(body, fs.createWriteStream(tmp));
    fs.renameSync(tmp, dest);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    job.status = 'failed';
    job.error = e.message;
    throw e;
  }
  return job;
}

// Starts a background download and returns immediately. Progress shows up in inventory().jobs.
function startTemplateDownload({ filename, url }) {
  const dest = tplPath(filename);
  const key = `tpl:${filename}`;
  if (jobs.get(key)?.status === 'running') throw new Error('A download of this image is already running on that node');
  (async () => {
    try {
      const job = await download(url, dest, key);
      const info = await imageInfo(dest);
      fs.writeFileSync(dest + '.meta.json', JSON.stringify({ format: info.format }));
      job.status = 'done';
    } catch (e) {
      fs.rmSync(dest, { force: true });
      const j = jobs.get(key);
      if (j) { j.status = 'failed'; j.error = j.error || e.message; }
    }
  })();
  return true;
}

function deleteTemplate(filename) {
  const file = tplPath(filename);
  fs.rmSync(file, { force: true });
  fs.rmSync(file + '.meta.json', { force: true });
  jobs.delete(`tpl:${filename}`);
  return true;
}

// ---- ISO library ----
function listIsos() {
  return fs.readdirSync(config.isoDir).filter((f) => ISO_RE.test(f))
    .map((f) => ({ name: f, size: fs.statSync(path.join(config.isoDir, f)).size }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
function downloadIso(url) {
  let name;
  try { name = decodeURIComponent(path.basename(new URL(url).pathname)); } catch { throw new Error('That is not a valid URL'); }
  if (!ISO_RE.test(name)) throw new Error('The URL must point to a file ending in .iso with a simple file name');
  const key = `iso:${name}`;
  if (jobs.get(key)?.status === 'running') throw new Error('A download of this ISO is already running on that node');
  download(url, path.join(config.isoDir, name), key).then((j) => { j.status = 'done'; }).catch(() => {});
  return name;
}
function deleteIso(name) {
  if (!ISO_RE.test(String(name))) throw new Error('Invalid ISO name');
  fs.rmSync(path.join(config.isoDir, name), { force: true });
  jobs.delete(`iso:${name}`);
  return true;
}

// Everything this machine has: used by the panel to know which nodes can build which VMs.
async function inventory() {
  const templates = {};
  for (const f of fs.readdirSync(config.tplDir)) {
    if (!TPL_RE.test(f)) continue;
    let format = null;
    try { format = await templateFormat(f); } catch { /* unreadable image */ }
    templates[f] = { size: fs.statSync(path.join(config.tplDir, f)).size, format };
  }
  return { templates, isos: listIsos(), jobs: Object.fromEntries([...jobs].map(([k, j]) => [k, { ...j }])) };
}

module.exports = {
  TPL_RE, ISO_RE, tplPath, templateFormat, startTemplateDownload, deleteTemplate,
  listIsos, downloadIso, deleteIso, inventory,
};
