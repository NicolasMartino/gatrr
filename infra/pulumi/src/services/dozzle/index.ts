/**
 * Dozzle service module
 *
 * A protected log viewer using oauth2-proxy for authentication.
 * Admin-only access - only users with the 'admin' role can view logs.
 *
 * This module creates:
 * - Dozzle container (log viewer)
 * - OAuth2-Proxy sidecar for authentication (via shared helper)
 *
 * Returns portal entry, route requests, and authorization policy.
 */

import * as pulumi from "@pulumi/pulumi";
import {
  ServiceContext,
  ServiceModuleResult,
  createContainer,
  ContainerIdentity,
  shortName,
} from "../../types";
import {
  createProtectedService,
  ProtectedServiceConfig,
  ProtectedServiceContext,
} from "../protected-service-helper";

/** Dozzle service configuration */
const SERVICE_ID = "dozzle";
const SERVICE_NAME = "Dozzle";
const SERVICE_GROUP = "admin";
const SERVICE_ICON = "file-text";
const SERVICE_DESCRIPTION = "Container log viewer (admin only)";
// Pin to specific version to prevent drift (plan.md: no :latest tags)
const APP_VERSION = "v8.14.12";
const APP_IMAGE = `amir20/dozzle:${APP_VERSION}`;
const APP_PORT = 8080;

/** Required realm roles to access this service (admin only) */
const REQUIRED_REALM_ROLES = ["admin"];

export interface DozzleServiceInputs {
  context: ServiceContext;
  /** OAuth2-Proxy client secret (per-service client) - required for this protected service */
  clientSecret?: pulumi.Input<string>;
}

/**
 * Create the dozzle service module
 *
 * SECURITY: Dozzle mounts the Docker socket, which provides host-level access.
 * It is blocked in production environments to prevent security exposure.
 */
export function createDozzleService(inputs: DozzleServiceInputs): ServiceModuleResult {
  const { context, clientSecret } = inputs;

  // Security guardrail: Block Dozzle in production
  // Dozzle mounts /var/run/docker.sock which grants host-level container access
  if (context.config.environment === "prod") {
    throw new Error(
      `Dozzle cannot be enabled in production (environment=prod). ` +
      `It mounts the Docker socket which poses a security risk. ` +
      `Use a centralized logging solution (e.g., 'logs' service with Loki) instead.`
    );
  }

  // Validate required client secret for protected service
  if (!clientSecret) {
    throw new Error(`Dozzle service requires a client secret for oauth2-proxy`);
  }

  const { config, network, keycloakInternalIssuerUrl, keycloakPublicIssuerUrl, oauth2ProxyCookieSecret } = context;

  // Build app container identity
  const appIdentity: ContainerIdentity = {
    deploymentId: config.deploymentId,
    serviceId: SERVICE_ID,
    version: APP_VERSION,
  };

  // Stable address for routing
  const appContainerAddress = shortName(config.deploymentId, SERVICE_ID);

  // Create app container
  // Dozzle needs access to Docker socket to read container logs
  const appContainer = createContainer(
    appIdentity,
    {
      network,
      image: APP_IMAGE,
      envs: [
        "DOZZLE_NO_ANALYTICS=true",
      ],
      volumes: [
        {
          hostPath: "/var/run/docker.sock",
          containerPath: "/var/run/docker.sock",
          readOnly: true,
        },
      ],
      restart: "unless-stopped",
    },
    {
      dependsOn: [network],
    }
  );

  // Service configuration for protected service helper
  const serviceConfig: ProtectedServiceConfig = {
    serviceId: SERVICE_ID,
    serviceName: SERVICE_NAME,
    serviceGroup: SERVICE_GROUP,
    serviceIcon: SERVICE_ICON,
    serviceDescription: SERVICE_DESCRIPTION,
    requiredRealmRoles: REQUIRED_REALM_ROLES,
  };

  // Context for protected service helper
  const protectedContext: ProtectedServiceContext = {
    config,
    network,
    keycloakInternalIssuerUrl,
    keycloakPublicIssuerUrl,
    oauth2ProxyCookieSecret,
    clientSecret,
  };

  // Create OAuth2-Proxy sidecar and get standard portal/routes/authz
  const protectedResult = createProtectedService(
    serviceConfig,
    protectedContext,
    {
      container: appContainer,
      port: APP_PORT,
      containerAddress: appContainerAddress,
    }
  );

  return {
    id: SERVICE_ID,
    portal: protectedResult.portal,
    routes: protectedResult.routes,
    oauth2ProxyAuthz: protectedResult.oauth2ProxyAuthz,
    resources: {
      container: appContainer,
      oauth2ProxyContainer: protectedResult.oauth2ProxyContainer,
    },
  };
}
