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

import Ajv2020, { AnySchema } from "ajv/dist/2020";
import * as fs from "fs";
import * as path from "path";
import { DeploymentConfig, buildUrl } from "../config";

// Re-export generated types as the public API
export type {
  PortalDescriptor,
  PortalConfig,
  KeycloakConfig,
  DeploymentInfo,
  Service,
  AuthType,
} from "./descriptor.gen";

/**
 * Options for generating the portal descriptor
 */
export interface GenerateDescriptorOptions {
  /** Deployment metadata (commit, timestamps) - optional */
  deployment?: {
    /** Git commit SHA that was deployed (40-character hex) */
    commitSha?: string;
    /** When the commit was made (git committer date, ISO 8601 UTC) */
    commitAt?: string;
    /** When the deployment happened (ISO 8601 UTC) */
    deployedAt?: string;
  };
}
export {
  isValidSlug,
  isValidHttpUrl,
  isProtectedAuthType,
  isPublicService,
  isOAuth2ProxyService,
  isPortalAuthService,
} from "./descriptor.gen";

import type { PortalDescriptor, Service, DeploymentInfo } from "./descriptor.gen";

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
  const schema = JSON.parse(schemaContent) as AnySchema;

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
        return `  - ${path}: ${err.message ?? "unknown error"}`;
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
  services: PortalService[],
  options?: GenerateDescriptorOptions
): PortalDescriptor {
  const portalUrl = buildUrl(config, "portal");
  const keycloakUrl = buildUrl(config, "keycloak");

  // Sort services for stable ordering
  const sortedServices = sortPortalServices(services);

  // Build deployment info if any fields are provided
  let deployment: DeploymentInfo | undefined;
  if (options?.deployment) {
    const { commitSha, commitAt, deployedAt } = options.deployment;
    // Only include deployment if at least one field is set
    if (commitSha || commitAt || deployedAt) {
      deployment = {
        ...(commitSha && { commitSha }),
        ...(commitAt && { commitAt }),
        ...(deployedAt && { deployedAt }),
      };
    }
  }

  const descriptor: PortalDescriptor = {
    version: "1",
    deploymentId: config.deploymentId,
    environment: config.environment,
    baseDomain: config.baseDomain,
    ...(deployment && { deployment }),
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
 * Get deployment info from environment variables
 *
 * Reads from:
 * - GATRR_COMMIT_SHA: Git commit SHA (40-character hex)
 * - GATRR_COMMIT_AT: When the commit was made (ISO 8601 UTC)
 * - GATRR_DEPLOYED_AT: When the deployment happened (ISO 8601 UTC)
 *
 * Returns undefined if no deployment info is set.
 */
export function getDeploymentInfoFromEnv(): GenerateDescriptorOptions["deployment"] | undefined {
  const commitSha = process.env.GATRR_COMMIT_SHA;
  const commitAt = process.env.GATRR_COMMIT_AT;
  const deployedAt = process.env.GATRR_DEPLOYED_AT;

  // Return undefined if no deployment info is set
  if (!commitSha && !commitAt && !deployedAt) {
    return undefined;
  }

  return {
    ...(commitSha && { commitSha }),
    ...(commitAt && { commitAt }),
    ...(deployedAt && { deployedAt }),
  };
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
