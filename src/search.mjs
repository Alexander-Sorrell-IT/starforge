// starreckon search — semantic search over AI-coding sessions via SecureBERT.
//
// Delegates to src/search.py which runs inside ~/.starreckon/.venv-search/.
// The Python side uses two Cisco SecureBERT models:
//
//   cisco-ai/SecureBERT2.0-biencoder     fast ANN candidate retrieval
//   cisco-ai/SecureBERT2.0-cross_encoder precise security-domain reranking
//
// This module is the thin Node bridge: resolve the path to search.py, spawn
// Python, stream output to the terminal. No ML in JS.
//
// @starreckon-intentional-spawn
// Uses node:child_process ONLY to call src/search.py — a Python script
// bundled in this package. Never downloads anything; the Python side owns
// model access and the venv. The static warden (verify.mjs) allowlists this
// file for the spawn call, same pattern as confine.mjs.
// The Python side sets HF_HUB_OFFLINE=1 before loading models so
// sentence-transformers makes zero network calls at inference time.
// Models are downloaded exactly once during `starreckon search --setup`.

import { spawn, spawnSync } from "node:child_process"; // launcher — only spawns src/search.py
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { logLayerRun, searchDetail, scheduledRun } from "./layerlog.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const SEARCH_PY = join(__dirname, "search.py");

/**
 * Spawn src/search.py with the given argv and stream stdout/stderr to the
 * terminal. Returns a promise that resolves with the exit code.
 *
 * opts.python — python3 binary name or path (default "python3")
 * opts.roots  — extra home root paths passed as --roots to search.py
 */
export function runSearch(argv, { python = "python3", roots = [] } = {}) {
  // EVERY model invocation this program makes passes through here — the
  // `search` subcommand, the [I] and [A] doors' setup download, and --full's
  // auto-index — which is why the log hook is here and not at the call sites.
  // A hook at three call sites is a hook that will one day be four call sites
  // and three hooks. The consent screen promises a log for EVERY run of the
  // layer, and this is the only place that promise can be kept by construction.
  //
  // The query itself is never recorded: searchDetail() reduces it to a length
  // and a hash prefix. The reasoning is in the masking note in layerlog.mjs.
  const { event, detail } = searchDetail(argv);
  const scheduled = scheduledRun();
  const trigger = scheduled?.layer === "models" ? "schedule" : "interactive";
  const started = Date.now();
  const log = (outcome, extra) =>
    logLayerRun({
      layer: "models",
      event,
      trigger,
      outcome,
      exit_code: Number.isInteger(extra?.exit_code) ? extra.exit_code : null,
      duration_ms: Date.now() - started,
      detail: { ...detail, ...(extra?.detail ?? {}) },
    });

  if (!existsSync(SEARCH_PY)) {
    // A model run that could not start is still an account of the layer: the
    // alternative is a silent gap that reads exactly like "nobody searched".
    log("failed", { detail: { error: "search.py not found" } });
    return Promise.reject(new Error(`search.py not found at ${SEARCH_PY}`));
  }
  const rootArgs = roots.flatMap((r) => ["--roots", r]);
  const child = spawn(python, [SEARCH_PY, ...rootArgs, ...argv], {
    stdio: "inherit",
  });
  return new Promise((resolve, reject) => {
    child.on("error", (e) => {
      log("failed", { detail: { error: String(e?.code ?? e?.message ?? e) } });
      reject(e);
    });
    child.on("close", (code) => {
      log(code === 0 ? "ok" : "failed", { exit_code: code });
      resolve(code);
    });
  });
}

/**
 * Check whether a python3 binary is available.
 * Returns the version string on success, or null if not found.
 */
export function checkPython(python = "python3") {
  const r = spawnSync(python, ["--version"], { encoding: "utf8" });
  if (r.status !== 0 || r.error) return null;
  return (r.stdout || r.stderr || "").trim();
}
