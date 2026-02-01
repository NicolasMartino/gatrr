/**
 * Tests for deployment configuration types and validators
 */

import { describe, it, expect } from "vitest";
import {
  isValidServiceId,
  isValidHost,
  isValidRole,
  isValidUsername,
  isValidEmail,
  isValidAuthType,
  isReservedHost,
  RESERVED_HOSTS,
} from "./types";

describe("isValidServiceId", () => {
  it("accepts valid service IDs", () => {
    expect(isValidServiceId("demo")).toBe(true);
    expect(isValidServiceId("my-service")).toBe(true);
    expect(isValidServiceId("api2")).toBe(true);
    expect(isValidServiceId("a")).toBe(true);
    expect(isValidServiceId("service-with-many-parts")).toBe(true);
  });

  it("rejects empty strings", () => {
    expect(isValidServiceId("")).toBe(false);
  });

  it("rejects IDs starting with numbers", () => {
    expect(isValidServiceId("123service")).toBe(false);
    expect(isValidServiceId("2fast")).toBe(false);
  });

  it("rejects IDs starting with hyphens", () => {
    expect(isValidServiceId("-service")).toBe(false);
  });

  it("rejects IDs ending with hyphens", () => {
    expect(isValidServiceId("service-")).toBe(false);
  });

  it("rejects IDs with uppercase letters", () => {
    expect(isValidServiceId("Demo")).toBe(false);
    expect(isValidServiceId("myService")).toBe(false);
    expect(isValidServiceId("MY-SERVICE")).toBe(false);
  });

  it("rejects IDs with underscores", () => {
    expect(isValidServiceId("my_service")).toBe(false);
  });

  it("rejects IDs with spaces", () => {
    expect(isValidServiceId("my service")).toBe(false);
  });

  it("rejects IDs with special characters", () => {
    expect(isValidServiceId("my.service")).toBe(false);
    expect(isValidServiceId("my@service")).toBe(false);
    expect(isValidServiceId("my/service")).toBe(false);
  });
});

describe("isValidHost", () => {
  it("accepts valid hosts", () => {
    expect(isValidHost("demo")).toBe(true);
    expect(isValidHost("my-app")).toBe(true);
    expect(isValidHost("api2")).toBe(true);
  });

  it("rejects empty strings", () => {
    expect(isValidHost("")).toBe(false);
  });

  it("rejects hosts starting with numbers", () => {
    expect(isValidHost("123host")).toBe(false);
  });

  it("rejects hosts ending with hyphens", () => {
    expect(isValidHost("host-")).toBe(false);
  });

  it("rejects hosts with uppercase letters", () => {
    expect(isValidHost("MyHost")).toBe(false);
  });
});

describe("isReservedHost", () => {
  it("identifies reserved hosts", () => {
    expect(isReservedHost("portal")).toBe(true);
    expect(isReservedHost("keycloak")).toBe(true);
  });

  it("allows non-reserved hosts", () => {
    expect(isReservedHost("demo")).toBe(false);
    expect(isReservedHost("api")).toBe(false);
    expect(isReservedHost("my-service")).toBe(false);
  });

  it("exports RESERVED_HOSTS constant", () => {
    expect(RESERVED_HOSTS).toContain("portal");
    expect(RESERVED_HOSTS).toContain("keycloak");
    expect(RESERVED_HOSTS.length).toBe(2);
  });
});

describe("isValidRole", () => {
  it("accepts valid roles", () => {
    expect(isValidRole("admin")).toBe(true);
    expect(isValidRole("dev")).toBe(true);
    expect(isValidRole("power-user")).toBe(true);
    expect(isValidRole("role2")).toBe(true);
  });

  it("rejects empty strings", () => {
    expect(isValidRole("")).toBe(false);
  });

  it("rejects roles starting with numbers", () => {
    expect(isValidRole("123role")).toBe(false);
  });

  it("rejects roles ending with hyphens", () => {
    expect(isValidRole("role-")).toBe(false);
  });

  it("rejects roles with uppercase letters", () => {
    expect(isValidRole("Admin")).toBe(false);
    expect(isValidRole("ADMIN")).toBe(false);
  });
});

describe("isValidUsername", () => {
  it("accepts valid usernames", () => {
    expect(isValidUsername("admin")).toBe(true);
    expect(isValidUsername("dev")).toBe(true);
    expect(isValidUsername("test-user")).toBe(true);
  });

  it("rejects empty strings", () => {
    expect(isValidUsername("")).toBe(false);
  });

  it("rejects usernames starting with numbers", () => {
    expect(isValidUsername("123user")).toBe(false);
  });

  it("rejects usernames with uppercase letters", () => {
    expect(isValidUsername("Admin")).toBe(false);
  });
});

describe("isValidEmail", () => {
  it("accepts valid emails", () => {
    expect(isValidEmail("user@example.com")).toBe(true);
    expect(isValidEmail("admin@test.org")).toBe(true);
    expect(isValidEmail("dev@localhost.local")).toBe(true);
  });

  it("rejects empty strings", () => {
    expect(isValidEmail("")).toBe(false);
  });

  it("rejects emails without @", () => {
    expect(isValidEmail("userexample.com")).toBe(false);
  });

  it("rejects emails without domain", () => {
    expect(isValidEmail("user@")).toBe(false);
  });

  it("rejects emails without TLD", () => {
    expect(isValidEmail("user@example")).toBe(false);
  });

  it("rejects emails with spaces", () => {
    expect(isValidEmail("user @example.com")).toBe(false);
    expect(isValidEmail("user@ example.com")).toBe(false);
  });
});

describe("isValidAuthType", () => {
  it("accepts valid auth types", () => {
    expect(isValidAuthType("oauth2-proxy")).toBe(true);
    expect(isValidAuthType("portal")).toBe(true);
    expect(isValidAuthType("none")).toBe(true);
  });

  it("rejects invalid auth types", () => {
    expect(isValidAuthType("")).toBe(false);
    expect(isValidAuthType("basic")).toBe(false);
    expect(isValidAuthType("oauth")).toBe(false);
    expect(isValidAuthType("NONE")).toBe(false);
  });
});
