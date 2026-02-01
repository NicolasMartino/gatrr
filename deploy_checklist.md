# Deployment Checklist

## Pre-Deployment: Pulumi ESC Setup (OIDC)

Pulumi ESC provides secure secret access without storing credentials in GitHub.
GitHub Actions authenticates via OIDC - no long-lived tokens.

### 1. Create Pulumi ESC Environment

In Pulumi Cloud → ESC → Environments → Create:

```yaml
# Environment name: gatrr-deploy
values:
  ssh:
    privateKey:
      fn::secret: |
        -----BEGIN OPENSSH PRIVATE KEY-----
        ... your deploy key ...
        -----END OPENSSH PRIVATE KEY-----
    knownHosts: "your-server.com ssh-ed25519 AAAA..."
    deployHost: "deployer@your-server.com"
```

### 2. Register GitHub as OIDC Issuer (Organization Settings)

In Pulumi Cloud → **Organization Settings** → **OIDC Issuers**:

- [ ] Click **Register Issuer**
- [ ] **Name:** `GitHubActions`
- [ ] **URL:** `https://token.actions.githubusercontent.com`
- [ ] Click **Register**

### 3. Add Authorization Policy

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

### 4. GitHub Repository Settings

Configure these in GitHub repo settings → Secrets and variables → Actions:

- [ ] `PULUMI_ORG` - Your Pulumi organization name (not a secret, can be a variable)

No other secrets needed - everything comes from Pulumi ESC via OIDC.

## Pre-Deployment: Server Setup

Run on fresh Ubuntu server as root:

```bash
# Bootstrap server (installs Docker, Node, Pulumi, UFW firewall)
curl -fsSL https://raw.githubusercontent.com/<org>/gatrr/master/scripts/server-bootstrap-ubuntu.sh | sudo bash
```

- [ ] Create deployer user with docker access:
  ```bash
  useradd -m -s /bin/bash deployer
  usermod -aG docker deployer
  ```

- [ ] Configure SSH forced-command in `/home/deployer/.ssh/authorized_keys`:
  ```
  command="/data/gatrr/scripts/ssh-deploy-entrypoint.sh",no-pty,no-agent-forwarding,no-port-forwarding,no-user-rc,no-X11-forwarding ssh-ed25519 AAAA... ci-deploy
  ```

- [ ] Clone repo to `/data/gatrr`:
  ```bash
  mkdir -p /data && cd /data
  git clone https://github.com/<org>/gatrr.git
  chown -R deployer:deployer /data/gatrr
  ```

- [ ] Initialize Pulumi stack:
  ```bash
  cd /data/gatrr/infra/pulumi
  npm ci
  export PULUMI_CONFIG_PASSPHRASE="<your-passphrase>"
  pulumi stack init staging
  # Configure stack values...
  ```

- [ ] Verify firewall is active:
  ```bash
  ufw status verbose
  # Should show: 22 open, 80/443 from Cloudflare IPs only
  ```

## Pre-Deployment: Verify OIDC Setup

- [ ] Test Pulumi ESC access locally (optional, for debugging):
  ```bash
  pulumi env open gatrr-deploy
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
        - run: pulumi env open gatrr-deploy --format=json | jq 'keys'
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
          pulumi env open gatrr-deploy --format=shell > .env
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

- [ ] Update `Pulumi.prod.yaml` with real domain (replace `example.com`)
- [ ] Set `acmeEmail` for Let's Encrypt notifications
- [ ] Test HTTPS on staging first (`useHttps: true`)
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
| SSH deploy key | Pulumi ESC | Annually or on compromise | Generate new key, update `authorized_keys` + Pulumi ESC |
| Pulumi passphrase | Local/Server | On compromise only | Re-encrypt all stacks |
| Keycloak admin password | Pulumi Config | Quarterly | Update via Pulumi config |
| OAuth2 client secrets | Pulumi Config | Annually | Rotate in Keycloak + Pulumi config |

## OIDC Security Benefits

With Pulumi ESC + OIDC:
- ✅ No long-lived secrets in GitHub
- ✅ Access restricted to specific repo/branch/workflow
- ✅ Audit log of all secret access in Pulumi Cloud
- ✅ New developers can't exfiltrate secrets by modifying workflows
- ✅ Secrets fetched just-in-time, not stored in CI
