#!/usr/bin/env bash
set -euo pipefail

# Deploy this repo on the target host.
# Intended to be run on the bare metal server (invoked via forced-command SSH).

usage() {
  echo "Usage: $0 <stack> <commit-sha>" >&2
  echo "Example: $0 staging abc123def456..." >&2
  echo "Note: full 40-character SHA is required" >&2
}

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

# Require full 40-char SHA to avoid ambiguity in large repos
if [[ ! "${SHA}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "ERROR: invalid commit sha '${SHA}' (must be full 40-char hex)" >&2
  exit 2
fi

REPO_DIR="${REPO_DIR:-/data/gatrr}"

if [[ ! -d "${REPO_DIR}/.git" ]]; then
  echo "ERROR: repo not found at ${REPO_DIR} (expected .git)" >&2
  exit 1
fi

# Use repo-local paths to avoid permission issues with deployer user
LOG_DIR="${LOG_DIR:-${REPO_DIR}/.deploy-logs}"
mkdir -p "${LOG_DIR}"

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
LOG_FILE="${LOG_DIR}/deploy-${STACK}-${TIMESTAMP}-${SHA:0:8}.log"

# Log to both file and stdout
exec > >(tee -a "${LOG_FILE}") 2>&1

echo "==> Deploy started at $(date -Iseconds)"
echo "    Stack: ${STACK}"
echo "    SHA:   ${SHA}"
echo "    Log:   ${LOG_FILE}"

# Lock file in repo dir (deployer has write access)
LOCK_FILE="${REPO_DIR}/.deploy.lock"
exec 9>"${LOCK_FILE}"
if ! flock -n 9; then
  echo "ERROR: another deploy is in progress (lock: ${LOCK_FILE})" >&2
  exit 1
fi

cd "${REPO_DIR}"

# Save current HEAD to restore on failure
PREV_HEAD="$(git rev-parse HEAD 2>/dev/null || echo "")"

cleanup() {
  local exit_code=$?
  if [[ ${exit_code} -ne 0 && -n "${PREV_HEAD}" ]]; then
    echo "==> Deploy failed (exit ${exit_code}), restoring previous HEAD: ${PREV_HEAD}"
    git checkout --detach "${PREV_HEAD}" 2>/dev/null || true
  fi
  echo "==> Deploy finished at $(date -Iseconds) with exit code ${exit_code}"
}
trap cleanup EXIT

GIT_REMOTE="${GIT_REMOTE:-origin}"

echo "==> Fetching git refs from ${GIT_REMOTE}"
git fetch "${GIT_REMOTE}" --prune

echo "==> Checking out ${SHA} (detached)"
git checkout --detach "${SHA}"

echo "==> Installing infra dependencies"
cd infra/pulumi
npm ci

echo "==> Selecting Pulumi stack: ${STACK}"
pulumi stack select "${STACK}"

echo "==> Pulumi preview"
pulumi preview --diff

echo "==> Pulumi up"
pulumi up --yes

echo "==> Deploy complete"
