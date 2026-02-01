# Architecture: Pulumi-first deployment, descriptor-only portal

This repository uses a deployment-centric workflow:

- **Pulumi TypeScript** is the source of truth for deployments.
- **Docker resources** are managed directly by Pulumi (no docker-compose).
- **Traefik routing is explicit** via file provider config (no Docker labels).
- **Portal discovery is descriptor-only**: the portal renders exclusively from a static JSON deployment descriptor.

This document describes the intended architecture for Phase 2+ and how to extend it without introducing dead code.

---

## Goals

1. **Single source of truth**: services are defined as Pulumi resources.
2. **Explicit routing**: hostnames and upstream targets are declared, not discovered.
3. **Descriptor-only UI contract**: portal renders from a stable JSON contract generated during deployment.
4. **Determinism**:
   - stable resource naming
   - stable ordering in descriptor
   - stable Traefik config output
5. **No dead code**:
   - no unused types that imply behavior that does not exist
   - no scripts that reference missing files
   - no config keys that are loaded but ignored

## Non-goals

- Multi-node orchestration (Kubernetes, Swarm).
- Compose-based discovery.
- Dynamic discovery via Docker labels.
- Portal reading Pulumi state.

---

## High-level data flow

1. Pulumi loads stack config (`deploymentId`, `baseDomain`, `useHttps`, etc.).
2. Pulumi creates shared infra resources:
   - Docker network
   - Keycloak
   - Traefik (with uploaded dynamic YAML)
   - Portal (with injected descriptor JSON)
3. Pulumi creates each service via a **service module**. Each service module:
   - declares the Docker containers it needs (app + optional sidecars)
   - returns a **route request** (host -> upstream container:port)
   - returns a **portal entry** (what the portal should display)
4. Central assemblers generate:
   - a single Traefik dynamic config file from all route requests
   - a single portal descriptor from all portal entries

---

## Directory structure (infra)

```
infra/
  state/                   # Pulumi state files (version controlled)
    README.md
    prod.json              # Production state (committed)
  pulumi/
    Pulumi.yaml            # Project configuration
    Pulumi.local.yaml      # Local stack config
    Pulumi.prod.yaml       # Production stack config
    src/
      index.ts             # composition root (deployment wiring)
      config.ts            # stack config parsing + validation
      types.ts             # shared types (PortalService, RouteRequest, etc.)
      network.ts           # docker network
      keycloak/
        index.ts           # keycloak container
        realm-import.ts    # pure functions for realm JSON generation
      portal/              # portal container + descriptor injection
      traefik/
        index.ts           # traefik container
        dynamic-config.ts  # pure functions for Traefik YAML generation
      oauth2-proxy/
        config.ts          # pure functions for oauth2-proxy env generation
      services/
        index.ts           # service registry (add new services here)
        demo/
          index.ts
        docs/
          index.ts
        ...
      descriptor/          # descriptor packaging (portal UI contract)
      secrets/             # secret generation utilities
      images/              # Docker image building
```

Notes:
- Each folder should have a single responsibility.
- Pure functions are extracted for testability (realm-import.ts, dynamic-config.ts, oauth2-proxy/config.ts).
- Service registry (`services/index.ts`) is the single place to add new services.

---

## Core concepts

### Deployment configuration

Pulumi configuration is read from the stack (e.g. `Pulumi.local.yaml`) and validated on startup.

Key fields:
- `deploymentId`: stable deployment identifier (namespaces resources)
- `environment`: `dev`, `prod`, ...
- `baseDomain`: `localhost` or a real domain
- `useHttps`: `false` for local Phase 2, `true` for prod Phase 3
- `keycloakRealm`
- `acmeEmail`, `acmeStaging` (required for `useHttps=true`)

The config boundary is strict: validate early and fail fast.

### Service module

A **service module** is a small factory responsible for declaring all Pulumi resources required to run a service.

A service module may create:
- one app container
- optional sidecars (e.g. oauth2-proxy)
- optional extra containers (workers, cron, etc.)

It must return:
- a portal entry (UI contract)
- at least one route request (public hostname -> upstream)

If the service is protected with oauth2-proxy, it must also declare its **authorization policy**:
- required realm roles (enforced by its oauth2-proxy sidecar)

Service modules should NOT:
- generate Traefik YAML
- choose Traefik router/service names
- implement cross-service validation

### Service context

Service modules receive a `ServiceContext` that provides explicit dependencies:

- `config` (deployment config)
- shared docker network
- shared secrets / values required for auth sidecars
- helpers (e.g. `buildUrl(config, host)`)

Keep dependencies explicit (no implicit global state).

### Service module result

Conceptually:

- `resources`: containers and related Pulumi resources
- `portal`: what the portal shows
- `routes`: how Traefik should route public traffic

A minimal type set:

```ts
export type PortalService = {
  id: string;
  name: string;
  url: string;
  protected: boolean;
  authType: "portal" | "oauth2-proxy" | "none";
  group?: string;
  icon?: string;
  description?: string;
};

export type RouteRequest = {
  // Host only, without domain. Example: "demo" -> demo.<baseDomain>
  host: string;
  upstream: {
    containerName: string;
    port: number;
  };
};

// Realm-role authorization enforced at oauth2-proxy.
//
// This is intentionally *not* part of the portal descriptor (descriptor is non-secret UI contract).
// It is an infra concern used to configure oauth2-proxy and Keycloak.
export type OAuth2ProxyAuthzPolicy = {
  requiredRealmRoles: string[];
};

export type ServiceModuleResult = {
  id: string;
  portal: PortalService;
  routes: RouteRequest[];

  // Optional: only present for services protected via oauth2-proxy.
  oauth2ProxyAuthz?: OAuth2ProxyAuthzPolicy;

  resources: Record<string, unknown>; // keep it specific per module
};
```

---

## Traefik routing architecture

### Inputs

Traefik dynamic config is generated from:
- core routes (portal + keycloak)
- all service modules' `RouteRequest[]`

### Canonical rule generation (option 1)

Service modules provide only `host` (e.g. `demo`). The Traefik generator computes:

- rule: `Host(\`demo.${baseDomain}\`)`

This avoids inconsistent Traefik rules and reduces surface area for mistakes.

### Canonical naming

Traefik router/service names are derived deterministically from `host`:

- router name: `host-${host}`
- service name: `svc-${host}`

Core routes use reserved names:
- `core-portal`
- `core-keycloak`

### Validation

The Traefik generator must fail fast on:
- duplicate `host` across all routes
- invalid host slugs (must match `^[a-z0-9-]+$`)
- reserved hosts used by services: `portal`, `keycloak`

### Upstreams

Traefik routes to the upstream declared by the service module:

- public service:
  - upstream = app container + app port
- oauth2-proxy protected service:
  - upstream = oauth2-proxy container + 4180

Traefik remains unaware of oauth2-proxy configuration details; it only needs the upstream target.

---

## AuthN/AuthZ architecture (Keycloak + realm roles)

### Authentication (AuthN)

- **Keycloak** is the OIDC provider for the deployment.
- The portal and each oauth2-proxy instance authenticate users via OIDC.

### Authorization (AuthZ)

Authorization is role-based and enforced at the edge:

- We use **Keycloak realm roles** to express access control (e.g. `demo`, `admin`).
- Each protected service has an **oauth2-proxy sidecar** that enforces a service-specific policy.

Policy model:
- A service module declares `requiredRealmRoles: string[]`.
- The oauth2-proxy wrapper translates those roles into an enforceable check.

### Role-to-claim mapping (roles -> groups)

oauth2-proxy authorization is claim-based. To keep the system simple and consistent:

- Keycloak realm roles are mapped into a claim that oauth2-proxy can check (commonly a `groups` claim).
- oauth2-proxy is configured per service with an allowlist matching that claim.

This lets us enforce "role X can access service A but not service B" using separate oauth2-proxy policies per hostname.

### Audience is not authorization

We do not use token audience (`aud`) as an authorization mechanism.

- `aud` is useful for validating who a token is intended for (**AuthN validation**).
- Role/group claims are used to decide *whether* the user is allowed to access a service (**AuthZ**).

Portal requirement:
- The portal validates that `aud` contains `portal` to prevent token reuse across clients.
- This is a token validation gate, not a role-based access policy.

---

## Logout architecture (portal + oauth2-proxy + Keycloak)

### Problem
Logging out from the portal clears the portal session and may log out of Keycloak, but it does **not** automatically clear per-service oauth2-proxy session cookies.
Because each protected service runs its own oauth2-proxy on its own hostname (e.g. `demo.<baseDomain>`), stale oauth2-proxy cookies can keep the browser "logged in" to that service.

### Key constraint
The portal cannot directly delete cookies for other hostnames (e.g. it cannot clear cookies set on `demo.<baseDomain>` by sending `Set-Cookie` from `portal.<baseDomain>`).
Therefore, each oauth2-proxy host must clear its own cookies via **front-channel** requests.

### Why we use top-level navigation (not iframes / fetch)
In practice, embedded cross-site requests (hidden iframes / background fetch/XHR) are not reliable for clearing oauth2-proxy cookies due to modern browser cookie policies.
Top-level navigation makes the service hostname first-party, which is the most reliable context for oauth2-proxy to clear its cookies.

### Descriptor-derived logout cascade (redirect chain)
The portal derives the list of oauth2-proxy services from the deployment descriptor:
- include services where `authType = "oauth2-proxy"`
- ignore services where `authType = "none"`

For each oauth2-proxy protected service, the portal computes a sign-out URL:
- `serviceSignOutUrl = <service.url> + "/oauth2/sign_out"`

Logout then proceeds as a sequential redirect chain:
1. Portal clears its own cookies immediately (`access_token`, oauth state).
2. Portal redirects the browser to the next service’s:
   - `<serviceSignOutUrl>?rd=<urlencoded portal continuation URL>`
3. The service clears its oauth2-proxy cookies and redirects back to the portal.
4. When all oauth2-proxy services are processed, the portal redirects to Keycloak end-session.

### Backend (BFF) reachability check (skip dead services)
A downside of a pure redirect chain is that if a service is down/unreachable, redirecting the browser to that hostname can strand the user on a network error page.

To avoid this, the portal performs a quick backend reachability probe **before** redirecting to each service:
- Probe target: use `<service.url>` (not `/oauth2/sign_out`) to avoid side-effects
- Treat "reachable" as: "we successfully received any HTTP response" (status code does not matter)
- Use short timeouts so logout stays fast
- If the probe fails (DNS/timeout/connection refused): log a warning and skip that service

This keeps logout best-effort and avoids trapping the user on a dead hostname.

Important limitation:
- Skipping an unreachable service means its oauth2-proxy cookie cannot be cleared during this logout.
- Result: the user may still appear logged in to that service until it is reachable again.

---

## Portal descriptor architecture

### Contract

The portal reads a single JSON descriptor (v1) injected at runtime via:

- `PORTAL_DESCRIPTOR_JSON` (small descriptors)
- `PORTAL_DESCRIPTOR_PATH` (preferred; no size limit)

Descriptor includes:
- deployment metadata (`deploymentId`, `environment`, `baseDomain`)
- `portal.publicUrl`
- `keycloak.publicUrl`, `issuerUrl`, `realm`
- ordered list of `services` (display order)

### Source of service entries

The `services[]` array comes from service modules' returned `PortalService` entries.

The descriptor packer is a thin boundary that:
- sorts services by `(group, name)` to ensure stable diffs
- ensures `protected` matches `authType` (e.g. `protected = authType !== "none"`)
- serializes with stable JSON formatting

The portal descriptor is intentionally non-secret.

---

## Naming conventions

### Docker container names

Namespace containers with `deploymentId` to avoid collisions:

- `${deploymentId}-portal`
- `${deploymentId}-keycloak`
- `${deploymentId}-${serviceId}`
- `${deploymentId}-oauth2-proxy-${serviceId}`

### Hostnames

Hostname scheme:

- `portal.${baseDomain}`
- `keycloak.${baseDomain}`
- `${serviceId}.${baseDomain}`

---

## Local vs production behavior

The desired behavior is controlled via `useHttps`:

- Local (Phase 2): `useHttps=false`
  - Traefik entrypoints: `web`
  - URLs use `http://`
  - ACME disabled

- Production (Phase 3): `useHttps=true`
  - Traefik entrypoints: `websecure`
  - URLs use `https://`
  - ACME enabled and persisted

Service modules should not special-case HTTP vs HTTPS beyond using helpers like `buildUrl(config, host)`.

---

## Configuration Loading

Each stack has a single config file: `config.<stack>.yaml`

This file contains:
- **Stack settings**: `deploymentId`, `baseDomain`, `environment`, etc.
- **Services**: Which services to deploy and their settings
- **Secrets**: Keycloak admin credentials and user definitions

### Workflow

```bash
# Create a new stack
npm run new <stack>
# → Creates Pulumi stack
# → Generates config.<stack>.yaml with example values

# Edit the config file, then load it into Pulumi
npm run config:load

# Deploy
pulumi up
```

The `config:load` script:
1. Reads `config.<stack>.yaml`
2. Sets stack config via `pulumi config set gatrr:<key> <value>`
3. Sets secrets via `pulumi config set --secret secrets:<key> <value>`

Config files are gitignored (they contain secrets).

### Per-service oauth2-proxy clients

For improved security, each protected service has its own Keycloak client (e.g. `oauth2-proxy-demo`).

Client secrets are generated and persisted by Pulumi (encrypted in state/config backend), rather than hand-managed.

The config file contains:
- Human-provided operational secrets (e.g. Keycloak admin credentials, user passwords)
- NOT per-service oauth2-proxy client secrets (these are auto-generated)

The Pulumi program reads from the Pulumi config system, not directly from the YAML file.

---

## Rules to prevent dead code

1. **No second source of truth**:
   - Avoid central specs that duplicate what the Pulumi resources already represent.
2. **No unused config keys**:
   - If a key is loaded, it must be used.
   - If a key is not used, remove it from loader + docs.
3. **No placeholder scripts**:
   - If an npm script references a file, the file must exist and be tested.
4. **No stringly-typed cross-module contracts**:
   - Service modules return typed route requests and portal entries.
   - Only the Traefik module renders YAML; only the descriptor module renders JSON.
5. **No wildcard redirect URIs** (especially in production):
   - Keycloak clients must have explicit redirect URIs derived from service public URLs.
6. **No audience-based authorization**:
   - Do not use token `aud` as a substitute for role/group-based access policy.
   - `aud` may be validated, but access control is roles/groups.

---

## Adding a new service (developer workflow)

1. Create a new module:
   - `infra/pulumi/src/services/<serviceId>/index.ts`
2. In the module:
   - create the app container
   - optionally create oauth2-proxy (or other sidecars)
   - return:
     - `portal` entry
     - `routes` with `host: <serviceId>` and the chosen upstream target
3. Register it in `infra/pulumi/src/services/index.ts`:
   ```ts
   {
     id: "my-service",
     factory: createMyService,
     needsOAuth2Proxy: true, // or false for public services
   }
   ```
4. Run:
   - `cd infra/pulumi && npm test && npm run build`
   - `pulumi preview`
   - `pulumi up`

---

## CI/CD and State Management

### State Storage

Pulumi state is managed via file-based backend with git version control:

- State files are stored in `infra/state/<stack>.json`
- Production state (`prod.json`) is committed to git
- Local state (`local.json`) is gitignored

### CI/CD Pipeline (GitLab with Containerized Runner)

The `.gitlab-ci.yml` pipeline provides:

1. **Validate stage**: Run tests and type checking
2. **Preview stage**: Import state, show planned changes
3. **Deploy stage**: Apply changes (manual approval required)
4. **Export stage**: Save updated state back to git

Key features:
- **Resource group**: Prevents concurrent deployments
- **Guardrails**: Warns about destructive operations (deletes/replaces)
- **State versioning**: All state changes are tracked in git history

#### Runner installation model (GitLab.com, minimal)

- The GitLab Runner is installed as a **Docker container** on the bare metal host.
- Runner config is persisted by mounting `/etc/gitlab-runner` to a host directory (e.g. `/srv/gitlab-runner/config`).
- The runner container mounts the host Docker socket (`/var/run/docker.sock`) so CI jobs can build images and Pulumi can create/manage containers.
- Registration uses a **GitLab.com runner authentication token** (stored in the runner config on disk).

This keeps the host setup minimal while keeping CI execution in a controlled container.

#### Containerized Runner Security & Configuration

**Security Isolation:**
- Runner runs in Docker container with controlled host Docker socket access.
- Process and filesystem isolation from host system.
- Resource limits (CPU/memory constraints).
- Locked runner (only assigned projects can use).

**Important note:** mounting `/var/run/docker.sock` effectively grants Docker-admin access to jobs that land on this runner.
Mitigation is operational (not code): keep the runner **locked** + **protected**, and require deploy jobs to use explicit tags.

**Configuration:**
- Polling interval: 60 seconds (configurable via `RUNNER_CHECK_INTERVAL`).
- Authentication: runner auth token stored in the persisted runner config.
- Access control: protected branch deployment only.
- Cleanup: container can be recreated for clean state.

**Deployment Flow:**
```
GitLab → Containerized Runner → Docker Socket → Pulumi → Infrastructure
```

**Benefits:**
- Enhanced security through container isolation.
- Consistent environment across deployments.
- Easy cleanup and recreation.
- Reduced host system exposure.

### Deployment Flow

```
git push → CI validates → preview → manual approval → deploy → export state → commit
```

**Containerized Runner Flow:**
```
GitLab → Containerized Runner → Docker Socket → Pulumi → Infrastructure
```

### Stack Configuration

- `Pulumi.local.yaml` - Local development (HTTP, localhost)
- `Pulumi.prod.yaml` - Production (HTTPS, real domain)

Production stack requires:
- `gatrr:baseDomain` - Your domain
- `gatrr:acmeEmail` - Let's Encrypt email
- Secrets configured via `pulumi config set --secret`

