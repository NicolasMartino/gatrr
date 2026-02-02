#!/usr/bin/env bash
set -euo pipefail

# Deploy this repo on the target host.
# Intended to be run on the bare metal server (invoked via forced-command SSH).

REPO_DIR="${REPO_DIR:-/data/gatrr}"
LOG_DIR="${LOG_DIR:-/var/log/gatrr}"

usage() {
  cat >&2 <<'EOF'
Usage:
  deploy-remote.sh [--only-update-repo] <stack> <commit-sha>

Examples:
  deploy-remote.sh prod a1b2c3... (40-char sha)
  deploy-remote.sh --only-update-repo prod a1b2c3... (updates scripts only)

Notes:
  - Full 40-character SHA is required.
  - --only-update-repo updates the versioned server scripts from that commit
    (no npm install, no pulumi).
EOF
}

ONLY_UPDATE_REPO=false
if [[ "${1:-}" == "--only-update-repo" ]]; then
  ONLY_UPDATE_REPO=true
  shift
fi

if [[ $# -ne 2 ]]; then
  usage
  exit 2
fi

STACK="$1"
SHA="$2"

case "${STACK}" in
  staging|prod) ;;
  *)
    echo "ERROR: invalid stack '${STACK}' (allowed: staging, prod)" >&2
    exit 2
    ;;
esac

if [[ ! "${SHA}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "ERROR: invalid commit sha '${SHA}' (must be full 40-char hex)" >&2
  exit 2
fi

if [[ ! -d "${REPO_DIR}/.git" ]]; then
  echo "ERROR: repo not found at ${REPO_DIR} (expected .git)" >&2
  exit 1
fi

mkdir -p "${LOG_DIR}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
LOG_FILE="${LOG_DIR}/deploy-${STACK}-${TIMESTAMP}-${SHA:0:8}.log"
exec > >(tee -a "${LOG_FILE}") 2>&1

echo "==> Started at $(date -Iseconds)"
echo "    Stack: ${STACK}"
echo "    SHA:   ${SHA}"
echo "    Mode:  $([[ "${ONLY_UPDATE_REPO}" == "true" ]] && echo update-repo || echo deploy)"
echo "    Log:   ${LOG_FILE}"

# Prevent concurrent runs
LOCK_FILE="${LOCK_FILE:-/var/run/gatrr/deploy.lock}"
mkdir -p "$(dirname "${LOCK_FILE}")"
exec 9>"${LOCK_FILE}"
if ! flock -n 9; then
  echo "ERROR: another deploy/update is in progress (lock: ${LOCK_FILE})" >&2
  exit 1
fi

cd "${REPO_DIR}"

PREV_HEAD="$(git rev-parse HEAD 2>/dev/null || echo "")"
cleanup() {
  local exit_code=$?
  if [[ ${exit_code} -ne 0 ]]; then
    echo "==> Failed (exit ${exit_code})"
    if [[ -n "${PREV_HEAD}" && "${ONLY_UPDATE_REPO}" != "true" ]]; then
      echo "==> Restoring previous HEAD: ${PREV_HEAD}"
      git checkout --detach "${PREV_HEAD}" 2>/dev/null || true
    fi
  fi
  echo "==> Finished at $(date -Iseconds) (exit ${exit_code})"
}
trap cleanup EXIT

GIT_REMOTE="${GIT_REMOTE:-origin}"

echo "==> Fetching git refs from ${GIT_REMOTE}"
git fetch "${GIT_REMOTE}" --prune

echo "==> Verifying commit exists: ${SHA}"
git cat-file -e "${SHA}^{commit}"

if [[ "${ONLY_UPDATE_REPO}" == "true" ]]; then
  echo "==> Updating versioned scripts from ${SHA} (no deploy)"
  git checkout "${SHA}" -- scripts/
  chmod +x scripts/*.sh
  echo "==> Scripts updated"
  exit 0
fi

echo "==> Checking out ${SHA} (detached)"
git checkout --detach "${SHA}"

echo "==> Installing infra dependencies"
cd infra/pulumi
npm ci

echo "==> Selecting Pulumi stack: ${STACK}"
pulumi stack select "${STACK}"

export GATRR_COMMIT_SHA="${SHA}"
export GATRR_COMMIT_AT="$(TZ=UTC git show -s --format=%cd --date=format:%Y-%m-%dT%H:%M:%SZ "${SHA}")"
export GATRR_DEPLOYED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "==> Deployment metadata"
echo "    GATRR_COMMIT_SHA=${GATRR_COMMIT_SHA}"
echo "    GATRR_COMMIT_AT=${GATRR_COMMIT_AT}"
echo "    GATRR_DEPLOYED_AT=${GATRR_DEPLOYED_AT}"

echo "==> Pulumi preview"
pulumi preview --diff

echo "==> Pulumi up"
pulumi up --yes

echo "==> Deploy complete"
