'use strict';
const { run } = require('../util');

const tapName = (vm) => `tap${vm.id}`;

async function bridgeExists(name) {
  try { await run('ip', ['link', 'show', name]); return true; } catch { return false; }
}

// Create a tap device, attach it to the bridge and (optionally) put it on a VLAN.
// Needs root and a bridge that already exists on the host.
async function setupTap(vm) {
  const tap = tapName(vm);
  if (!(await bridgeExists(vm.bridge))) {
    throw new Error(`Bridge "${vm.bridge}" does not exist on this host. Create it first or switch this VM to NAT networking.`);
  }
  await teardownTap(vm);
  await run('ip', ['tuntap', 'add', 'dev', tap, 'mode', 'tap']);
  try {
    await run('ip', ['link', 'set', tap, 'master', vm.bridge]);
    await run('ip', ['link', 'set', tap, 'up']);
    if (vm.vlan) {
      await run('bridge', ['vlan', 'del', 'dev', tap, 'vid', '1']).catch(() => {});
      await run('bridge', ['vlan', 'add', 'dev', tap, 'vid', String(vm.vlan), 'pvid', 'untagged']);
    }
  } catch (e) {
    await teardownTap(vm);
    throw e;
  }
  return tap;
}

async function teardownTap(vm) {
  await run('ip', ['link', 'del', tapName(vm)]).catch(() => {});
}

module.exports = { tapName, setupTap, teardownTap, bridgeExists };
