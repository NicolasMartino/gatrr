/**
 * Secrets generation and management
 *
 * Generates deployment secrets once and persists them in Pulumi state.
 * Subsequent deploys reuse the same secrets; rotation is an explicit operation.
 *
 * Per the plan (Model B):
 * - Client secrets are generated ONCE by Pulumi on first creation
 * - Persisted (encrypted) in Pulumi state/config backend
 * - Subsequent deploys must reuse the same client secrets
 * - Rotation is an explicit operation (not a side-effect of redeploy)
 */

import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";

/**
 * Generate a random secret string
 *
 * Uses Pulumi's random provider which persists the value in state.
 * The secret is generated once and reused on subsequent deploys.
 */
export function generateSecret(
  name: string,
  options: {
    /** Length of the secret (default: 32) */
    length?: number;
    /** Include special characters (default: false for URL-safe secrets) */
    special?: boolean;
  } = {}
): pulumi.Output<string> {
  const { length = 32, special = false } = options;

  const secret = new random.RandomPassword(name, {
    length,
    special,
    // Use URL-safe characters for secrets that may appear in URLs/configs
    overrideSpecial: special ? "!@#$%^&*" : undefined,
  });

  return secret.result;
}

/**
 * Generate a cookie secret for oauth2-proxy (exactly 32 characters)
 *
 * oauth2-proxy requires the cookie secret to be exactly 16, 24, or 32 bytes.
 * We generate a 32-character alphanumeric string.
 */
export function generateCookieSecret(name: string): pulumi.Output<string> {
  // Generate exactly 32 alphanumeric characters
  const secret = new random.RandomPassword(name, {
    length: 32,
    special: false,
  });

  return secret.result;
}

/**
 * Generated secrets for the deployment
 */
export interface GeneratedSecrets {
  /** Portal OIDC client secret */
  portalClientSecret: pulumi.Output<string>;
  /** Shared cookie secret for oauth2-proxy instances */
  oauth2ProxyCookieSecret: pulumi.Output<string>;
  /** Per-service oauth2-proxy client secrets (keyed by serviceId) */
  serviceClientSecrets: Record<string, pulumi.Output<string>>;
}

/**
 * Generate all deployment secrets
 *
 * These secrets are generated once and persisted in Pulumi state.
 * Subsequent deploys will reuse the same values.
 *
 * @param deploymentId - Deployment identifier for namespacing
 * @param protectedServiceIds - List of service IDs that need oauth2-proxy clients
 */
export function generateDeploymentSecrets(
  deploymentId: string,
  protectedServiceIds: string[]
): GeneratedSecrets {
  // Portal client secret
  const portalClientSecret = generateSecret(`${deploymentId}-portal-client-secret`);

  // Shared cookie secret for oauth2-proxy
  const oauth2ProxyCookieSecret = generateCookieSecret(`${deploymentId}-oauth2-proxy-cookie`);

  // Per-service client secrets (Model B)
  const serviceClientSecrets: Record<string, pulumi.Output<string>> = {};
  for (const serviceId of protectedServiceIds) {
    serviceClientSecrets[serviceId] = generateSecret(
      `${deploymentId}-oauth2-proxy-${serviceId}-client-secret`
    );
  }

  return {
    portalClientSecret,
    oauth2ProxyCookieSecret,
    serviceClientSecrets,
  };
}
