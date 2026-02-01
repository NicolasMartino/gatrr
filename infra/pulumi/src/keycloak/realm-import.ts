/**
 * Keycloak realm import generation - pure functions
 *
 * These functions build the Keycloak realm import JSON structure.
 * They are pure (no side effects, deterministic) and unit-testable.
 *
 * The realm import includes:
 * - Portal client (for portal auth)
 * - Per-service oauth2-proxy clients (Model B)
 * - Realm roles for authorization (from deployment config)
 * - Users (from deployment config, local stack only)
 * - Groups claim mapper for oauth2-proxy
 */

import { DeploymentConfig, buildUrl } from "../config";
import { KeycloakClientRequest, OAuth2ProxyAuthzPolicy } from "../types";
import { ResolvedDeploymentConfig, UserConfig } from "../deployment-config";

/**
 * Inputs for building the realm import
 */
export interface RealmImportInputs {
  config: DeploymentConfig;
  portalClientSecret: string;
  oauth2ProxyClientSecrets: Record<string, string>;
  clientRequests: KeycloakClientRequest[];
  authzPolicies: Array<{ serviceId: string; policy: OAuth2ProxyAuthzPolicy }>;
  /** Deployment config containing users and roles */
  deploymentConfig: ResolvedDeploymentConfig;
  /** User passwords from Pulumi secrets (keyed by username) */
  userPasswords: Record<string, string>;
}

/**
 * Keycloak realm role structure
 */
export interface RealmRole {
  name: string;
  description: string;
}

/**
 * Keycloak client structure (subset of full client config)
 */
export interface KeycloakClient {
  clientId: string;
  name: string;
  enabled: boolean;
  clientAuthenticatorType: string;
  secret: string;
  redirectUris: string[];
  webOrigins: string[];
  /**
   * Keycloak client attributes map.
   *
   * Note: Keycloak realm JSON import expects post logout redirect URIs to be
   * configured via `attributes["post.logout.redirect.uris"]` (values separated by `##`).
   */
  attributes?: Record<string, string>;
  publicClient: boolean;
  protocol: string;
  standardFlowEnabled: boolean;
  directAccessGrantsEnabled: boolean;
  protocolMappers: Array<{
    name: string;
    protocol: string;
    protocolMapper: string;
    consentRequired: boolean;
    config: Record<string, string>;
  }>;
}

/**
 * Keycloak user structure for realm import
 */
export interface KeycloakUser {
  username: string;
  enabled: boolean;
  emailVerified: boolean;
  email: string;
  firstName: string;
  lastName: string;
  credentials: Array<{
    type: string;
    value: string;
    temporary: boolean;
  }>;
  realmRoles: string[];
}

/**
 * Keycloak realm import structure
 */
export interface RealmImport {
  realm: string;
  enabled: boolean;
  sslRequired: string;
  registrationAllowed: boolean;
  loginWithEmailAllowed: boolean;
  duplicateEmailsAllowed: boolean;
  resetPasswordAllowed: boolean;
  editUsernameAllowed: boolean;
  bruteForceProtected: boolean;
  roles: {
    realm: RealmRole[];
  };
  clients: KeycloakClient[];
  users: KeycloakUser[];
}

/**
 * Build Keycloak client configuration for portal
 *
 * Portal uses explicit redirect URIs (no wildcards per security rules).
 */
export function buildPortalClient(
  config: DeploymentConfig,
  portalClientSecret: string
): KeycloakClient {
  const portalUrl = buildUrl(config, "portal");

  return {
    clientId: "portal",
    name: "Portal",
    enabled: true,
    clientAuthenticatorType: "client-secret",
    secret: portalClientSecret,
    // Explicit redirect URIs (no wildcards per architecture.md rule)
    redirectUris: [`${portalUrl}/auth/callback`],
    webOrigins: [portalUrl],
    attributes: {
      // Values separated by "##" when multiple are needed
      "post.logout.redirect.uris": `${portalUrl}/auth/logout/complete##${portalUrl}/auth/logout/`,
    },
    publicClient: false,
    protocol: "openid-connect",
    standardFlowEnabled: true,
    directAccessGrantsEnabled: false,
    // Protocol mappers for portal client
    protocolMappers: [
      // Audience mapper for token binding security (not authorization)
      // Per plan.md: "Token audience (aud) is not used as an authorization mechanism"
      // However, audience validation prevents token reuse across clients (security best practice)
      {
        name: "portal-audience",
        protocol: "openid-connect",
        protocolMapper: "oidc-audience-mapper",
        consentRequired: false,
        config: {
          "included.client.audience": "portal",
          "id.token.claim": "false",
          "access.token.claim": "true",
        },
      },
      // Explicit realm roles mapper to ensure realm_access.roles is always present
      // This makes the portal resilient to Keycloak client scope configuration changes
      // Without this, portal relies on Keycloak's default "roles" scope which could be removed
      {
        name: "realm-roles",
        protocol: "openid-connect",
        protocolMapper: "oidc-usermodel-realm-role-mapper",
        consentRequired: false,
        config: {
          multivalued: "true",
          "claim.name": "realm_access.roles",
          "jsonType.label": "String",
          "id.token.claim": "true",
          "access.token.claim": "true",
          "userinfo.token.claim": "true",
        },
      },
    ],
  };
}

/**
 * Build Keycloak client configuration for an oauth2-proxy protected service
 *
 * Model B: Each protected service gets its own client with explicit redirect URIs.
 */
export function buildOAuth2ProxyClient(
  clientRequest: KeycloakClientRequest,
  clientSecret: string
): KeycloakClient {
  return {
    clientId: clientRequest.clientId,
    name: `OAuth2 Proxy - ${clientRequest.serviceId}`,
    enabled: true,
    clientAuthenticatorType: "client-secret",
    secret: clientSecret,
    // Explicit redirect URIs (no wildcards)
    redirectUris: clientRequest.redirectUris,
    webOrigins: clientRequest.webOrigins,
    attributes: {
      // Values separated by "##" when multiple are needed
      "post.logout.redirect.uris": clientRequest.webOrigins.join("##"),
    },
    publicClient: false,
    protocol: "openid-connect",
    standardFlowEnabled: true,
    directAccessGrantsEnabled: false,
    // Add groups mapper to include realm roles in groups claim
    // This allows oauth2-proxy to check roles via OAUTH2_PROXY_ALLOWED_GROUPS
    protocolMappers: [
      {
        name: "realm-roles-mapper",
        protocol: "openid-connect",
        protocolMapper: "oidc-usermodel-realm-role-mapper",
        consentRequired: false,
        config: {
          multivalued: "true",
          "claim.name": "groups",
          "jsonType.label": "String",
          "id.token.claim": "true",
          "access.token.claim": "true",
          "userinfo.token.claim": "true",
        },
      },
    ],
  };
}

/**
 * Build realm roles from deployment config
 *
 * Roles come from deployment config (computed or explicit).
 * Returns roles in deterministic (sorted) order.
 */
export function buildRealmRoles(
  deploymentConfig: ResolvedDeploymentConfig
): RealmRole[] {
  // Roles are already computed/validated in deployment config
  return deploymentConfig.roles.map((role) => ({
    name: role,
    description: getRoleDescription(role),
  }));
}

/**
 * Get description for a realm role
 */
function getRoleDescription(role: string): string {
  switch (role) {
    case "admin":
      return "Administrator role - full access to all protected services";
    case "dev":
      return "Developer role - access to standard protected services";
    default:
      return `Access role: ${role}`;
  }
}

/**
 * Build Keycloak user from deployment config user
 *
 * @param user - User config from deployment config (no password)
 * @param password - Password from Pulumi secrets
 * @param realmName - Keycloak realm name
 */
export function buildKeycloakUser(
  user: UserConfig,
  password: string,
  realmName: string
): KeycloakUser {
  // Default roles assigned to all users
  const defaultRoles = [`default-roles-${realmName}`];

  return {
    username: user.username,
    enabled: true,
    emailVerified: true,
    email: user.email,
    firstName: user.firstName ?? user.username,
    lastName: user.lastName ?? "User",
    credentials: [
      {
        type: "password",
        value: password,
        temporary: false,
      },
    ],
    realmRoles: [...defaultRoles, ...user.roles],
  };
}

/**
 * Build the complete realm import object
 *
 * Users and roles come from deployment config.
 * This is a pure function - same inputs always produce same output.
 * The output is deterministic (sorted roles, sorted clients by clientId).
 */
export function buildRealmImport(inputs: RealmImportInputs): RealmImport {
  const {
    config,
    portalClientSecret,
    oauth2ProxyClientSecrets,
    clientRequests,
    deploymentConfig,
    userPasswords,
  } = inputs;

  // Build clients array
  const clients: KeycloakClient[] = [
    buildPortalClient(config, portalClientSecret),
  ];

  // Add per-service oauth2-proxy clients (sorted by serviceId for determinism)
  const sortedClientRequests = [...clientRequests].sort((a, b) =>
    a.serviceId.localeCompare(b.serviceId, "en-US")
  );

  for (const clientRequest of sortedClientRequests) {
    const secret = oauth2ProxyClientSecrets[clientRequest.serviceId];
    if (secret) {
      clients.push(buildOAuth2ProxyClient(clientRequest, secret));
    }
  }

  // Build realm roles from deployment config
  const realmRoles = buildRealmRoles(deploymentConfig);

  // Build users from deployment config with passwords from secrets
  const users = deploymentConfig.users.map((user) => {
    const password = userPasswords[user.username];
    if (!password) {
      throw new Error(
        `Missing password for user "${user.username}". ` +
        `This should have been caught by validation.`
      );
    }
    return buildKeycloakUser(user, password, config.keycloakRealm);
  });

  return {
    realm: config.keycloakRealm,
    enabled: true,
    sslRequired: config.useHttps ? "external" : "none",
    registrationAllowed: false,
    loginWithEmailAllowed: true,
    duplicateEmailsAllowed: false,
    resetPasswordAllowed: true,
    editUsernameAllowed: false,
    bruteForceProtected: true,
    // Realm roles for authorization
    roles: {
      realm: realmRoles,
    },
    clients,
    users,
  };
}

/**
 * Serialize realm import to JSON string
 *
 * Uses 2-space indentation for readability.
 */
export function serializeRealmImport(realm: RealmImport): string {
  return JSON.stringify(realm, null, 2);
}
