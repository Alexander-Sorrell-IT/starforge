#!/bin/sh
# starforge-proof.sh — kernel-level proof that starforge cannot reach the network.
#
# What this does, in order:
#   1. prints the OS sandbox profile (deny all network, allow everything else)
#   2. runs the starforge scan INSIDE that sandbox          -> must exit 0
#   3. positive control: tries to open TCP 1.1.1.1:443
#        OUTSIDE the sandbox  -> should CONNECT  (proves the probe works)
#        INSIDE  the sandbox  -> kernel must REFUSE (proves the wall is real)
#
# A proof that says "we tried to leave and the kernel stopped us" is worth
# more than one that says "we did not try".
#
# Scope, honestly: this seals SOCKETS for starforge and all its children.
# It cannot stop a file written into a cloud-synced folder from leaving the
# machine later; starforge writes only under ~/.starforge. sandbox-exec is
# marked DEPRECATED in Apple's man page — step 3 verifies it still enforces
# instead of trusting it.
#
# macOS only. On Linux run:  unshare -rn node src/cli.mjs --yes

set -u

DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
NODE=${NODE:-node}
SANDBOX=/usr/bin/sandbox-exec
PROFILE='(version 1) (allow default) (deny network*) (deny network-outbound) (deny network-inbound)'

[ "$(uname)" = Darwin ] || { echo "This script is macOS-only (Linux: unshare -rn node src/cli.mjs --yes)"; exit 2; }
[ -x "$SANDBOX" ] || { echo "$SANDBOX not found — cannot build the proof"; exit 2; }

echo "== sandbox profile =="
echo "$PROFILE"

echo
echo "== 1/3: starforge scan INSIDE the sandbox (network denied) =="
"$SANDBOX" -p "$PROFILE" "$NODE" "$DIR/src/cli.mjs" --yes "$@"
SCAN=$?

echo
echo "== 2/3: control probe OUTSIDE the sandbox (expected: connects) =="
"$NODE" "$DIR/src/confine.mjs" --probe
OUTSIDE=$?    # probe exit codes: 0 = blocked, 1 = egress open, 2 = ambiguous

echo
echo "== 3/3: same probe INSIDE the sandbox (expected: kernel refuses) =="
"$SANDBOX" -p "$PROFILE" "$NODE" "$DIR/src/confine.mjs" --probe
INSIDE=$?

echo
echo "== verdict =="
echo "  scan under sandbox     : exit $SCAN (0 = worked)"
echo "  egress outside sandbox : $([ $OUTSIDE -eq 1 ] && echo "open (control valid)" || echo "not open (control INVALID — offline?)")"
echo "  egress inside sandbox  : $([ $INSIDE -eq 0 ] && echo "BLOCKED by kernel" || echo "NOT blocked")"

if [ "$SCAN" -eq 0 ] && [ "$INSIDE" -eq 0 ] && [ "$OUTSIDE" -eq 1 ]; then
  echo "PASS: the scan ran with the network sealed off, and the kernel refused"
  echo "      our own escape attempt inside the sandbox while the identical"
  echo "      attempt outside connected. No-egress is enforced by the OS,"
  echo "      not promised by the code."
  exit 0
fi
if [ "$OUTSIDE" -ne 1 ]; then
  echo "INCONCLUSIVE: the outside control did not connect (machine offline?)."
  echo "A sandbox refusal cannot be distinguished from simply having no network."
  echo "Reconnect and re-run."
  exit 1
fi
echo "FAIL: see the steps above — do not trust the no-egress claim."
exit 1
