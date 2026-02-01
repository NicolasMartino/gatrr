/**
 * Tests for protected services derivation
 */

import { describe, it, expect } from "vitest";
import {
  getProtectedServices,
  getProtectedServiceIdsFromConfig,
  buildOAuth2ProxyAllowedGroups,
  isProtectedService,
} from "./protected-services";
import { ResolvedDeploymentConfig, ResolvedServiceConfig } from "./types";

describe("getProtectedServices", () => {
  it("returns empty array when no protected services", () => {
    const config: ResolvedDeploymentConfig = {
      stackName: "local",
      roles: [],
      users: [],
      services: [
        {
          serviceId: "docs",
          portalName: "Docs",
          host: "docs",
          authType: "none",
          requiredRoles: [],
        },
      ],
    };

    const result = getProtectedServices(config);
    expect(result).toEqual([]);
  });

  it("returns protected services only (filters out none)", () => {
    const config: ResolvedDeploymentConfig = {
      stackName: "local",
      roles: ["admin", "dev"],
      users: [],
      services: [
        {
          serviceId: "demo",
          portalName: "Demo",
          host: "demo",
          authType: "oauth2-proxy",
          requiredRoles: ["admin", "dev"],
        },
        {
          serviceId: "docs",
          portalName: "Docs",
          host: "docs",
          authType: "none",
          requiredRoles: [],
        },
      ],
    };

    const result = getProtectedServices(config);
    expect(result).toHaveLength(1);
    expect(result[0].serviceId).toBe("demo");
  });

  it("filters out portal authType services", () => {
    const config: ResolvedDeploymentConfig = {
      stackName: "local",
      roles: ["admin"],
      users: [],
      services: [
        {
          serviceId: "demo",
          portalName: "Demo",
          host: "demo",
          authType: "oauth2-proxy",
          requiredRoles: ["admin"],
        },
        {
          serviceId: "internal",
          portalName: "Internal",
          host: "internal",
          authType: "portal",
          requiredRoles: ["admin"],
        },
      ],
    };

    const result = getProtectedServices(config);
    expect(result).toHaveLength(1);
    expect(result[0].serviceId).toBe("demo");
  });

  it("includes correct fields", () => {
    const config: ResolvedDeploymentConfig = {
      stackName: "local",
      roles: ["admin", "dev"],
      users: [],
      services: [
        {
          serviceId: "demo",
          portalName: "Demo App",
          host: "demo-app",
          authType: "oauth2-proxy",
          requiredRoles: ["admin", "dev"],
          group: "apps",
          icon: "rocket",
        },
      ],
    };

    const result = getProtectedServices(config);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      serviceId: "demo",
      host: "demo-app",
      requiredRoles: ["admin", "dev"],
    });
  });

  it("returns sorted by serviceId", () => {
    const config: ResolvedDeploymentConfig = {
      stackName: "local",
      roles: ["admin"],
      users: [],
      services: [
        {
          serviceId: "zebra",
          portalName: "Zebra",
          host: "zebra",
          authType: "oauth2-proxy",
          requiredRoles: ["admin"],
        },
        {
          serviceId: "alpha",
          portalName: "Alpha",
          host: "alpha",
          authType: "oauth2-proxy",
          requiredRoles: ["admin"],
        },
        {
          serviceId: "middle",
          portalName: "Middle",
          host: "middle",
          authType: "oauth2-proxy",
          requiredRoles: ["admin"],
        },
      ],
    };

    const result = getProtectedServices(config);
    expect(result.map((s) => s.serviceId)).toEqual(["alpha", "middle", "zebra"]);
  });
});

describe("getProtectedServiceIdsFromConfig", () => {
  it("returns just IDs", () => {
    const config: ResolvedDeploymentConfig = {
      stackName: "local",
      roles: ["admin"],
      users: [],
      services: [
        {
          serviceId: "demo",
          portalName: "Demo",
          host: "demo",
          authType: "oauth2-proxy",
          requiredRoles: ["admin"],
        },
        {
          serviceId: "docs",
          portalName: "Docs",
          host: "docs",
          authType: "none",
          requiredRoles: [],
        },
      ],
    };

    const result = getProtectedServiceIdsFromConfig(config);
    expect(result).toEqual(["demo"]);
  });

  it("returns sorted alphabetically", () => {
    const config: ResolvedDeploymentConfig = {
      stackName: "local",
      roles: ["admin"],
      users: [],
      services: [
        {
          serviceId: "zebra",
          portalName: "Zebra",
          host: "zebra",
          authType: "oauth2-proxy",
          requiredRoles: ["admin"],
        },
        {
          serviceId: "alpha",
          portalName: "Alpha",
          host: "alpha",
          authType: "oauth2-proxy",
          requiredRoles: ["admin"],
        },
      ],
    };

    const result = getProtectedServiceIdsFromConfig(config);
    expect(result).toEqual(["alpha", "zebra"]);
  });

  it("is deterministic", () => {
    const config: ResolvedDeploymentConfig = {
      stackName: "local",
      roles: ["admin"],
      users: [],
      services: [
        {
          serviceId: "demo",
          portalName: "Demo",
          host: "demo",
          authType: "oauth2-proxy",
          requiredRoles: ["admin"],
        },
      ],
    };

    const result1 = getProtectedServiceIdsFromConfig(config);
    const result2 = getProtectedServiceIdsFromConfig(config);
    expect(result1).toEqual(result2);
  });
});

describe("buildOAuth2ProxyAllowedGroups", () => {
  it("handles single role", () => {
    expect(buildOAuth2ProxyAllowedGroups(["admin"])).toBe("admin");
  });

  it("handles multiple roles", () => {
    expect(buildOAuth2ProxyAllowedGroups(["admin", "dev"])).toBe("admin,dev");
  });

  it("handles empty roles", () => {
    expect(buildOAuth2ProxyAllowedGroups([])).toBe("");
  });

  it("preserves role order", () => {
    expect(buildOAuth2ProxyAllowedGroups(["dev", "admin", "beta"])).toBe("dev,admin,beta");
  });
});

describe("isProtectedService", () => {
  it("returns true for oauth2-proxy services", () => {
    const service: ResolvedServiceConfig = {
      serviceId: "demo",
      portalName: "Demo",
      host: "demo",
      authType: "oauth2-proxy",
      requiredRoles: ["admin"],
    };
    expect(isProtectedService(service)).toBe(true);
  });

  it("returns false for none services", () => {
    const service: ResolvedServiceConfig = {
      serviceId: "docs",
      portalName: "Docs",
      host: "docs",
      authType: "none",
      requiredRoles: [],
    };
    expect(isProtectedService(service)).toBe(false);
  });

  it("returns false for portal services", () => {
    const service: ResolvedServiceConfig = {
      serviceId: "internal",
      portalName: "Internal",
      host: "internal",
      authType: "portal",
      requiredRoles: ["admin"],
    };
    expect(isProtectedService(service)).toBe(false);
  });
});
