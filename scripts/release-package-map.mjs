#!/usr/bin/env node

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const roots = ["packages", "server", "ui", "cli"];

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function discoverPublicPackages() {
  const packages = [];

  function walk(relDir) {
    const absDir = join(repoRoot, relDir);
    if (!existsSync(absDir)) return;

    const pkgPath = join(absDir, "package.json");
    if (existsSync(pkgPath)) {
      const pkg = readJson(pkgPath);
      if (!pkg.private) {
        packages.push({
          dir: relDir,
          pkgPath,
          name: pkg.name,
          version: pkg.version,
          pkg,
        });
      }
      return;
    }

    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
      walk(join(relDir, entry.name));
    }
  }

  for (const rel of roots) {
    walk(rel);
  }

  return packages;
}

function sortTopologically(packages) {
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const visited = new Set();
  const visiting = new Set();
  const ordered = [];

  function visit(pkg) {
    if (visited.has(pkg.name)) return;
    if (visiting.has(pkg.name)) {
      throw new Error(`cycle detected in public package graph at ${pkg.name}`);
    }

    visiting.add(pkg.name);

    const dependencySections = [
      pkg.pkg.dependencies ?? {},
      pkg.pkg.optionalDependencies ?? {},
      pkg.pkg.peerDependencies ?? {},
    ];

    for (const deps of dependencySections) {
      for (const depName of Object.keys(deps)) {
        const dep = byName.get(depName);
        if (dep) visit(dep);
      }
    }

    visiting.delete(pkg.name);
    visited.add(pkg.name);
    ordered.push(pkg);
  }

  for (const pkg of [...packages].sort((a, b) => a.dir.localeCompare(b.dir))) {
    visit(pkg);
  }

  return ordered;
}

function replaceWorkspaceDeps(deps, version) {
  if (!deps) return deps;
  const next = { ...deps };

  for (const [name, value] of Object.entries(next)) {
    if (!name.startsWith("@paperclipai/")) continue;
    if (typeof value !== "string" || !value.startsWith("workspace:")) continue;
    next[name] = version;
  }

  return next;
}

function rewriteSourceEntrypoint(value) {
  if (typeof value === "string") {
    if (!value.startsWith("./src/")) return value;
    return value.replace(/^\.\/src\//, "./dist/").replace(/\.ts$/, ".js");
  }

  if (Array.isArray(value)) {
    return value.map((entry) => rewriteSourceEntrypoint(entry));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, rewriteSourceEntrypoint(entry)]),
    );
  }

  return value;
}

function rewritePublishEntrypoints(pkg) {
  const next = { ...pkg };

  if (next.main) next.main = rewriteSourceEntrypoint(next.main);
  if (next.types) next.types = rewriteSourceEntrypoint(next.types);
  if (next.exports) next.exports = rewriteSourceEntrypoint(next.exports);

  return next;
}

function setVersion(version) {
  const packages = sortTopologically(discoverPublicPackages());

  for (const pkg of packages) {
    const nextPkg = rewritePublishEntrypoints({
      ...pkg.pkg,
      version,
      dependencies: replaceWorkspaceDeps(pkg.pkg.dependencies, version),
      optionalDependencies: replaceWorkspaceDeps(pkg.pkg.optionalDependencies, version),
      peerDependencies: replaceWorkspaceDeps(pkg.pkg.peerDependencies, version),
      devDependencies: replaceWorkspaceDeps(pkg.pkg.devDependencies, version),
    });

    writeFileSync(pkg.pkgPath, `${JSON.stringify(nextPkg, null, 2)}\n`);
  }

  const cliEntryPath = join(repoRoot, "cli/src/index.ts");
  const cliEntry = readFileSync(cliEntryPath, "utf8");
  const nextCliEntry = cliEntry.replace(
    /\.version\("([^"]+)"\)/,
    `.version("${version}")`,
  );

  if (cliEntry !== nextCliEntry) {
    writeFileSync(cliEntryPath, nextCliEntry);
    return;
  }

  if (!cliEntry.includes(".version(cliVersion)")) {
    throw new Error("failed to rewrite CLI version string in cli/src/index.ts");
  }
}

function listPackages() {
  const packages = sortTopologically(discoverPublicPackages());
  for (const pkg of packages) {
    process.stdout.write(`${pkg.dir}\t${pkg.name}\t${pkg.version}\n`);
  }
}

function collectEntrypointStrings(value, strings = []) {
  if (typeof value === "string") {
    strings.push(value);
    return strings;
  }

  if (Array.isArray(value)) {
    for (const entry of value) collectEntrypointStrings(entry, strings);
    return strings;
  }

  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) collectEntrypointStrings(entry, strings);
  }

  return strings;
}

function validatePublishEntrypoints() {
  const packages = sortTopologically(discoverPublicPackages());
  const failures = [];

  for (const pkg of packages) {
    const manifest = readJson(pkg.pkgPath);
    const dependencySections = [
      manifest.dependencies ?? {},
      manifest.optionalDependencies ?? {},
      manifest.peerDependencies ?? {},
    ];
    const entrypoints = collectEntrypointStrings({
      main: manifest.main,
      types: manifest.types,
      exports: manifest.exports,
    });

    for (const deps of dependencySections) {
      for (const [name, value] of Object.entries(deps)) {
        if (name.startsWith("@paperclipai/") && typeof value === "string" && value.startsWith("workspace:")) {
          failures.push(`${pkg.name}: ${name} still uses ${value}`);
        }
      }
    }

    for (const entrypoint of entrypoints) {
      if (entrypoint.includes("./src/")) {
        failures.push(`${pkg.name}: entrypoint still points at source path ${entrypoint}`);
      }
      if (entrypoint.endsWith(".ts") && !entrypoint.endsWith(".d.ts")) {
        failures.push(`${pkg.name}: runtime entrypoint still points at TypeScript file ${entrypoint}`);
      }
    }
  }

  if (failures.length > 0) {
    process.stderr.write(`${failures.join("\n")}\n`);
    process.exit(1);
  }
}

function usage() {
  process.stderr.write(
    [
      "Usage:",
      "  node scripts/release-package-map.mjs list",
      "  node scripts/release-package-map.mjs set-version <version>",
      "  node scripts/release-package-map.mjs validate-publish-entrypoints",
      "",
    ].join("\n"),
  );
}

const [command, arg] = process.argv.slice(2);

if (command === "list") {
  listPackages();
  process.exit(0);
}

if (command === "set-version") {
  if (!arg) {
    usage();
    process.exit(1);
  }
  setVersion(arg);
  process.exit(0);
}

if (command === "validate-publish-entrypoints") {
  validatePublishEntrypoints();
  process.exit(0);
}

usage();
process.exit(1);
