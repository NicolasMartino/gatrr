#!/usr/bin/env bash
set -euo pipefail

# Bootstrap and configure a server for deploying this repo on Ubuntu.
#
# Installs:
# - Docker Engine + compose plugin
# - Node.js 20 + npm
# - Pulumi CLI
# - Git + base tooling
# - UFW firewall (Cloudflare-only for 80/443)
#
# Configures (when pulumi.key provided):
# - deployer user with docker access
# - Pulumi authentication for deployer
# - Git repo clone to /data/gatrr
# - Pulumi stack initialization
#
# Usage:
#   # Basic install (prerequisites only):
#   curl -fsSL https://raw.githubusercontent.com/<org>/gatrr/master/scripts/server-bootstrap-ubuntu.sh | sudo bash
#
#   # Full setup with Pulumi auth:
#   sudo ./server-bootstrap-ubuntu.sh --pulumi-key /path/to/pulumi.key --repo https://github.com/<org>/gatrr.git --stack prod
#
# Options:
#   --pulumi-key <file>   Path to file containing Pulumi access token (enables full setup)
#   --repo <url>          Git repo URL (required when --pulumi-key is used)
#   --stack <name>        Pulumi stack to initialize: staging or prod (default: staging)
#   --esc-env <name>      Pulumi ESC environment name (default: gatrr-<stack>)
#   --deploy-key <file>   SSH public key for deployer user's authorized_keys
#
# This script is idempotent and can be re-run safely.
#
# Supply chain note:
#   This script uses official install scripts from NodeSource and Pulumi.
#   These are fetched over HTTPS and executed. Review the URLs if you have
#   stricter supply chain requirements.

# --- Argument parsing ---
PULUMI_KEY_FILE=""
GIT_REPO_URL=""
STACK_NAME="staging"
ESC_ENV_NAME=""
DEPLOY_KEY_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pulumi-key)
      PULUMI_KEY_FILE="$2"
      shift 2
      ;;
    --repo)
      GIT_REPO_URL="$2"
      shift 2
      ;;
    --stack)
      STACK_NAME="$2"
      shift 2
      ;;
    --esc-env)
      ESC_ENV_NAME="$2"
      shift 2
      ;;
    --deploy-key)
      DEPLOY_KEY_FILE="$2"
      shift 2
      ;;
    -h|--help)
      head -50 "$0" | grep -E "^#" | sed 's/^# \?//'
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

# Validate stack name if provided
case "${STACK_NAME}" in
  staging|prod) ;;
  *)
    echo "ERROR: invalid stack '${STACK_NAME}' (allowed: staging, prod)" >&2
    exit 1
    ;;
esac

# Default ESC environment name
if [[ -z "${ESC_ENV_NAME}" ]]; then
  ESC_ENV_NAME="gatrr-${STACK_NAME}"
fi

if [[ "${EUID}" -ne 0 ]]; then
  echo "ERROR: run as root (use sudo)" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

echo "==> Updating apt"
apt-get update -y

echo "==> Installing base packages"
apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  gnupg \
  lsb-release \
  git \
  openssh-client \
  openssh-server \
  jq \
  unzip

echo "==> Installing Docker Engine"
install -m 0755 -d /etc/apt/keyrings
if [[ ! -f /etc/apt/keyrings/docker.gpg ]]; then
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
fi

ARCH="$(dpkg --print-architecture)"
CODENAME="$(. /etc/os-release && echo "${VERSION_CODENAME}")"

DOCKER_LIST="/etc/apt/sources.list.d/docker.list"
DOCKER_REPO="deb [arch=${ARCH} signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${CODENAME} stable"

if [[ ! -f "${DOCKER_LIST}" ]] || ! grep -qF "${CODENAME}" "${DOCKER_LIST}"; then
  echo "${DOCKER_REPO}" > "${DOCKER_LIST}"
  apt-get update -y
fi

apt-get install -y --no-install-recommends \
  docker-ce \
  docker-ce-cli \
  containerd.io \
  docker-buildx-plugin \
  docker-compose-plugin

systemctl enable --now docker

echo "==> Configuring UFW firewall"
apt-get install -y --no-install-recommends ufw

# Reset UFW to default state (deny incoming, allow outgoing)
ufw --force reset
ufw default deny incoming
ufw default allow outgoing

# Allow SSH (restrict to your admin IP in production by editing /etc/ufw/user.rules)
# For tighter security, replace this with: ufw allow from <YOUR_IP> to any port 22
ufw allow 22/tcp

# Cloudflare IPv4 ranges (source: https://www.cloudflare.com/ips-v4)
# Last updated: 2024-01 - check https://www.cloudflare.com/ips/ for updates
CLOUDFLARE_IPV4=(
  "173.245.48.0/20"
  "103.21.244.0/22"
  "103.22.200.0/22"
  "103.31.4.0/22"
  "141.101.64.0/18"
  "108.162.192.0/18"
  "190.93.240.0/20"
  "188.114.96.0/20"
  "197.234.240.0/22"
  "198.41.128.0/17"
  "162.158.0.0/15"
  "104.16.0.0/13"
  "104.24.0.0/14"
  "172.64.0.0/13"
  "131.0.72.0/22"
)

# Cloudflare IPv6 ranges (source: https://www.cloudflare.com/ips-v6)
CLOUDFLARE_IPV6=(
  "2400:cb00::/32"
  "2606:4700::/32"
  "2803:f800::/32"
  "2405:b500::/32"
  "2405:8100::/32"
  "2a06:98c0::/29"
  "2c0f:f248::/32"
)

echo "    Adding Cloudflare IP ranges for ports 80/443..."
for cidr in "${CLOUDFLARE_IPV4[@]}"; do
  ufw allow from "$cidr" to any port 80 proto tcp
  ufw allow from "$cidr" to any port 443 proto tcp
done

for cidr in "${CLOUDFLARE_IPV6[@]}"; do
  ufw allow from "$cidr" to any port 80 proto tcp
  ufw allow from "$cidr" to any port 443 proto tcp
done

# Enable UFW (--force to avoid interactive prompt)
ufw --force enable
echo "    UFW status:"
ufw status verbose

echo "==> Installing Node.js 20 (NodeSource)"
# Supply chain: https://github.com/nodesource/distributions
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | tr -d 'v' | cut -d. -f1)" -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y --no-install-recommends nodejs
fi

echo "==> Installing Pulumi CLI"
# Supply chain: https://github.com/pulumi/pulumi
# Pinned version for reproducibility. Update this when upgrading Pulumi.
PULUMI_VERSION="3.142.0"
PULUMI_BIN="/usr/local/bin/pulumi"

install_pulumi() {
  local tmp_dir
  tmp_dir="$(mktemp -d)"

  echo "    Downloading Pulumi v${PULUMI_VERSION}..."
  curl -fsSL "https://get.pulumi.com/releases/sdk/pulumi-v${PULUMI_VERSION}-linux-x64.tar.gz" -o "${tmp_dir}/pulumi.tar.gz"
  tar -xzf "${tmp_dir}/pulumi.tar.gz" -C "${tmp_dir}"
  install -m 0755 "${tmp_dir}/pulumi/pulumi" "${PULUMI_BIN}"

  # Install additional Pulumi binaries
  for bin in pulumi-language-nodejs pulumi-analyzer-policy; do
    if [[ -f "${tmp_dir}/pulumi/${bin}" ]]; then
      install -m 0755 "${tmp_dir}/pulumi/${bin}" "/usr/local/bin/${bin}"
    fi
  done

  # Cleanup temp directory
  rm -rf "${tmp_dir}"
}

if ! command -v pulumi >/dev/null 2>&1; then
  install_pulumi
else
  echo "    Pulumi already installed: $(pulumi version)"
fi

echo "==> Prerequisites installed"
echo "Docker: $(docker --version)"
echo "Node:   $(node --version)"
echo "Pulumi: $(pulumi version)"

# --- Full setup (only if pulumi key provided) ---
if [[ -z "${PULUMI_KEY_FILE}" ]]; then
  echo ""
  echo "==> Basic setup complete. For full setup, re-run with:"
  echo "    $0 --pulumi-key /path/to/pulumi.key --repo <git-url> --stack <staging|prod>"
  exit 0
fi

# Validate pulumi key file
if [[ ! -f "${PULUMI_KEY_FILE}" ]]; then
  echo "ERROR: Pulumi key file not found: ${PULUMI_KEY_FILE}" >&2
  exit 1
fi

PULUMI_ACCESS_TOKEN="$(cat "${PULUMI_KEY_FILE}" | tr -d '[:space:]')"
if [[ -z "${PULUMI_ACCESS_TOKEN}" ]]; then
  echo "ERROR: Pulumi key file is empty: ${PULUMI_KEY_FILE}" >&2
  exit 1
fi

if [[ -z "${GIT_REPO_URL}" ]]; then
  echo "ERROR: --repo is required when using --pulumi-key" >&2
  exit 1
fi

echo ""
echo "==> Creating deployer user"
if ! id deployer &>/dev/null; then
  useradd -m -s /bin/bash deployer
  echo "    Created user: deployer"
else
  echo "    User deployer already exists"
fi

# Add deployer to docker group
usermod -aG docker deployer
echo "    Added deployer to docker group"

# Create deploy directories (outside git tree)
mkdir -p /var/log/gatrr /var/run/gatrr
chown deployer:deployer /var/log/gatrr /var/run/gatrr
echo "    Created /var/log/gatrr and /var/run/gatrr"

# Set up SSH authorized_keys with forced command (if deploy key provided)
DEPLOYER_HOME="/home/deployer"
DEPLOYER_SSH="${DEPLOYER_HOME}/.ssh"

mkdir -p "${DEPLOYER_SSH}"
chmod 700 "${DEPLOYER_SSH}"

if [[ -n "${DEPLOY_KEY_FILE}" && -f "${DEPLOY_KEY_FILE}" ]]; then
  # Read and validate SSH public key (must be single line, valid format)
  DEPLOY_PUBKEY="$(tr -d '\n\r' < "${DEPLOY_KEY_FILE}")"

  # Validate key format (should start with ssh-ed25519, ssh-rsa, ecdsa-sha2-*, or sk-*)
  if ! [[ "${DEPLOY_PUBKEY}" =~ ^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp[0-9]+|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp[0-9]+@openssh\.com)[[:space:]] ]]; then
    echo "ERROR: Invalid SSH public key format in ${DEPLOY_KEY_FILE}" >&2
    echo "       Key must start with ssh-ed25519, ssh-rsa, ecdsa-sha2-*, or sk-*" >&2
    exit 1
  fi

  FORCED_CMD='command="/data/gatrr/scripts/ssh-deploy-entrypoint.sh",no-pty,no-agent-forwarding,no-port-forwarding,no-user-rc,no-X11-forwarding'

  AUTH_KEYS="${DEPLOYER_SSH}/authorized_keys"
  echo "${FORCED_CMD} ${DEPLOY_PUBKEY}" > "${AUTH_KEYS}"
  chmod 600 "${AUTH_KEYS}"
  echo "    Configured SSH authorized_keys with forced command"
else
  echo "    Skipping SSH key setup (no --deploy-key provided)"
fi

chown -R deployer:deployer "${DEPLOYER_SSH}"

echo "==> Configuring Pulumi authentication for deployer"
DEPLOYER_PULUMI="${DEPLOYER_HOME}/.pulumi"
mkdir -p "${DEPLOYER_PULUMI}"

# Create credentials.json for Pulumi Cloud
cat > "${DEPLOYER_PULUMI}/credentials.json" <<EOF
{
  "current": "https://api.pulumi.com",
  "accessTokens": {
    "https://api.pulumi.com": "${PULUMI_ACCESS_TOKEN}"
  }
}
EOF
chmod 600 "${DEPLOYER_PULUMI}/credentials.json"
chown -R deployer:deployer "${DEPLOYER_PULUMI}"
echo "    Pulumi credentials configured"

# Verify Pulumi login works
echo "    Verifying Pulumi authentication..."
if sudo -u deployer bash -c 'cd ~ && pulumi whoami' &>/dev/null; then
  PULUMI_USER="$(sudo -u deployer bash -c 'cd ~ && pulumi whoami')"
  echo "    Authenticated as: ${PULUMI_USER}"
else
  echo "ERROR: Pulumi authentication failed. Check your access token." >&2
  exit 1
fi

echo "==> Cloning repository"
REPO_DIR="/data/gatrr"

mkdir -p /data
if [[ -d "${REPO_DIR}/.git" ]]; then
  echo "    Repository already exists at ${REPO_DIR}"
  chown -R deployer:deployer "${REPO_DIR}"
  cd "${REPO_DIR}"
  sudo -u deployer git fetch origin
else
  git clone "${GIT_REPO_URL}" "${REPO_DIR}"
  chown -R deployer:deployer "${REPO_DIR}"
  echo "    Cloned to ${REPO_DIR}"
fi
cd "${REPO_DIR}"

echo "==> Installing infra dependencies"
cd "${REPO_DIR}/infra/pulumi"
sudo -u deployer npm ci

echo "==> Initializing Pulumi stack: ${STACK_NAME}"
cd "${REPO_DIR}/infra/pulumi"

# Check if stack exists
if sudo -u deployer pulumi stack ls 2>/dev/null | grep -q "^${STACK_NAME}"; then
  echo "    Stack ${STACK_NAME} already exists, selecting it"
  sudo -u deployer pulumi stack select "${STACK_NAME}"
else
  echo "    Creating new stack: ${STACK_NAME}"
  sudo -u deployer pulumi stack init "${STACK_NAME}"
fi

# Configure stack to use ESC environment
echo "==> Configuring ESC environment: ${ESC_ENV_NAME}"
# Note: The stack needs to import from the ESC environment
# This is done via Pulumi.yaml or stack config
echo "    ESC environment: ${ESC_ENV_NAME}"
echo "    Make sure this environment exists in Pulumi Cloud with your secrets"

echo ""
echo "=========================================="
echo "==> Server setup complete!"
echo "=========================================="
echo ""
echo "Stack:       ${STACK_NAME}"
echo "Repo:        ${REPO_DIR}"
echo "ESC Env:     ${ESC_ENV_NAME}"
echo "Deployer:    deployer (use 'sudo -u deployer' to run commands)"
echo ""
echo "Next steps:"
echo "1. Ensure ESC environment '${ESC_ENV_NAME}' exists in Pulumi Cloud"
echo "   (copy contents of infra/pulumi/esc.prod.yaml and update values)"
echo ""
echo "2. Configure the stack to import from ESC:"
echo "   cd ${REPO_DIR}/infra/pulumi"
echo "   Add to Pulumi.${STACK_NAME}.yaml:"
echo "     environment:"
echo "       - ${ESC_ENV_NAME}"
echo ""
echo "3. Test deployment:"
echo "   sudo -u deployer ${REPO_DIR}/scripts/deploy-remote.sh ${STACK_NAME} \$(git rev-parse HEAD)"
echo ""
echo "4. Test SSH forced-command (from remote):"
echo "   ssh deployer@<this-server> 'deploy ${STACK_NAME} <commit-sha>'"
echo ""
