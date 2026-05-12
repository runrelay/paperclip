import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const releasePackageMap = join(repoRoot, "scripts", "release-package-map.mjs");

function listPublicPackages() {
  return execFileSync(process.execPath, [releasePackageMap, "list"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [dir, name] = line.split("\t");
      return { dir, name, packagePath: join(repoRoot, dir, "package.json") };
    });
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function publicEntrypointStrings(pkg) {
  const values = [];

  function visit(value) {
    if (typeof value === "string") {
      values.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (value && typeof value === "object") {
      for (const entry of Object.values(value)) visit(entry);
    }
  }

  visit(pkg.main);
  visit(pkg.types);
  visit(pkg.exports);
  return values;
}

function backupFiles(filePaths) {
  const backups = new Map();
  for (const filePath of filePaths) {
    if (!existsSync(filePath)) continue;
    backups.set(filePath, readFileSync(filePath, "utf8"));
  }
  return () => {
    for (const [filePath, content] of backups.entries()) {
      writeFileSync(filePath, content);
    }
  };
}

test("set-version rewrites package entrypoints for publishable dist artifacts", () => {
  const packages = listPublicPackages();
  const restore = backupFiles([
    ...packages.map((pkg) => pkg.packagePath),
    join(repoRoot, "cli", "src", "index.ts"),
  ]);

  try {
    execFileSync(process.execPath, [releasePackageMap, "set-version", "2099.101.0-test.0"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    execFileSync(process.execPath, [releasePackageMap, "validate-publish-entrypoints"], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    for (const pkg of packages) {
      const packageJson = readJson(pkg.packagePath);
      const entrypoints = publicEntrypointStrings(packageJson);

      assert.equal(
        entrypoints.some((entrypoint) => entrypoint.includes("./src")),
        false,
        `${pkg.name} should not publish package entrypoints pointing at source files`,
      );
      assert.equal(
        entrypoints.some((entrypoint) => entrypoint.endsWith(".ts") && !entrypoint.endsWith(".d.ts")),
        false,
        `${pkg.name} should not publish runtime entrypoints pointing at TypeScript files`,
      );
    }
  } finally {
    restore();
  }
});
