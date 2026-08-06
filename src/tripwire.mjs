// In-process egress TRIPWIRE for starforge.
//
// HONEST LABEL: this is a tripwire for ACCIDENTAL egress, not a security
// boundary; the boundary is OS confinement (see confine.mjs — sandbox-exec
// deny-network on macOS, network namespace / seccomp on Linux). Red-teaming on
// this machine demonstrated that an in-process JS monkey-patch can be bypassed
// by Worker threads (fresh realm), child_process (fresh node), and
// process.binding('tcp_wrap') (below the patched JS layer), and is blind to
// filesystem egress (writes to a synced dir / network mount). Those open holes
// are enumerated verbatim in TRIPWIRE_LIMITS, which the verify command prints.
//
// What a patch DOES buy: Node returns the SAME builtin module object to
// createRequire()/require() and to `import`, so a program in THIS realm cannot
// dodge the patch via module-cache tricks — an accidental fetch()/net.connect
// in this process trips loudly instead of silently phoning home.
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import dgram from "node:dgram";
import { maskText } from "./redact.mjs";

// Exactly what this layer CANNOT catch — sourced from the red-team findings.
// The verify command prints these lines; keep them plain English.
export const TRIPWIRE_LIMITS = Object.freeze([
  "Worker threads run in a fresh realm: net/fetch inside a Worker never sees these patches.",
  "child_process can spawn a fresh node (or curl); nothing it does is visible to this tripwire.",
  "process.binding('tcp_wrap') and other internal bindings sit BELOW the patched JS layer and connect without touching it.",
  "Filesystem egress is invisible: a write into a synced folder or network mount leaves the machine with no socket in this process.",
  "This is a tripwire for accidental egress, not a security boundary — the boundary is OS confinement (sandbox-exec / network namespace).",
]);

const state = {
  armed: false,
  recorder: null,
  hits: [], // {api, target, at}
  unlockable: [], // patches we could NOT make writable:false/configurable:false
};

// Best-effort target description from heterogeneous call signatures.
function targetOf(args) {
  const a = args[0];
  if (typeof a === "string") return a;
  if (typeof a === "number") return `${args[1] ?? "?"}:${a}`; // net.connect(port, host)
  if (a instanceof URL) return a.href;
  if (a && typeof a === "object") {
    const host = a.host ?? a.hostname ?? a.path ?? "?";
    return a.port != null ? `${host}:${a.port}` : String(host);
  }
  return "?";
}

// Record the hit, THEN throw. The recorder must be called before the throw and
// must make the hit durable on its own, because this throw usually aborts the
// run: the audit recorder from startAudit() writes the run log to disk right
// here (see audit.mjs), so `starforge verify` can still count a hit from a run
// that never reached its normal end. An alarm that erases its own evidence
// would be worse than no alarm.
function trip(api, args) {
  const hit = {
    api,
    target: maskText(String(targetOf(args))),
    at: new Date().toISOString(),
  };
  state.hits.push(hit);
  try {
    state.recorder?.(hit);
  } catch {}
  throw new Error(
    `starforge tripwire: ${api} -> ${hit.target} blocked. This process is local-only; no network API should ever be reached. (Tripwire, not a boundary — see TRIPWIRE_LIMITS.)`
  );
}

// Replace obj[key] with a thrower. Prefer writable:false, configurable:false so
// the patch cannot be trivially reassigned or re-defined from this realm.
// Falls back to plain assignment when defineProperty is refused; those cases
// are tracked in state.unlockable.
//
// Known lock gaps (cheap-to-harden only goes so far):
// - A fresh realm (Worker, vm.createContext) gets its OWN globalThis and its
//   own module instances — locking here does not reach there (TRIPWIRE_LIMITS).
// - ESM named bindings captured by modules loaded BEFORE arming may retain the
//   original function; arm as early as possible in the entrypoint.
// - Anything already non-configurable on an exotic host object falls back to
//   assignment (writable), i.e. restorable — recorded in `unlockable`.
function patch(obj, key, api) {
  if (!obj) return;
  const thrower = function tripwired(...args) {
    trip(api, args);
  };
  try {
    Object.defineProperty(obj, key, {
      value: thrower,
      writable: false,
      configurable: false,
      enumerable: true,
    });
  } catch {
    try {
      obj[key] = thrower;
      state.unlockable.push(api);
    } catch {
      state.unlockable.push(`${api} (unpatchable)`);
    }
  }
}

// Arm every patch. recorder (optional) gets each {api,target,at} hit — wire
// audit.recorder from src/audit.mjs here so hits land in the run log AND on
// disk immediately (that recorder flushes the log at the moment of the hit,
// which is the only reason a tripped run leaves evidence behind).
export function armTripwire(recorder) {
  state.recorder = recorder ?? state.recorder;
  if (state.armed) return tripwireStatus();

  patch(net.Socket.prototype, "connect", "net.Socket.connect");
  patch(net, "connect", "net.connect");
  patch(net, "createConnection", "net.createConnection");
  patch(tls, "connect", "tls.connect");
  patch(http, "request", "http.request");
  patch(http, "get", "http.get");
  patch(https, "request", "https.request");
  patch(https, "get", "https.get");
  patch(dns, "lookup", "dns.lookup");
  patch(dns, "resolve", "dns.resolve");
  patch(dns.promises, "lookup", "dns.promises.lookup");
  patch(dns.promises, "resolve", "dns.promises.resolve");
  patch(dgram, "createSocket", "dgram.createSocket");
  patch(globalThis, "fetch", "fetch");
  patch(globalThis, "WebSocket", "WebSocket");

  state.armed = true;
  return tripwireStatus();
}

export function tripwireStatus() {
  return {
    armed: state.armed,
    hits: state.hits.slice(),
    unlockable: state.unlockable.slice(),
  };
}
