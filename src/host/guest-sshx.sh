#!/bin/sh
# Diablo: runs INSIDE every VM (installed by cloud-init as /usr/local/sbin/diablo-sshx).
#
# It installs sshx if needed, starts a session as the VM's login user, and prints the session link
# on the serial console as a single line:  DIABLO-SSHX-URL <link>
# The panel reads that line from the VM's serial log, so nothing has to be reachable from outside
# the VM and no port is opened: sshx only makes an outbound connection.
#
# Usage:  diablo-sshx <login-user> [sshx-server-url]
#         diablo-sshx --mark <text>       print a status marker (used on stop)
umask 077

# systemd starts services with a minimal environment; make sure the usual binary dirs are on PATH.
PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export PATH

TTY=/dev/ttyS0
emit() { printf '\nDIABLO-SSHX-URL %s\n' "$1" >> "$TTY" 2>/dev/null || true; }

if [ "$1" = "--mark" ]; then emit "${2:-stopped}"; exit 0; fi

USER_NAME="$1"
SERVER="${2:-https://sshx.io}"
OUT=/run/diablo-sshx.out
URLFILE=/run/diablo-sshx.url

log() { echo "diablo-sshx: $*" >&2; }
have() { command -v "$1" >/dev/null 2>&1; }

[ -n "$USER_NAME" ] || { log "no login user given"; exit 2; }

# Anything the panel read earlier belongs to a session that is gone.
emit starting

ensure_curl() {
  have curl && return 0
  if have apt-get; then
    apt-get update -qq >/dev/null 2>&1
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates >/dev/null 2>&1
  elif have dnf; then
    dnf install -y -q curl >/dev/null 2>&1
  elif have yum; then
    yum install -y -q curl >/dev/null 2>&1
  elif have apk; then
    apk add --no-cache curl ca-certificates >/dev/null 2>&1
  elif have pacman; then
    pacman -Sy --noconfirm curl ca-certificates >/dev/null 2>&1
  elif have zypper; then
    zypper --non-interactive install curl ca-certificates >/dev/null 2>&1
  fi
  have curl
}

# The network may still be coming up on first boot, so keep trying for a while. Each attempt tries
# curl first (covers almost every image) and falls back to wget (some minimal images ship wget but
# not curl, or a distro's package manager is momentarily locked while curl installs).
ensure_sshx() {
  have sshx && return 0
  n=0
  while [ "$n" -lt 40 ]; do
    if ensure_curl && curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 10 https://sshx.io/get | sh >/dev/null 2>&1 && have sshx; then return 0; fi
    if have wget && wget -qO- --timeout=10 https://sshx.io/get | sh >/dev/null 2>&1 && have sshx; then return 0; fi
    n=$((n + 1))
    log "sshx install attempt $n/40 failed, retrying in 15s"
    sleep 15
  done
  return 1
}

ensure_sshx || { log "could not install sshx"; emit error-install; exit 1; }

# Resolve the sshx binary to an absolute path: the service runs as root but sshx is executed as the
# login user, whose PATH may not include where the installer put it.
SSHX_BIN=$(command -v sshx 2>/dev/null)
[ -n "$SSHX_BIN" ] || SSHX_BIN=/usr/local/bin/sshx

HOME_DIR=$(getent passwd "$USER_NAME" | cut -d: -f6)
SHELL_BIN=$(getent passwd "$USER_NAME" | cut -d: -f7)
[ -n "$HOME_DIR" ] || HOME_DIR="/home/$USER_NAME"
[ -x "$SHELL_BIN" ] || SHELL_BIN=/bin/bash

rm -f "$OUT" "$URLFILE"
runuser -u "$USER_NAME" -- env PATH="$PATH" HOME="$HOME_DIR" USER="$USER_NAME" LOGNAME="$USER_NAME" SHELL="$SHELL_BIN" \
  "$SSHX_BIN" --quiet --server "$SERVER" --shell "$SHELL_BIN" > "$OUT" 2>/dev/null &
PID=$!

# --quiet makes sshx print only the link, as its first line of output.
URL=
n=0
while [ "$n" -lt 60 ]; do
  URL=$(head -n 1 "$OUT" 2>/dev/null)
  [ -n "$URL" ] && break
  kill -0 "$PID" 2>/dev/null || break
  n=$((n + 1))
  sleep 2
done
case "$URL" in
  http://*|https://*) ;;
  *) log "sshx did not report a link"; emit error-nolink; kill "$PID" 2>/dev/null; exit 1 ;;
esac

printf '%s\n' "$URL" > "$URLFILE" 2>/dev/null || true
emit "$URL"
# Say it again now and then, so the line is still inside the tail of the log the panel reads
# even after a lot of other console output.
t=0
while kill -0 "$PID" 2>/dev/null; do
  sleep 5
  t=$((t + 5))
  if [ "$t" -ge 300 ]; then t=0; emit "$URL"; fi
done
log "sshx exited"
exit 1
