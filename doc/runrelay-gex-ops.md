# RunRelay GEX Paperclip deploy/readout/canary loop

This document captures the repeatable operator loop for the RunRelay GEX Paperclip instance.
It is intentionally conservative: read-only by default, no schedulers, no heartbeat enablement,
and no forced run/agent resets.

## Topology defaults

- SSH host: `gex44`
- Paperclip API on host: `http://127.0.0.1:3201`
- PM2 process: `paperclip`
- PerfectLive/PER company id: `2e77f434-315b-42d5-b2d6-094fc554ca86`
- Current terminal-wake test agent: `LiteSRE-Test` (`abc3ee6a-3cdc-4fe4-9786-05525a02ee19`)

## Read-only operator readout

Run:

```sh
python3 scripts/ops/paperclip-gex-operator-readout.py --text
```

The readout checks:

- PM2 `paperclip` status / pid / restart count
- HTTP health for the local Paperclip UI/API
- live runs
- recent run sample
- busy agents
- Lite agents with heartbeat accidentally enabled

Verdicts:

- `PASS`: Paperclip is online, HTTP health is OK, and no accidental Lite heartbeat is enabled.
- `BUSY`: same as PASS posture, but one or more live runs are active; do not start bounded canaries.
- `HOLD`: health/PM2/heartbeat guard failed.

JSON evidence:

```sh
python3 scripts/ops/paperclip-gex-operator-readout.py \
  --output /tmp/paperclip-gex-readout.json
```

## Bounded terminal-wake canary

Dry-run/readiness check:

```sh
python3 scripts/ops/paperclip-gex-terminal-wake-canary.py --text
```

Live negative canary after a deploy:

```sh
python3 scripts/ops/paperclip-gex-terminal-wake-canary.py \
  --execute \
  --text \
  --output /tmp/paperclip-gex-terminal-wake-canary.json
```

The live negative canary:

1. Requires `live-runs=[]` before starting.
2. Creates a canary issue in `done` status.
3. Assigns the test agent and verifies no run is created.
4. Adds a generic comment and verifies the issue stays `done` with no run.
5. Adds an `@LiteSRE-Test` mention and verifies the issue stays `done` with no run.

It never:

- cancels runs
- resets agents
- enables heartbeat
- touches non-canary issues
- posts outside Paperclip

## Positive blocked-comment wake check

The script has an opt-in `--positive` mode, but this check is not cleanly isolatable with a
fresh public-API issue today. Assigning an agent to blocked work can itself create an assignment
wake before a comment is added. When that happens, the script records the positive step as `SKIP`,
not `HOLD`.

Use a dedicated fixture/lower-level harness if you need to prove exactly “comment on already-assigned
blocked issue wakes the assignee.” Do not infer a PER-2753 regression from this fresh-issue precondition.

## Deploy manifest

Every GEX deploy should produce a manifest with at least:

```json
{
  "target": {
    "host": "gex44",
    "service": "pm2:paperclip",
    "apiBaseUrl": "http://127.0.0.1:3201"
  },
  "source": {
    "repo": "runrelay/paperclip",
    "branch": "master",
    "commit": "<git sha>",
    "pr": "<github pr url>"
  },
  "artifacts": [
    {
      "path": "<artifact or installed file>",
      "sha256": "<sha256>",
      "package": "<package name/version if applicable>"
    }
  ],
  "deployment": {
    "startedAt": "<ISO timestamp>",
    "finishedAt": "<ISO timestamp>",
    "operator": "<name/tool>",
    "restartCommand": "pm2 restart paperclip --update-env"
  },
  "verification": {
    "readoutBefore": "<path or attached JSON>",
    "readoutAfter": "<path or attached JSON>",
    "canary": "<path or attached JSON>",
    "verdict": "PASS|HOLD"
  },
  "rollback": {
    "strategy": "restore previous artifacts then restart pm2",
    "backupDir": "<path>"
  }
}
```

## Recommended deploy posture

Hot-patching built `dist` files is acceptable only for urgent bounded hotfixes. The durable path is:

1. Build reproducible packages/tarballs from the internal `runrelay/paperclip` commit.
2. Record package hashes.
3. Install the package set on GEX.
4. Restart PM2.
5. Run readout.
6. Run bounded canary only if readout is `PASS` and live-runs are empty.
7. Record the manifest and evidence in Linear.

Do not open, push, or merge against public `paperclipai/paperclip` for RunRelay/PerfectLive deploy work
unless the operator explicitly names that public upstream target.
