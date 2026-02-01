/**
 * Deployment configuration module
 *
 * Provides types and utilities for per-stack deployment configuration.
 *
 * @see plan.md section 2.9 for full specification
 */

// Types
export type {
  UserConfig,
  ServiceConfig,
  DeploymentConfigFile,
  ResolvedServiceConfig,
  ResolvedDeploymentConfig,
  ValidationError,
  ValidationResult,
} from "./types";

// Constants
export { RESERVED_HOSTS } from "./types";

// Validators
export {
  isValidServiceId,
  isValidHost,
  isReservedHost,
  isValidRole,
  isValidUsername,
  isValidEmail,
  isValidAuthType,
} from "./types";

// Loader
export {
  getDeploymentConfigPath,
  loadDeploymentConfigFile,
  DeploymentConfigNotFoundError,
  DeploymentConfigParseError,
} from "./loader";

// Inference
export {
  inferPortalName,
  inferHost,
  inferAuthType,
  computeRoles,
  resolveServiceConfig,
  resolveDeploymentConfig,
} from "./inference";

// Validation
export {
  validateServiceExists,
  validateServiceIdFormat,
  validateHostFormat,
  validateNotReservedHost,
  validateAuthTypeRolesConsistency,
  validateRolesInAllowList,
  validateUsersLocalOnly,
  validateUserConfig,
  validateRoleFormat,
  validateDeploymentConfig,
  assertValidDeploymentConfig,
  validateUserPasswords,
  assertUserPasswordsProvided,
} from "./validation";

// Protected services
export type { ProtectedServiceInfo } from "./protected-services";
export {
  getProtectedServices,
  getProtectedServiceIdsFromConfig,
  buildOAuth2ProxyAllowedGroups,
  isProtectedService,
} from "./protected-services";
