#!/usr/bin/env node
/**
 * S12 — refuse to package a build that misreports its own version.
 *
 * WHY THIS RUNS IN THE BUILD AND NOT IN THE APP. The app CANNOT detect this
 * class of defect about itself, and the attempt to is instructive:
 * `UpdatesSettings.jsx` renders a mismatch warning when `serverApp !==
 * appVersion`. Measured on the shipped 1.24.0 install, both read **1.23.0** —
 * not because the guard is disabled, but because `VITE_APP_VERSION` is baked
 * from `package.json` at build time and `_app_version()` reads the SAME
 * `package.json` out of the bundle at run time. **Two values derived from one
 * file agree with each other no matter how stale that file is.** It is a
 * self-consistency check wearing the shape of a cross-check.
 *
 * The real mismatch is between the BUNDLE and the INSTALLER, and nothing inside
 * the running app can see the installer's number. So it has to be caught here,
 * before the artifact exists.
 *
 * WHAT IT COSTS TO GET WRONG: the updater compares the number the app BELIEVES
 * it is against GitHub Releases. A 1.24.0 install reporting 1.23.0 is
 * perpetually offered the release it is already running. That is the live
 * consequence, measured 2026-08-02, and this program has already shipped two
 * different binaries under `Plexar_1.23.0`.
 *
 * Node + stdlib only, deliberately: this runs inside `npm run tauri:build`, on
 * any machine that can build the app, with no Python and no extra dependency.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND = join(HERE, "..");

const fail = (msg) => {
  console.error(`\n  VERSION CHECK FAILED\n\n${msg}\n`);
  process.exit(1);
};

const pkg = JSON.parse(readFileSync(join(FRONTEND, "package.json"), "utf8"));
const version = pkg.version;
if (!version) fail("package.json has no version.");

// 1. tauri.conf.json must still DERIVE from package.json. If someone replaces
//    that with a literal, every check here starts comparing a number against a
//    copy of itself and goes quietly vacuous.
const conf = JSON.parse(readFileSync(join(FRONTEND, "src-tauri", "tauri.conf.json"), "utf8"));
if (conf.version !== "../package.json") {
  fail(
    `tauri.conf.json no longer derives its version (found ${JSON.stringify(conf.version)}).\n` +
    `  It must stay "../package.json", or the installer can disagree with the app\n` +
    `  and this check can no longer tell.`
  );
}

// 2. Cargo stamps the Windows exe metadata and cannot read package.json, so it
//    has to be asserted rather than derived. This was stale by TWELVE minor
//    versions (1.12.1 against 1.24.0) in both installs on 2026-08-02 — Explorer
//    and Task Manager reported 1.12.1 for a 1.24.0 build.
const cargo = readFileSync(join(FRONTEND, "src-tauri", "Cargo.toml"), "utf8");
const cargoVersion = /^version\s*=\s*"([^"]+)"/m.exec(cargo)?.[1];
if (cargoVersion !== version) {
  fail(
    `Cargo.toml is ${cargoVersion}, package.json is ${version}.\n` +
    `  Cargo stamps the Windows exe file metadata. Bump both.`
  );
}

// 3. THE ONE THAT CATCHES WHAT SHIPPED. `vite build` freezes package.json's
//    version into the bundle as VITE_APP_VERSION. If dist/ predates the bump,
//    the installer says one number and the UI displays another — the installer
//    being right, which is the dangerous way round, because the updater and the
//    user then disagree about what is installed.
const assets = join(FRONTEND, "dist", "assets");
if (!existsSync(assets)) {
  fail(
    "dist/assets is missing — there is no built bundle to check.\n" +
    "  Run `vite build` before packaging. (`npm run tauri:build` chains it.)"
  );
}
const bundles = readdirSync(assets).filter((f) => /^index-.*\.js$/.test(f));
if (bundles.length === 0) fail("dist/assets has no index bundle; the build is incomplete.");

const seen = new Set();
let found = false;
for (const b of bundles) {
  const src = readFileSync(join(assets, b), "utf8");
  if (src.includes(version)) found = true;
  for (const m of src.matchAll(/\b\d+\.\d+\.\d+\b/g)) seen.add(m[0]);
}
if (!found) {
  fail(
    `the built bundle does not contain package.json's version ${version}.\n` +
    `  dist/ is STALE — built before the version bump, so the installer will say\n` +
    `  ${version} while the app displays something else, and the updater will keep\n` +
    `  offering a release that is already installed.\n` +
    `  Re-run \`npm run build\` before packaging.\n` +
    `  Versions found in the bundle: ${[...seen].sort().slice(0, 10).join(", ")}`
  );
}

console.log(`  version check OK — package.json, tauri.conf, Cargo.toml and dist/ all agree on ${version}`);
