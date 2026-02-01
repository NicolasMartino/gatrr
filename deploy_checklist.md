# Deployment Checklist

## Pre-Deployment: Pulumi ESC Setup (OIDC)

Pulumi ESC provides secure secret access without storing credentials in GitHub.
GitHub Actions authenticates via OIDC - no long-lived tokens.

**Generated template file:**
```bash
cd infra/pulumi
npm run new:pulumiCloud prod    # Generates esc.prod.yaml
```

This creates `infra/pulumi/esc.prod.yaml` containing:
- Stack configuration (domain, HTTPS, etc.)
- Application secrets (Keycloak passwords, users)
- SSH credentials for CI/CD deployment

### 1. Create ESC Environment in Pulumi Cloud

**Steps:**

1. Generate the template (if not already done):
   ```bash
   cd infra/pulumi && npm run new:pulumiCloud prod
   ```

2. In Pulumi Cloud → ESC → Environments → **Create Environment** named `gatrr-prod`

3. Copy the entire contents of `esc.prod.yaml` into the YAML editor

4. **Update these placeholder values** with your real configuration:
   - [ ] `gatrr:baseDomain`: `example.com` → your actual domain
   - [ ] `gatrr:acmeEmail`: `admin@example.com` → your email for Let's Encrypt
   - [ ] `secrets:keycloakAdminPassword`: `CHANGE_ME` → strong password
   - [ ] `secrets:unifiedUsers`: Update usernames, passwords, and emails
   - [ ] `ssh.privateKey`: Paste your deploy key private key
   - [ ] `ssh.knownHosts`: Run `ssh-keyscan -t ed25519 your-server.com`
   - [ ] `ssh.deployHost`: `deployer@your-server.com`

5. Click **Save**

> **Note:** The template stays in git with placeholder values. Your real secrets live only in Pulumi Cloud.

### 2. Stack Configuration (Already Done)

The stack config file `infra/pulumi/Pulumi.prod.yaml` is already configured to import from ESC:

```yaml
environment:
  - gatrr-prod
```

All configuration and secrets are pulled from the ESC environment.

### 3. Register GitHub as OIDC Issuer (Organization Settings)

In Pulumi Cloud → **Organization Settings** → **OIDC Issuers**:

- [ ] Click **Register Issuer**
- [ ] **Name:** `GitHubActions`
- [ ] **URL:** `https://token.actions.githubusercontent.com`
- [ ] Click **Register**

### 4. Add Authorization Policy

Under the issuer you just created, add a policy:

- [ ] Click **Add Policy** (or edit Rules)
- [ ] **Decision:** Allow
- [ ] **Audience (aud):** `urn:pulumi:org:YOUR_ORG` (replace with your org name)
- [ ] **Subject (sub):** `repo:YOUR_ORG/gatrr:ref:refs/heads/master`
- [ ] Click **Save Policy**

The subject pattern restricts access to only master branch. You can use:
- `repo:org/repo:*` - any branch
- `repo:org/repo:ref:refs/heads/master` - only master
- `repo:org/repo:environment:production` - only production environment

### 5. GitHub Repository Settings

Configure these in GitHub repo settings → Secrets and variables → Actions:

- [ ] `PULUMI_ORG` - Your Pulumi organization name (not a secret, can be a variable)

No other secrets needed - everything comes from Pulumi ESC via OIDC.

## Pre-Deployment: Server Setup

### Prerequisites

Before running the bootstrap script, prepare these files locally:

1. **Pulumi Access Token** (`pulumi.key`):
   - Go to Pulumi Cloud → Settings → Access Tokens → Create Token
   - Save the token to a file: `echo "pul-xxxx..." > pulumi.key`

2. **Deploy SSH Key Pair** (for CI to SSH to server):
   ```bash
   ssh-keygen -t ed25519 -f deploy_key -N "" -C "ci-deploy"
   # This creates: deploy_key (private) and deploy_key.pub (public)
   ```

3. **Copy files to server**:
   ```bash
   scp pulumi.key deploy_key.pub root@your-server:/root/
   ```

### Run Bootstrap Script

SSH to server as root and run:

```bash
./server-bootstrap-ubuntu.sh \
  --pulumi-key /root/pulumi.key \
  --repo https://github.com/<org>/gatrr.git \
  --stack prod \
  --deploy-key /root/deploy_key.pub
```

This script will:
- [x] Install Docker, Node.js 20, Pulumi CLI, UFW firewall
- [x] Configure UFW to allow SSH and Cloudflare IPs only for 80/443
- [x] Create `deployer` user with docker access
- [x] Configure SSH forced-command in authorized_keys
- [x] Set up Pulumi authentication for deployer
- [x] Clone repo to `/data/gatrr`
- [x] Install npm dependencies
- [x] Initialize Pulumi stack

### Post-Bootstrap Verification

- [ ] Verify Pulumi auth works:
  ```bash
  sudo -u deployer pulumi whoami
  ```

- [ ] Verify firewall is active:
  ```bash
  ufw status verbose
  # Should show: 22 open, 80/443 from Cloudflare IPs only
  ```

- [ ] Clean up sensitive files:
  ```bash
  rm /root/pulumi.key /root/deploy_key.pub
  ```

## Pre-Deployment: Verify OIDC Setup

- [ ] Test Pulumi ESC access locally (optional, for debugging):
  ```bash
  pulumi env open gatrr-prod
  # Should show your secrets (redacted)
  ```

- [ ] Create a test workflow to verify OIDC works:
  ```yaml
  # .github/workflows/test-oidc.yml (delete after testing)
  name: Test OIDC
  on: workflow_dispatch
  permissions:
    id-token: write
  jobs:
    test:
      runs-on: ubuntu-latest
      steps:
        - uses: pulumi/auth-actions@v1
          with:
            organization: ${{ vars.PULUMI_ORG }}
            requested-token-type: access-token
        - run: pulumi env open gatrr-prod --format=json | jq 'keys'
  ```

- [ ] Run the test workflow and verify it can access the environment

## Pre-Deployment: Verify SSH Access

From your local machine:

- [ ] Test SSH restriction (should fail):
  ```bash
  ssh deployer@your-server "echo test"
  # Expected: command not allowed
  ```

- [ ] Test deploy command (should work):
  ```bash
  ssh deployer@your-server "deploy staging $(git rev-parse HEAD)"
  ```

## GitHub Actions Workflow (OIDC)

Your deploy workflow should use Pulumi ESC via OIDC:

```yaml
# .github/workflows/deploy.yml
name: Deploy

on:
  push:
    branches: [master]
  workflow_dispatch:

# Required for OIDC authentication
permissions:
  id-token: write
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: staging  # Optional: adds approval requirement
    steps:
      - uses: actions/checkout@v4

      # Authenticate to Pulumi via OIDC (no PULUMI_ACCESS_TOKEN needed)
      - uses: pulumi/auth-actions@v1
        with:
          organization: ${{ vars.PULUMI_ORG }}
          requested-token-type: access-token

      # Fetch secrets from Pulumi ESC
      - name: Get deploy secrets
        run: |
          pulumi env open gatrr-prod --format=shell > .env
          source .env
          echo "DEPLOY_HOST=$ssh_deployHost" >> $GITHUB_ENV
          echo "$ssh_privateKey" > /tmp/deploy_key
          chmod 600 /tmp/deploy_key
          mkdir -p ~/.ssh
          echo "$ssh_knownHosts" > ~/.ssh/known_hosts

      - name: Deploy
        run: |
          ssh -i /tmp/deploy_key ${{ env.DEPLOY_HOST }} \
            "deploy staging ${{ github.sha }}"

      - name: Cleanup
        if: always()
        run: rm -f /tmp/deploy_key
```

## First Staging Deploy

- [ ] Push to master branch
- [ ] Go to Actions → Deploy → Run workflow (manual trigger)
- [ ] Monitor GitHub Actions logs
- [ ] Check server logs: `tail -f /data/gatrr/.deploy-logs/*.log`
- [ ] Verify services running: `docker ps`
- [ ] Test portal: `curl -I https://portal.your-domain.com/healthz`

## Before Production Deploy

- [ ] Verify ESC environment `gatrr-prod` has correct values:
  - [ ] `gatrr:baseDomain` is your real domain (not `example.com`)
  - [ ] `gatrr:acmeEmail` is set for Let's Encrypt notifications
  - [ ] `gatrr:useHttps` is `"true"`
  - [ ] All `secrets:*` values are strong, non-default passwords
- [ ] Test HTTPS on staging first
- [ ] Add production deploy job to `.github/workflows/deploy.yml`
- [ ] Configure GitHub environment protection rules for `production`
- [ ] Initialize prod Pulumi stack on server

## Before Public Traffic

### Cloudflare Setup
- [ ] Add domain to Cloudflare
- [ ] Enable proxy (orange cloud) on DNS records
- [ ] Enable Managed WAF rules
- [ ] Enable rate limiting / bot protection
- [ ] Set SSL/TLS mode to "Full (strict)"
- [ ] Enable "Always Use HTTPS"

### Verify Security
- [ ] Origin IP not directly accessible (only via Cloudflare)
- [ ] Security headers present: `curl -I https://portal.your-domain.com`
- [ ] HSTS header present with HTTPS
- [ ] Rate limiting active in Traefik logs

### GitHub Repository
- [ ] Enable branch protection on master (require PR reviews)
- [ ] Verify all secrets are non-default values
- [ ] Remove any `secrets.local.json` if accidentally committed

## Rollback Procedure

If deployment fails or causes issues:

```bash
# SSH to server
ssh deployer@your-server

# Find previous working commit
cd /data/gatrr
git log --oneline -10

# Deploy previous commit
./scripts/deploy-remote.sh staging <previous-sha>
```

Or trigger via GitHub Actions with specific SHA.

## Monitoring (Post-Launch)

- [ ] Set up uptime monitoring (e.g., UptimeRobot, Pingdom)
- [ ] Configure alerting for deployment failures
- [ ] Review Traefik access logs periodically
- [ ] Monitor container health: `docker ps --format "table {{.Names}}\t{{.Status}}"`

## Secret Rotation Schedule

| Secret | Location | Rotation Frequency | How to Rotate |
|--------|----------|-------------------|---------------|
| SSH deploy key | ESC `gatrr-prod` | Annually or on compromise | Generate new key, update `authorized_keys` + ESC |
| Pulumi access token | Server `~/.pulumi/credentials.json` | Annually or on compromise | Create new token in Pulumi Cloud, re-run bootstrap |
| Keycloak admin password | ESC `gatrr-prod` | Quarterly | Update in ESC environment |
| User passwords | ESC `gatrr-prod` | On request or compromise | Update `secrets:unifiedUsers` in ESC |
| OAuth2 client secrets | Pulumi state (auto-generated) | Annually | Delete from state, redeploy to regenerate |

## OIDC Security Benefits

With Pulumi ESC + OIDC:
- ✅ No long-lived secrets in GitHub
- ✅ Access restricted to specific repo/branch/workflow
- ✅ Audit log of all secret access in Pulumi Cloud
- ✅ New developers can't exfiltrate secrets by modifying workflows
- ✅ Secrets fetched just-in-time, not stored in CI
