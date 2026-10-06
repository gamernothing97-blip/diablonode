'use strict';
// Everything a machine that runs VMs can do. The panel calls this directly for its built-in
// "Local" node; the node agent exposes the same `methods` over its tunnel to the panel.
const vm = require('./vm');
const images = require('./images');
const files = require('./files');
const guestfs = require('./guestfs');
const { openStream } = require('./streams');
const { stats } = require('./stats');

module.exports = {
  HAS_KVM: vm.HAS_KVM,
  paths: vm.paths,
  isRunning: vm.isRunning,
  status: vm.status,
  buildArgs: vm.buildArgs,
  qmp: vm.qmp,
  reconcile: vm.reconcile,
  openStream,
  stats,
  inventory: images.inventory,
  // Remote-callable operations. Arguments and results are plain JSON.
  methods: {
    start: vm.start,
    stop: vm.stop,
    forceStop: vm.forceStop,
    reboot: vm.reboot,
    suspend: vm.suspend,
    resume: vm.resume,
    vmCpuTicks: (v) => vm.cpuTicks(v),
    vmStats: (v) => vm.vmStats(v),
    sshxLink: vm.sshxLink,
    sshxStop: vm.sshxStop,
    sshxRestart: vm.sshxRestart,
    installSshx: vm.installSshx,
    attachIso: vm.attachIso,
    detachIso: vm.detachIso,
    resizeDisk: vm.resizeDisk,
    provision: vm.provision,
    destroy: vm.destroy,
    downloadTemplate: async (tpl) => images.startTemplateDownload(tpl),
    deleteTemplate: async (filename) => images.deleteTemplate(filename),
    downloadIso: async (url) => images.downloadIso(url),
    deleteIso: async (name) => images.deleteIso(name),
    // Per-VM file manager (works locally and on remote nodes).
    listVmFiles: (v) => files.list(v),
    statVmFile: (v, name) => files.stat(v, name),
    readVmFileChunk: (v, name, offset, length) => files.readChunk(v, name, offset, length),
    deleteVmFile: (v, name) => files.remove(v, name),
    beginVmFile: (v, name, size) => files.begin(v, name, size),
    chunkVmFile: (token, b64) => files.chunk(token, b64),
    finishVmFile: (token) => files.finish(token),
    abortVmFile: (token) => files.abort(token),
    // Guest filesystem browser (libguestfs): read the VM's real disk, read-only.
    guestfsAvailable: () => guestfs.available(),
    listGuestFiles: (v, dir) => guestfs.list(v, dir),
    readGuestFile: (v, p, max) => guestfs.readFile(v, p, max),
  },
};
