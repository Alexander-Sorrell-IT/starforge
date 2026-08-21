// The scheduled scan deliberately does NOT run the model layer.
//
// The daemon's argv is `--yes --no-wrapped --no-pace --ledger` — not --full.
// --full runs the SecureBERT auto-index, and the model layer is SEPARATELY
// CONSENTED: runSearch() is one door with one log because the consent screen
// promises a log for every run. A daemon spawning an embedding job on a timer
// runs a consented-separately layer without its consent.
//
// The cost is real and stated: nothing re-indexes on its own, and
// `search --search-status` reports "N indexed · M on disk" so the gap is
// visible. This test pins the DECISION so nobody "fixes" it by adding --full.
import { test } from "node:test";
import assert from "node:assert/strict";
import { launchdPlist, systemdUnits } from "../src/daemon.mjs";

test("the launchd scan job never passes --full", () => {
  const plist = launchdPlist({});
  assert.ok(plist.includes("--ledger"), "the scan argv changed shape entirely");
  assert.ok(!plist.includes("--full"),
    "--full runs the separately-consented model layer on a timer");
});

test("the systemd scan job never passes --full", () => {
  const units = systemdUnits({});
  const blob = typeof units === "string" ? units : JSON.stringify(units);
  assert.ok(!blob.includes("--full"),
    "--full runs the separately-consented model layer on a timer");
});
