/**
 * Tests for Keycloak realm import generation
 *
 * These tests verify:
 * - Realm roles are correctly derived from deployment config
 * - OAuth2-proxy clients have correct protocol mappers (groups claim)
 * - Portal client has explicit redirect URIs (no wildcards)
 * - Users are created from deployment config
 * - Deterministic output ordering
 */

import { describe, it, expect } from "vitest";
import {
  buildRealmImport,
  buildRealmRoles,
  buildPortalClient,
  buildOAuth2ProxyClient,
  buildKeycloakUser,
  serializeRealmImport,
  RealmImportInputs,
} from "./realm-import";
import { DeploymentConfig } from "../config";
import { KeycloakClientRequest, OAuth2ProxyAuthzPolicy } from "../types";
import { ResolvedDeploymentConfig, UserConfig } from "../deployment-config";

const testConfig: DeploymentConfig = {
  deploymentId: "local",
  environment: "dev",
  baseDomain: "localhost",
  useHttps: false,
  keycloakRealm: "dev",
  descriptorInjection: "file",
  buildPlatform: "linux/amd64",
};

const testConfigHttps: DeploymentConfig = {
  ...testConfig,
  deploymentId: "prod",
  environment: "prod",
  baseDomain: "example.com",
  useHttps: true,
};

const baseDeploymentConfig: ResolvedDeploymentConfig = {
  stackName: "local",
  roles: ["admin", "dev"],
  users: [
    {
      username: "admin",
      email: "admin@example.com",
      firstName: "Admin",
      lastName: "User",
      roles: ["admin"],
    },
    {
      username: "dev",
      email: "dev@example.com",
      firstName: "Dev",
      lastName: "User",
      roles: ["dev"],
    },
  ],
  services: [],
};

const baseUserPasswords: Record<string, string> = {
  admin: "admin-secret",
  dev: "dev-secret",
};

describe("buildRealmRoles", () => {
  it("returns roles from deployment config", () => {
    const roles = buildRealmRoles(baseDeploymentConfig);

    expect(roles.map((r) => r.name)).toContain("admin");
    expect(roles.map((r) => r.name)).toContain("dev");
  });

  it("returns roles in order from config", () => {
    const config: ResolvedDeploymentConfig = {
      ...baseDeploymentConfig,
      roles: ["admin", "beta", "dev"],
    };

    const roles = buildRealmRoles(config);

    expect(roles.map((r) => r.name)).toEqual(["admin", "beta", "dev"]);
  });

  it("returns empty array when no roles", () => {
    const config: ResolvedDeploymentConfig = {
      ...baseDeploymentConfig,
      roles: [],
    };

    const roles = buildRealmRoles(config);

    expect(roles).toHaveLength(0);
  });

  it("includes descriptions for known roles", () => {
    const roles = buildRealmRoles(baseDeploymentConfig);

    const adminRole = roles.find((r) => r.name === "admin");
    expect(adminRole?.description).toContain("Administrator");

    const devRole = roles.find((r) => r.name === "dev");
    expect(devRole?.description).toContain("Developer");
  });
});

describe("buildPortalClient", () => {
  it("uses explicit redirect URI (no wildcards)", () => {
    const client = buildPortalClient(testConfig, "test-secret");

    expect(client.redirectUris).toEqual(["http://portal.localhost/auth/callback"]);
    expect(client.attributes?.["post.logout.redirect.uris"]).toBe(
      "http://portal.localhost/auth/logout/complete##http://portal.localhost/auth/logout/"
    );
    expect(client.redirectUris[0]).not.toContain("*");
  });

  it("uses HTTPS redirect URI when useHttps is true", () => {
    const client = buildPortalClient(testConfigHttps, "test-secret");

    expect(client.redirectUris).toEqual(["https://portal.example.com/auth/callback"]);
    expect(client.attributes?.["post.logout.redirect.uris"]).toBe(
      "https://portal.example.com/auth/logout/complete##https://portal.example.com/auth/logout/"
    );
  });

  it("has audience mapper for token binding security", () => {
    const client = buildPortalClient(testConfig, "test-secret");

    const audienceMapper = client.protocolMappers.find(
      (m) => m.name === "portal-audience"
    );

    expect(audienceMapper).toBeDefined();
    expect(audienceMapper?.protocolMapper).toBe("oidc-audience-mapper");
    expect(audienceMapper?.config["included.client.audience"]).toBe("portal");
    expect(audienceMapper?.config["access.token.claim"]).toBe("true");
  });

  it("sets correct client properties", () => {
    const client = buildPortalClient(testConfig, "my-secret");

    expect(client.clientId).toBe("portal");
    expect(client.secret).toBe("my-secret");
    expect(client.publicClient).toBe(false);
    expect(client.standardFlowEnabled).toBe(true);
    expect(client.directAccessGrantsEnabled).toBe(false);
  });
});

describe("buildOAuth2ProxyClient", () => {
  it("has realm-roles-mapper for groups claim", () => {
    const clientRequest: KeycloakClientRequest = {
      clientId: "oauth2-proxy-demo",
      serviceId: "demo",
      redirectUris: ["http://demo.localhost/oauth2/callback"],
      webOrigins: ["http://demo.localhost"],
    };

    const client = buildOAuth2ProxyClient(clientRequest, "test-secret");

    expect(client.attributes?.["post.logout.redirect.uris"]).toBe("http://demo.localhost");

    const rolesMapper = client.protocolMappers.find(
      (m) => m.name === "realm-roles-mapper"
    );

    expect(rolesMapper).toBeDefined();
    expect(rolesMapper?.protocolMapper).toBe("oidc-usermodel-realm-role-mapper");
    expect(rolesMapper?.config["claim.name"]).toBe("groups");
    expect(rolesMapper?.config["access.token.claim"]).toBe("true");
    expect(rolesMapper?.config["id.token.claim"]).toBe("true");
    expect(rolesMapper?.config["userinfo.token.claim"]).toBe("true");
  });

  it("uses explicit redirect URIs from request", () => {
    const clientRequest: KeycloakClientRequest = {
      clientId: "oauth2-proxy-demo",
      serviceId: "demo",
      redirectUris: ["http://demo.localhost/oauth2/callback"],
      webOrigins: ["http://demo.localhost"],
    };

    const client = buildOAuth2ProxyClient(clientRequest, "test-secret");

    expect(client.redirectUris).toEqual(["http://demo.localhost/oauth2/callback"]);
    expect(client.attributes?.["post.logout.redirect.uris"]).toBe("http://demo.localhost");
    expect(client.redirectUris[0]).not.toContain("*");
  });

  it("sets correct client properties", () => {
    const clientRequest: KeycloakClientRequest = {
      clientId: "oauth2-proxy-admin",
      serviceId: "admin",
      redirectUris: ["http://admin.localhost/oauth2/callback"],
      webOrigins: ["http://admin.localhost"],
    };

    const client = buildOAuth2ProxyClient(clientRequest, "admin-secret");

    expect(client.clientId).toBe("oauth2-proxy-admin");
    expect(client.secret).toBe("admin-secret");
    expect(client.name).toBe("OAuth2 Proxy - admin");
    expect(client.publicClient).toBe(false);
  });
});

describe("buildKeycloakUser", () => {
  it("creates user with correct properties", () => {
    const userConfig: UserConfig = {
      username: "testuser",
      email: "test@example.com",
      firstName: "Test",
      lastName: "User",
      roles: ["admin", "dev"],
    };

    const user = buildKeycloakUser(userConfig, "testpass", "dev");

    expect(user.username).toBe("testuser");
    expect(user.email).toBe("test@example.com");
    expect(user.firstName).toBe("Test");
    expect(user.lastName).toBe("User");
    expect(user.credentials[0].value).toBe("testpass");
    expect(user.realmRoles).toContain("admin");
    expect(user.realmRoles).toContain("dev");
    expect(user.realmRoles).toContain("default-roles-dev");
  });

  it("uses username as firstName if not provided", () => {
    const userConfig: UserConfig = {
      username: "testuser",
      email: "test@example.com",
      roles: ["admin"],
    };

    const user = buildKeycloakUser(userConfig, "testpass", "dev");

    expect(user.firstName).toBe("testuser");
    expect(user.lastName).toBe("User");
  });
});

describe("buildRealmImport", () => {
  const baseInputs: RealmImportInputs = {
    config: testConfig,
    portalClientSecret: "portal-secret",
    oauth2ProxyClientSecrets: {},
    clientRequests: [],
    authzPolicies: [],
    deploymentConfig: baseDeploymentConfig,
    userPasswords: baseUserPasswords,
  };

  it("includes portal client", () => {
    const realm = buildRealmImport(baseInputs);

    const portalClient = realm.clients.find((c) => c.clientId === "portal");
    expect(portalClient).toBeDefined();
    expect(portalClient?.secret).toBe("portal-secret");
  });

  it("includes oauth2-proxy clients for protected services", () => {
    const inputs: RealmImportInputs = {
      ...baseInputs,
      oauth2ProxyClientSecrets: {
        demo: "demo-secret",
        admin: "admin-secret",
      },
      clientRequests: [
        {
          clientId: "oauth2-proxy-demo",
          serviceId: "demo",
          redirectUris: ["http://demo.localhost/oauth2/callback"],
          webOrigins: ["http://demo.localhost"],
        },
        {
          clientId: "oauth2-proxy-admin",
          serviceId: "admin",
          redirectUris: ["http://admin.localhost/oauth2/callback"],
          webOrigins: ["http://admin.localhost"],
        },
      ],
      authzPolicies: [
        { serviceId: "demo", policy: { requiredRealmRoles: ["demo"] } },
        { serviceId: "admin", policy: { requiredRealmRoles: ["admin", "ops"] } },
      ],
    };

    const realm = buildRealmImport(inputs);

    // Should have portal + 2 oauth2-proxy clients
    expect(realm.clients).toHaveLength(3);

    const demoClient = realm.clients.find((c) => c.clientId === "oauth2-proxy-demo");
    expect(demoClient).toBeDefined();
    expect(demoClient?.secret).toBe("demo-secret");

    const adminClient = realm.clients.find((c) => c.clientId === "oauth2-proxy-admin");
    expect(adminClient).toBeDefined();
    expect(adminClient?.secret).toBe("admin-secret");
  });

  it("includes realm roles from deployment config", () => {
    const inputs: RealmImportInputs = {
      ...baseInputs,
      deploymentConfig: {
        ...baseDeploymentConfig,
        roles: ["admin", "beta", "dev"],
      },
    };

    const realm = buildRealmImport(inputs);

    expect(realm.roles.realm).toHaveLength(3);
    expect(realm.roles.realm.map((r) => r.name)).toEqual(["admin", "beta", "dev"]);
  });

  it("creates realm users from deployment config", () => {
    const realm = buildRealmImport(baseInputs);

    expect(realm.users).toHaveLength(2);

    // Admin user
    const adminUser = realm.users.find((u) => u.username === "admin");
    expect(adminUser).toBeDefined();
    expect(adminUser?.credentials[0].value).toBe("admin-secret");
    expect(adminUser?.realmRoles).toContain("admin");
    expect(adminUser?.realmRoles).toContain("default-roles-dev");

    // Dev user
    const devUser = realm.users.find((u) => u.username === "dev");
    expect(devUser).toBeDefined();
    expect(devUser?.credentials[0].value).toBe("dev-secret");
    expect(devUser?.realmRoles).toContain("dev");
    expect(devUser?.realmRoles).toContain("default-roles-dev");
  });

  it("creates no users when deployment config has no users", () => {
    const inputs: RealmImportInputs = {
      ...baseInputs,
      deploymentConfig: {
        ...baseDeploymentConfig,
        users: [],
      },
    };

    const realm = buildRealmImport(inputs);

    expect(realm.users).toHaveLength(0);
  });

  it("sets correct realm properties", () => {
    const realm = buildRealmImport(baseInputs);

    expect(realm.realm).toBe("dev");
    expect(realm.enabled).toBe(true);
    expect(realm.sslRequired).toBe("none"); // useHttps=false
    expect(realm.bruteForceProtected).toBe(true);
  });

  it("sets sslRequired to external when useHttps is true", () => {
    const inputs: RealmImportInputs = {
      ...baseInputs,
      config: testConfigHttps,
    };

    const realm = buildRealmImport(inputs);

    expect(realm.sslRequired).toBe("external");
  });

  it("produces deterministic output", () => {
    const inputs: RealmImportInputs = {
      ...baseInputs,
      oauth2ProxyClientSecrets: {
        z: "z-secret",
        a: "a-secret",
      },
      clientRequests: [
        {
          clientId: "oauth2-proxy-z",
          serviceId: "z",
          redirectUris: ["http://z.localhost/oauth2/callback"],
          webOrigins: ["http://z.localhost"],
        },
        {
          clientId: "oauth2-proxy-a",
          serviceId: "a",
          redirectUris: ["http://a.localhost/oauth2/callback"],
          webOrigins: ["http://a.localhost"],
        },
      ],
      authzPolicies: [
        { serviceId: "z", policy: { requiredRealmRoles: ["z"] } },
        { serviceId: "a", policy: { requiredRealmRoles: ["a"] } },
      ],
    };

    const realm1 = buildRealmImport(inputs);
    const realm2 = buildRealmImport(inputs);

    const json1 = serializeRealmImport(realm1);
    const json2 = serializeRealmImport(realm2);

    expect(json1).toBe(json2);
  });
});

describe("serializeRealmImport", () => {
  it("produces valid JSON", () => {
    const realm = buildRealmImport({
      config: testConfig,
      portalClientSecret: "secret",
      oauth2ProxyClientSecrets: {},
      clientRequests: [],
      authzPolicies: [],
      deploymentConfig: baseDeploymentConfig,
      userPasswords: baseUserPasswords,
    });

    const json = serializeRealmImport(realm);

    expect(() => JSON.parse(json)).not.toThrow();
  });

  it("uses 2-space indentation", () => {
    const realm = buildRealmImport({
      config: testConfig,
      portalClientSecret: "secret",
      oauth2ProxyClientSecrets: {},
      clientRequests: [],
      authzPolicies: [],
      deploymentConfig: baseDeploymentConfig,
      userPasswords: baseUserPasswords,
    });

    const json = serializeRealmImport(realm);

    expect(json).toContain('  "realm"');
    expect(json).toContain('  "enabled"');
  });
});

describe("integration: roles protected services", () => {
  it("protected service with roles results in correct realm import", () => {
    const deploymentConfig: ResolvedDeploymentConfig = {
      stackName: "local",
      roles: ["admin", "dev"],
      users: [
        {
          username: "admin",
          email: "admin@example.com",
          roles: ["admin"],
        },
        {
          username: "dev",
          email: "dev@example.com",
          roles: ["dev"],
        },
      ],
      services: [],
    };

    const userPasswords: Record<string, string> = {
      admin: "admin-pwd",
      dev: "dev-pwd",
    };

    const inputs: RealmImportInputs = {
      config: testConfig,
      portalClientSecret: "portal-secret",
      oauth2ProxyClientSecrets: {
        demo: "demo-secret",
        dozzle: "dozzle-secret",
      },
      clientRequests: [
        {
          clientId: "oauth2-proxy-demo",
          serviceId: "demo",
          redirectUris: ["http://demo.localhost/oauth2/callback"],
          webOrigins: ["http://demo.localhost"],
        },
        {
          clientId: "oauth2-proxy-dozzle",
          serviceId: "dozzle",
          redirectUris: ["http://dozzle.localhost/oauth2/callback"],
          webOrigins: ["http://dozzle.localhost"],
        },
      ],
      authzPolicies: [
        { serviceId: "demo", policy: { requiredRealmRoles: ["admin", "dev"] } },
        { serviceId: "dozzle", policy: { requiredRealmRoles: ["admin"] } },
      ],
      deploymentConfig,
      userPasswords,
    };

    const realm = buildRealmImport(inputs);

    // 1. Verify realm roles from deployment config
    expect(realm.roles.realm.map((r) => r.name)).toEqual(["admin", "dev"]);

    // 2. Verify each oauth2-proxy client has the realm-role mapper
    const demoClient = realm.clients.find((c) => c.clientId === "oauth2-proxy-demo")!;
    const dozzleClient = realm.clients.find((c) => c.clientId === "oauth2-proxy-dozzle")!;

    const demoMapper = demoClient.protocolMappers.find(
      (m) => m.protocolMapper === "oidc-usermodel-realm-role-mapper"
    );
    expect(demoMapper).toBeDefined();
    expect(demoMapper?.config["claim.name"]).toBe("groups");
    expect(demoMapper?.config["access.token.claim"]).toBe("true");

    const dozzleMapper = dozzleClient.protocolMappers.find(
      (m) => m.protocolMapper === "oidc-usermodel-realm-role-mapper"
    );
    expect(dozzleMapper).toBeDefined();
    expect(dozzleMapper?.config["claim.name"]).toBe("groups");

    // 3. Verify redirect URIs are explicit (no wildcards)
    expect(demoClient.redirectUris).toEqual(["http://demo.localhost/oauth2/callback"]);
    expect(dozzleClient.redirectUris).toEqual(["http://dozzle.localhost/oauth2/callback"]);
    expect(demoClient.redirectUris.every((uri) => !uri.includes("*"))).toBe(true);
    expect(dozzleClient.redirectUris.every((uri) => !uri.includes("*"))).toBe(true);

    // 4. Verify portal client also has no wildcards
    const portalClient = realm.clients.find((c) => c.clientId === "portal")!;
    expect(portalClient.redirectUris).toEqual(["http://portal.localhost/auth/callback"]);
    expect(portalClient.redirectUris.every((uri) => !uri.includes("*"))).toBe(true);

    // 5. Verify users are created from deployment config
    expect(realm.users).toHaveLength(2);
    expect(realm.users.map((u) => u.username).sort()).toEqual(["admin", "dev"]);
  });
});
