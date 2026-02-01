/**
 * GENERATED FILE - DO NOT EDIT
 *
 * Generated from: schema/portal-descriptor.schema.json
 *
 * To regenerate, run: npm run generate:types
 */

/**
 * Authentication type for a service
 */
export type AuthType = "none" | "oauth2-proxy" | "portal";

/**
 * Portal configuration within the descriptor
 */
export interface PortalConfig {
  /** Browser-visible URL for the portal */
  publicUrl: string;
}

/**
 * Keycloak configuration within the descriptor
 */
export interface KeycloakConfig {
  /** Browser-visible URL for Keycloak */
  publicUrl: string;
  /** OIDC issuer URL (e.g., https://keycloak.example.com/realms/dev) */
  issuerUrl: string;
  /** Realm name */
  realm: string;
}

/**
 * A service entry in the descriptor
 *
 * Schema rules (validated at runtime):
 * - authType="none": protected=false, requiredRealmRoles must be undefined
 * - authType="oauth2-proxy": protected=true, requiredRealmRoles required and non-empty
 * - authType="portal": protected=true, requiredRealmRoles required and non-empty
 */
export interface Service {
  /** Stable identifier / slug (e.g., 'demo', 'api', 'docs') */
  id: string;
  /** Display name (e.g., 'Demo App', 'API Documentation') */
  name: string;
  /** Fully-qualified, browser-visible URL */
  url: string;
  /** Whether the service requires authentication */
  protected: boolean;
  /** How authentication is handled */
  authType: AuthType;
  /** Optional grouping for UI organization */
  group?: string;
  /** Optional icon (emoji or icon name) */
  icon?: string;
  /** Optional description */
  description?: string;
  /**
   * Required realm roles to access this service (for UI filtering)
   *
   * Schema rules:
   * - Required for authType: "oauth2-proxy" and "portal" services
   * - Forbidden for authType: "none" services
   */
  requiredRealmRoles?: string[];
}

// Discriminated union types for stricter type checking when creating services
// These are optional exports for callers that want compile-time guarantees

/**
 * Public service (authType: "none")
 * Use this type when creating a public service for compile-time guarantees
 */
export interface PublicService {
  id: string;
  name: string;
  url: string;
  protected: false;
  authType: "none";
  group?: string;
  icon?: string;
  description?: string;
  // requiredRealmRoles is intentionally omitted
}

/**
 * OAuth2-Proxy protected service
 * Use this type when creating an oauth2-proxy service for compile-time guarantees
 */
export interface OAuth2ProxyService {
  id: string;
  name: string;
  url: string;
  protected: true;
  authType: "oauth2-proxy";
  group?: string;
  icon?: string;
  description?: string;
  requiredRealmRoles: string[];
}

/**
 * Portal-auth protected service
 * Use this type when creating a portal-auth service for compile-time guarantees
 */
export interface PortalAuthService {
  id: string;
  name: string;
  url: string;
  protected: true;
  authType: "portal";
  group?: string;
  icon?: string;
  description?: string;
  requiredRealmRoles: string[];
}

/**
 * Portal Descriptor v1 - Complete deployment descriptor
 */
export interface PortalDescriptor {
  /** Schema version (currently only '1' is supported) */
  version: "1";
  /** Deployment identifier (e.g., 'prod', 'staging', 'local') */
  deploymentId: string;
  /** Environment type (e.g., 'prod', 'dev') */
  environment: string;
  /** Base domain (e.g., 'localhost', 'example.com') */
  baseDomain: string;
  /** Portal configuration */
  portal: PortalConfig;
  /** Keycloak configuration */
  keycloak: KeycloakConfig;
  /** Services to display (order is display order) */
  services: Service[];
}

// ============================================================================
// Validation helpers
// ============================================================================

/** Slug pattern: lowercase alphanumeric with hyphens, cannot start/end with hyphen */
const SLUG_PATTERN = /^[a-z][a-z0-9-]*[a-z0-9]$|^[a-z]$/;

/** HTTP URL pattern: absolute URL with http:// or https:// scheme */
const HTTP_URL_PATTERN = /^https?:\/\/[^\s]+$/;

/**
 * Validate a slug (lowercase alphanumeric with hyphens)
 */
export function isValidSlug(value: string): boolean {
  return SLUG_PATTERN.test(value);
}

/**
 * Validate an HTTP URL (absolute, http or https scheme)
 */
export function isValidHttpUrl(value: string): boolean {
  return HTTP_URL_PATTERN.test(value);
}

/**
 * Type guard: check if auth type is protected
 */
export function isProtectedAuthType(authType: AuthType): authType is "oauth2-proxy" | "portal" {
  return authType === "oauth2-proxy" || authType === "portal";
}

/**
 * Type guard: check if service is a public service
 */
export function isPublicService(service: Service): service is PublicService {
  return service.authType === "none";
}

/**
 * Type guard: check if service is an OAuth2-Proxy service
 */
export function isOAuth2ProxyService(service: Service): service is OAuth2ProxyService {
  return service.authType === "oauth2-proxy";
}

/**
 * Type guard: check if service is a portal-auth service
 */
export function isPortalAuthService(service: Service): service is PortalAuthService {
  return service.authType === "portal";
}
