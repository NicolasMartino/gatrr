/**
 * Deployment configuration validation
 *
 * Validates resolved configuration against business rules.
 * All validation runs AFTER inference, on the resolved config.
 *
 * @see plan.md section 2.9.3 for validation rules specification
 */

import { AuthType } from "../types";
import {
  ResolvedDeploymentConfig,
  UserConfig,
  ValidationError,
  ValidationResult,
  isValidServiceId,
  isValidHost,
  isReservedHost,
  isValidRole,
  isValidUsername,
  isValidEmail,
} from "./types";

// =============================================================================
// Individual Validation Functions
// =============================================================================

/**
 * Rule 1: Validate service exists in catalog
 */
export function validateServiceExists(
  serviceId: string,
  catalog: readonly string[]
): ValidationError | null {
  if (catalog.includes(serviceId)) {
    return null;
  }
  const available = catalog.length > 0 ? catalog.join(", ") : "(none)";
  return {
    code: "UNKNOWN_SERVICE",
    message: `Unknown service "${serviceId}". Available services: ${available}`,
    path: `services.${serviceId}`,
  };
}

/**
 * Rule 2: Validate slug format for serviceId
 */
export function validateServiceIdFormat(serviceId: string): ValidationError | null {
  if (isValidServiceId(serviceId)) {
    return null;
  }
  return {
    code: "INVALID_SERVICE_ID",
    message: `Invalid serviceId "${serviceId}": must start with lowercase letter and contain only lowercase letters, numbers, and hyphens`,
    path: `services.${serviceId}`,
  };
}

/**
 * Rule 2: Validate slug format for host
 */
export function validateHostFormat(
  host: string,
  serviceId: string
): ValidationError | null {
  if (isValidHost(host)) {
    return null;
  }
  return {
    code: "INVALID_HOST",
    message: `Invalid host "${host}" for service "${serviceId}": must start with lowercase letter and contain only lowercase letters, numbers, and hyphens`,
    path: `services.${serviceId}.host`,
  };
}

/**
 * Rule 3: Validate host is not reserved
 */
export function validateNotReservedHost(
  host: string,
  serviceId: string
): ValidationError | null {
  if (!isReservedHost(host)) {
    return null;
  }
  return {
    code: "RESERVED_HOST",
    message: `Reserved host "${host}" cannot be used by service "${serviceId}". Reserved hosts: portal, keycloak`,
    path: `services.${serviceId}.host`,
  };
}

/**
 * Rules 4-6: Validate authType and requiredRoles consistency
 */
export function validateAuthTypeRolesConsistency(
  authType: AuthType,
  requiredRoles: readonly string[],
  serviceId: string
): ValidationError | null {
  const hasRoles = requiredRoles.length > 0;

  // Rule 4: authType:none + requiredRoles = conflict
  if (authType === "none" && hasRoles) {
    return {
      code: "AUTH_NONE_WITH_ROLES",
      message: `Service "${serviceId}" has authType "none" but requiredRoles [${requiredRoles.join(", ")}]. Remove requiredRoles or change authType.`,
      path: `services.${serviceId}`,
    };
  }

  // Rule 5: authType:oauth2-proxy - requiredRoles = missing
  if (authType === "oauth2-proxy" && !hasRoles) {
    return {
      code: "OAUTH2_PROXY_WITHOUT_ROLES",
      message: `Service "${serviceId}" has authType "oauth2-proxy" but no requiredRoles. Add requiredRoles or change authType to "none".`,
      path: `services.${serviceId}`,
    };
  }

  // Rule 6: authType:portal - requiredRoles = missing
  if (authType === "portal" && !hasRoles) {
    return {
      code: "PORTAL_WITHOUT_ROLES",
      message: `Service "${serviceId}" has authType "portal" but no requiredRoles. Add requiredRoles or change authType to "none".`,
      path: `services.${serviceId}`,
    };
  }

  return null;
}

/**
 * Rule 7: Validate roles are in allow-list
 */
export function validateRolesInAllowList(
  referencedRoles: readonly string[],
  allowList: readonly string[],
  context: string,
  path: string
): ValidationError[] {
  const errors: ValidationError[] = [];

  for (const role of referencedRoles) {
    if (!allowList.includes(role)) {
      errors.push({
        code: "ROLE_NOT_IN_ALLOWLIST",
        message: `Role "${role}" used by ${context} is not in roles allow-list [${allowList.join(", ")}]. Add "${role}" to roles array or remove from ${context}.`,
        path,
      });
    }
  }

  return errors;
}

/**
 * Rule 8: Validate users only on local stack
 */
export function validateUsersLocalOnly(
  users: readonly UserConfig[],
  stackName: string
): ValidationError | null {
  if (users.length === 0) {
    return null;
  }
  if (stackName === "local") {
    return null;
  }
  return {
    code: "USERS_NOT_LOCAL",
    message: `users[] is only allowed on "local" stack, not "${stackName}". Remove users from deployment.${stackName}.json.`,
    path: "users",
  };
}

/**
 * Validate user configuration
 */
export function validateUserConfig(
  user: UserConfig,
  index: number
): ValidationError[] {
  const errors: ValidationError[] = [];
  const path = `users[${String(index)}]`;

  if (!isValidUsername(user.username)) {
    errors.push({
      code: "INVALID_USERNAME",
      message: `Invalid username "${user.username}": must start with lowercase letter and contain only lowercase letters, numbers, and hyphens`,
      path: `${path}.username`,
    });
  }

  if (!isValidEmail(user.email)) {
    errors.push({
      code: "INVALID_EMAIL",
      message: `Invalid email "${user.email}" for user "${user.username}"`,
      path: `${path}.email`,
    });
  }

  if (user.roles.length === 0) {
    errors.push({
      code: "USER_NO_ROLES",
      message: `User "${user.username}" has no roles. Each user must have at least one role.`,
      path: `${path}.roles`,
    });
  }

  for (const role of user.roles) {
    if (!isValidRole(role)) {
      errors.push({
        code: "INVALID_ROLE_FORMAT",
        message: `Invalid role "${role}" for user "${user.username}": must start with lowercase letter and contain only lowercase letters, numbers, and hyphens`,
        path: `${path}.roles`,
      });
    }
  }

  return errors;
}

/**
 * Validate role format
 */
export function validateRoleFormat(
  role: string,
  index: number
): ValidationError | null {
  if (isValidRole(role)) {
    return null;
  }
  return {
    code: "INVALID_ROLE_FORMAT",
    message: `Invalid role "${role}" at roles[${String(index)}]: must start with lowercase letter and contain only lowercase letters, numbers, and hyphens`,
    path: `roles[${String(index)}]`,
  };
}

// =============================================================================
// Main Validation Function
// =============================================================================

/**
 * Validate deployment configuration
 *
 * Runs all validation rules and collects all errors.
 * This should be called AFTER inference, on the resolved config.
 *
 * @param config - Resolved deployment configuration
 * @param serviceCatalog - List of available service IDs
 * @returns Validation result with all errors
 */
export function validateDeploymentConfig(
  config: ResolvedDeploymentConfig,
  serviceCatalog: readonly string[]
): ValidationResult {
  const errors: ValidationError[] = [];

  // Validate explicit roles format
  for (let i = 0; i < config.roles.length; i++) {
    const error = validateRoleFormat(config.roles[i], i);
    if (error) errors.push(error);
  }

  // Rule 8: Users only on local stack
  const usersError = validateUsersLocalOnly(config.users, config.stackName);
  if (usersError) errors.push(usersError);

  // Validate each user
  for (let i = 0; i < config.users.length; i++) {
    const userErrors = validateUserConfig(config.users[i], i);
    errors.push(...userErrors);

    // Rule 7: User roles in allow-list (only if explicit roles provided)
    if (config.roles.length > 0) {
      const user = config.users[i];
      const roleErrors = validateRolesInAllowList(
        user.roles,
        config.roles,
        `user "${user.username}"`,
        `users[${String(i)}].roles`
      );
      errors.push(...roleErrors);
    }
  }

  // Validate each service
  for (const service of config.services) {
    // Rule 2: Service ID format
    const idError = validateServiceIdFormat(service.serviceId);
    if (idError) errors.push(idError);

    // Rule 1: Service exists in catalog
    const existsError = validateServiceExists(service.serviceId, serviceCatalog);
    if (existsError) errors.push(existsError);

    // Rule 2: Host format
    const hostFormatError = validateHostFormat(service.host, service.serviceId);
    if (hostFormatError) errors.push(hostFormatError);

    // Rule 3: Reserved host
    const reservedError = validateNotReservedHost(service.host, service.serviceId);
    if (reservedError) errors.push(reservedError);

    // Rules 4-6: AuthType/roles consistency
    const authError = validateAuthTypeRolesConsistency(
      service.authType,
      service.requiredRoles,
      service.serviceId
    );
    if (authError) errors.push(authError);

    // Rule 7: Service roles in allow-list (only if explicit roles provided)
    if (config.roles.length > 0 && service.requiredRoles.length > 0) {
      const roleErrors = validateRolesInAllowList(
        service.requiredRoles,
        config.roles,
        `service "${service.serviceId}"`,
        `services.${service.serviceId}.requiredRoles`
      );
      errors.push(...roleErrors);
    }
  }

  // Check for duplicate hosts
  const hostCounts = new Map<string, string[]>();
  for (const service of config.services) {
    const existing = hostCounts.get(service.host) ?? [];
    existing.push(service.serviceId);
    hostCounts.set(service.host, existing);
  }
  for (const [host, serviceIds] of hostCounts) {
    if (serviceIds.length > 1) {
      errors.push({
        code: "DUPLICATE_HOST",
        message: `Duplicate host "${host}" used by services: ${serviceIds.join(", ")}. Each service must have a unique host.`,
        path: `services`,
      });
    }
  }

  if (errors.length === 0) {
    return { valid: true, config };
  }
  return { valid: false, errors };
}

/**
 * Validate and throw if invalid
 *
 * Convenience function for Pulumi programs that want to fail fast.
 */
export function assertValidDeploymentConfig(
  config: ResolvedDeploymentConfig,
  serviceCatalog: readonly string[]
): void {
  const result = validateDeploymentConfig(config, serviceCatalog);
  if (!result.valid) {
    const errorMessages = result.errors
      .map((e) => `  - ${e.message}${e.path ? ` (at ${e.path})` : ""}`)
      .join("\n");
    throw new Error(
      `Deployment configuration validation failed:\n${errorMessages}`
    );
  }
}

// =============================================================================
// User Password Validation (separate from config validation)
// =============================================================================

/**
 * Get the Pulumi secret key for a user password.
 * Format: realm<CapitalizedUsername>Password (e.g., realmAdminPassword)
 */
function getUserPasswordSecretKey(username: string): string {
  const capitalized = username.charAt(0).toUpperCase() + username.slice(1);
  return `realm${capitalized}Password`;
}

/**
 * Validate that all users have passwords in the secrets config
 *
 * This is called separately from config validation because passwords
 * come from Pulumi secrets, not the deployment config file.
 *
 * @param users - Users from deployment config
 * @param userPasswords - Passwords from Pulumi secrets (keyed by username)
 * @returns Array of validation errors for missing passwords
 */
export function validateUserPasswords(
  users: readonly UserConfig[],
  userPasswords: Record<string, string | undefined>
): ValidationError[] {
  const errors: ValidationError[] = [];

  for (const user of users) {
    const password = userPasswords[user.username];
    if (!password || password.trim() === "") {
      const secretKey = getUserPasswordSecretKey(user.username);
      errors.push({
        code: "MISSING_USER_PASSWORD",
        message: `Missing password for user "${user.username}" in Pulumi secrets config. ` +
          `Add secret: pulumi config set --secret secrets:${secretKey} <password>`,
        path: `secrets:${secretKey}`,
      });
    }
  }

  return errors;
}

/**
 * Validate user passwords and throw if any are missing
 *
 * Convenience function for Pulumi programs that want to fail fast.
 */
export function assertUserPasswordsProvided(
  users: readonly UserConfig[],
  userPasswords: Record<string, string | undefined>
): void {
  const errors = validateUserPasswords(users, userPasswords);
  if (errors.length > 0) {
    const errorMessages = errors
      .map((e) => `  - ${e.message}`)
      .join("\n");
    throw new Error(
      `Missing user passwords in Pulumi secrets:\n${errorMessages}`
    );
  }
}
