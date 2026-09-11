#!/usr/bin/env node
// Build the DMG for the version in package.json, archive it under releases/,
// and publish it as a GitHub Release asset.
//
//   npm run release              build current version (skips if already built)
//   npm run release -- --force   rebuild even if releases/ already has it
//   npm run release -- --local   build + archive only, no git push, no GitHub
//   npm run release -- --draft   publish the GitHub Release as a draft
//
// `npm version 0.2.0` bumps package.json, commits, tags, then runs this via
// the postversion hook.

import { execFileSync, execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const RELEASES = join(ROOT, "releases");

const args = process.argv.slice(2);
const has = (...names) => names.some((n) => args.includes(n));
const FORCE = has("--force", "-f");
const LOCAL = has("--local");
const DRAFT = has("--draft");

const say = (msg) => console.log(`\x1b[36m▸\x1b[0m ${msg}`);
const warn = (msg) => console.log(`\x1b[33m!\x1b[0m ${msg}`);
const die = (msg) => {
  console.error(`\x1b[31m✗\x1b[0m ${msg}`);
  process.exit(1);
};

const run = (cmd, opts = {}) => execSync(cmd, { cwd: ROOT, stdio: "inherit", ...opts });
const capture = (cmd) => execSync(cmd, { cwd: ROOT, encoding: "utf8" }).trim();
const mb = (p) => `${(statSync(p).size / 1024 / 1024).toFixed(0)} MB`;

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const { version, productName = pkg.build?.productName ?? pkg.name } = { ...pkg, productName: pkg.build?.productName };
const tag = `v${version}`;

// DMGs for this version, whatever arch suffix electron-builder chose.
const dmgsIn = (dir) => {
  if (!existsSync(dir)) return [];
  const re = new RegExp(`^${productName}-${version.replace(/\./g, "\\.")}(-[^-]+)?\\.dmg$`);
  return readdirSync(dir).filter((f) => re.test(f)).map((f) => join(dir, f));
};

say(`${productName} ${version} (tag ${tag})`);

// ---------------------------------------------------------------- 1. build
const archived = dmgsIn(RELEASES);
if (archived.length && !FORCE) {
  say(`already archived: ${archived.map((p) => p.slice(ROOT.length + 1)).join(", ")} — skipping build (--force to rebuild)`);
} else {
  try {
    if (capture("git status --porcelain")) warn("working tree is dirty — building it as-is");
  } catch {
    /* not a git repo; fine */
  }
  say("building — npm run dist");
  run("npm run dist");

  const built = dmgsIn(DIST);
  if (!built.length) die(`build finished but no ${productName}-${version}*.dmg in dist/`);

  mkdirSync(RELEASES, { recursive: true });
  for (const src of built) {
    const name = src.slice(DIST.length + 1);
    const dest = join(RELEASES, name);
    rmSync(dest, { force: true }); // hdiutil refuses to overwrite

    // electron-builder only emits UDZO/UDBZ/ULFO. Recompressing to ULMO (LZMA)
    // is ~25% smaller than UDZO here; macOS 10.15+ mounts it natively.
    try {
      say(`recompressing ${name} → ULMO`);
      execFileSync("hdiutil", ["convert", src, "-format", "ULMO", "-o", dest], { stdio: "ignore" });
      say(`archived releases/${name} (${mb(dest)}, down from ${mb(src)})`);
    } catch {
      warn("hdiutil convert failed — archiving the UDZO build as-is");
      copyFileSync(src, dest);
      say(`archived releases/${name} (${mb(dest)})`);
    }
  }
}

const assets = dmgsIn(RELEASES);
if (!assets.length) die(`nothing to publish — no DMG in releases/ for ${version}`);

if (LOCAL) {
  say("--local: stopping before git push / GitHub Release");
  process.exit(0);
}

// ------------------------------------------------------- 2. tag and push
try {
  execFileSync("gh", ["auth", "status"], { stdio: "ignore" });
} catch {
  die("gh is not installed or not authenticated — run `gh auth login`, or use --local");
}

const tagExists = (() => {
  try {
    execFileSync("git", ["rev-parse", "--verify", `refs/tags/${tag}`], { cwd: ROOT, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

if (!tagExists) {
  say(`tagging ${tag}`);
  run(`git tag ${tag}`);
}

const branch = capture("git rev-parse --abbrev-ref HEAD");
say(`pushing ${branch} and ${tag} to origin`);
run(`git push origin ${branch}`);
run(`git push origin ${tag}`);

// -------------------------------------------------- 3. GitHub Release
const releaseExists = (() => {
  try {
    execFileSync("gh", ["release", "view", tag], { cwd: ROOT, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

if (releaseExists) {
  say(`release ${tag} exists — uploading assets with --clobber`);
  execFileSync("gh", ["release", "upload", tag, ...assets, "--clobber"], { cwd: ROOT, stdio: "inherit" });
} else {
  say(`creating release ${tag}${DRAFT ? " (draft)" : ""}`);
  execFileSync(
    "gh",
    [
      "release", "create", tag, ...assets,
      "--title", `${productName} ${version}`,
      "--generate-notes",
      ...(DRAFT ? ["--draft"] : []),
    ],
    { cwd: ROOT, stdio: "inherit" },
  );
}

say(`done — ${capture(`gh release view ${tag} --json url --jq .url`)}`);
