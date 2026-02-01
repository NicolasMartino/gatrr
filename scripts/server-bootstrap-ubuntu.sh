#!/usr/bin/env bash
set -euo pipefail

# Bootstrap prerequisites for deploying this repo on Ubuntu (latest).
# Installs:
# - Docker Engine + compose plugin
# - Node.js 20 + npm
# - Pulumi CLI
# - Git + base tooling
#
# This script is idempotent and can be re-run safely.
#
# Supply chain note:
#   This script uses official install scripts from NodeSource and Pulumi.
#   These are fetched over HTTPS and executed. Review the URLs if you have
#   stricter supply chain requirements.

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
  ufw allow from "$cidr" to any port 80,443 proto tcp
done

for cidr in "${CLOUDFLARE_IPV6[@]}"; do
  ufw allow from "$cidr" to any port 80,443 proto tcp
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
  trap "rm -rf '${tmp_dir}'" RETURN

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
}

if ! command -v pulumi >/dev/null 2>&1; then
  install_pulumi
else
  echo "    Pulumi already installed: $(pulumi version)"
fi

echo "==> Done"
echo "Docker: $(docker --version)"
echo "Node:   $(node --version)"
echo "Pulumi: $(pulumi version)"
