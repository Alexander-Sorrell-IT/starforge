// The PACKAGE, not the code. `npm test` never touches packaging, which is how
// starreckon spent a day unpublishable without anything noticing.
//
// `npm pkg set devDependencies."@jazzer.js/core"="^2.1.0"` reads the dot as a
// PATH SEPARATOR and writes a nested object:
//
//     "@jazzer": { "js/core": "^2.1.0" }        what landed
//     "@jazzer.js/core": "^2.1.0"               what was meant
//
// A dependency spec that is an object rather than a string makes `npm pack`
// fail with "must provide string spec" — so the tarball could not be built,
// and therefore could not be published, from commit f647d33 onward. Every
// test passed the whole time, because a test suite runs the source tree and a
// user installs the package.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

test("every dependency spec is a STRING", () => {
  for (const field of ["dependencies", "devDependencies", "peerDependencies",
                       "optionalDependencies"]) {
    for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
      assert.equal(typeof spec, "string",
        `${field}["${name}"] is ${typeof spec} — a scoped name containing a dot `
        + `nests under npm pkg set, and npm pack refuses the result`);
    }
  }
});

test("no dependency name is a fragment of a scoped name", () => {
  // The specific shape the bug produced: a key with no slash where the real
  // package name has one.
  for (const field of ["dependencies", "devDependencies"]) {
    for (const name of Object.keys(pkg[field] ?? {})) {
      if (name.startsWith("@")) {
        assert.ok(name.includes("/"),
          `"${name}" is a scope with no package — the rest of the name was `
          + `eaten by a dot`);
      }
    }
  }
});

test("everything the bin points at exists", () => {
  const bins = typeof pkg.bin === "string" ? { [pkg.name]: pkg.bin } : (pkg.bin ?? {});
  for (const [cmd, rel] of Object.entries(bins)) {
    assert.ok(existsSync(join(ROOT, rel)),
      `bin "${cmd}" points at ${rel}, which is not in the tree`);
  }
  if (pkg.main) assert.ok(existsSync(join(ROOT, pkg.main.replace(/^\.\//, ""))),
    `main points at ${pkg.main}, which is not in the tree`);
});

test("the files list carries what the program reads at RUN time", () => {
  // spec/sources.json is loaded by sources.mjs on every run. Shipping the code
  // without it would give an installed package that cannot discover anything —
  // and would look, from inside this repo, exactly like a working program.
  const files = pkg.files ?? [];
  assert.ok(files.some((f) => f.startsWith("spec")),
    "spec/ is not shipped, and loadSources() reads spec/sources.json at runtime");
  assert.ok(files.some((f) => f.startsWith("src")), "src/ is not shipped");
});

test("the private identity file is EXCLUDED by name", () => {
  assert.ok((pkg.files ?? []).includes("!spec/identity.json"),
    "spec/ is shipped wholesale and identity.json would go with it");
});

test("the version is a plain semver", () => {
  assert.match(pkg.version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/,
    `"${pkg.version}" is not something npm will accept`);
});
