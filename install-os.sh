#!/usr/bin/env bash
# Downloads the supported OS images onto THIS node, so you don't have to do it from the panel.
# The files go into <data-dir>/templates with the same names the panel uses. The agent reports
# them to the panel within seconds and they show as ready for this node under OS templates.
#
#   sudo bash install-os.sh                       # all supported OS
#   sudo bash install-os.sh ubuntu-24.04 debian-12
#   sudo bash install-os.sh --list                # show the names
#   sudo bash install-os.sh --data-dir /var/lib/kvmpanel-node all
set -Eeuo pipefail

DATA_DIR=/var/lib/kvmpanel-node
# name | file name (must match the panel's template) | download URL
OS_LIST=(
  "ubuntu-24.04|ubuntu-24.04.qcow2|https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img"
  "ubuntu-22.04|ubuntu-22.04.qcow2|https://cloud-images.ubuntu.com/jammy/current/jammy-server-cloudimg-amd64.img"
  "debian-12|debian-12.qcow2|https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-amd64.qcow2"
  "almalinux-9|almalinux-9.qcow2|https://repo.almalinux.org/almalinux/9/cloud/x86_64/images/AlmaLinux-9-GenericCloud-latest.x86_64.qcow2"
  "centos-stream-9|centos-stream-9.qcow2|https://cloud.centos.org/centos/9-stream/x86_64/images/CentOS-Stream-GenericCloud-9-latest.x86_64.qcow2"
  "fedora-42|fedora-42.qcow2|https://download.fedoraproject.org/pub/fedora/linux/releases/42/Cloud/x86_64/images/Fedora-Cloud-Base-Generic-42-1.1.x86_64.qcow2"
)

say()  { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

WANT=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --data-dir) [[ $# -ge 2 ]] || die "--data-dir needs a value"; DATA_DIR="$2"; shift 2 ;;
    --list) for e in "${OS_LIST[@]}"; do echo "${e%%|*}"; done; exit 0 ;;
    all) shift ;;
    none) exit 0 ;;
    -*) die "Unknown option: $1" ;;
    *) WANT+=("$1"); shift ;;
  esac
done

[[ $EUID -eq 0 ]] || die "Run this as root (sudo bash install-os.sh)."
command -v curl >/dev/null || die "curl is required."
command -v qemu-img >/dev/null || die "qemu-img is required (apt-get install qemu-utils)."

TPL="$DATA_DIR/templates"
mkdir -p "$TPL"; chmod 700 "$DATA_DIR" "$TPL"

want() { [[ ${#WANT[@]} -eq 0 ]] && return 0; local n; for n in "${WANT[@]}"; do [[ "$n" == "$1" ]] && return 0; done; return 1; }

for n in "${WANT[@]:-}"; do
  [[ -z "$n" ]] && continue
  found=0; for e in "${OS_LIST[@]}"; do [[ "${e%%|*}" == "$n" ]] && found=1; done
  [[ $found -eq 1 ]] || die "Unknown OS '$n'. Run: bash install-os.sh --list"
done

ok=0; failed=()
for e in "${OS_LIST[@]}"; do
  IFS='|' read -r name file url <<<"$e"
  want "$name" || continue
  dest="$TPL/$file"
  if [[ -s "$dest" && -s "$dest.meta.json" ]]; then echo "Already installed: $name"; ok=$((ok+1)); continue; fi
  say "Downloading $name"
  # -C - resumes a partly downloaded file if you run the script again after an interruption
  if curl -fL --retry 3 --retry-delay 3 -C - -o "$dest.part" "$url"; then
    fmt=$(qemu-img info --output=json "$dest.part" | python3 -c 'import sys,json;print(json.load(sys.stdin)["format"])') \
      || { warn "$name: downloaded file is not a valid disk image"; rm -f "$dest.part"; failed+=("$name"); continue; }
    mv "$dest.part" "$dest"
    printf '{"format":"%s"}' "$fmt" > "$dest.meta.json"
    chmod 600 "$dest" "$dest.meta.json"
    echo "Installed $name ($fmt)"; ok=$((ok+1))
  else
    warn "$name could not be downloaded (the vendor may have moved the file). You can set a new URL in the panel under OS templates."
    rm -f "$dest.part"; failed+=("$name")
  fi
done

say "OS images installed: $ok"
[[ ${#failed[@]} -eq 0 ]] || warn "Failed: ${failed[*]}"
echo "They appear as ready for this node in the panel under OS templates within a few seconds."
