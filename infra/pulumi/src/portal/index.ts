/**
 * Portal container
 *
 * The portal is the service dashboard that displays all services.
 * It receives the descriptor via one of two injection methods:
 * - File-based injection (PORTAL_DESCRIPTOR_PATH) - preferred for real deployments
 * - JSON env var injection (PORTAL_DESCRIPTOR_JSON) - for small descriptors only
 *
 * The injection method is controlled by config.descriptorInjection.
 */

import * as docker from "@pulumi/docker";
import * as pulumi from "@pulumi/pulumi";
import { DeploymentConfig, buildUrl, DESCRIPTOR_JSON_MAX_SIZE, getPortalVersion } from "../config";
import {
  PortalDescriptor,
  serializeDescriptor,
  serializeDescriptorMinified,
} from "../descriptor/index";
import { createContainer, ContainerIdentity, shortName } from "../types";
import * as path from "path";

// Compute repo root from this file's location (infra/pulumi/src/portal/index.ts -> repo root)
const repoRoot = path.resolve(__dirname, "../../../..");

/** Portal version from Cargo.toml */
const PORTAL_VERSION = getPortalVersion(repoRoot);

export interface PortalInputs {
  config: DeploymentConfig;
  network: docker.Network;
  descriptor: PortalDescriptor;
  /** Keycloak internal URL for server-to-server communication */
  keycloakInternalUrl: string;
  /** Portal OAuth2 client ID */
  clientId: string;
  /** Portal OAuth2 client secret */
  clientSecret: pulumi.Input<string>;
  /** Portal image name (required - built by images module) */
  image: pulumi.Input<string>;
}

export interface PortalResources {
  container: docker.Container;
  /** Public URL for the portal */
  publicUrl: string;
}

/** Container path where descriptor will be uploaded (for file injection) */
const DESCRIPTOR_CONTAINER_PATH = "/etc/portal/descriptor.json";

/**
 * Create the portal container
 */
export function createPortal(inputs: PortalInputs): PortalResources {
  const {
    config,
    network,
    descriptor,
    keycloakInternalUrl,
    clientId,
    clientSecret,
    image,
  } = inputs;

  const publicUrl = buildUrl(config, "portal");

  // Serialize descriptor based on injection method:
  // - File injection: pretty-printed for readability/debugging
  // - JSON injection: minified to avoid newline/quoting issues in env vars
  const descriptorJsonPretty = serializeDescriptor(descriptor);
  const descriptorJsonMinified = serializeDescriptorMinified(descriptor);

  // Enforce 64KB size guard for JSON injection (per plan.md)
  if (config.descriptorInjection === "json") {
    const descriptorSize = Buffer.byteLength(descriptorJsonMinified, "utf-8");
    if (descriptorSize > DESCRIPTOR_JSON_MAX_SIZE) {
      throw new Error(
        `Descriptor size (${descriptorSize} bytes) exceeds maximum for JSON injection ` +
          `(${DESCRIPTOR_JSON_MAX_SIZE} bytes). Use descriptorInjection: "file" instead.`
      );
    }
  }

  // Build environment variables based on injection method
  const envs = pulumi.all([clientSecret]).apply(([secret]) => {
    const baseEnvs = [
      // Environment
      config.environment === "prod"
        ? "ENVIRONMENT=production"
        : "ENVIRONMENT=development",

      // Server configuration
      "SERVER_HOST=0.0.0.0",
      "SERVER_PORT=3000",

      // Keycloak configuration
      `KEYCLOAK_URL=${keycloakInternalUrl}`,
      `KEYCLOAK_CALLBACK_URL=${descriptor.keycloak.publicUrl}`,
      `KEYCLOAK_REALM=${config.keycloakRealm}`,

      // OAuth2 client configuration
      `CLIENT_ID=${clientId}`,
      `CLIENT_SECRET=${secret}`,
      `REDIRECT_URI=${publicUrl}/auth/callback`,

      // Cookie configuration
      // Security: Host-only cookies (no COOKIE_DOMAIN env var set).
      // Portal cookies are scoped to portal.{baseDomain} only and won't be
      // sent to other subdomains. This limits cookie exposure surface.
      // See code_fix.md P0 item 2 for rationale.

      // Internal Traefik URL for reachability probes during logout
      // The portal probes services through Traefik using Host headers since
      // public URLs (e.g., dozzle.localhost) are not resolvable inside Docker.
      `TRAEFIK_INTERNAL_URL=http://${shortName(config.deploymentId, "traefik")}:80`,
    ];

    // Add descriptor injection env var based on method
    if (config.descriptorInjection === "json") {
      // JSON injection via environment variable (minified to avoid quoting issues)
      baseEnvs.push(`PORTAL_DESCRIPTOR_JSON=${descriptorJsonMinified}`);
    } else {
      // File injection via path (default, preferred)
      baseEnvs.push(`PORTAL_DESCRIPTOR_PATH=${DESCRIPTOR_CONTAINER_PATH}`);
    }

    return baseEnvs;
  });

  // Build uploads array - only include descriptor file for file injection
  // Use pretty-printed JSON for file injection (easier to debug/inspect)
  const uploads: docker.types.input.ContainerUpload[] =
    config.descriptorInjection === "file"
      ? [
          {
            file: DESCRIPTOR_CONTAINER_PATH,
            content: descriptorJsonPretty,
          },
        ]
      : [];

  // Build container identity
  const identity: ContainerIdentity = {
    deploymentId: config.deploymentId,
    serviceId: "portal",
    version: PORTAL_VERSION,
  };

  const container = createContainer(
    identity,
    {
      network,
      image,
      envs,
      // Upload descriptor directly into container (only for file injection)
      uploads: uploads.length > 0 ? uploads : undefined,
      restart: "unless-stopped",
      healthcheck: {
        // Use /readyz for readiness: checks JWKS cache is populated (Keycloak reachable)
        // This ensures container is only "healthy" when it can authenticate users
        tests: ["CMD", "curl", "-fsS", "http://127.0.0.1:3000/readyz"],
        interval: "30s",
        timeout: "10s",
        retries: 3,
        startPeriod: "30s", // Allow time for initial JWKS fetch from Keycloak
      },
    },
    {
      dependsOn: [network],
    }
  );

  return {
    container,
    publicUrl,
  };
}
