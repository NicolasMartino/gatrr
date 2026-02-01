#!/usr/bin/env bash
set -euo pipefail

# Forced-command SSH entrypoint.
#
# Add this script as the forced command in authorized_keys. It will only allow:
#   deploy <stack> <sha>
#
# Everything else is rejected.
#
# Configuration:
#   DEPLOY_SCRIPT - path to deploy-remote.sh (default: same directory as this script)

ORIG="${SSH_ORIGINAL_COMMAND:-}"

if [[ -z "${ORIG}" ]]; then
  echo "ERROR: no command provided. Usage: deploy <stack> <sha>" >&2
  exit 2
fi

# Split on whitespace (expected: 3 tokens)
read -r CMD STACK SHA EXTRA <<<"${ORIG}"

if [[ "${CMD}" != "deploy" ]]; then
  echo "ERROR: unknown command '${CMD}'. Only 'deploy' is allowed." >&2
  exit 2
fi

if [[ -z "${STACK:-}" || -z "${SHA:-}" ]]; then
  echo "ERROR: missing arguments. Usage: deploy <stack> <sha>" >&2
  exit 2
fi

if [[ -n "${EXTRA:-}" ]]; then
  echo "ERROR: too many arguments. Usage: deploy <stack> <sha>" >&2
  exit 2
fi

# Allow override via env var, default to script in same directory
DEPLOY_SCRIPT="${DEPLOY_SCRIPT:-$(dirname "${BASH_SOURCE[0]}")/deploy-remote.sh}"

if [[ ! -x "${DEPLOY_SCRIPT}" ]]; then
  echo "ERROR: deploy script not found or not executable: ${DEPLOY_SCRIPT}" >&2
  exit 1
fi

exec "${DEPLOY_SCRIPT}" "${STACK}" "${SHA}"
