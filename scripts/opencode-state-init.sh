#!/bin/sh
# Seed and repair OpenCode persistent volumes. Runs as root, networkless.
set -eu

uid="${OPENCODE_UID:-1000}"
gid="${OPENCODE_GID:-1000}"
init_version="${OPENCODE_STATE_INIT_VERSION:-1}"
ownership_marker=/state/.opencode-lab-ownership
desired_ownership="${init_version}:${uid}:${gid}"
tui_init_version="${OPENCODE_TUI_INIT_VERSION:-1}"
tui_marker=/user-config/.opencode-lab-tui

case "${uid}:${gid}" in
  *[!0-9:]*)
    echo "OPENCODE_UID and OPENCODE_GID must be numeric." >&2
    exit 1
    ;;
esac

owned_by_opencode() {
  [ "$(ls -nd "$1" | awk '{print $3 ":" $4}')" = "${uid}:${gid}" ]
}

mkdir -p /user-config
mkdir -p /user-config/themes
mkdir -p /package-cache

for theme in /defaults/themes/*.json; do
  [ -f "$theme" ] || continue
  target="/user-config/themes/$(basename "$theme")"
  if [ ! -e "$target" ]; then
    cp "$theme" "$target"
    chown "$uid:$gid" "$target"
  fi
done

if [ ! -f /user-config/tui.json ]; then
  if [ -f /state/config/opencode/tui.json ]; then
    cp /state/config/opencode/tui.json /user-config/tui.json
  elif [ -f /state/config/tui.json ]; then
    cp /state/config/tui.json /user-config/tui.json
  else
    cp /defaults/tui.json /user-config/tui.json
  fi
  chown "$uid:$gid" /user-config/tui.json
fi

# Interactive /theme writes the selection to state kv, while startup prefers
# tui.json. Sync kv → tui so theme choices survive container restarts.
if [ -f /state/state/opencode/kv.json ] && [ -f /user-config/tui.json ]; then
  theme=$(
    sed -n 's/.*"theme"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
      /state/state/opencode/kv.json | head -n 1
  )
  case "$theme" in
    "" | *[!a-zA-Z0-9._-]*) ;;
    *)
      sed -i \
        "s/\"theme\"[[:space:]]*:[[:space:]]*\"[^\"]*\"/\"theme\": \"$theme\"/" \
        /user-config/tui.json
      ;;
  esac
fi

# Merge Lab copy/paste and plugin defaults in this existing one-shot instead
# of starting two more Compose containers on every warm launch. The marker is
# separate from ownership so future TUI migrations do not trigger a recursive
# traversal of the package cache and state volumes.
tui_marker_value=""
if [ -f "$tui_marker" ]; then
  tui_marker_value="$(head -n 1 "$tui_marker")"
fi
if [ "$tui_marker_value" != "$tui_init_version" ]; then
  node /init/opencode-tui-merge.mjs /user-config/tui.json
  chown "$uid:$gid" /user-config/tui.json
  printf '%s\n' "$tui_init_version" > "${tui_marker}.tmp"
  chown "$uid:$gid" "${tui_marker}.tmp"
  mv "${tui_marker}.tmp" "$tui_marker"
fi

# Stale lock directories left by an older image UID block the host-mapped
# OpenCode user. Remove them on every init; they are ephemeral.
rm -rf /state/state/opencode/locks
mkdir -p /state/state/opencode/locks
chown "$uid:$gid" /state/state/opencode/locks

# Recursive ownership repair is a migration, not a launch task. Trust the
# versioned marker only while every mounted volume root still has the expected
# owner; replacing any one volume therefore triggers a safe repair.
marker_value=""
if [ -f "$ownership_marker" ]; then
  marker_value="$(head -n 1 "$ownership_marker")"
fi
if [ "$marker_value" != "$desired_ownership" ] \
  || ! owned_by_opencode /state \
  || ! owned_by_opencode /state/state/opencode \
  || ! owned_by_opencode /user-config \
  || ! owned_by_opencode /user-config/themes \
  || ! owned_by_opencode /package-cache; then
  find /state \( -path /state/config/pulse \) -prune -o -exec chown "$uid:$gid" {} +
  find /user-config -exec chown "$uid:$gid" {} +
  find /package-cache -exec chown "$uid:$gid" {} +
  printf '%s\n' "$desired_ownership" > "${ownership_marker}.tmp"
  chown "$uid:$gid" "${ownership_marker}.tmp"
  mv "${ownership_marker}.tmp" "$ownership_marker"
fi
chown "$uid:$gid" /tmp-opencode
