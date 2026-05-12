#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { areBuildTargetsFresh, isBuildTargetStale } from "./ensure-plugin-build-deps-lib.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const tscCliPath = path.join(rootDir, "node_modules", "typescript", "bin", "tsc");
const lockDir = path.join(rootDir, "node_modules", ".cache", "paperclip-plugin-build-deps.lock");
const lockTimeoutMs = 60_000;
const lockPollMs = 100;
const rootTsconfig = path.join(rootDir, "tsconfig.base.json");

const buildTargets = [
  {
    name: "@paperclipai/shared",
    outputPaths: [
      path.join(rootDir, "packages/shared/dist/index.js"),
      path.join(rootDir, "packages/shared/dist/index.d.ts"),
    ],
    inputPaths: [
      path.join(rootDir, "packages/shared/src"),
      path.join(rootDir, "packages/shared/package.json"),
      path.join(rootDir, "packages/shared/tsconfig.json"),
      rootTsconfig,
    ],
    tsconfig: path.join(rootDir, "packages/shared/tsconfig.json"),
  },
  {
    name: "@paperclipai/plugin-sdk",
    outputPaths: [
      path.join(rootDir, "packages/plugins/sdk/dist/index.js"),
      path.join(rootDir, "packages/plugins/sdk/dist/index.d.ts"),
      path.join(rootDir, "packages/plugins/sdk/dist/protocol.d.ts"),
      path.join(rootDir, "packages/plugins/sdk/dist/types.d.ts"),
      path.join(rootDir, "packages/plugins/sdk/dist/testing.d.ts"),
      path.join(rootDir, "packages/plugins/sdk/dist/bundlers.d.ts"),
      path.join(rootDir, "packages/plugins/sdk/dist/dev-server.d.ts"),
      path.join(rootDir, "packages/plugins/sdk/dist/ui/index.d.ts"),
      path.join(rootDir, "packages/plugins/sdk/dist/ui/hooks.d.ts"),
      path.join(rootDir, "packages/plugins/sdk/dist/ui/types.d.ts"),
    ],
    inputPaths: [
      path.join(rootDir, "packages/plugins/sdk/src"),
      path.join(rootDir, "packages/plugins/sdk/package.json"),
      path.join(rootDir, "packages/plugins/sdk/tsconfig.json"),
      path.join(rootDir, "packages/shared/dist/index.d.ts"),
      rootTsconfig,
    ],
    tsconfig: path.join(rootDir, "packages/plugins/sdk/tsconfig.json"),
  },
];

if (!fs.existsSync(tscCliPath)) {
  throw new Error(`TypeScript CLI not found at ${tscCliPath}`);
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function allTargetsFresh() {
  return areBuildTargetsFresh(buildTargets);
}

function waitForLockRelease() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < lockTimeoutMs) {
    if (!fs.existsSync(lockDir)) {
      return;
    }
    if (allTargetsFresh()) {
      return;
    }
    sleep(lockPollMs);
  }

  throw new Error(`Timed out waiting for plugin build dependency lock at ${lockDir}`);
}

if (allTargetsFresh()) {
  process.exit(0);
}

fs.mkdirSync(path.dirname(lockDir), { recursive: true });

let holdsLock = false;
let exitCode = 0;
let rebuiltDependency = false;
try {
  try {
    fs.mkdirSync(lockDir);
    holdsLock = true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      waitForLockRelease();
      if (!allTargetsFresh()) {
        throw new Error("Plugin build dependency lock released before build outputs became fresh");
      }
      process.exit(0);
    }
    throw error;
  }

  for (const target of buildTargets) {
    if (!rebuiltDependency && !isBuildTargetStale(target)) {
      continue;
    }

    const result = spawnSync(process.execPath, [tscCliPath, "-p", target.tsconfig], {
      cwd: rootDir,
      stdio: "inherit",
    });

    if (result.error) {
      throw result.error;
    }

    if (result.status !== 0) {
      exitCode = result.status ?? 1;
      break;
    }

    rebuiltDependency = true;
  }
} finally {
  if (holdsLock) {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

if (exitCode !== 0) {
  process.exit(exitCode);
}

if (!allTargetsFresh()) {
  throw new Error("Plugin build dependency outputs are still stale after rebuild");
}
