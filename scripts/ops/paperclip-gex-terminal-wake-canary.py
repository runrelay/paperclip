#!/usr/bin/env python3
"""Bounded terminal-wake canary for the RunRelay GEX Paperclip instance.

Default mode is dry-run/readiness only. Pass --execute to create canary issues
and comments. The script never cancels runs, resets agents, enables heartbeat, or
touches non-canary issues.
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
DEFAULT_AGENT_ID = "abc3ee6a-3cdc-4fe4-9786-05525a02ee19"  # LiteSRE-Test

REMOTE_TEMPLATE = r'''
import json, time, urllib.request, urllib.error, sys
from datetime import datetime, timezone

BASE = __BASE_URL__
COMPANY = __COMPANY_ID__
AGENT = __AGENT_ID__
EXECUTE = __EXECUTE__
INCLUDE_POSITIVE = __INCLUDE_POSITIVE__
MARKER = 'POSTDEPLOY_TERMINAL_WAKE_CANARY_' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')

def req(method, path, data=None):
    body = None if data is None else json.dumps(data).encode()
    request = urllib.request.Request(BASE + path, data=body, method=method, headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            raw = response.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        raw = e.read().decode(errors='replace')
        raise RuntimeError(f'{method} {path} -> {e.code}: {raw}')

def live_company(): return req('GET', f'/api/companies/{COMPANY}/live-runs?minCount=0&limit=50')
def live_issue(identifier): return req('GET', f'/api/issues/{identifier}/live-runs')
def get_issue(identifier): return req('GET', f'/api/issues/{identifier}')
def comments(identifier): return req('GET', f'/api/issues/{identifier}/comments?limit=10&order=desc')

def wait_until(fn, timeout=90, interval=3):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        last = fn()
        if last:
            return True, last
        time.sleep(interval)
    return False, last

result = {
    'marker': MARKER,
    'execute': EXECUTE,
    'includePositiveBlockedCommentWake': INCLUDE_POSITIVE,
    'agentId': AGENT,
    'steps': [],
}
pre_live = live_company()
result['pre_live_count'] = len(pre_live)
result['pre_live_sample'] = [{k: r.get(k) for k in ['id', 'status', 'agentName', 'issueId']} for r in pre_live[:10]]
if pre_live:
    result['overall'] = 'HOLD_PRECHECK_LIVE_RUNS'
    print(json.dumps(result, indent=2))
    sys.exit(2)
if not EXECUTE:
    result['overall'] = 'DRY_RUN_READY'
    print(json.dumps(result, indent=2))
    sys.exit(0)

issue1 = req('POST', f'/api/companies/{COMPANY}/issues', {
    'title': f'{MARKER} closed-assignment inert canary',
    'description': f'Canary: closed assignment/comment/mention must stay inert. Marker: {MARKER}',
    'status': 'done',
    'priority': 'low',
})
ident1 = issue1['identifier']
req('PATCH', f'/api/issues/{issue1["id"]}', {'assigneeAgentId': AGENT})
time.sleep(3)
issue1_after = get_issue(ident1)
live1 = live_issue(ident1)
result['steps'].append({
    'name': 'closed_assignment_no_wake',
    'identifier': ident1,
    'status_after': issue1_after.get('status'),
    'assignee_after': issue1_after.get('assigneeAgentId'),
    'active_runs_for_issue': len(live1),
    'verdict': 'PASS' if issue1_after.get('status') == 'done' and issue1_after.get('assigneeAgentId') == AGENT and len(live1) == 0 else 'HOLD',
})

comment = req('POST', f'/api/issues/{issue1["id"]}/comments', {'body': f'{MARKER} generic terminal comment; no reopen/resume requested.'})
time.sleep(5)
issue1_comment_after = get_issue(ident1)
live1_comment = live_issue(ident1)
result['steps'].append({
    'name': 'closed_generic_comment_no_reopen_no_wake',
    'identifier': ident1,
    'comment_id': comment.get('id'),
    'status_after': issue1_comment_after.get('status'),
    'active_runs_for_issue': len(live1_comment),
    'verdict': 'PASS' if issue1_comment_after.get('status') == 'done' and len(live1_comment) == 0 else 'HOLD',
})

comment2 = req('POST', f'/api/issues/{issue1["id"]}/comments', {'body': f'{MARKER} @LiteSRE-Test mention on closed issue; should remain inert.'})
time.sleep(5)
issue1_mention_after = get_issue(ident1)
live1_mention = live_issue(ident1)
result['steps'].append({
    'name': 'closed_mention_no_reopen_no_wake',
    'identifier': ident1,
    'comment_id': comment2.get('id'),
    'status_after': issue1_mention_after.get('status'),
    'active_runs_for_issue': len(live1_mention),
    'verdict': 'PASS' if issue1_mention_after.get('status') == 'done' and len(live1_mention) == 0 else 'HOLD',
})

if INCLUDE_POSITIVE:
    issue2 = req('POST', f'/api/companies/{COMPANY}/issues', {
        'title': f'{MARKER} blocked-comment positive wake canary',
        'description': f'Canary: human comment on assigned blocked work should wake the test agent. Include marker once: {MARKER}. Finish comment-only/in_review.',
        'status': 'blocked',
        'priority': 'low',
    })
    ident2 = issue2['identifier']
    req('PATCH', f'/api/issues/{issue2["id"]}', {'assigneeAgentId': AGENT})
    time.sleep(4)
    pre_comment_live = live_issue(ident2)
    if pre_comment_live:
        result['steps'].append({
            'name': 'blocked_positive_precondition_no_assignment_wake',
            'identifier': ident2,
            'active_runs_for_issue': len(pre_comment_live),
            'verdict': 'SKIP',
            'note': 'assignment_to_blocked_created_wake; cannot isolate comment wake on a fresh issue via public API',
        })
    else:
        c = req('POST', f'/api/issues/{issue2["id"]}/comments', {'body': f'{MARKER} human follow-up on blocked assigned issue; wake expected.'})
        ok, sample = wait_until(lambda: live_issue(ident2), timeout=45, interval=3)
        after = get_issue(ident2)
        result['steps'].append({
            'name': 'blocked_comment_wakes',
            'identifier': ident2,
            'comment_id': c.get('id'),
            'status_after_initial': after.get('status'),
            'saw_active_run': ok,
            'active_run_sample': sample[:3] if sample else [],
            'verdict': 'PASS' if ok and after.get('status') in ('todo', 'in_progress', 'in_review') else 'HOLD',
        })
        wait_until(lambda: len(live_issue(ident2)) == 0, timeout=120, interval=5)
        after2 = get_issue(ident2)
        live_after2 = live_issue(ident2)
        result['steps'].append({
            'name': 'blocked_positive_settled',
            'identifier': ident2,
            'status_after': after2.get('status'),
            'active_runs_for_issue': len(live_after2),
            'latest_comment_count': len(comments(ident2)),
            'verdict': 'PASS' if len(live_after2) == 0 and after2.get('status') in ('in_review', 'done', 'todo', 'in_progress') else 'HOLD',
        })

post_live = live_company()
result['post_live_count'] = len(post_live)
result['post_live_sample'] = [{k: r.get(k) for k in ['id', 'status', 'agentName', 'issueId']} for r in post_live[:10]]
result['overall'] = 'PASS' if all(s['verdict'] in ('PASS', 'SKIP') for s in result['steps']) and any(s['verdict'] == 'PASS' for s in result['steps']) else 'HOLD'
print(json.dumps(result, indent=2))
sys.exit(0 if result['overall'] == 'PASS' else 2)
'''


def run_remote(host: str, base_url: str, company_id: str, agent_id: str, execute: bool, include_positive: bool) -> dict[str, Any]:
    remote = (
        REMOTE_TEMPLATE
        .replace("__BASE_URL__", json.dumps(base_url))
        .replace("__COMPANY_ID__", json.dumps(company_id))
        .replace("__AGENT_ID__", json.dumps(agent_id))
        .replace("__EXECUTE__", "True" if execute else "False")
        .replace("__INCLUDE_POSITIVE__", "True" if include_positive else "False")
    )
    cmd = "python3 -c " + shlex.quote(remote)
    proc = subprocess.run(["ssh", host, cmd], text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=260)
    if proc.returncode not in (0, 2):
        raise SystemExit(f"remote canary failed rc={proc.returncode}\nSTDERR:\n{proc.stderr}\nSTDOUT:\n{proc.stdout}")
    try:
        data = json.loads(proc.stdout)
    except Exception as exc:
        raise SystemExit(f"could not parse remote JSON: {exc}\nSTDERR:\n{proc.stderr}\nSTDOUT:\n{proc.stdout}")
    data["remoteReturnCode"] = proc.returncode
    return data


def text_report(data: dict[str, Any]) -> str:
    lines = [f"Paperclip terminal-wake canary: {data.get('overall')} marker={data.get('marker')}"]
    lines.append(f"pre_live={data.get('pre_live_count')} post_live={data.get('post_live_count')}")
    for step in data.get("steps", []):
        status = step.get("status_after") or step.get("status_after_initial")
        lines.append(f"- {step.get('name')}: {step.get('verdict')} issue={step.get('identifier')} status={status} runs={step.get('active_runs_for_issue')}")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--company-id", default=DEFAULT_COMPANY_ID)
    parser.add_argument("--agent-id", default=DEFAULT_AGENT_ID, help="Test agent id; defaults to LiteSRE-Test on GEX")
    parser.add_argument("--execute", action="store_true", help="Create live canary issues/comments")
    parser.add_argument("--positive", action="store_true", help="Attempt positive blocked-comment wake canary; may SKIP when assignment itself wakes")
    parser.add_argument("--text", action="store_true", help="Print compact text instead of JSON")
    parser.add_argument("--output", help="Write JSON evidence to this path")
    args = parser.parse_args()

    data = run_remote(args.host, args.base_url, args.company_id, args.agent_id, args.execute, args.positive)
    if args.output:
        Path(args.output).write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    print(text_report(data) if args.text else json.dumps(data, indent=2, ensure_ascii=False))
    return 0 if data.get("overall") in ("PASS", "DRY_RUN_READY") else 2


if __name__ == "__main__":
    raise SystemExit(main())
