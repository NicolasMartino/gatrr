/**
 * Portal descriptor generation
 *
 * Pure functions that generate the portal descriptor from Service[].
 * The descriptor is the contract between Pulumi and the portal.
 *
 * Key properties:
 * - Deterministic: same input always produces same output
 * - Stable ordering: services sorted by group, then name
 * - No side effects: pure transformation
 * - Schema validation: JSON Schema is the single source of truth
 */

import Ajv2020 from "ajv/dist/2020";
import * as fs from "fs";
import * as path from "path";
import { DeploymentConfig, buildUrl } from "../config";

// Re-export generated types as the public API
export type {
  PortalDescriptor,
  PortalConfig,
  KeycloakConfig,
  Service,
  AuthType,
} from "./descriptor.gen";
export {
  isValidSlug,
  isValidHttpUrl,
  isProtectedAuthType,
  isPublicService,
  isOAuth2ProxyService,
  isPortalAuthService,
} from "./descriptor.gen";

import type { PortalDescriptor, Service } from "./descriptor.gen";

// Legacy alias for backwards compatibility
export type PortalService = Service;

// ============================================================================
// Schema validation (JSON Schema is the single source of truth)
// ============================================================================

/** Path to the canonical JSON Schema */
const SCHEMA_PATH = path.resolve(__dirname, "../../../../schema/portal-descriptor.schema.json");

/** Cached Ajv validator instance */
let cachedValidator: ReturnType<InstanceType<typeof Ajv2020>["compile"]> | null = null;

/**
 * Get or create the schema validator
 *
 * Uses Ajv with JSON Schema draft 2020-12 support.
 * The validator is cached for performance.
 */
function getSchemaValidator(): ReturnType<InstanceType<typeof Ajv2020>["compile"]> {
  if (cachedValidator) {
    return cachedValidator;
  }

  const schemaContent = fs.readFileSync(SCHEMA_PATH, "utf-8");
  const schema = JSON.parse(schemaContent);

  const ajv = new Ajv2020({
    strict: false, // Schema uses "not" patterns that strict mode flags
    allErrors: true, // Collect all errors, not just the first
  });

  cachedValidator = ajv.compile(schema);
  return cachedValidator;
}

/**
 * Validate a descriptor against the JSON Schema
 *
 * This is the single enforcement point for all descriptor rules.
 * The JSON Schema defines all invariants (protected/authType consistency,
 * requiredRealmRoles rules, slug patterns, etc.).
 *
 * @throws Error if validation fails, with detailed error messages
 */
export function validateDescriptorSchema(descriptor: PortalDescriptor): void {
  const validate = getSchemaValidator();
  const valid = validate(descriptor);

  if (!valid && validate.errors) {
    const errorMessages = validate.errors
      .map((err) => {
        const path = err.instancePath || "(root)";
        return `  - ${path}: ${err.message}`;
      })
      .join("\n");
    throw new Error(`Descriptor schema validation failed:\n${errorMessages}`);
  }
}

// ============================================================================
// Sorting utilities
// ============================================================================

/** Collator options for deterministic sorting across environments */
const SORT_COLLATOR_OPTIONS: Intl.CollatorOptions = {
  sensitivity: "base",
  numeric: true,
};

/** Locale for deterministic sorting (POSIX/C locale equivalent) */
const SORT_LOCALE = "en-US";

/**
 * Compare two strings with deterministic locale settings
 *
 * Uses en-US locale with base sensitivity for consistent ordering
 * across different environments and Node.js versions.
 */
function compareStrings(a: string, b: string): number {
  return a.localeCompare(b, SORT_LOCALE, SORT_COLLATOR_OPTIONS);
}

/**
 * Sort services by group (alphabetically), then by name (alphabetically)
 * Services without a group come last.
 *
 * Uses explicit locale (en-US) for deterministic sorting across environments.
 */
export function sortPortalServices(services: PortalService[]): PortalService[] {
  return [...services].sort((a, b) => {
    // Group comparison (undefined groups sort last)
    const groupA = a.group ?? "\uffff"; // Use high unicode to sort last
    const groupB = b.group ?? "\uffff";

    if (groupA !== groupB) {
      return compareStrings(groupA, groupB);
    }

    // Name comparison within same group
    return compareStrings(a.name, b.name);
  });
}

/**
 * Generate portal descriptor from config and portal services
 *
 * This is a pure function - same inputs always produce same output.
 * Services are sorted by group (alphabetically), then by name (alphabetically).
 *
 * Validates the generated descriptor against the JSON Schema before returning.
 * This is the single enforcement point - all rules are defined in the schema.
 */
export function generateDescriptor(
  config: DeploymentConfig,
  services: PortalService[]
): PortalDescriptor {
  const portalUrl = buildUrl(config, "portal");
  const keycloakUrl = buildUrl(config, "keycloak");

  // Sort services for stable ordering
  const sortedServices = sortPortalServices(services);

  const descriptor: PortalDescriptor = {
    version: "1",
    deploymentId: config.deploymentId,
    environment: config.environment,
    baseDomain: config.baseDomain,
    portal: {
      publicUrl: portalUrl,
    },
    keycloak: {
      publicUrl: keycloakUrl,
      issuerUrl: `${keycloakUrl}/realms/${config.keycloakRealm}`,
      realm: config.keycloakRealm,
    },
    services: sortedServices,
  };

  // Validate against JSON Schema (single source of truth)
  validateDescriptorSchema(descriptor);

  return descriptor;
}

/**
 * Serialize descriptor to JSON with stable formatting
 * Uses 2-space indentation for readability (file injection, debugging)
 */
export function serializeDescriptor(descriptor: PortalDescriptor): string {
  return JSON.stringify(descriptor, null, 2);
}

/**
 * Serialize descriptor to minified JSON
 * Use this for env var injection to avoid newline/quoting issues
 */
export function serializeDescriptorMinified(descriptor: PortalDescriptor): string {
  return JSON.stringify(descriptor);
}
