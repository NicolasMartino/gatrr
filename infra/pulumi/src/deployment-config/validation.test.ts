/**
 * Tests for deployment configuration validation
 */

import { describe, it, expect } from "vitest";
import {
  validateServiceExists,
  validateServiceIdFormat,
  validateHostFormat,
  validateNotReservedHost,
  validateAuthTypeRolesConsistency,
  validateRolesInAllowList,
  validateUsersLocalOnly,
  validateUserConfig,
  validateRoleFormat,
  validateDeploymentConfig,
  assertValidDeploymentConfig,
  validateUserPasswords,
  assertUserPasswordsProvided,
} from "./validation";
import { ResolvedDeploymentConfig, UserConfig } from "./types";

describe("validateServiceExists", () => {
  const catalog = ["demo", "docs", "dozzle"];

  it("passes for valid service ID", () => {
    expect(validateServiceExists("demo", catalog)).toBeNull();
    expect(validateServiceExists("docs", catalog)).toBeNull();
  });

  it("fails for unknown service ID", () => {
    const error = validateServiceExists("unknown", catalog);
    expect(error).not.toBeNull();
    expect(error!.code).toBe("UNKNOWN_SERVICE");
    expect(error!.message).toContain("unknown");
    expect(error!.message).toContain("demo, docs, dozzle");
  });

  it("fails with empty catalog", () => {
    const error = validateServiceExists("demo", []);
    expect(error).not.toBeNull();
    expect(error!.message).toContain("(none)");
  });
});

describe("validateServiceIdFormat", () => {
  it("passes for valid slugs", () => {
    expect(validateServiceIdFormat("demo")).toBeNull();
    expect(validateServiceIdFormat("my-service")).toBeNull();
    expect(validateServiceIdFormat("api-v2")).toBeNull();
  });

  it("fails for uppercase", () => {
    const error = validateServiceIdFormat("Demo");
    expect(error).not.toBeNull();
    expect(error!.code).toBe("INVALID_SERVICE_ID");
  });

  it("fails for underscore", () => {
    const error = validateServiceIdFormat("my_service");
    expect(error).not.toBeNull();
  });

  it("fails for leading hyphen", () => {
    const error = validateServiceIdFormat("-start");
    expect(error).not.toBeNull();
  });

  it("fails for trailing hyphen", () => {
    const error = validateServiceIdFormat("end-");
    expect(error).not.toBeNull();
  });

  it("fails for leading number", () => {
    const error = validateServiceIdFormat("123service");
    expect(error).not.toBeNull();
  });
});

describe("validateHostFormat", () => {
  it("passes for valid hosts", () => {
    expect(validateHostFormat("demo", "demo")).toBeNull();
    expect(validateHostFormat("my-app", "demo")).toBeNull();
  });

  it("fails for invalid hosts", () => {
    const error = validateHostFormat("My-App", "demo");
    expect(error).not.toBeNull();
    expect(error!.code).toBe("INVALID_HOST");
    expect(error!.path).toBe("services.demo.host");
  });
});

describe("validateNotReservedHost", () => {
  it("passes for non-reserved hosts", () => {
    expect(validateNotReservedHost("demo", "demo")).toBeNull();
    expect(validateNotReservedHost("api", "api")).toBeNull();
  });

  it("fails for portal", () => {
    const error = validateNotReservedHost("portal", "my-portal");
    expect(error).not.toBeNull();
    expect(error!.code).toBe("RESERVED_HOST");
    expect(error!.message).toContain("portal");
  });

  it("fails for keycloak", () => {
    const error = validateNotReservedHost("keycloak", "my-keycloak");
    expect(error).not.toBeNull();
    expect(error!.code).toBe("RESERVED_HOST");
  });
});

describe("validateAuthTypeRolesConsistency", () => {
  it("passes: none + no roles", () => {
    expect(validateAuthTypeRolesConsistency("none", [], "demo")).toBeNull();
  });

  it("fails: none + roles", () => {
    const error = validateAuthTypeRolesConsistency("none", ["admin"], "demo");
    expect(error).not.toBeNull();
    expect(error!.code).toBe("AUTH_NONE_WITH_ROLES");
    expect(error!.message).toContain("demo");
    expect(error!.message).toContain("admin");
  });

  it("passes: oauth2-proxy + roles", () => {
    expect(validateAuthTypeRolesConsistency("oauth2-proxy", ["admin"], "demo")).toBeNull();
  });

  it("fails: oauth2-proxy + no roles", () => {
    const error = validateAuthTypeRolesConsistency("oauth2-proxy", [], "demo");
    expect(error).not.toBeNull();
    expect(error!.code).toBe("OAUTH2_PROXY_WITHOUT_ROLES");
  });

  it("passes: portal + roles", () => {
    expect(validateAuthTypeRolesConsistency("portal", ["admin"], "demo")).toBeNull();
  });

  it("fails: portal + no roles", () => {
    const error = validateAuthTypeRolesConsistency("portal", [], "demo");
    expect(error).not.toBeNull();
    expect(error!.code).toBe("PORTAL_WITHOUT_ROLES");
  });
});

describe("validateRolesInAllowList", () => {
  const allowList = ["admin", "dev"];

  it("passes when all roles in list", () => {
    const errors = validateRolesInAllowList(["admin"], allowList, "user admin", "users[0].roles");
    expect(errors).toHaveLength(0);
  });

  it("fails when role not in list", () => {
    const errors = validateRolesInAllowList(["superadmin"], allowList, "user admin", "users[0].roles");
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe("ROLE_NOT_IN_ALLOWLIST");
    expect(errors[0].message).toContain("superadmin");
    expect(errors[0].message).toContain("user admin");
  });

  it("reports multiple missing roles", () => {
    const errors = validateRolesInAllowList(["super", "ultra"], allowList, "service demo", "services.demo.requiredRoles");
    expect(errors).toHaveLength(2);
  });

  it("passes with empty referenced roles", () => {
    const errors = validateRolesInAllowList([], allowList, "service demo", "services.demo.requiredRoles");
    expect(errors).toHaveLength(0);
  });
});

describe("validateUsersLocalOnly", () => {
  const users: UserConfig[] = [
    { username: "admin", email: "admin@test.com", roles: ["admin"] },
  ];

  it("passes: local stack + users", () => {
    expect(validateUsersLocalOnly(users, "local")).toBeNull();
  });

  it("passes: local stack + no users", () => {
    expect(validateUsersLocalOnly([], "local")).toBeNull();
  });

  it("fails: prod stack + users", () => {
    const error = validateUsersLocalOnly(users, "prod");
    expect(error).not.toBeNull();
    expect(error!.code).toBe("USERS_NOT_LOCAL");
    expect(error!.message).toContain("prod");
  });

  it("passes: prod stack + no users", () => {
    expect(validateUsersLocalOnly([], "prod")).toBeNull();
  });

  it("fails: staging stack + users", () => {
    const error = validateUsersLocalOnly(users, "staging");
    expect(error).not.toBeNull();
  });
});

describe("validateUserConfig", () => {
  it("passes for valid user", () => {
    const user: UserConfig = {
      username: "admin",
      email: "admin@test.com",
      roles: ["admin"],
    };
    const errors = validateUserConfig(user, 0);
    expect(errors).toHaveLength(0);
  });

  it("fails for invalid username", () => {
    const user: UserConfig = {
      username: "Admin",
      email: "admin@test.com",
      roles: ["admin"],
    };
    const errors = validateUserConfig(user, 0);
    expect(errors.some((e) => e.code === "INVALID_USERNAME")).toBe(true);
  });

  it("fails for invalid email", () => {
    const user: UserConfig = {
      username: "admin",
      email: "invalid-email",
      roles: ["admin"],
    };
    const errors = validateUserConfig(user, 0);
    expect(errors.some((e) => e.code === "INVALID_EMAIL")).toBe(true);
  });

  it("fails for empty roles", () => {
    const user: UserConfig = {
      username: "admin",
      email: "admin@test.com",
      roles: [],
    };
    const errors = validateUserConfig(user, 0);
    expect(errors.some((e) => e.code === "USER_NO_ROLES")).toBe(true);
  });

  it("fails for invalid role format", () => {
    const user: UserConfig = {
      username: "admin",
      email: "admin@test.com",
      roles: ["Admin"],
    };
    const errors = validateUserConfig(user, 0);
    expect(errors.some((e) => e.code === "INVALID_ROLE_FORMAT")).toBe(true);
  });
});

describe("validateRoleFormat", () => {
  it("passes for valid role", () => {
    expect(validateRoleFormat("admin", 0)).toBeNull();
    expect(validateRoleFormat("power-user", 1)).toBeNull();
  });

  it("fails for invalid role", () => {
    const error = validateRoleFormat("Admin", 0);
    expect(error).not.toBeNull();
    expect(error!.code).toBe("INVALID_ROLE_FORMAT");
  });
});

describe("validateDeploymentConfig", () => {
  const catalog = ["demo", "docs", "dozzle"];

  it("passes for valid config", () => {
    const config: ResolvedDeploymentConfig = {
      stackName: "local",
      roles: ["admin", "dev"],
      users: [
        { username: "admin", email: "admin@test.com", roles: ["admin"] },
      ],
      services: [
        {
          serviceId: "demo",
          portalName: "Demo",
          host: "demo",
          authType: "oauth2-proxy",
          requiredRoles: ["dev"],
        },
      ],
    };
    const result = validateDeploymentConfig(config, catalog);
    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error("Expected valid result");
    expect(result.config).toBeDefined();
  });

  it("collects multiple errors", () => {
    const config: ResolvedDeploymentConfig = {
      stackName: "prod",
      roles: ["admin"],
      users: [
        { username: "admin", email: "admin@test.com", roles: ["admin"] },
      ],
      services: [
        {
          serviceId: "unknown",
          portalName: "Unknown",
          host: "portal", // reserved
          authType: "none",
          requiredRoles: ["admin"], // conflict with none
        },
      ],
    };
    const result = validateDeploymentConfig(config, catalog);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(1);
  });

  it("detects duplicate hosts", () => {
    const config: ResolvedDeploymentConfig = {
      stackName: "local",
      roles: [],
      users: [],
      services: [
        {
          serviceId: "demo",
          portalName: "Demo",
          host: "app",
          authType: "none",
          requiredRoles: [],
        },
        {
          serviceId: "docs",
          portalName: "Docs",
          host: "app", // duplicate
          authType: "none",
          requiredRoles: [],
        },
      ],
    };
    const result = validateDeploymentConfig(config, catalog);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === "DUPLICATE_HOST")).toBe(true);
  });

  it("validates role allow-list when explicit", () => {
    const config: ResolvedDeploymentConfig = {
      stackName: "local",
      roles: ["admin"], // explicit allow-list
      users: [],
      services: [
        {
          serviceId: "demo",
          portalName: "Demo",
          host: "demo",
          authType: "oauth2-proxy",
          requiredRoles: ["superadmin"], // not in allow-list
        },
      ],
    };
    const result = validateDeploymentConfig(config, catalog);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === "ROLE_NOT_IN_ALLOWLIST")).toBe(true);
  });
});

describe("assertValidDeploymentConfig", () => {
  const catalog = ["demo", "docs"];

  it("does not throw for valid config", () => {
    const config: ResolvedDeploymentConfig = {
      stackName: "local",
      roles: [],
      users: [],
      services: [
        {
          serviceId: "demo",
          portalName: "Demo",
          host: "demo",
          authType: "none",
          requiredRoles: [],
        },
      ],
    };
    expect(() => assertValidDeploymentConfig(config, catalog)).not.toThrow();
  });

  it("throws with all errors for invalid config", () => {
    const config: ResolvedDeploymentConfig = {
      stackName: "local",
      roles: [],
      users: [],
      services: [
        {
          serviceId: "unknown",
          portalName: "Unknown",
          host: "portal",
          authType: "none",
          requiredRoles: [],
        },
      ],
    };
    expect(() => assertValidDeploymentConfig(config, catalog)).toThrow(
      /Deployment configuration validation failed/
    );
  });
});

describe("validateUserPasswords", () => {
  it("passes when all users have passwords", () => {
    const users: UserConfig[] = [
      { username: "admin", email: "admin@test.com", roles: ["admin"] },
      { username: "dev", email: "dev@test.com", roles: ["dev"] },
    ];
    const passwords = { admin: "admin-pass", dev: "dev-pass" };
    const errors = validateUserPasswords(users, passwords);
    expect(errors).toHaveLength(0);
  });

  it("fails when user is missing password", () => {
    const users: UserConfig[] = [
      { username: "admin", email: "admin@test.com", roles: ["admin"] },
      { username: "dev", email: "dev@test.com", roles: ["dev"] },
    ];
    const passwords = { admin: "admin-pass" }; // missing dev
    const errors = validateUserPasswords(users, passwords);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe("MISSING_USER_PASSWORD");
    expect(errors[0].message).toContain("dev");
    expect(errors[0].message).toContain("pulumi config set --secret");
  });

  it("fails when password is empty string", () => {
    const users: UserConfig[] = [
      { username: "admin", email: "admin@test.com", roles: ["admin"] },
    ];
    const passwords = { admin: "" };
    const errors = validateUserPasswords(users, passwords);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe("MISSING_USER_PASSWORD");
  });

  it("fails when password is undefined", () => {
    const users: UserConfig[] = [
      { username: "admin", email: "admin@test.com", roles: ["admin"] },
    ];
    const passwords: Record<string, string | undefined> = { admin: undefined };
    const errors = validateUserPasswords(users, passwords);
    expect(errors).toHaveLength(1);
  });

  it("passes with no users", () => {
    const errors = validateUserPasswords([], {});
    expect(errors).toHaveLength(0);
  });
});

describe("assertUserPasswordsProvided", () => {
  it("does not throw when all passwords provided", () => {
    const users: UserConfig[] = [
      { username: "admin", email: "admin@test.com", roles: ["admin"] },
    ];
    const passwords = { admin: "admin-pass" };
    expect(() => assertUserPasswordsProvided(users, passwords)).not.toThrow();
  });

  it("throws when password is missing", () => {
    const users: UserConfig[] = [
      { username: "admin", email: "admin@test.com", roles: ["admin"] },
    ];
    const passwords: Record<string, string | undefined> = {};
    expect(() => assertUserPasswordsProvided(users, passwords)).toThrow(
      /Missing user passwords/
    );
  });
});
