import { describe, it, expect } from "vitest";
import {
  normalizeRoles,
  resolveUnifiedUser,
  parseUnifiedSecretsYaml,
  parseUnifiedUsersYaml,
} from "./unified-users";

describe("normalizeRoles", () => {
  it("returns empty array for undefined", () => {
    expect(normalizeRoles(undefined)).toEqual([]);
  });

  it("wraps string in array", () => {
    expect(normalizeRoles("admin")).toEqual(["admin"]);
  });

  it("returns array as-is", () => {
    expect(normalizeRoles(["admin", "dev"])).toEqual(["admin", "dev"]);
  });
});

describe("resolveUnifiedUser", () => {
  it("applies defaults for optional fields", () => {
    const result = resolveUnifiedUser(
      { username: "admin", password: "secret" },
      "local"
    );

    expect(result).toEqual({
      username: "admin",
      password: "secret",
      email: "admin@local.local",
      firstName: "Admin",
      lastName: "User",
      roles: [],
    });
  });

  it("preserves provided optional fields", () => {
    const result = resolveUnifiedUser(
      {
        username: "dev",
        password: "secret",
        email: "dev@example.com",
        firstName: "Developer",
        lastName: "Smith",
        roles: ["dev", "viewer"],
      },
      "prod"
    );

    expect(result).toEqual({
      username: "dev",
      password: "secret",
      email: "dev@example.com",
      firstName: "Developer",
      lastName: "Smith",
      roles: ["dev", "viewer"],
    });
  });

  it("normalizes single role string to array", () => {
    const result = resolveUnifiedUser(
      { username: "admin", password: "secret", roles: "admin" },
      "local"
    );

    expect(result.roles).toEqual(["admin"]);
  });
});

describe("parseUnifiedSecretsYaml", () => {
  it("parses valid YAML", () => {
    const yaml = `
keycloakAdminUsername: admin
keycloakAdminPassword: secret
users:
  - username: admin
    password: adminpass
    roles: admin
  - username: dev
    password: devpass
`;

    const result = parseUnifiedSecretsYaml(yaml);

    expect(result.keycloakAdminUsername).toBe("admin");
    expect(result.keycloakAdminPassword).toBe("secret");
    expect(result.users).toHaveLength(2);
    expect(result.users[0].username).toBe("admin");
    expect(result.users[0].roles).toBe("admin");
    expect(result.users[1].username).toBe("dev");
    expect(result.users[1].roles).toBeUndefined();
  });

  it("throws on missing keycloakAdminUsername", () => {
    const yaml = `
keycloakAdminPassword: secret
users:
  - username: admin
    password: adminpass
`;

    expect(() => parseUnifiedSecretsYaml(yaml)).toThrow("keycloakAdminUsername");
  });

  it("throws on empty users array", () => {
    const yaml = `
keycloakAdminUsername: admin
keycloakAdminPassword: secret
users: []
`;

    expect(() => parseUnifiedSecretsYaml(yaml)).toThrow("at least one user");
  });

  it("throws on duplicate usernames", () => {
    const yaml = `
keycloakAdminUsername: admin
keycloakAdminPassword: secret
users:
  - username: admin
    password: pass1
  - username: admin
    password: pass2
`;

    expect(() => parseUnifiedSecretsYaml(yaml)).toThrow("duplicate");
  });
});

describe("parseUnifiedUsersYaml", () => {
  it("parses users array YAML", () => {
    const yaml = `
- username: admin
  password: adminpass
  roles: admin
  email: admin@example.com
- username: dev
  password: devpass
  roles:
    - dev
    - viewer
`;

    const result = parseUnifiedUsersYaml(yaml);

    expect(result).toHaveLength(2);
    expect(result[0].username).toBe("admin");
    expect(result[0].email).toBe("admin@example.com");
    expect(result[1].roles).toEqual(["dev", "viewer"]);
  });

  it("throws on invalid username format", () => {
    const yaml = `
- username: Admin
  password: pass
`;

    expect(() => parseUnifiedUsersYaml(yaml)).toThrow("valid username");
  });

  it("throws on missing password", () => {
    const yaml = `
- username: admin
`;

    expect(() => parseUnifiedUsersYaml(yaml)).toThrow("password");
  });
});
