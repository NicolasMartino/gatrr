/**
 * Tests for deployment configuration inference rules
 */

import { describe, it, expect } from "vitest";
import {
  inferPortalName,
  inferHost,
  inferAuthType,
  computeRoles,
  resolveServiceConfig,
  resolveDeploymentConfig,
} from "./inference";
import { DeploymentConfigFile, ServiceConfig, UserConfig } from "./types";

describe("inferPortalName", () => {
  it("capitalizes single word", () => {
    expect(inferPortalName("demo")).toBe("Demo");
  });

  it("capitalizes each word in hyphenated string", () => {
    expect(inferPortalName("my-service")).toBe("My Service");
  });

  it("handles multiple hyphens", () => {
    expect(inferPortalName("api-v2-beta")).toBe("Api V2 Beta");
  });

  it("handles single character", () => {
    expect(inferPortalName("a")).toBe("A");
  });

  it("handles empty string", () => {
    expect(inferPortalName("")).toBe("");
  });

  it("lowercases rest of word", () => {
    expect(inferPortalName("API")).toBe("Api");
  });
});

describe("inferHost", () => {
  it("returns serviceId unchanged", () => {
    expect(inferHost("demo")).toBe("demo");
  });

  it("preserves hyphenated names", () => {
    expect(inferHost("my-service")).toBe("my-service");
  });

  it("handles empty string", () => {
    expect(inferHost("")).toBe("");
  });
});

describe("inferAuthType", () => {
  it("returns 'none' for undefined", () => {
    expect(inferAuthType(undefined)).toBe("none");
  });

  it("returns 'none' for empty array", () => {
    expect(inferAuthType([])).toBe("none");
  });

  it("returns 'oauth2-proxy' for single role", () => {
    expect(inferAuthType(["admin"])).toBe("oauth2-proxy");
  });

  it("returns 'oauth2-proxy' for multiple roles", () => {
    expect(inferAuthType(["dev", "admin"])).toBe("oauth2-proxy");
  });
});

describe("computeRoles", () => {
  it("returns explicit roles when provided", () => {
    const result = computeRoles(["admin", "dev"], [], {});
    expect(result).toEqual(["admin", "dev"]);
  });

  it("sorts explicit roles", () => {
    const result = computeRoles(["dev", "admin", "beta"], [], {});
    expect(result).toEqual(["admin", "beta", "dev"]);
  });

  it("infers roles from users only", () => {
    const users: UserConfig[] = [
      { username: "admin", password: "admin", email: "admin@test.com", roles: ["admin"] },
      { username: "dev", password: "dev", email: "dev@test.com", roles: ["dev"] },
    ];
    const result = computeRoles(undefined, users, {});
    expect(result).toEqual(["admin", "dev"]);
  });

  it("infers roles from services only", () => {
    const services: Record<string, ServiceConfig> = {
      demo: { requiredRoles: ["dev"] },
      admin: { requiredRoles: ["admin"] },
    };
    const result = computeRoles(undefined, [], services);
    expect(result).toEqual(["admin", "dev"]);
  });

  it("infers roles from both users and services", () => {
    const users: UserConfig[] = [
      { username: "admin", password: "admin", email: "admin@test.com", roles: ["admin", "beta"] },
    ];
    const services: Record<string, ServiceConfig> = {
      demo: { requiredRoles: ["dev", "admin"] },
    };
    const result = computeRoles(undefined, users, services);
    expect(result).toEqual(["admin", "beta", "dev"]);
  });

  it("deduplicates roles", () => {
    const users: UserConfig[] = [
      { username: "admin", password: "admin", email: "admin@test.com", roles: ["admin", "dev"] },
    ];
    const services: Record<string, ServiceConfig> = {
      demo: { requiredRoles: ["dev", "admin"] },
    };
    const result = computeRoles(undefined, users, services);
    expect(result).toEqual(["admin", "dev"]);
  });

  it("returns empty array when no roles referenced", () => {
    const result = computeRoles(undefined, [], {});
    expect(result).toEqual([]);
  });

  it("handles services without requiredRoles", () => {
    const services: Record<string, ServiceConfig> = {
      docs: {}, // No requiredRoles
      demo: { requiredRoles: ["dev"] },
    };
    const result = computeRoles(undefined, [], services);
    expect(result).toEqual(["dev"]);
  });
});

describe("resolveServiceConfig", () => {
  it("applies all defaults when config is empty", () => {
    const result = resolveServiceConfig("demo", {});
    expect(result).toEqual({
      serviceId: "demo",
      portalName: "Demo",
      host: "demo",
      authType: "none",
      requiredRoles: [],
    });
  });

  it("preserves explicit portalName", () => {
    const result = resolveServiceConfig("demo", { portalName: "Demo Application" });
    expect(result.portalName).toBe("Demo Application");
  });

  it("preserves explicit host", () => {
    const result = resolveServiceConfig("demo", { host: "demo-app" });
    expect(result.host).toBe("demo-app");
  });

  it("preserves explicit authType", () => {
    const result = resolveServiceConfig("demo", { authType: "portal" });
    expect(result.authType).toBe("portal");
  });

  it("infers authType from requiredRoles", () => {
    const result = resolveServiceConfig("demo", { requiredRoles: ["dev"] });
    expect(result.authType).toBe("oauth2-proxy");
    expect(result.requiredRoles).toEqual(["dev"]);
  });

  it("preserves optional fields when present", () => {
    const result = resolveServiceConfig("demo", {
      group: "Apps",
      icon: "rocket",
      description: "A demo app",
    });
    expect(result.group).toBe("Apps");
    expect(result.icon).toBe("rocket");
    expect(result.description).toBe("A demo app");
  });

  it("omits optional fields when absent", () => {
    const result = resolveServiceConfig("demo", {});
    expect(result).not.toHaveProperty("group");
    expect(result).not.toHaveProperty("icon");
    expect(result).not.toHaveProperty("description");
  });
});

describe("resolveDeploymentConfig", () => {
  it("resolves minimal config", () => {
    const raw: DeploymentConfigFile = {
      services: {
        demo: {},
      },
    };
    const result = resolveDeploymentConfig("local", raw);

    expect(result.stackName).toBe("local");
    expect(result.roles).toEqual([]);
    expect(result.users).toEqual([]);
    expect(result.services).toHaveLength(1);
    expect(result.services[0].serviceId).toBe("demo");
  });

  it("sorts services by serviceId", () => {
    const raw: DeploymentConfigFile = {
      services: {
        zebra: {},
        alpha: {},
        middle: {},
      },
    };
    const result = resolveDeploymentConfig("local", raw);

    expect(result.services.map((s) => s.serviceId)).toEqual(["alpha", "middle", "zebra"]);
  });

  it("includes users from config", () => {
    const raw: DeploymentConfigFile = {
      users: [
        { username: "admin", password: "admin", email: "admin@test.com", roles: ["admin"] },
      ],
      services: {},
    };
    const result = resolveDeploymentConfig("local", raw);

    expect(result.users).toHaveLength(1);
    expect(result.users[0].username).toBe("admin");
  });

  it("computes roles from users and services", () => {
    const raw: DeploymentConfigFile = {
      users: [
        { username: "admin", password: "admin", email: "admin@test.com", roles: ["admin"] },
      ],
      services: {
        demo: { requiredRoles: ["dev"] },
      },
    };
    const result = resolveDeploymentConfig("local", raw);

    expect(result.roles).toEqual(["admin", "dev"]);
  });

  it("uses explicit roles when provided", () => {
    const raw: DeploymentConfigFile = {
      roles: ["admin", "dev", "beta"],
      services: {
        demo: { requiredRoles: ["dev"] },
      },
    };
    const result = resolveDeploymentConfig("local", raw);

    expect(result.roles).toEqual(["admin", "beta", "dev"]);
  });

  it("resolves all service fields", () => {
    const raw: DeploymentConfigFile = {
      services: {
        demo: {
          portalName: "Demo App",
          host: "demo-app",
          requiredRoles: ["dev", "admin"],
          authType: "oauth2-proxy",
          group: "Apps",
          icon: "rocket",
          description: "A demo application",
        },
      },
    };
    const result = resolveDeploymentConfig("prod", raw);

    expect(result.services[0]).toEqual({
      serviceId: "demo",
      portalName: "Demo App",
      host: "demo-app",
      authType: "oauth2-proxy",
      requiredRoles: ["dev", "admin"],
      group: "Apps",
      icon: "rocket",
      description: "A demo application",
    });
  });
});
