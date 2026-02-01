/**
 * Protected services derivation
 *
 * Derives protected service information from deployment config.
 * A service is "protected" when authType === "oauth2-proxy".
 *
 * @see plan.md section 2.9.4 for protected services derivation
 */

import { ResolvedDeploymentConfig, ResolvedServiceConfig } from "./types";

/**
 * Information about a protected service
 */
export interface ProtectedServiceInfo {
  /** Service identifier */
  readonly serviceId: string;
  /** Host (subdomain) */
  readonly host: string;
  /** Required realm roles for access */
  readonly requiredRoles: readonly string[];
}

/**
 * Get detailed info for all protected services
 *
 * Protected services are those with authType === "oauth2-proxy".
 * These services need:
 * - Client secret generation
 * - Keycloak client creation
 * - oauth2-proxy sidecar configuration
 *
 * @param config - Resolved deployment configuration
 * @returns Array of protected service info, sorted by serviceId
 */
export function getProtectedServices(
  config: ResolvedDeploymentConfig
): ProtectedServiceInfo[] {
  return config.services
    .filter((svc) => svc.authType === "oauth2-proxy")
    .map((svc) => ({
      serviceId: svc.serviceId,
      host: svc.host,
      requiredRoles: svc.requiredRoles,
    }))
    .sort((a, b) => a.serviceId.localeCompare(b.serviceId, "en-US"));
}

/**
 * Get just the IDs of protected services
 *
 * Convenience function for secret generation and other ID-only operations.
 *
 * @param config - Resolved deployment configuration
 * @returns Sorted array of protected service IDs
 */
export function getProtectedServiceIdsFromConfig(
  config: ResolvedDeploymentConfig
): string[] {
  return getProtectedServices(config).map((svc) => svc.serviceId);
}

/**
 * Build OAUTH2_PROXY_ALLOWED_GROUPS value from required roles
 *
 * oauth2-proxy uses comma-separated groups for access control.
 *
 * @param requiredRoles - Array of required realm roles
 * @returns Comma-separated string for OAUTH2_PROXY_ALLOWED_GROUPS
 */
export function buildOAuth2ProxyAllowedGroups(
  requiredRoles: readonly string[]
): string {
  return requiredRoles.join(",");
}

/**
 * Check if a service is protected based on its config
 *
 * @param service - Resolved service configuration
 * @returns true if service requires oauth2-proxy protection
 */
export function isProtectedService(service: ResolvedServiceConfig): boolean {
  return service.authType === "oauth2-proxy";
}
