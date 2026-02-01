/**
 * Centralized constants and validation patterns
 *
 * This module provides a single source of truth for:
 * - Reserved hosts (portal, keycloak)
 * - Slug validation patterns
 * - Other shared constants
 *
 * Phase 3 of plan.md: Centralize naming/validation constants
 */

// ============================================================================
// Reserved Hosts
// ============================================================================

/**
 * Reserved hosts that cannot be used by services
 *
 * These hosts are used by core infrastructure components.
 */
export const RESERVED_HOSTS: readonly string[] = ["portal", "keycloak"] as const;

/**
 * Check if a host is reserved
 */
export function isReservedHost(host: string): boolean {
  return RESERVED_HOSTS.includes(host);
}

// ============================================================================
// Slug Validation
// ============================================================================

/**
 * Slug pattern: lowercase alphanumeric with hyphens
 * Cannot start or end with hyphen
 */
export const SLUG_PATTERN = /^[a-z][a-z0-9-]*[a-z0-9]$|^[a-z]$/;

/**
 * Check if a value is a valid slug
 *
 * Valid slugs:
 * - Start with lowercase letter
 * - Contain only lowercase letters, digits, and hyphens
 * - Cannot start or end with hyphen
 * - At least one character
 *
 * Examples:
 * - "demo" -> valid
 * - "my-service" -> valid
 * - "my-service-2" -> valid
 * - "2fast" -> invalid (starts with number)
 * - "My-Service" -> invalid (uppercase)
 * - "-service" -> invalid (starts with hyphen)
 */
export function isValidSlug(value: string): boolean {
  if (!value || value.length === 0) return false;
  return SLUG_PATTERN.test(value);
}

// ============================================================================
// Project Constants
// ============================================================================

/** Project namespace included in all Docker resource names */
export const PROJECT_NAME = "gatrr";

/** OAuth2-Proxy version (shared across all services) */
export const OAUTH2_PROXY_VERSION = "v7.6.0";
