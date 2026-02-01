/**
 * Demo service module
 *
 * A protected demo application using oauth2-proxy for authentication.
 * This module creates:
 * - App container (nginx as placeholder)
 * - OAuth2-Proxy sidecar for authentication (via shared helper)
 *
 * Returns portal entry, route requests, and authorization policy.
 */

import * as pulumi from "@pulumi/pulumi";
import * as path from "path";
import { getPortalVersion } from "../../config";
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

// Compute repo root from this file's location
const repoRoot = path.resolve(__dirname, "../../../../..");

/** Demo service configuration */
const SERVICE_ID = "demo";
const SERVICE_NAME = "Demo App";
const SERVICE_GROUP = "apps";
const SERVICE_ICON = "rocket";
const SERVICE_DESCRIPTION = "Demo application with OAuth2 protection";
const APP_IMAGE = "nginx:alpine";
const APP_PORT = 80;

/** Project version from portal's Cargo.toml */
const PROJECT_VERSION = getPortalVersion(repoRoot);

/** Required realm roles to access this service (admin OR dev) */
const REQUIRED_REALM_ROLES = ["admin", "dev"];

export interface DemoServiceInputs {
  context: ServiceContext;
  /** OAuth2-Proxy client secret (per-service client) - required for this protected service */
  clientSecret?: pulumi.Input<string>;
}

/**
 * Create the demo service module
 */
export function createDemoService(inputs: DemoServiceInputs): ServiceModuleResult {
  const { context, clientSecret } = inputs;

  // Validate required client secret for protected service
  if (!clientSecret) {
    throw new Error(`Demo service requires a client secret for oauth2-proxy`);
  }

  const { config, network, keycloakInternalIssuerUrl, keycloakPublicIssuerUrl, oauth2ProxyCookieSecret } = context;

  // Build app container identity
  const appIdentity: ContainerIdentity = {
    deploymentId: config.deploymentId,
    serviceId: SERVICE_ID,
    version: PROJECT_VERSION,
  };

  // Stable address for routing
  const appContainerAddress = shortName(config.deploymentId, SERVICE_ID);

  // Create app container
  const appContainer = createContainer(
    appIdentity,
    {
      network,
      image: APP_IMAGE,
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
