#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/gex-package-deploy-loop.sh --version VERSION --artifact-dir DIR [options]

Options:
  --remote HOST             SSH host for GEX/Paperclip (default: gex44)
  --port PORT               Remote Paperclip port (default: 3201)
  --company-id UUID         Company to inspect live-runs for (default: PAPERCLIP_COMPANY_ID or PerfectLive)
  --deploy                  Perform npm install -g + pm2 restart. Without this flag the script is read-only after artifact validation.
  --remote-artifact-dir DIR Remote artifact directory (default: /tmp/paperclip-package-VERSION)
  -h, --help                Show help

Default mode is a safe preflight/readout loop:
  1. verify local artifact checksums
  2. install the tarball set into a disposable empty npm app
  3. scan installed package manifests for workspace:* and ./src exports
  4. syntax-check server/CLI dist entrypoints
  5. read remote health/live-runs
  6. rsync artifacts to remote and verify checksums there

Only --deploy mutates the remote global npm install or PM2 process.
EOF
}

version=""
artifact_dir=""
remote="${PAPERCLIP_DEPLOY_REMOTE:-gex44}"
port="${PAPERCLIP_DEPLOY_PORT:-3201}"
company_id="${PAPERCLIP_COMPANY_ID:-2e77f434-315b-42d5-b2d6-094fc554ca86}"
deploy=false
remote_artifact_dir=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      shift
      version="${1:-}"
      ;;
    --artifact-dir)
      shift
      artifact_dir="${1:-}"
      ;;
    --remote)
      shift
      remote="${1:-}"
      ;;
    --port)
      shift
      port="${1:-}"
      ;;
    --company-id)
      shift
      company_id="${1:-}"
      ;;
    --remote-artifact-dir)
      shift
      remote_artifact_dir="${1:-}"
      ;;
    --deploy)
      deploy=true
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unexpected argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

[ -n "$version" ] || { echo "--version is required" >&2; exit 2; }
[ -n "$artifact_dir" ] || { echo "--artifact-dir is required" >&2; exit 2; }
[ -d "$artifact_dir" ] || { echo "artifact dir not found: $artifact_dir" >&2; exit 2; }
[ -f "$artifact_dir/SHA256SUMS" ] || { echo "SHA256SUMS not found in $artifact_dir" >&2; exit 2; }
remote_artifact_dir="${remote_artifact_dir:-/tmp/paperclip-package-$version}"

log() { printf '\n==> %s\n' "$*"; }

check_sha256sums() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -c SHA256SUMS
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 -c SHA256SUMS
  else
    echo "missing sha256sum/shasum" >&2
    return 1
  fi
}

log "Local artifact checksum verification"
(cd "$artifact_dir" && check_sha256sums)

log "Disposable empty-app install proof"
sandbox="$(mktemp -d "${TMPDIR:-/tmp}/paperclip-install-smoke.XXXXXX")"
cleanup() { rm -rf "$sandbox"; }
trap cleanup EXIT
(
  cd "$sandbox"
  npm init -y >/dev/null
  npm install --no-audit --no-fund "$artifact_dir"/*.tgz
  node - <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const packageRoot = path.join(process.cwd(), 'node_modules');
const packages = ['paperclipai'];
const scopedRoot = path.join(packageRoot, '@paperclipai');
if (fs.existsSync(scopedRoot)) {
  for (const entry of fs.readdirSync(scopedRoot)) packages.push(`@paperclipai/${entry}`);
}
for (const name of packages.sort()) {
  const manifestPath = path.join(packageRoot, ...name.split('/'), 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const serialized = JSON.stringify({
    dependencies: manifest.dependencies,
    optionalDependencies: manifest.optionalDependencies,
    peerDependencies: manifest.peerDependencies,
    main: manifest.main,
    types: manifest.types,
    exports: manifest.exports,
  });
  if (serialized.includes('workspace:')) throw new Error(`${name} leaked workspace:* dependency`);
  if (serialized.includes('./src/')) throw new Error(`${name} leaked ./src export`);
  console.log(`${name}@${manifest.version}`);
}
NODE
  node --check node_modules/@paperclipai/server/dist/index.js
  node --check node_modules/paperclipai/dist/index.js
  ./node_modules/.bin/paperclipai --version
)

log "Remote readout before deploy"
ssh "$remote" "set -euo pipefail
printf 'health='; curl -sS http://127.0.0.1:$port/api/health; echo
printf 'live_runs='; curl -sS 'http://127.0.0.1:$port/api/companies/$company_id/live-runs?minCount=0&limit=50'; echo
pm2 jlist > /tmp/paperclip-deploy-pm2.json
python3 - <<'PY'
import json
for p in json.load(open('/tmp/paperclip-deploy-pm2.json')):
    if p.get('name') == 'paperclip':
        print('pm2=', {'pid': p.get('pid'), 'status': p.get('pm2_env', {}).get('status'), 'restarts': p.get('pm2_env', {}).get('restart_time')})
PY
"

log "Sync artifacts to remote and verify checksums"
ssh "$remote" "mkdir -p '$remote_artifact_dir'"
rsync -a --delete "$artifact_dir/" "$remote:$remote_artifact_dir/"
ssh "$remote" "cd '$remote_artifact_dir' && sha256sum -c SHA256SUMS"

if [ "$deploy" != true ]; then
  log "Preflight complete; remote install/restart skipped (pass --deploy to mutate live GEX)"
  exit 0
fi

log "Deploy package set to remote global npm and restart Paperclip"
ssh "$remote" "set -euo pipefail
cd '$remote_artifact_dir'
npm install -g --no-audit --no-fund ./*.tgz
paperclipai --version
pm2 restart paperclip --update-env
for i in \$(seq 1 60); do
  if curl -sS -f http://127.0.0.1:$port/api/health >/tmp/paperclip-deploy-health.json 2>/dev/null; then
    cat /tmp/paperclip-deploy-health.json; echo
    exit 0
  fi
  sleep 1
done
pm2 logs paperclip --lines 120 --nostream
exit 1
"

log "Remote readout after deploy"
ssh "$remote" "set -euo pipefail
printf 'health='; curl -sS http://127.0.0.1:$port/api/health; echo
printf 'live_runs='; curl -sS 'http://127.0.0.1:$port/api/companies/$company_id/live-runs?minCount=0&limit=50'; echo
pm2 jlist > /tmp/paperclip-deploy-pm2.json
python3 - <<'PY'
import json
for p in json.load(open('/tmp/paperclip-deploy-pm2.json')):
    if p.get('name') == 'paperclip':
        print('pm2=', {'pid': p.get('pid'), 'status': p.get('pm2_env', {}).get('status'), 'restarts': p.get('pm2_env', {}).get('restart_time')})
PY
"
