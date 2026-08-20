// @ts-nocheck
// Clipboard command selection — OS and session aware.
//
// DETECTION IS BY SIGNAL, NOT BY PLATFORM NAME. The same platform name can
// hide four different clipboard realities:
//
//   macOS                  pbcopy — always present
//   Linux / X11            xclip -selection clipboard
//   Linux / Wayland        wl-copy — xclip requires X11 and silently fails here
//   WSL (Linux kernel,     clip.exe via Windows interop — writes to the Windows
//        Windows host)     clipboard which is what the user actually pastes from
//   Windows                clip
//
// xdotool is deliberately absent. It does not copy to the clipboard at all —
// it simulates physical keystrokes into whichever window currently has focus.
// If the user switches terminal tabs between pressing [X] and xdotool firing,
// it types the full share URL into whatever is focused: a code editor, a
// browser address bar, another terminal. That is actively worse than "copy
// failed" and there is no safe way to use it here.
//
// Both `env` and `platform` are injectable so this function is fully testable
// without spawning a subprocess or caring which OS the test runner is on.

/**
 * Returns an ordered list of [command, args] pairs to try for clipboard copy.
 * The first one that exits 0 wins; the rest are fallbacks.
 *
 * @param {object} env      - environment variables (default: process.env)
 * @param {string} platform - OS platform string (default: process.platform)
 * @returns {Array<[string, string[]]>}
 */
export function clipboardCmds(env = process.env, platform = process.platform) {
  // WSL: Windows interop puts clip.exe on PATH. Prefer it — it writes to the
  // Windows clipboard which is what the user actually wants to paste from.
  // WSLENV is set even when WSL_INTEROP is absent (interop disabled).
  const isWsl = Boolean(env.WSL_INTEROP || env.WSLENV);

  // Wayland: WAYLAND_DISPLAY is set by the compositor. xclip requires X11 and
  // will silently fail (exit non-zero or hang) under a pure Wayland session.
  const isWayland = Boolean(env.WAYLAND_DISPLAY);

  if (platform === "darwin") {
    return [["pbcopy", []]];
  }
  if (platform === "win32") {
    return [["clip", []]];
  }
  // Linux (including WSL — Linux kernel, Windows host)
  if (isWsl) {
    return [
      ["clip.exe", []],
      ["wl-copy", []],
      ["xclip", ["-selection", "clipboard"]],
    ];
  }
  if (isWayland) {
    return [["wl-copy", []]];
  }
  // X11 or unknown Linux desktop — xclip is the safest default
  return [["xclip", ["-selection", "clipboard"]]];
}
