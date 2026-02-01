/**
 * Shared helper for creating OAuth2-Proxy protected services
 *
 * This module reduces boilerplate for services that use oauth2-proxy authentication.
 * It creates the OAuth2-Proxy sidecar container and returns standard portal/route/authz fields.
 *
 * Phase 3 of plan.md: Reduce service-module boilerplate
 */

import * as docker from "@pulumi/docker";
import * as pulumi from "@pulumi/pulumi";
import { DeploymentConfig, buildUrl } from "../config";
import { OAUTH2_PROXY_VERSION } from "../constants";
import {
  PortalService,
  RouteRequest,
  OAuth2ProxyAuthzPolicy,
  createContainer,
  ContainerIdentity,
  shortName,
} from "../types";
import { buildOAuth2ProxyEnvs } from "../oauth2-proxy/config";

// Re-export for backwards compatibility
export { OAUTH2_PROXY_VERSION } from "../constants";

/** OAuth2-Proxy image URL */
export const OAUTH2_PROXY_IMAGE = `quay.io/oauth2-proxy/oauth2-proxy:${OAUTH2_PROXY_VERSION}`;

/** OAuth2-Proxy listen port */
export const OAUTH2_PROXY_PORT = 4180;

/**
 * Configuration for a protected service
 */
export interface ProtectedServiceConfig {
  /** Service identifier (slug) */
  serviceId: string;
  /** Display name for portal */
  serviceName: string;
  /** Portal group for organization */
  serviceGroup: string;
  /** Portal icon */
  serviceIcon: string;
  /** Portal description */
  serviceDescription: string;
  /** Required realm roles to access this service */
  requiredRealmRoles: string[];
}

/**
 * Context for creating a protected service
 */
export interface ProtectedServiceContext {
  /** Deployment configuration */
  config: DeploymentConfig;
  /** Docker network */
  network: docker.Network;
  /** Keycloak internal issuer URL (for oauth2-proxy OIDC discovery in dev) */
  keycloakInternalIssuerUrl: string;
  /** Keycloak public issuer URL (for oauth2-proxy OIDC discovery in prod) */
  keycloakPublicIssuerUrl: string;
  /** OAuth2-Proxy cookie secret */
  oauth2ProxyCookieSecret: pulumi.Input<string>;
  /** OAuth2-Proxy client secret for this service */
  clientSecret: pulumi.Input<string>;
}

/**
 * Configuration for the app container that will be protected
 */
export interface AppContainerConfig {
  /** App container (already created) */
  container: docker.Container;
  /** App container port to proxy to */
  port: number;
  /** Stable container address (without version) */
  containerAddress: string;
}

/**
 * Result from creating the oauth2-proxy sidecar
 */
export interface OAuth2ProxySidecarResult {
  /** OAuth2-Proxy container */
  container: docker.Container;
  /** Stable container address for routing */
  containerAddress: string;
}

/**
 * Result from creating a protected service
 */
export interface ProtectedServiceResult {
  /** Portal entry for this service */
  portal: PortalService;
  /** Route requests for Traefik */
  routes: RouteRequest[];
  /** Authorization policy */
  oauth2ProxyAuthz: OAuth2ProxyAuthzPolicy;
  /** OAuth2-Proxy container */
  oauth2ProxyContainer: docker.Container;
}

/**
 * Create OAuth2-Proxy sidecar container for a protected service
 *
 * This handles the common boilerplate of:
 * - Building the proxy identity
 * - Creating the proxy container with correct envs
 * - Setting up dependencies
 */
export function createOAuth2ProxySidecar(
  serviceConfig: ProtectedServiceConfig,
  context: ProtectedServiceContext,
  appConfig: AppContainerConfig
): OAuth2ProxySidecarResult {
  const { config, network, keycloakInternalIssuerUrl, keycloakPublicIssuerUrl, oauth2ProxyCookieSecret, clientSecret } = context;
  const { serviceId, requiredRealmRoles } = serviceConfig;

  // Build proxy identity
  const proxyIdentity: ContainerIdentity = {
    deploymentId: config.deploymentId,
    serviceId: `oauth2-proxy-${serviceId}`,
    version: OAUTH2_PROXY_VERSION,
  };

  // Stable address for routing
  const proxyContainerAddress = shortName(config.deploymentId, `oauth2-proxy-${serviceId}`);

  // Build proxy envs
  const proxyEnvs = pulumi
    .all([clientSecret, oauth2ProxyCookieSecret])
    .apply(([secret, cookie]) =>
      buildOAuth2ProxyEnvs({
        config,
        serviceId,
        keycloakInternalIssuerUrl,
        keycloakPublicIssuerUrl,
        clientSecret: secret,
        cookieSecret: cookie,
        upstreamContainerName: appConfig.containerAddress,
        upstreamPort: appConfig.port,
        requiredRealmRoles,
      })
    );

  // Create proxy container
  const proxyContainer = createContainer(
    proxyIdentity,
    {
      network,
      image: OAUTH2_PROXY_IMAGE,
      envs: proxyEnvs,
      restart: "unless-stopped",
    },
    {
      dependsOn: [network, appConfig.container],
    }
  );

  return {
    container: proxyContainer,
    containerAddress: proxyContainerAddress,
  };
}

/**
 * Build the standard portal/routes/authz result for a protected service
 *
 * This handles the common boilerplate of:
 * - Building the portal entry
 * - Building route requests
 * - Building the authorization policy
 */
export function buildProtectedServiceResult(
  serviceConfig: ProtectedServiceConfig,
  config: DeploymentConfig,
  proxySidecar: OAuth2ProxySidecarResult
): ProtectedServiceResult {
  const { serviceId, serviceName, serviceGroup, serviceIcon, serviceDescription, requiredRealmRoles } = serviceConfig;
  const serviceUrl = buildUrl(config, serviceId);

  // Build portal entry
  const portal: PortalService = {
    id: serviceId,
    name: serviceName,
    url: serviceUrl,
    protected: true,
    authType: "oauth2-proxy",
    group: serviceGroup,
    icon: serviceIcon,
    description: serviceDescription,
    requiredRealmRoles,
  };

  // Build route request (Traefik routes to oauth2-proxy, not the app directly)
  const routes: RouteRequest[] = [
    {
      host: serviceId,
      upstream: {
        containerName: proxySidecar.containerAddress,
        port: OAUTH2_PROXY_PORT,
      },
    },
  ];

  // Build authorization policy
  const oauth2ProxyAuthz: OAuth2ProxyAuthzPolicy = {
    requiredRealmRoles,
  };

  return {
    portal,
    routes,
    oauth2ProxyAuthz,
    oauth2ProxyContainer: proxySidecar.container,
  };
}

/**
 * Create a complete protected service with OAuth2-Proxy sidecar
 *
 * This is a convenience function that combines createOAuth2ProxySidecar
 * and buildProtectedServiceResult into a single call.
 */
export function createProtectedService(
  serviceConfig: ProtectedServiceConfig,
  context: ProtectedServiceContext,
  appConfig: AppContainerConfig
): ProtectedServiceResult {
  const proxySidecar = createOAuth2ProxySidecar(serviceConfig, context, appConfig);
  return buildProtectedServiceResult(serviceConfig, context.config, proxySidecar);
}
