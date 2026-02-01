# How-To Guide

Quick reference for common operations.

## Configuration Overview

All configuration is in a single file per stack: `config.<stack>.yaml`

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
    icon: rocket
    description: Demo application

secrets:
  keycloakAdminUsername: admin
  keycloakAdminPassword: admin-dev-password
  users:
    - username: admin
      password: admin
      roles: admin
      email: admin@localhost.local
```

After any changes, run:

```bash
cd infra/pulumi
npm run config:load
pulumi up
```

## Adding Users

Users are defined in `config.<stack>.yaml` under `secrets.users`:

```yaml
secrets:
  users:
    - username: alice
      password: password123
      roles: admin, dev
      email: alice@example.local
      firstName: Alice
      lastName: Smith
```

**Fields:**
- `username`: Required. Login name.
- `password`: Required. Initial password.
- `roles`: Required. Comma-separated or array of roles (e.g., `admin, dev` or `[admin, dev]`).
- `email`: Optional. User's email address.
- `firstName`, `lastName`: Optional. Display name.

**Roles**: Must be lowercase slugs (e.g., `admin`, `dev`, `viewer`).

**Production note**: Don't use config file for production users. Manage them directly in Keycloak admin console.

## Adding a Public Service

Public services have no authentication. Anyone can access them.

### 1. Create the service module

Create `infra/pulumi/src/services/myservice/index.ts`:

```typescript
import * as docker from "@pulumi/docker";
import { buildUrl } from "../../config";
import { ServiceContext, ServiceModuleResult, PortalService, RouteRequest } from "../../types";

const SERVICE_ID = "myservice";

export function createMyService(inputs: { context: ServiceContext }): ServiceModuleResult {
  const { context } = inputs;
  const { config, network } = context;

  const containerName = `${config.deploymentId}-${SERVICE_ID}`;

  const container = new docker.Container(
    `${config.deploymentId}-svc-${SERVICE_ID}`,
    {
      name: containerName,
      image: "nginx:alpine",  // Replace with your image
      networksAdvanced: [{ name: network.name, aliases: [containerName] }],
      restart: "unless-stopped",
    },
    { dependsOn: [network] }
  );

  const portal: PortalService = {
    id: SERVICE_ID,
    name: "My Service",
    url: buildUrl(config, SERVICE_ID),
    protected: false,
    authType: "none",
    group: "tools",
    icon: "tool",
    description: "My public service",
  };

  const routes: RouteRequest[] = [
    { host: SERVICE_ID, upstream: { containerName, port: 80 } },
  ];

  return { id: SERVICE_ID, portal, routes, resources: { container } };
}
```

### 2. Register in catalog

Edit `infra/pulumi/src/services/catalog.ts`:

```typescript
import { createMyService } from "./myservice";

export const SERVICE_CATALOG: ServiceCatalog = {
  // ... existing services
  myservice: {
    factory: createMyService,
    description: "My public service",
  },
};
```

### 3. Activate in config file

Edit `config.<stack>.yaml`:

```yaml
services:
  myservice:
    portalName: My Service
    group: tools
    icon: tool
    description: My public service
```

**Note**: No `requiredRoles` = public service.

### 4. Deploy

```bash
cd infra/pulumi
npm run config:load
pulumi up
```

## Adding an OAuth2-Protected Service

Protected services require authentication via oauth2-proxy. Only users with the required roles can access.

### 1. Create the service module

Create `infra/pulumi/src/services/myapp/index.ts`:

```typescript
import * as docker from "@pulumi/docker";
import * as pulumi from "@pulumi/pulumi";
import { buildUrl } from "../../config";
import { ServiceContext, ServiceModuleResult, PortalService, RouteRequest, OAuth2ProxyAuthzPolicy } from "../../types";
import { buildOAuth2ProxyEnvs } from "../../oauth2-proxy/config";

const SERVICE_ID = "myapp";
const REQUIRED_ROLES = ["admin", "dev"];  // Users need one of these roles

export function createMyAppService(inputs: {
  context: ServiceContext;
  clientSecret?: pulumi.Input<string>;
}): ServiceModuleResult {
  const { context, clientSecret } = inputs;

  if (!clientSecret) {
    throw new Error(`${SERVICE_ID} requires a client secret for oauth2-proxy`);
  }

  const { config, network, keycloakInternalIssuerUrl, oauth2ProxyCookieSecret } = context;

  const appContainerName = `${config.deploymentId}-${SERVICE_ID}`;
  const proxyContainerName = `${config.deploymentId}-oauth2-proxy-${SERVICE_ID}`;

  // App container
  const appContainer = new docker.Container(
    `${config.deploymentId}-svc-${SERVICE_ID}`,
    {
      name: appContainerName,
      image: "myapp:latest",  // Replace with your image
      networksAdvanced: [{ name: network.name, aliases: [appContainerName] }],
      restart: "unless-stopped",
    },
    { dependsOn: [network] }
  );

  // OAuth2-Proxy sidecar
  const proxyEnvs = pulumi
    .all([clientSecret, oauth2ProxyCookieSecret])
    .apply(([secret, cookie]) =>
      buildOAuth2ProxyEnvs({
        config,
        serviceId: SERVICE_ID,
        keycloakInternalIssuerUrl,
        clientSecret: secret,
        cookieSecret: cookie,
        upstreamContainerName: appContainerName,
        upstreamPort: 80,
        requiredRealmRoles: REQUIRED_ROLES,
      })
    );

  const proxyContainer = new docker.Container(
    proxyContainerName,
    {
      name: proxyContainerName,
      image: "quay.io/oauth2-proxy/oauth2-proxy:v7.6.0",
      envs: proxyEnvs,
      networksAdvanced: [{ name: network.name, aliases: [proxyContainerName] }],
      restart: "unless-stopped",
    },
    { dependsOn: [network, appContainer] }
  );

  const portal: PortalService = {
    id: SERVICE_ID,
    name: "My App",
    url: buildUrl(config, SERVICE_ID),
    protected: true,
    authType: "oauth2-proxy",
    group: "apps",
    icon: "lock",
    description: "My protected application",
    requiredRealmRoles: REQUIRED_ROLES,
  };

  // Route to oauth2-proxy, NOT the app directly
  const routes: RouteRequest[] = [
    { host: SERVICE_ID, upstream: { containerName: proxyContainerName, port: 4180 } },
  ];

  const oauth2ProxyAuthz: OAuth2ProxyAuthzPolicy = {
    requiredRealmRoles: REQUIRED_ROLES,
  };

  return {
    id: SERVICE_ID,
    portal,
    routes,
    oauth2ProxyAuthz,
    resources: { container: appContainer, oauth2ProxyContainer: proxyContainer },
  };
}
```

### 2. Register in catalog

Edit `infra/pulumi/src/services/catalog.ts`:

```typescript
import { createMyAppService } from "./myapp";

export const SERVICE_CATALOG: ServiceCatalog = {
  // ... existing services
  myapp: {
    factory: createMyAppService,
    description: "My protected application",
  },
};
```

### 3. Activate in config file

Edit `config.<stack>.yaml`:

```yaml
services:
  myapp:
    portalName: My App
    requiredRoles: [admin, dev]
    group: apps
    icon: lock
    description: My protected application
```

**Key**: `requiredRoles` makes it protected. Users need at least one of these roles.

### 4. Deploy

```bash
cd infra/pulumi
npm run config:load
pulumi up
```

## Activating/Deactivating Services

Services in the catalog are available but not deployed until added to `config.<stack>.yaml`.

### Activate a service

Add its key to `services` in `config.<stack>.yaml`:

```yaml
services:
  demo:
    portalName: Demo App
    # ...
  newservice:
    portalName: New Service
```

Then deploy:

```bash
npm run config:load
pulumi up
```

### Deactivate a service

Remove its key from `services`:

```yaml
services:
  demo:
    portalName: Demo App
  # newservice removed - will be destroyed on next deploy
```

Then deploy:

```bash
npm run config:load
pulumi up
```

Pulumi will destroy the removed service's containers and routes.

## Quick Reference

| Task | Config Location | Key Field |
|------|-----------------|-----------|
| Add user | `config.<stack>.yaml` | `secrets.users[]` |
| Add public service | `config.<stack>.yaml` | `services.<id>` (no `requiredRoles`) |
| Add protected service | `config.<stack>.yaml` | `services.<id>.requiredRoles` |
| Activate service | `config.<stack>.yaml` | Add key to `services` |
| Deactivate service | `config.<stack>.yaml` | Remove key from `services` |

After any change: `npm run config:load && pulumi up`

## Validation Rules

- **Service IDs**: Lowercase slugs (`my-service`, not `MyService`)
- **Roles**: Lowercase slugs (`admin`, `dev`, not `Admin`)
- **Reserved hosts**: `portal` and `keycloak` cannot be used as service hosts
- **Users**: Only allowed in `local` stack (rejected for `staging`/`prod`)
