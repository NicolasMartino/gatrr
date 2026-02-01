/**
 * Service module types
 *
 * These types define the contract for service modules.
 * Each service module returns a ServiceModuleResult containing:
 * - portal: what the portal displays
 * - routes: how Traefik should route traffic
 * - oauth2ProxyAuthz: optional authorization policy for protected services
 *
 * This replaces the central ServiceSpec pattern with a module-first approach.
 */

import * as docker from "@pulumi/docker";
import * as pulumi from "@pulumi/pulumi";
import { DeploymentConfig } from "./config";

// Re-export generated types from schema
export type {
  AuthType,
  Service,
  PublicService,
  OAuth2ProxyService,
  PortalAuthService,
} from "./descriptor/descriptor.gen";
export {
  isValidSlug as isValidSlugFromSchema,
  isProtectedAuthType,
  isPublicService,
  isOAuth2ProxyService,
  isPortalAuthService,
} from "./descriptor/descriptor.gen";

// Legacy type alias for backwards compatibility
// TODO: Migrate callers to use Service directly
import type { Service } from "./descriptor/descriptor.gen";
export type PortalService = Service;

/**
 * Route request - how Traefik should route traffic
 *
 * Service modules provide only the host (e.g., "demo").
 * The Traefik generator computes the full rule: Host(`demo.${baseDomain}`)
 */
export interface RouteRequest {
  /** Host only, without domain. Example: "demo" -> demo.<baseDomain> */
  host: string;
  /** Upstream target for Traefik */
  upstream: {
    /** Container name (namespaced with deploymentId) */
    containerName: string;
    /** Port the container listens on */
    port: number;
  };
}

/**
 * OAuth2-Proxy authorization policy
 *
 * Realm-role authorization enforced at oauth2-proxy.
 * This is intentionally NOT part of the portal descriptor (descriptor is non-secret UI contract).
 * It is an infra concern used to configure oauth2-proxy and Keycloak.
 */
export interface OAuth2ProxyAuthzPolicy {
  /** Required Keycloak realm roles to access this service */
  requiredRealmRoles: string[];
}

/**
 * Service module result - what a service module returns
 *
 * Each service module is a factory that creates Pulumi resources
 * and returns this result for composition.
 */
export interface ServiceModuleResult {
  /** Service identifier (must match the service folder name) */
  id: string;
  /** Portal entry for this service */
  portal: PortalService;
  /** Route requests for Traefik */
  routes: RouteRequest[];
  /** Optional authorization policy (only for oauth2-proxy protected services) */
  oauth2ProxyAuthz?: OAuth2ProxyAuthzPolicy;
  /** Pulumi resources created by this module */
  resources: {
    /** Main application container */
    container: docker.Container;
    /** OAuth2-Proxy sidecar container (if protected) */
    oauth2ProxyContainer?: docker.Container;
  };
}

/**
 * Service context - dependencies passed to service modules
 *
 * Service modules receive this context to access shared infrastructure.
 * Keep dependencies explicit (no implicit global state).
 */
export interface ServiceContext {
  /** Deployment configuration */
  config: DeploymentConfig;
  /** Shared Docker network */
  network: docker.Network;
  /** Keycloak internal issuer URL (for oauth2-proxy OIDC discovery in dev) */
  keycloakInternalIssuerUrl: string;
  /** Keycloak public issuer URL (for oauth2-proxy OIDC discovery in prod) */
  keycloakPublicIssuerUrl: string;
  /** OAuth2-Proxy cookie secret (shared across all proxies) */
  oauth2ProxyCookieSecret: pulumi.Input<string>;
}

/**
 * Keycloak client request - what a service needs from Keycloak
 *
 * Used by the Keycloak module to create per-service clients (Model B).
 */
export interface KeycloakClientRequest {
  /** Client ID (e.g., "oauth2-proxy-demo") */
  clientId: string;
  /** Service ID this client is for */
  serviceId: string;
  /** Redirect URIs for this client */
  redirectUris: string[];
  /** Web origins for CORS */
  webOrigins: string[];
}

/**
 * Derive protected status from authType
 * This ensures consistency between protected and authType fields
 */
export function isProtected(authType: string): boolean {
  return authType !== "none";
}

// Re-export isValidSlug from constants for backwards compatibility
export { isValidSlug } from "./constants";

/** Project namespace included in all Docker resource names */
const PROJECT_NAME = "gatrr";

// =============================================================================
// Container Identity and Factory
// =============================================================================

/**
 * Container identity - required fields for container naming
 *
 * ALL containers must be created with a ContainerIdentity.
 * This enforces consistent naming across the entire deployment.
 */
export interface ContainerIdentity {
  /** Deployment identifier (e.g., "local", "staging", "prod") */
  readonly deploymentId: string;
  /** Service identifier (e.g., "portal", "keycloak", "loki") */
  readonly serviceId: string;
  /** Service version (e.g., "2025.1.0", "24.0", "2.9.4") */
  readonly version: string;
}

/**
 * Get container name with version
 * Pattern: {deploymentId}-{projectName}-{serviceId}-{version}
 * Example: local-gatrr-portal-2025.1.0
 *
 * This is the Docker container name visible in `docker ps`.
 */
export function nameWithVersion(identity: ContainerIdentity): string {
  return `${identity.deploymentId}-${PROJECT_NAME}-${identity.serviceId}-${identity.version}`;
}

/**
 * Get short name (stable, no version)
 * Pattern: {deploymentId}-{projectName}-{serviceId}
 * Example: local-gatrr-portal
 *
 * Used for:
 * - Network alias for Traefik routing
 * - Referencing containers without needing version
 *
 * Stable across version bumps.
 */
export function shortName(deploymentId: string, serviceId: string): string {
  return `${deploymentId}-${PROJECT_NAME}-${serviceId}`;
}

/**
 * Arguments for createContainer (extends docker.ContainerArgs minus name)
 */
export interface CreateContainerArgs extends Omit<docker.ContainerArgs, "name" | "networksAdvanced"> {
  /** Docker network to attach to (required) */
  network: docker.Network;
  /** Additional network aliases (optional, container name is always added) */
  additionalAliases?: string[];
}

/**
 * Create a Docker container with enforced naming convention
 *
 * This is the ONLY way to create containers in this codebase.
 * It enforces:
 * - Consistent naming pattern with version (container name)
 * - Stable network alias for routing (without version)
 * - Automatic network attachment
 *
 * @param identity - Container identity (deploymentId, serviceId, version)
 * @param args - Container configuration
 * @param opts - Pulumi resource options
 * @returns Docker container resource
 */
export function createContainer(
  identity: ContainerIdentity,
  args: CreateContainerArgs,
  opts?: pulumi.ResourceOptions
): docker.Container {
  const fullName = nameWithVersion(identity);
  const stableAlias = shortName(identity.deploymentId, identity.serviceId);
  const { network, additionalAliases, ...containerArgs } = args;

  // Build network aliases:
  // - stableAlias (shortName, without version) for Traefik routing
  // - fullName (nameWithVersion) for explicit addressing
  // - any additional aliases
  const aliases = [stableAlias, fullName, ...(additionalAliases ?? [])];

  return new docker.Container(
    fullName,
    {
      ...containerArgs,
      name: fullName,
      networksAdvanced: [
        {
          name: network.name,
          aliases,
        },
      ],
    },
    opts
  );
}

// =============================================================================
// Volume and Network Naming (no version - data persistence)
// =============================================================================

/**
 * Generate volume name with project namespace
 * Pattern: {deploymentId}-{projectName}-{name}
 * Example: local-gatrr-loki-data
 *
 * Note: Volumes do NOT include version to preserve data across upgrades
 */
export function volumeName(deploymentId: string, name: string): string {
  return `${deploymentId}-${PROJECT_NAME}-${name}`;
}

/**
 * Generate network name with project namespace
 * Pattern: {deploymentId}-{projectName}-network
 * Example: local-gatrr-network
 *
 * Note: Network does NOT include version for stability
 */
export function networkName(deploymentId: string): string {
  return `${deploymentId}-${PROJECT_NAME}-network`;
}
