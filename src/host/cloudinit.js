'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { run, LINUX_USER_RE, SSHX_SERVER_RE, SSHX_DEFAULT_SERVER } = require('../util');

// SHA-512 crypt hash. The panel hashes the guest password, so the plain text never
// leaves the panel and never lands on a node or on the seed image.
function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const p = execFile('openssl', ['passwd', '-6', '-stdin'], (err, stdout) => {
      if (err) return reject(new Error('openssl is required to hash guest passwords'));
      resolve(stdout.trim());
    });
    p.stdin.end(password);
  });
}

const q = (s) => JSON.stringify(String(s)); // JSON strings are valid YAML scalars
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

// ---- SSHX: a browser terminal inside every VM ----
// A small root service in the guest starts sshx as the login user and prints the session link on
// the serial console; the panel picks it up from the serial log (see vm.sshxLink). It needs only
// outbound internet, so it works on NAT VMs too and opens nothing on the host.
const SSHX_SCRIPT = fs.readFileSync(path.join(__dirname, 'guest-sshx.sh'), 'utf8');

function sshxUnit(user, server) {
  return [
    '[Unit]',
    'Description=Diablo SSHX browser terminal',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    `ExecStart=/usr/local/sbin/diablo-sshx ${user} ${server}`,
    'ExecStopPost=/usr/local/sbin/diablo-sshx --mark stopped',
    'Restart=always',
    'RestartSec=10',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
}

// The serial console auto-logs in the guest user, so opening the panel's Terminal drops the user
// straight into a root shell with no password (container-like access). Written as a systemd
// drop-in so it overrides the stock unit's ExecStart.
function autologinConf(user) {
  return [
    '[Service]',
    'ExecStart=',
    `ExecStart=-/sbin/agetty --autologin ${user} --noclear %I $TERM`,
    '',
  ].join('\n');
}

const ROOT_SSH_CONF = ['PermitRootLogin yes', 'PasswordAuthentication yes', ''].join('\n');

// A single cloud-config file. Everything that writes a file goes into ONE `write_files:` list and
// everything that runs a command goes into ONE `runcmd:` list. Emitting the same top-level key
// twice makes YAML keep only the last one, which silently drops the earlier block -- that is what
// previously stopped the SSHX service from ever being enabled, so SSHX never came up.
function userData(vm, passwordHash, sshx) {
  // "root" is a first-class login user here: the panel builds VMs that you reach directly as root
  // over SSH and on the serial console, with no extra sudo account in the way.
  const asRoot = String(vm.guest_user) === 'root';
  const lines = [
    '#cloud-config',
    `hostname: ${vm.name}`,
    'manage_etc_hosts: true',
    'ssh_pwauth: true',
    `disable_root: ${asRoot ? 'false' : 'true'}`,
    'users:',
    '  - default',
    `  - name: ${vm.guest_user}`,
  ];
  if (asRoot) {
    lines.push('    lock_passwd: false', `    passwd: ${q(passwordHash)}`);
  } else {
    lines.push(
      '    groups: [sudo, wheel]',
      '    sudo: ALL=(ALL) NOPASSWD:ALL',
      '    shell: /bin/bash',
      '    lock_passwd: false',
      `    passwd: ${q(passwordHash)}`,
    );
  }
  if (vm.ssh_key) {
    lines.push('    ssh_authorized_keys:');
    for (const k of vm.ssh_key.split('\n').map((s) => s.trim()).filter(Boolean)) lines.push(`      - ${q(k)}`);
  }
  lines.push('package_update: false', 'growpart:', '  mode: auto', '  devices: ["/"]', 'resize_rootfs: true');

  // ---- one write_files: list ----
  const files = [];
  const sshxOn = !!(sshx && sshx.enabled);
  if (sshxOn) {
    const server = sshx.server || SSHX_DEFAULT_SERVER;
    if (!LINUX_USER_RE.test(String(vm.guest_user)) || !SSHX_SERVER_RE.test(server)) throw new Error('Invalid SSHX settings');
    files.push({ path: '/usr/local/sbin/diablo-sshx', permissions: '0755', content: SSHX_SCRIPT });
    files.push({ path: '/etc/systemd/system/diablo-sshx.service', permissions: '0644', content: sshxUnit(vm.guest_user, server) });
  }
  files.push({ path: '/etc/systemd/system/serial-getty@ttyS0.service.d/autologin.conf', permissions: '0644', content: autologinConf(vm.guest_user) });
  if (asRoot) files.push({ path: '/etc/ssh/sshd_config.d/99-diablo-root.conf', permissions: '0644', content: ROOT_SSH_CONF });

  if (files.length) {
    lines.push('write_files:');
    for (const f of files) {
      lines.push(`  - path: ${f.path}`);
      lines.push(`    permissions: "${f.permissions}"`);
      lines.push('    encoding: b64');
      lines.push(`    content: ${b64(f.content)}`);
    }
  }

  // ---- one runcmd: list ----
  const cmds = ['[systemctl, daemon-reload]'];
  // A getty on ttyS0 that auto-logs in the guest user, so the serial console in the panel is a
  // ready root shell with no password. Cloud images already enable+start this unit long before
  // cloud-init's runcmd runs, so "enable --now" is a no-op on an already-active service and never
  // picks up the autologin drop-in written above. An explicit restart forces it to re-exec with
  // the new ExecStart every time, which is what actually makes the console auto-log in.
  cmds.push('[systemctl, enable, serial-getty@ttyS0.service]');
  cmds.push('[systemctl, restart, serial-getty@ttyS0.service]');
  if (sshxOn) {
    cmds.push('[systemctl, enable, diablo-sshx.service]');
    // --no-block: cloud-init is still running, and this must not wait on anything ordered after it.
    cmds.push('[systemctl, start, --no-block, diablo-sshx.service]');
  }
  lines.push('runcmd:');
  for (const c of cmds) lines.push(`  - ${c}`);

  return lines.join('\n') + '\n';
}

function networkConfig(vm) {
  const iface = ['version: 2', 'ethernets:', '  net0:', '    match:', `      macaddress: ${q(vm.mac)}`];
  if (vm.net_mode === 'bridge' && vm.ip) {
    const dns = (vm.dns || '').split(',').map((s) => s.trim()).filter(Boolean);
    iface.push('    dhcp4: false', '    addresses:', `      - ${vm.ip}/${vm.prefix || 24}`);
    if (vm.gateway) iface.push('    routes:', '      - to: 0.0.0.0/0', `        via: ${vm.gateway}`);
    if (dns.length) iface.push('    nameservers:', `      addresses: [${dns.join(', ')}]`);
  } else {
    iface.push('    dhcp4: true');
  }
  return iface.join('\n') + '\n';
}

function metaData(vm, instanceSuffix) {
  return `instance-id: kvmp-${vm.uuid}-${instanceSuffix}\nlocal-hostname: ${vm.name}\n`;
}

async function isoTool() {
  for (const [bin, args] of [['genisoimage', []], ['mkisofs', []], ['xorriso', ['-as', 'mkisofs']]]) {
    try { await run(bin, [...args, '--version']); return [bin, args]; } catch (e) { if (e.code !== 'ENOENT') return [bin, args]; }
  }
  throw new Error('Install genisoimage (or xorriso) on the node to build the cloud-init seed image');
}

// Writes user-data/meta-data/network-config and packs them into seed.iso (label "cidata").
async function buildSeed(vm, dir, passwordHash, sshx) {
  const stage = path.join(dir, 'seed');
  fs.mkdirSync(stage, { recursive: true });
  fs.writeFileSync(path.join(stage, 'user-data'), userData(vm, passwordHash, sshx), { mode: 0o600 });
  fs.writeFileSync(path.join(stage, 'meta-data'), metaData(vm, Date.now()));
  fs.writeFileSync(path.join(stage, 'network-config'), networkConfig(vm));
  const [bin, pre] = await isoTool();
  const out = path.join(dir, 'seed.iso');
  await run(bin, [...pre, '-output', out, '-volid', 'cidata', '-joliet', '-rock',
    path.join(stage, 'user-data'), path.join(stage, 'meta-data'), path.join(stage, 'network-config')]);
  return out;
}

module.exports = { hashPassword, buildSeed, userData, networkConfig, metaData, SSHX_SCRIPT, sshxUnit };
