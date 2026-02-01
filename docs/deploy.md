# Deployment (GitHub Actions -> SSH forced command -> Pulumi Cloud)

This document describes a deployment workflow where:

- GitHub Actions runs `pulumi preview` automatically on PRs and pushes to master.
- A manual workflow dispatch SSHes into the bare metal server and triggers a single deployment script.
- The SSH key used by CI is restricted to run only that script (forced command).
- Pulumi uses Pulumi Cloud for state, locking, and audit history.

This fits the current repo because the Pulumi program builds Docker images with `skipPush: true`.
That means builds must happen on the target Docker daemon (the bare metal host).

## Overview

- Target OS: Ubuntu (latest)
- Target environment: staging (bare metal)
- IaC: Pulumi TypeScript (`infra/pulumi/`)
- State backend: Pulumi Cloud
- Deploy execution: on the server (invoked via SSH)

## CI/CD Flow

1) Automatic preview

- Trigger: pull requests and pushes to `master` branch
- Runner: GitHub-hosted runner
- Action: `pulumi preview --diff` for the `staging` stack

2) Manual deploy

- Trigger: workflow dispatch (manual) on `master` branch
- Runner: GitHub-hosted runner
- Action: SSH to the server and run the deploy script for a specific commit SHA
- Guardrails: protected environment + concurrency group + forced-command SSH key

## Server Setup

### Prerequisites

- Public DNS points to the server (and for HTTPS stacks, ports 80/443 reachable).
- Docker installed and running.
- Node.js installed (Node 20 is a good default for this repo).
- Pulumi CLI installed.
- A working copy of this repo present on disk.

### Install prerequisites (one-time)

Use the bootstrap script:

```bash
sudo bash scripts/server-bootstrap-ubuntu.sh
```

This installs:

- Docker Engine + Docker Compose plugin
- Node.js 20 + npm
- Pulumi CLI
- Git + base tooling

Tip: run this on the server after cloning this repo, or copy `scripts/server-bootstrap-ubuntu.sh` over and run it.

### Create a dedicated deploy user

Create a non-root user (example: `deployer`) and give it Docker access:

```bash
sudo adduser --disabled-password --gecos "" deployer
sudo usermod -aG docker deployer
```

Note: membership in the `docker` group is effectively root-level on the host.
Treat deploy credentials accordingly.

### Clone repo on the server

The deploy script defaults to `/data/gatrr`. Clone to this location:

```bash
sudo mkdir -p /data/gatrr
sudo chown deployer:deployer /data/gatrr
sudo -u deployer git clone <YOUR_REPO_SSH_OR_HTTPS_URL> /data/gatrr
```

**Using a different path**: If you need a different location (e.g., `/opt/gatrr`), set `REPO_DIR` in the SSH forced command (see [SSH Hardening](#ssh-hardening-forced-command)).

### Authenticate Pulumi (Pulumi Cloud)

On the server (as `deployer`), authenticate and select the stack:

```bash
sudo -u deployer bash -lc 'pulumi login'
sudo -u deployer bash -lc 'cd /data/gatrr/infra/pulumi && pulumi stack select staging --create'
```

Then configure the stack by creating a config file and loading it:

```bash
# Create config file (as deployer)
sudo -u deployer bash -lc 'cd /data/gatrr/infra/pulumi && npm run config:load'
# → Creates config.staging.yaml with example values

# Edit the config file
sudo -u deployer nano /data/gatrr/infra/pulumi/config.staging.yaml

# Load config into Pulumi
sudo -u deployer bash -lc 'cd /data/gatrr/infra/pulumi && npm run config:load'
```

The config file contains stack settings, services, and secrets in one place. See the README for the full format.

## Pulumi Cloud

This project uses [Pulumi Cloud](https://app.pulumi.com) as the state backend. Pulumi Cloud provides:

- **State storage**: Stack state is stored remotely, not in local files
- **Locking**: Prevents concurrent updates to the same stack
- **Audit history**: Full history of who deployed what and when
- **Secrets encryption**: Secrets are encrypted at rest using Pulumi's encryption

### Getting Started with Pulumi Cloud

1. Create a free account at [app.pulumi.com](https://app.pulumi.com)

2. Create an access token (Settings → Access Tokens)

3. Login from the CLI:
   ```bash
   pulumi login
   ```

4. For CI, set the `PULUMI_ACCESS_TOKEN` secret in GitHub Actions

### Viewing State and History

- **Web UI**: Visit [app.pulumi.com](https://app.pulumi.com) to see stacks, resources, and deployment history
- **CLI**: Use `pulumi stack history` to see recent deployments

## Configuration System

Each stack has a unified config file: `config.<stack>.yaml`

This file contains all stack settings, services, and secrets in one place.

### Setup (Local Development)

```bash
cd infra/pulumi
export PULUMI_CONFIG_PASSPHRASE=""  # Empty for local dev

# Create stack and generate config file
npm run new local
# → Creates config.local.yaml with example values

# Edit the config file with your settings
# Then load it into Pulumi:
npm run config:load
```

### Config File Format

```yaml
stack:
  deploymentId: local
  baseDomain: localhost
  environment: dev
  keycloakRealm: local
  keycloakDevMode: true

services:
  demo:
    portalName: Demo App
    requiredRoles: [admin, dev]
    group: apps

secrets:
  keycloakAdminUsername: admin
  keycloakAdminPassword: changeme
  users:
    - username: admin
      password: admin
      roles: admin
      email: admin@localhost.local
```

### When to Use

| Environment | Method |
|-------------|--------|
| **Local dev** | `config.local.yaml` + `npm run config:load` |
| **Staging/Prod** | `config.<stack>.yaml` + `npm run config:load` on the server |

**Important**: Config files are gitignored (they contain secrets).

## Deploy Script (server)

The deploy script should:

- accept `(stack, commitSha)`
- validate inputs (stack allowlist + SHA format)
- fetch and checkout the exact SHA (detached)
- run `npm ci` and `pulumi up --yes`
- take a lock to prevent concurrent deploys

Suggested layout:

- `scripts/deploy-remote.sh` in this repo (copied to the server, or run from the repo checkout)

## SSH Hardening (forced command)

Goal: the CI SSH key should only be able to run the deploy script.

The repo includes:

- `scripts/ssh-deploy-entrypoint.sh` (forced-command entrypoint; only allows `deploy <stack> <sha>`)
- `scripts/deploy-remote.sh` (does the actual deploy)

On the server, in `/home/deployer/.ssh/authorized_keys`, set a forced command for the CI key:

```
command="/data/gatrr/scripts/ssh-deploy-entrypoint.sh",no-pty,no-agent-forwarding,no-port-forwarding,no-user-rc,no-X11-forwarding ssh-ed25519 AAAA... ci-deploy
```

The entrypoint script reads `$SSH_ORIGINAL_COMMAND` and only permits the intended invocation.

**Custom repo path**: If you cloned to a different location, set `REPO_DIR` in the forced command:

```
command="REPO_DIR=/opt/gatrr /opt/gatrr/scripts/ssh-deploy-entrypoint.sh",no-pty,no-agent-forwarding,no-port-forwarding,no-user-rc,no-X11-forwarding ssh-ed25519 AAAA... ci-deploy
```

## GitHub Actions Notes

- Preview runs on GitHub-hosted runners for PRs and pushes to master.
- Deploy is triggered manually via workflow dispatch.
- Use `concurrency` groups to prevent concurrent deploys.
- Deploy passes the immutable commit SHA (`${{ github.sha }}`) to the server.

Example deploy invocation:

```bash
ssh deployer@<host> "deploy staging ${{ github.sha }}"
```

### Workflow File

The workflow is defined in `.github/workflows/deploy.yml`. Key features:

- **test/lint**: Validate Pulumi TypeScript code
- **preview**: Show Pulumi diff for staging (runs on PRs and master)
- **deploy**: Manual deployment via workflow dispatch

To trigger a deploy:
1. Go to Actions → CI/CD → Run workflow
2. Select the branch (`master`)
3. Click "Run workflow"

**Required secrets** (Settings → Secrets and variables → Actions):

| Secret | Description |
|--------|-------------|
| `SSH_PRIVATE_KEY` | Ed25519 private key for deployer |
| `SSH_KNOWN_HOSTS` | Output of `ssh-keyscan -t ed25519 <host>` |
| `PULUMI_ACCESS_TOKEN` | Pulumi Cloud token (for preview job) |
| `DEPLOY_HOST` | Deploy target, e.g. `deployer@your-server.example.com` |

### CI Hardening

For production use, apply these additional safeguards:

1. **Protected secrets**: Secrets are automatically protected in GitHub. For additional security, use environment-specific secrets.

2. **Protected environments**: Configure `staging` as a protected environment in GitHub (Settings → Environments). Add reviewers if desired.

3. **Pin known_hosts**: Don't use `StrictHostKeyChecking=no`. The workflow uses `SSH_KNOWN_HOSTS` secret:
   ```bash
   # Get the server's host key
   ssh-keyscan -t ed25519 <host>
   # Copy output to SSH_KNOWN_HOSTS secret
   ```

4. **Branch protection**: Enable branch protection on `master` with required status checks (test, lint, preview).

5. **Audit trail**: GitHub Actions logs + Pulumi Cloud history provide full audit trail of who triggered what and when.

## Working Tree Requirements

The deploy script runs `git checkout --detach <sha>` which assumes the working tree is clean. The `/data/gatrr` checkout should be **deploy-only**:

- Don't make local edits on the server
- Don't leave uncommitted changes
- The script restores the previous HEAD on failure, but cannot recover from a dirty working tree

If the checkout gets dirty, reset it manually:

```bash
# WARNING: This deletes ALL local changes and untracked files
git reset --hard && git clean -fd
```

## Configuration Assumptions

The deploy script assumes:

- **Remote name**: `origin` (standard Git default). If using a different remote name, set `GIT_REMOTE` env var or edit the script.
- **Stack exists**: `pulumi stack select` will fail if the stack doesn't exist. This is intentional—stacks should be created during initial server setup, not during automated deploys. To create a missing stack, run manually:
  ```bash
  sudo -u deployer bash -lc 'cd /data/gatrr/infra/pulumi && pulumi stack select <stack> --create'
  ```

## Logging

Deploy logs are written to `/data/gatrr/.deploy-logs/` (inside the repo) with the format:

```
deploy-<stack>-<timestamp>-<sha-prefix>.log
```

Example: `deploy-staging-20250115-143022-5ee5106a.log`

Logs capture both stdout and stderr. To view recent deploys:

```bash
ls -lt /data/gatrr/.deploy-logs/ | head
tail -f /data/gatrr/.deploy-logs/deploy-staging-*.log
```

Note: The `.deploy-logs` directory is inside the repo to avoid permission issues with the `deployer` user. Add it to `.gitignore` if not already present.

## Rollback Procedure

To roll back to a previous version, deploy an earlier commit SHA:

```bash
# From CI (manual job with custom SHA)
ssh deployer@<host> "deploy staging <previous-commit-sha>"

# Or directly on the server
sudo -u deployer /data/gatrr/scripts/deploy-remote.sh staging <previous-commit-sha>
```

To find previous successful deploys, check the logs or git history:

```bash
# On the server
ls -lt /data/gatrr/.deploy-logs/
git log --oneline -20
```

Note: Pulumi tracks state in Pulumi Cloud. Rolling back deploys a previous code version but Pulumi will compute the diff from current state, not replay history.

## Secrets Rotation

### SSH Deploy Key

1. Generate a new key pair:
   ```bash
   ssh-keygen -t ed25519 -f ci-deploy-new -C "ci-deploy-rotated"
   ```

2. Add the new public key to `/home/deployer/.ssh/authorized_keys` on the server (with forced command).

3. Update the GitHub secret `SSH_PRIVATE_KEY` with the new private key.

4. Test a deploy with the new key.

5. Remove the old public key from `authorized_keys`.

### Pulumi Access Token

1. Create a new token in Pulumi Cloud (Settings → Access Tokens).

2. On the server, re-authenticate:
   ```bash
   sudo -u deployer bash -lc 'pulumi logout && pulumi login'
   ```

3. Revoke the old token in Pulumi Cloud.

### Application Secrets

Application secrets are stored in Pulumi config (encrypted). To rotate:

```bash
sudo -u deployer bash -lc 'cd /data/gatrr/infra/pulumi && pulumi config set --secret secrets:<key> <new-value>'
```

Then trigger a deploy to apply.

## Supply Chain Trust

This deployment setup trusts the following external sources:

| Component | Source | Verification |
|-----------|--------|--------------|
| Docker Engine | download.docker.com | GPG key in `/etc/apt/keyrings/docker.gpg` |
| Node.js | deb.nodesource.com | HTTPS, NodeSource signing key |
| Pulumi CLI | get.pulumi.com | HTTPS, pinned to v3.142.0 in bootstrap script |

For stricter environments, consider:
- Mirroring packages to internal registries
- Verifying checksums before installation
- Using a hardened base image with pre-installed dependencies

## Health Checks

After a deploy, verify the stack is healthy:

```bash
# Check running containers
docker ps

# Check container logs
docker logs <container-name> --tail 50

# Check application endpoints (adjust URLs)
curl -sf http://localhost/health || echo "Health check failed"
```

Consider adding automated smoke tests to the deploy script or as a post-deploy CI step.

## Staging Environment

The staging stack allows testing production code paths locally without HTTPS.

### Setup

```bash
cd infra/pulumi
export PULUMI_CONFIG_PASSPHRASE=""

# Create staging stack and generate config
npm run new staging
# → Creates config.staging.yaml with example values

# Edit config.staging.yaml with your settings
# Then load and deploy:
npm run config:load
pulumi up
```

### What Staging Tests

The staging stack uses `environment: prod` which enables:

- **Keycloak production mode**: Uses `start` (not `start-dev`), strict hostname validation
- **OAuth2-Proxy issuer verification**: Enabled (no skip)
- **Traefik dashboard disabled**: No port 8080, no insecure API
- **No Dozzle**: Removed from deployment config (security-sensitive Docker socket access)

This lets you verify production security settings work correctly before deploying to real production with HTTPS.

### Keycloak Production Mode

When `keycloakDevMode: false` (the default), Keycloak runs in production mode:

- `KC_HOSTNAME_STRICT=true`: Strict hostname validation
- `KC_HOSTNAME_STRICT_HTTPS=false`: Allows HTTP behind reverse proxy
- `KC_HTTP_ENABLED=true`: Required for Traefik internal communication

If you need dev mode locally, set `gatrr:keycloakDevMode: "true"` in your stack config.

## Production Security Checklist

Before exposing to public traffic, verify:

### Infrastructure

- [ ] **Traefik dashboard disabled**: `curl http://server:8080/api/version` should fail
- [ ] **Keycloak in production mode**: `docker logs <keycloak-container>` shows "Production mode"
- [ ] **OAuth2-Proxy issuer verification enabled**: No `INSECURE_OIDC_SKIP_ISSUER_VERIFICATION=true` in logs
- [ ] **Dozzle not deployed**: `docker ps | grep dozzle` returns nothing
- [ ] **HTTPS enabled**: `useHttps: true` with valid ACME email
- [ ] **ACME production server**: `acmeStaging: false` for real certificates

### Portal

- [ ] **Non-root container user**: `docker exec <portal> whoami` returns `portal`
- [ ] **No cookie logging**: `docker logs <portal> | grep -i cookie` shows no token values
- [ ] **Vendored assets**: No CDN requests in browser network tab
- [ ] **Logout is POST**: GET `/auth/logout` returns 405

### Secrets

- [ ] **Secrets rotated**: If `secrets.local.json` was ever used with real credentials, rotate them
- [ ] **No secrets in logs**: Review Pulumi Cloud deployment logs for leaked values
- [ ] **Pulumi Cloud secrets encrypted**: Verify secrets show as encrypted in Pulumi Cloud UI

### Network

- [ ] **TRAEFIK_INTERNAL_URL set**: Required for production portal logout cascade
- [ ] **Firewall rules**: Only ports 80 and 443 exposed publicly
- [ ] **Internal network isolated**: Docker network not exposed to host

## Security Headers (Traefik)

For production HTTPS deployments, add security headers via Traefik middleware.

Add to `infra/pulumi/src/traefik/dynamic-config.ts` (or create a headers middleware):

```yaml
http:
  middlewares:
    security-headers:
      headers:
        stsSeconds: 31536000
        stsIncludeSubdomains: true
        stsPreload: true
        contentTypeNosniff: true
        frameDeny: true
        browserXssFilter: true
        referrerPolicy: "strict-origin-when-cross-origin"
        contentSecurityPolicy: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'"
```

Then apply to routers:

```yaml
http:
  routers:
    portal:
      middlewares:
        - security-headers
```

### Header Descriptions

| Header | Purpose |
|--------|---------|
| `Strict-Transport-Security` | Force HTTPS for 1 year, include subdomains |
| `X-Content-Type-Options: nosniff` | Prevent MIME type sniffing |
| `X-Frame-Options: DENY` | Prevent clickjacking |
| `X-XSS-Protection` | Legacy XSS filter (deprecated but harmless) |
| `Referrer-Policy` | Control referrer header leakage |
| `Content-Security-Policy` | Restrict resource loading sources |

## Secrets Rotation Checklist

### When to Rotate

Rotate secrets if:

- Config file (`config.<stack>.yaml`) was ever committed or shared
- A team member with access leaves
- Credentials were displayed in logs or error messages
- Periodic rotation (recommended: every 90 days for production)

### What to Rotate

| Secret | How to Rotate |
|--------|---------------|
| `keycloakAdminPassword` | `pulumi config set --secret secrets:keycloakAdminPassword <new>` + redeploy |
| `portalClientSecret` | Regenerate random value, update Pulumi config + redeploy |
| `oauth2ProxyClientSecret` | Regenerate random value, update Pulumi config + redeploy |
| `oauth2ProxyCookieSecret` | Regenerate (32 bytes base64), update Pulumi config + redeploy |
| User passwords | Update in Keycloak admin console or Pulumi config + redeploy |

### Generating New Secrets

```bash
# Random password (32 chars)
openssl rand -base64 24

# Cookie secret (32 bytes base64)
openssl rand -base64 32
```
