/**
 * Deployment configuration inference rules
 *
 * Pure functions that apply default values to raw configuration.
 * These functions are deterministic and have no side effects.
 *
 * @see plan.md section 2.9.2 for inference rules specification
 */

import { AuthType } from "../types";
import {
  DeploymentConfigFile,
  ServiceConfig,
  UserConfig,
  ResolvedServiceConfig,
  ResolvedDeploymentConfig,
} from "./types";

/**
 * Capitalize a word (first letter uppercase, rest lowercase)
 */
function capitalizeWord(word: string): string {
  if (word.length === 0) return word;
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/**
 * Infer portal display name from service ID
 *
 * Transforms hyphenated slugs into title case:
 * - "demo" -> "Demo"
 * - "my-service" -> "My Service"
 * - "api-v2" -> "Api V2"
 */
export function inferPortalName(serviceId: string): string {
  if (!serviceId) return "";
  return serviceId.split("-").map(capitalizeWord).join(" ");
}

/**
 * Infer host from service ID
 *
 * Returns the service ID unchanged (identity function).
 * The host is the subdomain without the base domain.
 */
export function inferHost(serviceId: string): string {
  return serviceId;
}

/**
 * Infer authentication type from required roles
 *
 * - If requiredRoles is undefined or empty: "none"
 * - If requiredRoles has values: "oauth2-proxy"
 */
export function inferAuthType(requiredRoles?: readonly string[]): AuthType {
  if (!requiredRoles || requiredRoles.length === 0) {
    return "none";
  }
  return "oauth2-proxy";
}

/**
 * Compute the set of available roles
 *
 * If explicit roles are provided, return them as-is.
 * Otherwise, compute the union of all role references from users and services.
 *
 * @param explicitRoles - Explicitly defined roles (if any)
 * @param users - User configurations
 * @param services - Service configurations
 * @returns Sorted, deduplicated array of role names
 */
export function computeRoles(
  explicitRoles: readonly string[] | undefined,
  users: readonly UserConfig[],
  services: Readonly<Record<string, ServiceConfig>>
): string[] {
  // If explicit roles provided, return them sorted
  if (explicitRoles !== undefined) {
    return [...explicitRoles].sort();
  }

  // Collect all role references
  const roleSet = new Set<string>();

  // From users
  for (const user of users) {
    for (const role of user.roles) {
      roleSet.add(role);
    }
  }

  // From services
  for (const config of Object.values(services)) {
    if (config.requiredRoles) {
      for (const role of config.requiredRoles) {
        roleSet.add(role);
      }
    }
  }

  // Return sorted array
  return Array.from(roleSet).sort();
}

/**
 * Resolve a single service configuration
 *
 * Applies inference rules to produce a fully-resolved service config.
 */
export function resolveServiceConfig(
  serviceId: string,
  config: ServiceConfig
): ResolvedServiceConfig {
  const authType = config.authType ?? inferAuthType(config.requiredRoles);
  const requiredRoles = config.requiredRoles ?? [];

  return {
    serviceId,
    portalName: config.portalName ?? inferPortalName(serviceId),
    host: config.host ?? inferHost(serviceId),
    authType,
    requiredRoles: [...requiredRoles],
    ...(config.group !== undefined && { group: config.group }),
    ...(config.icon !== undefined && { icon: config.icon }),
    ...(config.description !== undefined && { description: config.description }),
  };
}

/**
 * Resolve deployment configuration
 *
 * Applies all inference rules to transform raw config into resolved config.
 * The result has all defaults applied and is ready for validation.
 *
 * @param stackName - Pulumi stack name
 * @param raw - Raw configuration from JSON file
 * @returns Fully resolved configuration
 */
export function resolveDeploymentConfig(
  stackName: string,
  raw: DeploymentConfigFile
): ResolvedDeploymentConfig {
  const users = raw.users ?? [];

  // Resolve each service
  const services = Object.entries(raw.services)
    .map(([serviceId, config]) => resolveServiceConfig(serviceId, config))
    .sort((a, b) => a.serviceId.localeCompare(b.serviceId, "en-US"));

  // Compute roles
  const roles = computeRoles(raw.roles, users, raw.services);

  return {
    stackName,
    roles,
    users: [...users],
    services,
  };
}
