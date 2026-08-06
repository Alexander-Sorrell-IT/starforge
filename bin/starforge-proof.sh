#!/bin/sh
# starforge-proof.sh — kernel-level proof that starforge cannot reach the network.
#
# What this does, in order:
#   1. prints the OS sandbox profile (deny all network, allow everything else)
#   2. runs the starforge scan INSIDE that sandbox (its exit code is reported
#      on its own line; it is a scan result, NOT part of the egress verdict)
#   3. positive control: tries to open TCP 1.1.1.1:443
#        OUTSIDE the sandbox  -> should CONNECT  (proves the probe works)
#        INSIDE  the sandbox  -> kernel must REFUSE (proves the wall is real)
#
# A proof that says "we tried to leave and the kernel stopped us" is worth
# more than one that says "we did not try".
#
# Scope, honestly: this seals SOCKETS for starforge and all its children.
# It cannot stop a file written into a cloud-synced folder from leaving the
# machine later; starforge writes under ~/.starforge, plus any --join-fleet
# directory you name (that one is a path you chose, so it is the one that can
# sit inside Dropbox or iCloud — PROVE-IT.md §6). sandbox-exec is marked
# DEPRECATED in Apple's man page — step 3 verifies it still enforces instead
# of trusting it.
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
# STARFORGE_CONFINEMENT labels the run in its own audit log ("this run was
# launched under sandbox-exec"). It is a CLAIM, not proof — any process can set
# it, so the log records it with verified:false. Without it a genuinely
# confined run would be logged as unconfined; steps 2/3 below are the proof.
STARFORGE_CONFINEMENT=sandbox-exec "$SANDBOX" -p "$PROFILE" "$NODE" "$DIR/src/cli.mjs" --yes "$@"
SCAN=$?

echo
echo "== 2/3: control probe OUTSIDE the sandbox (expected: connects) =="
"$NODE" "$DIR/src/confine.mjs" --probe
OUTSIDE=$?    # probe exit codes: 0 = blocked, 1 = egress open, 2 = ambiguous

echo
echo "== 3/3: same probe INSIDE the sandbox (expected: kernel refuses) =="
STARFORGE_CONFINEMENT=sandbox-exec "$SANDBOX" -p "$PROFILE" "$NODE" "$DIR/src/confine.mjs" --probe
INSIDE=$?

echo
echo "== verdict =="
echo "  scan under sandbox     : exit $SCAN (0 = worked)"
echo "  egress outside sandbox : $([ $OUTSIDE -eq 1 ] && echo "open (control valid)" || echo "not open (control INVALID — offline?)")"
echo "  egress inside sandbox  : $([ $INSIDE -eq 0 ] && echo "BLOCKED by kernel" || echo "NOT blocked")"

# The verdict judges the CONFINEMENT RESULT, in the order the evidence has to
# be read: is the control valid, and did the kernel refuse? The scan's exit
# code is a separate fact about the scan, printed above and named again below
# — it is not an egress result and must not be reported as one. It used to be
# ANDed into the PASS condition, so a machine with no AI-coding logs (where
# the scan exited non-zero for having nothing to read) printed
# "FAIL … do not trust the no-egress claim" while the kernel proof had just
# succeeded in front of the reader's eyes.
if [ "$OUTSIDE" -ne 1 ]; then
  echo "INCONCLUSIVE: the outside control did not connect (machine offline?)."
  echo "A sandbox refusal cannot be distinguished from simply having no network."
  echo "Reconnect and re-run."
  exit 1
fi
if [ "$INSIDE" -ne 0 ]; then
  echo "FAIL: the identical probe connected OUTSIDE the sandbox but the kernel did"
  echo "      NOT refuse it INSIDE — the wall is not doing what this script claims."
  echo "      Do not trust the no-egress claim on this machine."
  exit 1
fi
echo "PASS: the kernel refused our own escape attempt inside the sandbox while"
echo "      the identical attempt outside connected. No-egress is enforced by"
echo "      the OS, not promised by the code."
if [ "$SCAN" -eq 0 ]; then
  echo "      The scan itself also ran to completion under that sealed network."
  exit 0
fi
echo
echo "NOTE: the scan exited $SCAN under the sandbox. That is a SCAN result, not an"
echo "      egress result — the no-egress proof above stands on its own (steps"
echo "      2/3 above are the whole of it). Read step 1's output to see why the"
echo "      scan exited non-zero; it is a separate problem."
exit 0
