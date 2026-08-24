#!/bin/sh
# Optional tighter sandbox for untrusted commands inside Lab.
# Falls back to a plain exec when bubblewrap is unavailable.
set -eu
if ! command -v bwrap >/dev/null 2>&1; then
  exec "$@"
fi
workdir="${OPENCODE_WORKSPACE_CONTAINER:-/workspace}"
exec bwrap \
  --die-with-parent \
  --new-session \
  --unshare-pid \
  --ro-bind / / \
  --bind "$workdir" "$workdir" \
  --bind /tmp /tmp \
  --bind-try /home/opencode/.tmp /home/opencode/.tmp \
  --dev /dev \
  --proc /proc \
  --chdir "$workdir" \
  "$@"
