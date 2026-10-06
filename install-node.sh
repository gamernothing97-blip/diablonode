#!/usr/bin/env bash
# Installs the Diablo node agent on a Debian or Ubuntu server that will run VMs for the panel.
#
# Easiest: use the one-line command from the node's Configuration tab in the panel:
#   curl -fsSL https://panel.example.com/node-deploy/<code> | sudo bash
#
# Or run this from the extracted project folder:
#   sudo bash install-node.sh --panel https://panel.example.com --token knode_xxxxxxxx [--os all|none|ubuntu-24.04,debian-12]
# By default it also downloads all supported OS images (see install-os.sh --list). Use --os none to skip.
set -Eeuo pipefail

APP_DIR=/opt/kvmpanel-node
CONF_DIR=/etc/diablo-node
DATA_DIR=/var/lib/kvmpanel-node
PANEL=""; TOKEN=""; OS="all"

while [[ $# -gt 0 ]]; do
  if [[ "$1" == --* && $# -lt 2 ]]; then echo "Error: $1 needs a value" >&2; exit 1; fi
  case "$1" in
    --panel) PANEL="${2:-}"; shift 2 ;;
    --token) TOKEN="${2:-}"; shift 2 ;;
    --os) OS="${2:-}"; shift 2 ;;
    --data-dir) DATA_DIR="${2:-}"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

say() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run this script as root (sudo bash install-node.sh ...)."
command -v apt-get >/dev/null || die "This installer supports Debian and Ubuntu (apt)."
[[ -f package.json && -d src ]] || die "Run the script from the project folder that contains package.json."
[[ -n "$PANEL" && -n "$TOKEN" ]] || die "Usage: sudo bash install-node.sh --panel https://panel.example.com --token knode_..."
PANEL="${PANEL%/}"
# "]" must come first inside the bracket expression for it to be a literal character
[[ "$PANEL" =~ ^https?://[]A-Za-z0-9.:_[-]+$ ]] || die "--panel must look like https://panel.example.com"

say "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends qemu-system-x86 qemu-utils genisoimage iproute2 openssl ca-certificates curl build-essential python3

need_node=1
if command -v node >/dev/null; then
  major=$(node -p 'process.versions.node.split(".")[0]')
  [[ $major -ge 22 ]] && need_node=0
fi
if [[ $need_node -eq 1 ]]; then
  say "Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

say "Copying the agent to $APP_DIR"
mkdir -p "$APP_DIR" "$DATA_DIR"
cp -r package.json package-lock.json src "$APP_DIR"/
cp install-os.sh "$APP_DIR"/ 2>/dev/null || true

say "Writing the configuration to $CONF_DIR/config.yml"
mkdir -p "$CONF_DIR"
chmod 700 "$CONF_DIR"
cat > "$CONF_DIR/config.yml" <<CONF
# Diablo node configuration. Keep this file private: the token identifies this node to the panel.
panel_url: $PANEL
token: $TOKEN
data_dir: $DATA_DIR
CONF
chmod 600 "$CONF_DIR/config.yml"
rm -f "$APP_DIR/.env"   # older installs kept the settings here

say "Installing Node dependencies"
# better-sqlite3 (used by the panel, not the agent) ships prebuilt binaries, so skip install scripts.
(cd "$APP_DIR" && npm ci --omit=dev --ignore-scripts)

say "Creating the systemd service"
cp kvmpanel-node.service /etc/systemd/system/kvmpanel-node.service
systemctl daemon-reload
systemctl enable kvmpanel-node
systemctl restart kvmpanel-node

sleep 3
if [[ "$OS" != "none" && -f install-os.sh ]]; then
  say "Installing OS images ($OS)"
  # a failed image download must not fail the whole node install
  bash install-os.sh --data-dir "$DATA_DIR" ${OS//,/ } || echo "Some OS images failed. Re-run: sudo bash $APP_DIR/install-os.sh"
fi
say "Done"
if [[ -e /dev/kvm ]]; then echo "KVM acceleration: available"; else echo "WARNING: /dev/kvm is missing. VMs on this node will run without hardware acceleration."; fi
echo "Status:   systemctl status kvmpanel-node"
echo "Logs:     journalctl -u kvmpanel-node -n 30"
echo "Config:   $CONF_DIR/config.yml"
echo "The node should show as Online in the panel under Administration > Nodes."
