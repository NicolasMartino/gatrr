#!/bin/bash
set -euo pipefail

# Forced-command SSH entrypoint.
# Restricts SSH access to only allow specific commands.

SCRIPTS_DIR="/data/gatrr/scripts"
LOG_DIR="/var/log/gatrr"
mkdir -p "${LOG_DIR}"

cmdline="${SSH_ORIGINAL_COMMAND:-}"
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) SSH command: ${cmdline}" >> "${LOG_DIR}/ssh-commands.log"

if [[ -z "${cmdline}" ]]; then
  echo "ERROR: no command provided." >&2
  echo "Allowed commands:" >&2
  echo "  deploy <stack> <sha> [--only-update-repo]" >&2
  echo "  update <stack> <sha>" >&2
  exit 2
fi

read -r cmd a b c extra <<<"${cmdline}"

if [[ ! -x "${SCRIPTS_DIR}/deploy-remote.sh" ]]; then
  echo "ERROR: deploy script not found or not executable: ${SCRIPTS_DIR}/deploy-remote.sh" >&2
  exit 1
fi

case "${cmd}" in
  deploy)
    # Allowed:
    #   deploy <stack> <sha>
    #   deploy <stack> <sha> --only-update-repo
    #   deploy --only-update-repo <stack> <sha>
    if [[ "${a}" == "--only-update-repo" ]]; then
      [[ -z "${b:-}" || -z "${c:-}" || -n "${extra:-}" ]] && { echo "ERROR: Usage: deploy --only-update-repo <stack> <sha>" >&2; exit 2; }
      exec "${SCRIPTS_DIR}/deploy-remote.sh" --only-update-repo "${b}" "${c}"
    else
      if [[ -z "${a:-}" || -z "${b:-}" ]]; then
        echo "ERROR: Usage: deploy <stack> <sha> [--only-update-repo]" >&2
        exit 2
      fi
      if [[ "${c:-}" == "--only-update-repo" ]]; then
        [[ -n "${extra:-}" ]] && { echo "ERROR: too many arguments" >&2; exit 2; }
        exec "${SCRIPTS_DIR}/deploy-remote.sh" --only-update-repo "${a}" "${b}"
      else
        [[ -n "${c:-}" ]] && { echo "ERROR: too many arguments" >&2; exit 2; }
        exec "${SCRIPTS_DIR}/deploy-remote.sh" "${a}" "${b}"
      fi
    fi
    ;;

  update)
    # Wrapper for updating scripts without deploying.
    # Usage: update <stack> <sha>
    [[ -z "${a:-}" || -z "${b:-}" || -n "${c:-}" ]] && { echo "ERROR: Usage: update <stack> <sha>" >&2; exit 2; }
    exec "${SCRIPTS_DIR}/deploy-remote.sh" --only-update-repo "${a}" "${b}"
    ;;

  *)
    echo "ERROR: unknown command '${cmd}'." >&2
    echo "Allowed commands:" >&2
    echo "  deploy <stack> <sha> [--only-update-repo]" >&2
    echo "  update <stack> <sha>" >&2
    exit 2
    ;;
esac
