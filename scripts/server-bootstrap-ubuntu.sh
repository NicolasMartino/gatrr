#!/bin/bash
#
# Server bootstrap script for Ubuntu
#
# Installs:
# - Docker Engine (from official Docker repo)
# - Node.js 20 + npm
# - Pulumi CLI (pinned version)
# - UFW firewall (Cloudflare-only for 80/443, SSH open)
#
# Modes:
#   1. Pipe install (prerequisites only - no repo, no deployer user):
#      curl -fsSL https://raw.githubusercontent.com/NicolasMartino/gatrr/master/scripts/server-bootstrap-ubuntu.sh | sudo bash
#
#   2. Full setup (prerequisites + repo + deployer user + optional Pulumi):
#   sudo ./server-bootstrap-ubuntu.sh \
#     --pulumi-token /path/to/pulumi-token.txt \
#     --repo https://github.com/NicolasMartino/gatrr.git \
#     --stack prod \
#     --deploy-key /path/to/deploy.pub
#
# Update mode (just updates scripts, doesn't reinstall):
#   sudo ./server-bootstrap-ubuntu.sh --update --repo https://github.com/NicolasMartino/gatrr.git
#
# This script is idempotent and can be re-run safely.

set -euo pipefail

# --- Constants ---
INSTALL_DIR="/data/gatrr"
DEPLOYER_USER="deployer"
PULUMI_VERSION="3.217.1"

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

# --- Root check ---
if [[ "${EUID}" -ne 0 ]]; then
    echo "ERROR: This script must be run as root (use sudo)" >&2
    exit 1
fi

# --- OS check ---
if [[ ! -f /etc/os-release ]] || ! grep -qi ubuntu /etc/os-release; then
    echo "ERROR: This script is designed for Ubuntu" >&2
    exit 1
fi

export DEBIAN_FRONTEND=noninteractive

# --- Argument parsing ---
REPO_URL=""
STACK=""
PULUMI_TOKEN_PATH=""
DEPLOY_KEY_PATH=""
UPDATE_ONLY=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --repo)
            REPO_URL="$2"
            shift 2
            ;;
        --stack)
            STACK="$2"
            shift 2
            ;;
        --pulumi-token)
            PULUMI_TOKEN_PATH="$2"
            shift 2
            ;;
        --deploy-key)
            DEPLOY_KEY_PATH="$2"
            shift 2
            ;;
        --update)
            UPDATE_ONLY=true
            shift
            ;;
        -h|--help)
            head -25 "$0" | grep -E "^#" | sed 's/^# \?//'
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            exit 1
            ;;
    esac
done

# --- Stack validation ---
if [[ -n "$STACK" ]]; then
    case "$STACK" in
        staging|prod) ;;
        *)
            echo "ERROR: Invalid stack '$STACK' (allowed: staging, prod)" >&2
            exit 1
            ;;
    esac
fi

echo "============================================"
echo "GATRR Server Bootstrap"
echo "============================================"

# --- Update mode ---
if [[ "$UPDATE_ONLY" == "true" ]]; then
    echo "Mode: Update scripts only"

    if [[ -z "$REPO_URL" ]]; then
        echo "Error: --repo is required for update mode" >&2
        exit 1
    fi

    if [[ ! -d "$INSTALL_DIR/.git" ]]; then
        echo "ERROR: Repository not found at $INSTALL_DIR" >&2
        echo "       Run full installation first (without --update)" >&2
        exit 1
    fi

    # Verify origin matches --repo to prevent accidental updates from wrong repo
    cd "$INSTALL_DIR"
    EXISTING_ORIGIN="$(git remote get-url origin 2>/dev/null || echo "")"
    if [[ "$EXISTING_ORIGIN" != "$REPO_URL" ]]; then
        echo "ERROR: Origin mismatch" >&2
        echo "       Existing: $EXISTING_ORIGIN" >&2
        echo "       Provided: $REPO_URL" >&2
        echo "       Use 'git remote set-url origin <url>' to change, or verify --repo" >&2
        exit 1
    fi

    echo "Fetching latest scripts..."
    git fetch origin
    git checkout origin/master -- scripts/
    chmod +x scripts/*.sh

    echo "Scripts updated successfully!"
    echo "============================================"
    exit 0
fi

# --- Full installation mode ---
echo "Mode: Full installation"

if [[ -z "$REPO_URL" ]]; then
    echo "Error: --repo is required" >&2
    exit 1
fi

# --- Install base packages ---
echo "==> Installing base packages..."
apt-get update -y
apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gnupg \
    lsb-release \
    git \
    jq \
    unzip \
    openssh-server \
    util-linux  # provides flock, used by deploy script

# Ensure SSH is running (may not be on minimal images)
systemctl enable --now ssh

# --- Install Docker CE (official repo) ---
echo "==> Installing Docker Engine..."
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

# --- Configure UFW firewall ---
# WARNING: This resets UFW to a clean state, removing any existing rules.
# This is appropriate for a dedicated GATRR host. If this server has other
# services with custom firewall rules, back them up first or skip this section.
echo "==> Configuring UFW firewall..."
echo "    WARNING: Resetting UFW (existing rules will be removed)"
apt-get install -y --no-install-recommends ufw

# Reset UFW to default state (destructive - removes all existing rules)
ufw --force reset
ufw default deny incoming
ufw default allow outgoing

# Allow SSH (restrict to admin IP in production by editing /etc/ufw/user.rules)
ufw allow 22/tcp

# Add Cloudflare IP ranges for ports 80/443
echo "    Adding Cloudflare IP ranges for ports 80/443..."
for cidr in "${CLOUDFLARE_IPV4[@]}"; do
    ufw allow from "$cidr" to any port 80 proto tcp
    ufw allow from "$cidr" to any port 443 proto tcp
done

for cidr in "${CLOUDFLARE_IPV6[@]}"; do
    ufw allow from "$cidr" to any port 80 proto tcp
    ufw allow from "$cidr" to any port 443 proto tcp
done

ufw --force enable
echo "    UFW enabled"

# --- Install Node.js 20 ---
echo "==> Installing Node.js 20..."
if ! command -v node &>/dev/null || [[ "$(node -v | tr -d 'v' | cut -d. -f1)" -lt 20 ]]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y --no-install-recommends nodejs
fi

# --- Install Pulumi (pinned version) ---
echo "==> Installing Pulumi v${PULUMI_VERSION}..."
PULUMI_BIN="/usr/local/bin/pulumi"

if ! command -v pulumi &>/dev/null; then
    TMP_DIR="$(mktemp -d)"
    curl -fsSL "https://get.pulumi.com/releases/sdk/pulumi-v${PULUMI_VERSION}-linux-x64.tar.gz" -o "${TMP_DIR}/pulumi.tar.gz"
    tar -xzf "${TMP_DIR}/pulumi.tar.gz" -C "${TMP_DIR}"
    install -m 0755 "${TMP_DIR}/pulumi/pulumi" "${PULUMI_BIN}"

    for bin in pulumi-language-nodejs pulumi-analyzer-policy; do
        if [[ -f "${TMP_DIR}/pulumi/${bin}" ]]; then
            install -m 0755 "${TMP_DIR}/pulumi/${bin}" "/usr/local/bin/${bin}"
        fi
    done

    rm -rf "${TMP_DIR}"
else
    echo "    Pulumi already installed: $(pulumi version)"
fi

# --- Summary ---
echo "==> Prerequisites installed"
echo "    Docker: $(docker --version)"
echo "    Node:   $(node --version)"
echo "    Pulumi: $(pulumi version)"

# --- Create deployer user ---
echo "==> Creating deployer user..."
if ! id "$DEPLOYER_USER" &>/dev/null; then
    useradd -m -s /bin/bash "$DEPLOYER_USER"
    echo "    Created user: $DEPLOYER_USER"
else
    echo "    User $DEPLOYER_USER already exists"
fi

usermod -aG docker "$DEPLOYER_USER"

# --- Create directories ---
mkdir -p /var/log/gatrr /var/run/gatrr
chown "$DEPLOYER_USER:$DEPLOYER_USER" /var/log/gatrr /var/run/gatrr

# --- Setup Pulumi credentials ---
# --pulumi-token expects a file containing a raw Pulumi access token (not JSON)
# The token is written into ~/.pulumi/credentials.json for the deployer user
if [[ -n "$PULUMI_TOKEN_PATH" && -f "$PULUMI_TOKEN_PATH" ]]; then
    echo "==> Setting up Pulumi credentials..."

    PULUMI_ACCESS_TOKEN="$(tr -d '[:space:]' < "$PULUMI_TOKEN_PATH")"
    if [[ -z "$PULUMI_ACCESS_TOKEN" ]]; then
        echo "ERROR: Pulumi token file is empty: $PULUMI_TOKEN_PATH" >&2
        exit 1
    fi

    DEPLOYER_HOME=$(eval echo ~$DEPLOYER_USER)
    mkdir -p "$DEPLOYER_HOME/.pulumi"

    cat > "$DEPLOYER_HOME/.pulumi/credentials.json" <<EOF
{
  "current": "https://api.pulumi.com",
  "accessTokens": {
    "https://api.pulumi.com": "${PULUMI_ACCESS_TOKEN}"
  }
}
EOF

    chown -R "$DEPLOYER_USER:$DEPLOYER_USER" "$DEPLOYER_HOME/.pulumi"
    chmod 600 "$DEPLOYER_HOME/.pulumi/credentials.json"

    # Verify Pulumi authentication
    echo "    Verifying Pulumi authentication..."
    if sudo -u "$DEPLOYER_USER" bash -c 'cd ~ && pulumi whoami' &>/dev/null; then
        PULUMI_USER="$(sudo -u "$DEPLOYER_USER" bash -c 'cd ~ && pulumi whoami')"
        echo "    Authenticated as: ${PULUMI_USER}"
    else
        echo "ERROR: Pulumi authentication failed. Check your access token." >&2
        exit 1
    fi
fi

# --- Clone or update repo ---
echo "==> Setting up repository..."
if [[ -d "$INSTALL_DIR/.git" ]]; then
    echo "    Updating repository..."
    cd "$INSTALL_DIR"
    git fetch origin
else
    echo "    Cloning repository..."
    mkdir -p "$(dirname "$INSTALL_DIR")"
    git clone "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
chown -R "$DEPLOYER_USER:$DEPLOYER_USER" "$INSTALL_DIR"
chmod +x scripts/*.sh

# --- Setup SSH deploy key ---
# NOTE: This overwrites authorized_keys for the deployer user (not appends).
# The deployer account is single-purpose; only the deploy key should have access.
if [[ -n "$DEPLOY_KEY_PATH" && -f "$DEPLOY_KEY_PATH" ]]; then
    echo "==> Setting up SSH deploy key..."

    # Read and validate SSH public key
    DEPLOY_KEY="$(tr -d '\n\r' < "$DEPLOY_KEY_PATH")"

    # Validate key format
    if ! [[ "$DEPLOY_KEY" =~ ^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp[0-9]+|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp[0-9]+@openssh\.com)[[:space:]] ]]; then
        echo "ERROR: Invalid SSH public key format in $DEPLOY_KEY_PATH" >&2
        echo "       Key must start with ssh-ed25519, ssh-rsa, ecdsa-sha2-*, or sk-*" >&2
        exit 1
    fi

    DEPLOYER_HOME=$(eval echo ~$DEPLOYER_USER)
    mkdir -p "$DEPLOYER_HOME/.ssh"

    # Full forced command with all security restrictions
    FORCED_CMD="command=\"$INSTALL_DIR/scripts/ssh-deploy-entrypoint.sh\",no-pty,no-agent-forwarding,no-port-forwarding,no-user-rc,no-X11-forwarding"

    AUTHORIZED_KEYS="$DEPLOYER_HOME/.ssh/authorized_keys"

    # Warn if overwriting existing keys
    if [[ -f "$AUTHORIZED_KEYS" ]]; then
        echo "    WARNING: Overwriting existing authorized_keys for $DEPLOYER_USER"
    fi

    echo "$FORCED_CMD $DEPLOY_KEY" > "$AUTHORIZED_KEYS"

    chown -R "$DEPLOYER_USER:$DEPLOYER_USER" "$DEPLOYER_HOME/.ssh"
    chmod 700 "$DEPLOYER_HOME/.ssh"
    chmod 600 "$AUTHORIZED_KEYS"

    echo "    Configured SSH authorized_keys with forced command"
fi

# --- Initialize Pulumi stack ---
if [[ -n "$STACK" ]]; then
    echo "==> Initializing Pulumi stack: $STACK"
    cd "$INSTALL_DIR/infra/pulumi"
    sudo -u "$DEPLOYER_USER" npm ci

    # Stack select/create - requires valid Pulumi credentials
    # If --pulumi-token was not provided, this will fail (which is correct)
    if sudo -u "$DEPLOYER_USER" pulumi stack select "$STACK" 2>/dev/null; then
        echo "    Selected existing stack: $STACK"
    elif sudo -u "$DEPLOYER_USER" pulumi stack init "$STACK" 2>&1; then
        echo "    Created new stack: $STACK"
    else
        echo "ERROR: Failed to select or create Pulumi stack '$STACK'" >&2
        echo "       Ensure --pulumi-token was provided and is valid" >&2
        exit 1
    fi
fi

echo "============================================"
echo "Bootstrap complete!"
echo ""
echo "Installed versions:"
echo "  Docker: $(docker --version | cut -d' ' -f3 | tr -d ',')"
echo "  Node:   $(node --version)"
echo "  Pulumi: $(pulumi version)"
echo ""
echo "UFW firewall: enabled (SSH open, HTTP/HTTPS Cloudflare-only)"
echo ""
echo "Next steps:"
echo "  1. Ensure Pulumi ESC environment is configured"
echo "  2. Deploy with: ssh deployer@<host> 'deploy $STACK <sha>'"
echo "============================================"
