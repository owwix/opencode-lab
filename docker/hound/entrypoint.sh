#!/bin/sh
set -eu

child_pid=""
watchdog_pid=""

forward_signal() {
  if [ -n "$child_pid" ]; then
    kill -TERM "$child_pid" 2>/dev/null || true
  fi
}
trap forward_signal TERM INT

"$@" &
child_pid=$!

# Docker can restart a container whose network namespace is shared without
# moving the sharing container into the replacement namespace. The embedded
# DNS alias then disappears from Hound's old namespace. Exit after three local
# alias failures so the existing restart policy rejoins the current firewall.
(
  failures=0
  while kill -0 "$child_pid" 2>/dev/null; do
    if python -c 'import socket; socket.getaddrinfo("hound-firewall", 8765, type=socket.SOCK_STREAM)' >/dev/null 2>&1; then
      failures=0
    else
      failures=$((failures + 1))
      if [ "$failures" -ge 3 ]; then
        kill -TERM "$child_pid" 2>/dev/null || true
        exit 0
      fi
    fi
    sleep 5
  done
) &
watchdog_pid=$!

set +e
wait "$child_pid"
status=$?
set -e
kill "$watchdog_pid" 2>/dev/null || true
wait "$watchdog_pid" 2>/dev/null || true
exit "$status"
