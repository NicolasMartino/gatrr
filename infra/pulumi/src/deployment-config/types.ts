/**
 * Deployment configuration types (v1)
 *
 * These types define the schema for per-stack deployment JSON files.
 * The deployment config is the single source of truth for:
 * - Which services are deployed in each stack
 * - How each service is accessed (host) and protected (authType + required roles)
 * - Portal display metadata (name/group/icon/description)
 * - Local-only Keycloak bootstrap users
 *
 * @see plan.md section 2.9 for full specification
 */

import { AuthType } from "../types";
// Use centralized slug validation from constants
import { isValidSlug } from "../constants";
// Re-export from centralized constants for backwards compatibility
export { RESERVED_HOSTS, isReservedHost } from "../constants";

// =============================================================================
// Raw Configuration Types (as read from JSON file)
// =============================================================================

/**
 * User configuration for Keycloak bootstrap (local stack only)
 *
 * These users are created in the Keycloak realm import for local development.
 * NOT for production use - production users should be managed through Keycloak admin.
 *
 * Note: Passwords are NOT stored here - they come from Pulumi secrets config.
 * This keeps deployment config non-secret and version-controllable.
 */
export interface UserConfig {
  /** Username for login */
  readonly username: string;
  /** Email address */
  readonly email: string;
  /** Optional first name */
  readonly firstName?: string;
  /** Optional last name */
  readonly lastName?: string;
  /** Realm roles assigned to this user (must be non-empty) */
  readonly roles: readonly string[];
}

/**
 * Service configuration entry (as specified in deployment JSON)
 *
 * All fields are optional - inference rules apply defaults.
 */
export interface ServiceConfig {
  /** Display name in portal (default: Capitalize(serviceId)) */
  readonly portalName?: string;
  /** Subdomain hostname without baseDomain (default: serviceId) */
  readonly host?: string;
  /** Required Keycloak realm roles for access */
  readonly requiredRoles?: readonly string[];
  /** Authentication type (inferred from requiredRoles if omitted) */
  readonly authType?: AuthType;
  /** Portal UI grouping */
  readonly group?: string;
  /** Portal UI icon (emoji or icon name) */
  readonly icon?: string;
  /** Portal UI description */
  readonly description?: string;
}

/**
 * Deployment configuration file schema (v1)
 *
 * This is the raw structure as read from deployment.<stack>.json
 */
export interface DeploymentConfigFile {
  /**
   * Optional explicit role allow-list
   *
   * If omitted: inferred as union of all users[].roles and services[].requiredRoles
   * If present: treated as an explicit allow-list (validation enforces subset rules)
   */
  readonly roles?: readonly string[];
  /**
   * Bootstrap users (local stack only)
   *
   * Validation rejects this field on non-local stacks.
   */
  readonly users?: readonly UserConfig[];
  /**
   * Services to deploy, keyed by service ID
   *
   * Keys are the set of services to deploy.
   * Values configure how each service is accessed and protected.
   */
  readonly services: Readonly<Record<string, ServiceConfig>>;
}

// =============================================================================
// Resolved Configuration Types (after inference and validation)
// =============================================================================

/**
 * Resolved service configuration (after inference)
 *
 * All optional fields from ServiceConfig are resolved to concrete values.
 */
export interface ResolvedServiceConfig {
  /** Service identifier (from the key in services object) */
  readonly serviceId: string;
  /** Display name in portal (always present after inference) */
  readonly portalName: string;
  /** Subdomain hostname without baseDomain (always present after inference) */
  readonly host: string;
  /** Authentication type (always present after inference) */
  readonly authType: AuthType;
  /**
   * Required realm roles for access
   *
   * Empty array for authType: "none"
   * Non-empty array for authType: "oauth2-proxy" or "portal"
   */
  readonly requiredRoles: readonly string[];
  /** Portal UI grouping */
  readonly group?: string;
  /** Portal UI icon */
  readonly icon?: string;
  /** Portal UI description */
  readonly description?: string;
}

/**
 * Resolved deployment configuration (after inference and validation)
 *
 * This is the fully-resolved configuration ready for use by Pulumi.
 */
export interface ResolvedDeploymentConfig {
  /** Stack name (e.g., "local", "prod") */
  readonly stackName: string;
  /** All available realm roles (computed if not explicit) */
  readonly roles: readonly string[];
  /** Bootstrap users (empty array for non-local stacks) */
  readonly users: readonly UserConfig[];
  /** Resolved service configurations */
  readonly services: readonly ResolvedServiceConfig[];
}

// =============================================================================
// Validation Types
// =============================================================================

/**
 * Validation error with context
 */
export interface ValidationError {
  /** Error code for programmatic handling */
  readonly code: string;
  /** Human-readable error message */
  readonly message: string;
  /** Path to the invalid field (e.g., "services.demo.host") */
  readonly path?: string;
}

/**
 * Validation result
 */
export type ValidationResult =
  | { readonly valid: true; readonly config: ResolvedDeploymentConfig }
  | { readonly valid: false; readonly errors: readonly ValidationError[] };

// =============================================================================
// Type Guards and Validators
// =============================================================================

// Note: All slug validation uses the canonical isValidSlug from constants.ts
// which validates: lowercase letter start, alphanumeric/hyphen middle, alphanumeric end
// Pattern: ^[a-z][a-z0-9-]*[a-z0-9]$|^[a-z]$

/**
 * Validate service ID format
 *
 * Service IDs must be valid slugs: lowercase alphanumeric with hyphens,
 * cannot start or end with hyphen.
 */
export function isValidServiceId(id: string): boolean {
  return isValidSlug(id);
}

/**
 * Validate host format
 *
 * Hosts must be valid slugs and not reserved.
 * This only validates format - reservation check is separate.
 */
export function isValidHost(host: string): boolean {
  return isValidSlug(host);
}

/**
 * Validate role format
 *
 * Roles must be valid slugs: lowercase alphanumeric with hyphens,
 * cannot start or end with hyphen.
 */
export function isValidRole(role: string): boolean {
  return isValidSlug(role);
}

/**
 * Validate username format
 *
 * Usernames must be valid slugs.
 */
export function isValidUsername(username: string): boolean {
  return isValidSlug(username);
}

/**
 * Validate email format (basic check)
 */
export function isValidEmail(email: string): boolean {
  if (!email || email.length === 0) return false;
  // Basic email pattern - not exhaustive but catches obvious errors
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Check if authType is valid
 */
export function isValidAuthType(authType: string): authType is AuthType {
  return authType === "oauth2-proxy" || authType === "portal" || authType === "none";
}
