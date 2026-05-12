import fs from "node:fs";
import path from "node:path";

const IGNORED_INPUT_DIRS = new Set([".git", "dist", "node_modules"]);

function newestMtimeMs(filePath) {
  const stats = fs.statSync(filePath);
  if (stats.isFile()) {
    return stats.mtimeMs;
  }
  if (!stats.isDirectory()) {
    return 0;
  }

  let newest = stats.mtimeMs;
  for (const entry of fs.readdirSync(filePath, { withFileTypes: true })) {
    if (entry.isDirectory() && IGNORED_INPUT_DIRS.has(entry.name)) {
      continue;
    }
    newest = Math.max(newest, newestMtimeMs(path.join(filePath, entry.name)));
  }
  return newest;
}

function oldestMtimeMs(filePaths) {
  let oldest = Number.POSITIVE_INFINITY;
  for (const filePath of filePaths) {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) {
      return null;
    }
    oldest = Math.min(oldest, stats.mtimeMs);
  }
  return oldest;
}

export function isBuildTargetStale({ inputPaths, outputPaths }) {
  const oldestOutput = oldestMtimeMs(outputPaths);
  if (oldestOutput === null) {
    return true;
  }

  let newestInput = 0;
  for (const inputPath of inputPaths) {
    if (!fs.existsSync(inputPath)) {
      continue;
    }
    newestInput = Math.max(newestInput, newestMtimeMs(inputPath));
  }

  return newestInput > oldestOutput;
}

export function areBuildTargetsFresh(buildTargets) {
  return buildTargets.every((target) => !isBuildTargetStale(target));
}
