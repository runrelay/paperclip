#!/usr/bin/env python3
"""Read-only operator readout for the RunRelay GEX Paperclip instance.

Defaults target the current GEX topology:
- SSH host: gex44
- Paperclip API on the host: http://127.0.0.1:3201
- Company: PerfectLive / PER

The script does not mutate Paperclip, PM2, agents, issues, or runs.
"""
from __future__ import annotations

import argparse
import json
import shlex
import subprocess
from pathlib import Path
from typing import Any

DEFAULT_HOST = "gex44"
DEFAULT_BASE_URL = "http://127.0.0.1:3201"
DEFAULT_COMPANY_ID = "2e77f434-315b-42d5-b2d6-094fc554ca86"

REMOTE_TEMPLATE = r'''
import json, subprocess, time, urllib.request
BASE = __BASE_URL__
COMPANY = __COMPANY_ID__

def api(path):
    with urllib.request.urlopen(BASE + path, timeout=20) as r:
        raw = r.read()
    return json.loads(raw) if raw else None

def sh(cmd):
    return subprocess.run(cmd, shell=True, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20)

out = {"host": __HOST__, "baseUrl": BASE, "companyId": COMPANY, "checkedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}

pm2 = sh("pm2 jlist")
out["pm2_error"] = pm2.stderr.strip() if pm2.returncode else None
try:
    plist = json.loads(pm2.stdout)
except Exception as e:
    plist = []
    out["pm2_parse_error"] = repr(e)
for p in plist:
    if p.get("name") == "paperclip":
        env = p.get("pm2_env") or {}
        out["paperclip_pm2"] = {
            "pid": p.get("pid"),
            "status": env.get("status"),
            "restartCount": env.get("restart_time"),
            "createdAt": env.get("created_at"),
            "pmUptime": env.get("pm_uptime"),
            "script": env.get("pm_exec_path"),
            "args": env.get("args"),
        }
        break

try:
    with urllib.request.urlopen(urllib.request.Request(BASE + "/", method="GET"), timeout=10) as resp:
        out["health"] = {"ok": 200 <= resp.status < 400, "status": resp.status}
except Exception as e:
    out["health"] = {"ok": False, "error": repr(e)}

try:
    out["live_runs"] = api(f"/api/companies/{COMPANY}/live-runs?minCount=0&limit=50")
    out["recent_runs"] = api(f"/api/companies/{COMPANY}/live-runs?minCount=10&limit=10")
except Exception as e:
    out["runs_error"] = repr(e)

try:
    agents = api(f"/api/companies/{COMPANY}/agents")
    audited = []
    accidental_heartbeat = []
    busy = []
    for a in agents:
        hb = ((a.get("runtimeConfig") or {}).get("heartbeat") or {})
        ac = a.get("adapterConfig") or {}
        row = {
            "name": a.get("name"),
            "id": a.get("id"),
            "status": a.get("status"),
            "adapterType": a.get("adapterType"),
            "heartbeatEnabled": hb.get("enabled"),
            "wakeOnDemand": hb.get("wakeOnDemand"),
            "maxConcurrentRuns": hb.get("maxConcurrentRuns"),
            "completionStatus": ac.get("completionStatus"),
            "postComment": ac.get("postComment"),
        }
        name = row["name"] or ""
        if name.startswith("Lite") or name in {"COO", "HermesAdvisor", "DispatcherKimi"}:
            audited.append(row)
        if name.startswith("Lite") and hb.get("enabled") is True:
            accidental_heartbeat.append(row)
        if row["status"] not in (None, "idle"):
            busy.append(row)
    out["audited_agents"] = audited
    out["accidental_lite_heartbeat"] = accidental_heartbeat
    out["busy_agents"] = busy
except Exception as e:
    out["agents_error"] = repr(e)

print(json.dumps(out, ensure_ascii=False))
'''


def run_remote(host: str, base_url: str, company_id: str) -> dict[str, Any]:
    remote = (
        REMOTE_TEMPLATE
        .replace("__BASE_URL__", json.dumps(base_url))
        .replace("__COMPANY_ID__", json.dumps(company_id))
        .replace("__HOST__", json.dumps(host))
    )
    cmd = "python3 -c " + shlex.quote(remote)
    proc = subprocess.run(["ssh", host, cmd], text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
    if proc.returncode != 0:
        raise SystemExit(f"ssh/readout failed ({proc.returncode})\nSTDERR:\n{proc.stderr}\nSTDOUT:\n{proc.stdout}")
    return json.loads(proc.stdout)


def text_report(data: dict[str, Any]) -> str:
    pm2 = data.get("paperclip_pm2") or {}
    live = data.get("live_runs") or []
    recent = data.get("recent_runs") or []
    accidental = data.get("accidental_lite_heartbeat") or []
    busy = data.get("busy_agents") or []
    health = data.get("health") or {}
    lines = [
        f"GEX Paperclip readout @ {data.get('checkedAt')}",
        f"PM2 paperclip: {pm2.get('status')} pid={pm2.get('pid')} restarts={pm2.get('restartCount')}",
        f"HTTP health: {'OK' if health.get('ok') else 'FAIL'} status={health.get('status') or health.get('error')}",
        f"Live runs: {len(live)}",
    ]
    for run in live[:10]:
        silence = (run.get("outputSilence") or {}).get("level")
        lines.append(f"  - {run.get('id')} {run.get('status')} {run.get('agentName')} issueId={run.get('issueId')} silence={silence}")
    lines.append(f"Recent rows sampled: {len(recent)}")
    lines.append(f"Busy agents: {len(busy)}" + (" — " + ", ".join((b.get("name") or "?") + ":" + str(b.get("status")) for b in busy[:10]) if busy else ""))
    lines.append(f"Accidental Lite heartbeat enabled: {len(accidental)}" + (" — " + ", ".join(a.get("name") or "?" for a in accidental) if accidental else ""))
    verdict = "PASS" if (pm2.get("status") == "online" and health.get("ok") and not accidental) else "HOLD"
    if live:
        verdict = "BUSY"
    lines.append(f"Verdict: {verdict}")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--company-id", default=DEFAULT_COMPANY_ID)
    parser.add_argument("--text", action="store_true", help="Print compact text instead of JSON")
    parser.add_argument("--output", help="Write JSON evidence to this path")
    args = parser.parse_args()

    data = run_remote(args.host, args.base_url, args.company_id)
    if args.output:
        Path(args.output).write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    print(text_report(data) if args.text else json.dumps(data, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
