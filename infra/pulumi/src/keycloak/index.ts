/**
 * Keycloak OAuth2/OIDC provider container
 *
 * Keycloak provides authentication for the portal and protected services.
 * In local/dev mode, it runs with ephemeral storage and imports a realm on startup.
 *
 * Model B: One Keycloak OIDC client per oauth2-proxy protected service.
 * Realm roles are used for authorization (mapped to groups claim for oauth2-proxy).
 */

import * as crypto from "crypto";
import * as docker from "@pulumi/docker";
import * as pulumi from "@pulumi/pulumi";
import { DeploymentConfig, buildUrl } from "../config";
import { KeycloakClientRequest, OAuth2ProxyAuthzPolicy, createContainer, ContainerIdentity, shortName } from "../types";
import { ResolvedDeploymentConfig } from "../deployment-config";
import { buildRealmImport, serializeRealmImport } from "./realm-import";

/** Keycloak version (from image tag) */
const KEYCLOAK_VERSION = "24.0";

export interface KeycloakInputs {
  config: DeploymentConfig;
  network: docker.Network;
  /** Portal client secret for OIDC */
  portalClientSecret: pulumi.Input<string>;
  /** Per-service oauth2-proxy client secrets (keyed by serviceId) */
  oauth2ProxyClientSecrets: Record<string, pulumi.Input<string>>;
  /** Keycloak admin username (required - no defaults for security) */
  adminUsername: pulumi.Input<string>;
  /** Keycloak admin password (required - no defaults for security) */
  adminPassword: pulumi.Input<string>;
  /** Deployment config for realm generation (users, roles) */
  deploymentConfig: pulumi.Input<ResolvedDeploymentConfig>;
  /** User passwords from Pulumi secrets (keyed by username) */
  userPasswords: pulumi.Input<Record<string, pulumi.Input<string>>>;
  /** Client requests from protected services */
  clientRequests: KeycloakClientRequest[];
  /** Authorization policies from protected services (for realm role creation) */
  authzPolicies: Array<{ serviceId: string; policy: OAuth2ProxyAuthzPolicy }>;
}

export interface KeycloakResources {
  container: docker.Container;
  /** Internal URL for server-to-server communication */
  internalUrl: string;
  /** Public URL for browser redirects */
  publicUrl: string;
  /** OIDC issuer URL (public, for browser redirects) */
  issuerUrl: string;
  /** OIDC issuer URL (internal, for server-to-server OIDC discovery) */
  internalIssuerUrl: string;
}

// Pure functions for realm import are in ./realm-import.ts
// This file focuses on the Pulumi resource wrapper.

/**
 * Create Keycloak container
 */
export function createKeycloak(inputs: KeycloakInputs): KeycloakResources {
  const {
    config,
    network,
    portalClientSecret,
    oauth2ProxyClientSecrets,
    adminUsername,
    adminPassword,
    deploymentConfig,
    userPasswords,
    clientRequests,
    authzPolicies,
  } = inputs;

  // Build container identity
  const identity: ContainerIdentity = {
    deploymentId: config.deploymentId,
    serviceId: "keycloak",
    version: KEYCLOAK_VERSION,
  };

  const keycloakAddress = shortName(config.deploymentId, "keycloak");
  const publicUrl = buildUrl(config, "keycloak");
  // Use stable short name for internal URL (routing)
  const internalUrl = `http://${keycloakAddress}:8080`;
  const issuerUrl = `${publicUrl}/realms/${config.keycloakRealm}`;
  const internalIssuerUrl = `${internalUrl}/realms/${config.keycloakRealm}`;

  // Generate realm JSON with all secrets and deployment config resolved
  const realmJson = pulumi
    .all([
      portalClientSecret,
      pulumi.output(oauth2ProxyClientSecrets),
      pulumi.output(deploymentConfig),
      pulumi.output(userPasswords),
    ])
    .apply(([portalSecret, clientSecrets, resolvedDeploymentConfig, passwords]) => {
      // Resolve all client secrets
      const resolvedClientSecrets: Record<string, string> = {};
      for (const [serviceId, secret] of Object.entries(clientSecrets)) {
        resolvedClientSecrets[serviceId] = secret;
      }

      // Resolve all user passwords
      const resolvedUserPasswords: Record<string, string> = {};
      for (const [username, password] of Object.entries(passwords)) {
        resolvedUserPasswords[username] = password;
      }

      // Use pure functions from realm-import.ts
      const realmImport = buildRealmImport({
        config,
        portalClientSecret: portalSecret,
        oauth2ProxyClientSecrets: resolvedClientSecrets,
        clientRequests,
        authzPolicies,
        deploymentConfig: resolvedDeploymentConfig,
        userPasswords: resolvedUserPasswords,
      });

      return serializeRealmImport(realmImport);
    });

  // Compute hash of realm config to force container restart when config changes
  const realmConfigHash = realmJson.apply((json) =>
    crypto.createHash("sha256").update(json).digest("hex").substring(0, 16)
  );

  // Build environment variables with secrets
  // Production mode uses strict hostname validation; dev mode is more relaxed
  const envs = pulumi
    .all([adminUsername, adminPassword, realmConfigHash])
    .apply(([username, password, configHash]) => {
      const baseEnvs = [
        `KEYCLOAK_ADMIN=${username}`,
        `KEYCLOAK_ADMIN_PASSWORD=${password}`,
        `KC_HOSTNAME=keycloak.${config.baseDomain}`,
        "KC_PROXY_HEADERS=xforwarded",
        // Force realm import to overwrite existing users/config on every restart
        // This ensures ESC password changes are applied to Keycloak
        "KC_SPI_IMPORT_IMPORTER_STRATEGY=OVERWRITE_EXISTING",
        // Hash of realm config - changes when passwords/users change, forcing container restart
        `REALM_CONFIG_HASH=${configHash}`,
      ];

      if (config.keycloakDevMode) {
        // Dev mode: relaxed hostname validation
        return [
          ...baseEnvs,
          "KC_HOSTNAME_STRICT=false",
          "KC_HTTP_ENABLED=true",
        ];
      } else {
        // Production mode: strict hostname but HTTP still enabled for Traefik internal communication
        // KC_HOSTNAME_STRICT_HTTPS=false allows HTTP behind reverse proxy
        return [
          ...baseEnvs,
          "KC_HOSTNAME_STRICT=true",
          "KC_HTTP_ENABLED=true",
          "KC_HOSTNAME_STRICT_HTTPS=false",
        ];
      }
    });

  // Command selection: start-dev for development, start for production
  const command = config.keycloakDevMode
    ? ["start-dev", "--import-realm"]
    : ["start", "--import-realm"];

  const container = createContainer(
    identity,
    {
      network,
      image: `quay.io/keycloak/keycloak:${KEYCLOAK_VERSION}`,
      command,
      envs,
      uploads: [
        {
          file: `/opt/keycloak/data/import/${config.keycloakRealm}-realm.json`,
          content: realmJson,
        },
      ],
      restart: "unless-stopped",
    },
    {
      dependsOn: [network],
    }
  );

  return {
    container,
    internalUrl,
    publicUrl,
    issuerUrl,
    internalIssuerUrl,
  };
}

/**
 * Build a KeycloakClientRequest for an oauth2-proxy protected service
 */
export function buildClientRequest(
  config: DeploymentConfig,
  serviceId: string
): KeycloakClientRequest {
  const serviceUrl = buildUrl(config, serviceId);

  return {
    clientId: `oauth2-proxy-${serviceId}`,
    serviceId,
    redirectUris: [`${serviceUrl}/oauth2/callback`],
    webOrigins: [serviceUrl],
  };
}
