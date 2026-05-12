#!/usr/bin/env node
import test from "node:test";
import { afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isBuildTargetStale } from "./ensure-plugin-build-deps-lib.mjs";

const fixtures = [];

afterEach(() => {
  for (const dir of fixtures.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function touch(file, mtimeMs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${path.basename(file)}\n`);
  const time = new Date(mtimeMs);
  fs.utimesSync(file, time, time);
}

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-build-deps-test-"));
  fixtures.push(dir);
  return dir;
}

test("build target is fresh when every declared output is newer than every input", () => {
  const root = fixture();
  const input = path.join(root, "src", "index.ts");
  const output = path.join(root, "dist", "index.d.ts");
  touch(input, 1_000);
  touch(output, 2_000);

  assert.equal(
    isBuildTargetStale({
      rootDir: root,
      inputPaths: [input],
      outputPaths: [output],
    }),
    false,
  );
});

test("build target is stale when any input is newer than the oldest declared output", () => {
  const root = fixture();
  const input = path.join(root, "src", "protocol.ts");
  const output = path.join(root, "dist", "protocol.d.ts");
  touch(output, 1_000);
  touch(input, 2_000);

  assert.equal(
    isBuildTargetStale({
      rootDir: root,
      inputPaths: [input],
      outputPaths: [output],
    }),
    true,
  );
});

test("build target is stale when a declared output is missing", () => {
  const root = fixture();
  const input = path.join(root, "src", "index.ts");
  touch(input, 1_000);

  assert.equal(
    isBuildTargetStale({
      rootDir: root,
      inputPaths: [input],
      outputPaths: [path.join(root, "dist", "index.d.ts")],
    }),
    true,
  );
});

test("directory inputs are scanned recursively and ignore dist and node_modules", () => {
  const root = fixture();
  const output = path.join(root, "dist", "index.d.ts");
  touch(path.join(root, "src", "index.ts"), 1_000);
  touch(path.join(root, "src", "nested", "types.ts"), 3_000);
  touch(path.join(root, "src", "nested", "dist", "generated.ts"), 9_000);
  touch(path.join(root, "src", "node_modules", "ignored.ts"), 9_000);
  touch(output, 2_000);

  assert.equal(
    isBuildTargetStale({
      rootDir: root,
      inputPaths: [path.join(root, "src")],
      outputPaths: [output],
    }),
    true,
  );
});
