#!/usr/bin/env npx ts-node
/**
 * Generate TypeScript types from JSON Schema
 *
 * Usage: npm run generate:types
 *
 * This script reads the canonical JSON schema and generates TypeScript types.
 * The generated file includes validation helpers and type guards.
 */

import * as fs from "fs";
import * as path from "path";

const SCHEMA_PATH = path.resolve(__dirname, "../../../schema/portal-descriptor.schema.json");
const OUTPUT_PATH = path.resolve(__dirname, "../src/descriptor/descriptor.gen.ts");

interface JsonSchema {
  $defs?: Record<string, JsonSchemaDef>;
  properties?: Record<string, JsonSchemaProp>;
  required?: string[];
  [key: string]: unknown;
}

interface JsonSchemaDef {
  type?: string;
  enum?: string[];
  pattern?: string;
  description?: string;
  properties?: Record<string, JsonSchemaProp>;
  required?: string[];
  items?: JsonSchemaProp;
  $ref?: string;
}

interface JsonSchemaProp {
  type?: string;
  const?: string | boolean;
  enum?: string[];
  description?: string;
  $ref?: string;
  items?: JsonSchemaProp;
  pattern?: string;
}

function loadSchema(): JsonSchema {
  const content = fs.readFileSync(SCHEMA_PATH, "utf-8");
  return JSON.parse(content);
}

function generateHeader(): string {
  return `/**
 * GENERATED FILE - DO NOT EDIT
 *
 * Generated from: schema/portal-descriptor.schema.json
 *
 * To regenerate, run: npm run generate:types
 */

`;
}

function generateAuthType(schema: JsonSchema): string {
  const authTypeDef = schema.$defs?.authType;
  if (!authTypeDef?.enum) {
    throw new Error("authType enum not found in schema");
  }

  const values = authTypeDef.enum.map((v) => `"${v}"`).join(" | ");
  return `/**
 * Authentication type for a service
 */
export type AuthType = ${values};

`;
}

function generatePortalConfig(): string {
  return `/**
 * Portal configuration within the descriptor
 */
export interface PortalConfig {
  /** Browser-visible URL for the portal */
  publicUrl: string;
}

`;
}

function generateKeycloakConfig(): string {
  return `/**
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

`;
}

function generateService(): string {
  return `/**
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

`;
}

function generateDiscriminatedUnions(): string {
  return `// Discriminated union types for stricter type checking when creating services
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

`;
}

function generatePortalDescriptor(): string {
  return `/**
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

`;
}

function generateValidationHelpers(schema: JsonSchema): string {
  // Extract patterns directly from the schema - single source of truth
  const slugPattern = schema.$defs?.slug?.pattern;
  const httpUrlPattern = schema.$defs?.httpUrl?.pattern;

  if (!slugPattern) {
    throw new Error("slug pattern not found in schema.$defs.slug.pattern");
  }
  if (!httpUrlPattern) {
    throw new Error("httpUrl pattern not found in schema.$defs.httpUrl.pattern");
  }

  // Convert JSON Schema regex pattern to JavaScript regex literal string
  // 1. Escape forward slashes (required in regex literals): / → \/
  // 2. Backslashes from JSON are already single (\s), keep them as-is for regex literals
  function escapeForRegexLiteral(pattern: string): string {
    return pattern.replace(/\//g, "\\/");
  }

  const slugPatternEscaped = escapeForRegexLiteral(slugPattern);
  const httpUrlPatternEscaped = escapeForRegexLiteral(httpUrlPattern);

  return `// ============================================================================
// Validation helpers
// ============================================================================

/** Slug pattern: lowercase alphanumeric with hyphens, cannot start/end with hyphen */
const SLUG_PATTERN = /${slugPatternEscaped}/;

/** HTTP URL pattern: absolute URL with http:// or https:// scheme */
const HTTP_URL_PATTERN = /${httpUrlPatternEscaped}/;

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
`;
}

function main(): void {
  console.log("Generating TypeScript types from JSON Schema...");
  console.log(`  Schema: ${SCHEMA_PATH}`);
  console.log(`  Output: ${OUTPUT_PATH}`);

  const schema = loadSchema();

  const output = [
    generateHeader(),
    generateAuthType(schema),
    generatePortalConfig(),
    generateKeycloakConfig(),
    generateService(),
    generateDiscriminatedUnions(),
    generatePortalDescriptor(),
    generateValidationHelpers(schema),
  ].join("");

  fs.writeFileSync(OUTPUT_PATH, output);
  console.log("Done!");
}

main();
