/**
 * Tests for descriptor generation
 *
 * These tests verify:
 * - Deterministic ordering (group/name sort)
 * - Deterministic JSON output (stable field shapes)
 * - URL + authType mapping correctness
 */

import { describe, it, expect } from "vitest";
import {
  generateDescriptor,
  sortPortalServices,
  serializeDescriptor,
  PortalDescriptor,
} from "./index";
import { DeploymentConfig } from "../config";
import { PortalService } from "../types";

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

describe("generateDescriptor", () => {
  it("generates correct structure with empty services", () => {
    const descriptor = generateDescriptor(testConfig, []);

    expect(descriptor.version).toBe("1");
    expect(descriptor.deploymentId).toBe("local");
    expect(descriptor.environment).toBe("dev");
    expect(descriptor.baseDomain).toBe("localhost");
    expect(descriptor.portal.publicUrl).toBe("http://portal.localhost");
    expect(descriptor.keycloak.publicUrl).toBe("http://keycloak.localhost");
    expect(descriptor.keycloak.issuerUrl).toBe(
      "http://keycloak.localhost/realms/dev"
    );
    expect(descriptor.keycloak.realm).toBe("dev");
    expect(descriptor.services).toEqual([]);
  });

  it("generates HTTPS URLs when useHttps is true", () => {
    const descriptor = generateDescriptor(testConfigHttps, []);

    expect(descriptor.portal.publicUrl).toBe("https://portal.example.com");
    expect(descriptor.keycloak.publicUrl).toBe("https://keycloak.example.com");
    expect(descriptor.keycloak.issuerUrl).toBe(
      "https://keycloak.example.com/realms/dev"
    );
  });

  it("includes services correctly", () => {
    const services: PortalService[] = [
      {
        id: "demo",
        name: "Demo App",
        url: "http://demo.localhost",
        protected: true,
        authType: "oauth2-proxy",
        icon: "rocket",
        description: "Demo application",
        requiredRealmRoles: ["admin", "dev"],
      },
    ];

    const descriptor = generateDescriptor(testConfig, services);

    expect(descriptor.services).toHaveLength(1);
    expect(descriptor.services[0]).toEqual({
      id: "demo",
      name: "Demo App",
      url: "http://demo.localhost",
      protected: true,
      authType: "oauth2-proxy",
      icon: "rocket",
      description: "Demo application",
      requiredRealmRoles: ["admin", "dev"],
    });
  });

  it("preserves protected=false for authType=none", () => {
    const services: PortalService[] = [
      {
        id: "docs",
        name: "Documentation",
        url: "http://docs.localhost",
        protected: false,
        authType: "none",
      },
    ];

    const descriptor = generateDescriptor(testConfig, services);

    expect(descriptor.services[0].protected).toBe(false);
    expect(descriptor.services[0].authType).toBe("none");
  });

  it("preserves protected=true for authType=portal", () => {
    const services: PortalService[] = [
      {
        id: "admin",
        name: "Admin Panel",
        url: "http://admin.localhost",
        protected: true,
        authType: "portal",
        requiredRealmRoles: ["admin"],
      },
    ];

    const descriptor = generateDescriptor(testConfig, services);

    expect(descriptor.services[0].protected).toBe(true);
    expect(descriptor.services[0].authType).toBe("portal");
  });

  it("omits optional fields when not present", () => {
    const services: PortalService[] = [
      {
        id: "minimal",
        name: "Minimal Service",
        url: "http://minimal.localhost",
        protected: false,
        authType: "none",
      },
    ];

    const descriptor = generateDescriptor(testConfig, services);
    const service = descriptor.services[0];

    expect(service).not.toHaveProperty("group");
    expect(service).not.toHaveProperty("icon");
    expect(service).not.toHaveProperty("description");
  });

  it("includes optional fields when present", () => {
    const services: PortalService[] = [
      {
        id: "full",
        name: "Full Service",
        url: "http://full.localhost",
        protected: true,
        authType: "oauth2-proxy",
        group: "apps",
        icon: "star",
        description: "A fully configured service",
        requiredRealmRoles: ["admin"],
      },
    ];

    const descriptor = generateDescriptor(testConfig, services);
    const service = descriptor.services[0];

    expect(service.group).toBe("apps");
    expect(service.icon).toBe("star");
    expect(service.description).toBe("A fully configured service");
    expect(service.requiredRealmRoles).toEqual(["admin"]);
  });
});

describe("generateDescriptor schema validation", () => {
  // Schema validation tests - JSON Schema is the single source of truth
  // These tests verify that invalid descriptors are rejected by Ajv

  it("throws on invalid protected/authType mismatch", () => {
    const services: PortalService[] = [
      { id: "bad", name: "Bad", url: "http://bad.localhost", protected: false, authType: "oauth2-proxy", requiredRealmRoles: ["dev"] },
    ];

    expect(() => generateDescriptor(testConfig, services)).toThrow("schema validation failed");
  });

  it("throws on missing requiredRealmRoles for oauth2-proxy", () => {
    const services: PortalService[] = [
      { id: "bad", name: "Bad", url: "http://bad.localhost", protected: true, authType: "oauth2-proxy" },
    ];

    expect(() => generateDescriptor(testConfig, services)).toThrow("schema validation failed");
  });

  it("throws on protected=true with authType=none", () => {
    const services: PortalService[] = [
      { id: "bad", name: "Bad", url: "http://bad.localhost", protected: true, authType: "none" },
    ];

    expect(() => generateDescriptor(testConfig, services)).toThrow("schema validation failed");
  });

  it("throws on missing requiredRealmRoles for portal-auth", () => {
    const services: PortalService[] = [
      { id: "bad", name: "Bad", url: "http://bad.localhost", protected: true, authType: "portal" },
    ];

    expect(() => generateDescriptor(testConfig, services)).toThrow("schema validation failed");
  });

  it("accepts valid services", () => {
    const services: PortalService[] = [
      { id: "demo", name: "Demo", url: "http://demo.localhost", protected: true, authType: "oauth2-proxy", requiredRealmRoles: ["dev"] },
      { id: "docs", name: "Docs", url: "http://docs.localhost", protected: false, authType: "none" },
      { id: "admin", name: "Admin", url: "http://admin.localhost", protected: true, authType: "portal", requiredRealmRoles: ["admin"] },
    ];

    // Should not throw
    expect(() => generateDescriptor(testConfig, services)).not.toThrow();
  });
});

describe("sortPortalServices", () => {
  it("sorts by group alphabetically", () => {
    const services: PortalService[] = [
      { id: "c", name: "C", url: "http://c.localhost", protected: false, authType: "none", group: "z" },
      { id: "a", name: "A", url: "http://a.localhost", protected: false, authType: "none", group: "a" },
      { id: "b", name: "B", url: "http://b.localhost", protected: false, authType: "none", group: "m" },
    ];

    const sorted = sortPortalServices(services);

    expect(sorted.map((s) => s.group)).toEqual(["a", "m", "z"]);
  });

  it("sorts by name within same group", () => {
    const services: PortalService[] = [
      {
        id: "c",
        name: "Zebra",
        url: "http://c.localhost",
        protected: false,
        authType: "none",
        group: "animals",
      },
      {
        id: "a",
        name: "Ant",
        url: "http://a.localhost",
        protected: false,
        authType: "none",
        group: "animals",
      },
      {
        id: "b",
        name: "Bear",
        url: "http://b.localhost",
        protected: false,
        authType: "none",
        group: "animals",
      },
    ];

    const sorted = sortPortalServices(services);

    expect(sorted.map((s) => s.name)).toEqual(["Ant", "Bear", "Zebra"]);
  });

  it("places services without group last", () => {
    const services: PortalService[] = [
      { id: "no-group", name: "No Group", url: "http://x.localhost", protected: false, authType: "none" },
      {
        id: "has-group",
        name: "Has Group",
        url: "http://y.localhost",
        protected: false,
        authType: "none",
        group: "apps",
      },
    ];

    const sorted = sortPortalServices(services);

    expect(sorted[0].id).toBe("has-group");
    expect(sorted[1].id).toBe("no-group");
  });

  it("produces deterministic output for same input", () => {
    const services: PortalService[] = [
      {
        id: "b",
        name: "Beta",
        url: "http://b.localhost",
        protected: false,
        authType: "none",
        group: "greek",
      },
      {
        id: "a",
        name: "Alpha",
        url: "http://a.localhost",
        protected: false,
        authType: "none",
        group: "greek",
      },
      {
        id: "g",
        name: "Gamma",
        url: "http://g.localhost",
        protected: false,
        authType: "none",
        group: "greek",
      },
    ];

    // Sort multiple times
    const sorted1 = sortPortalServices(services);
    const sorted2 = sortPortalServices(services);
    const sorted3 = sortPortalServices([...services].reverse());

    // All should produce same order
    expect(sorted1.map((s) => s.id)).toEqual(["a", "b", "g"]);
    expect(sorted2.map((s) => s.id)).toEqual(["a", "b", "g"]);
    expect(sorted3.map((s) => s.id)).toEqual(["a", "b", "g"]);
  });

  it("does not mutate original array", () => {
    const services: PortalService[] = [
      { id: "b", name: "B", url: "http://b.localhost", protected: false, authType: "none" },
      { id: "a", name: "A", url: "http://a.localhost", protected: false, authType: "none" },
    ];

    const originalOrder = services.map((s) => s.id);
    sortPortalServices(services);

    expect(services.map((s) => s.id)).toEqual(originalOrder);
  });
});

describe("serializeDescriptor", () => {
  it("produces valid JSON", () => {
    const descriptor = generateDescriptor(testConfig, []);
    const json = serializeDescriptor(descriptor);

    expect(() => { JSON.parse(json); }).not.toThrow();
  });

  it("produces deterministic output", () => {
    const services: PortalService[] = [
      {
        id: "demo",
        name: "Demo",
        url: "http://demo.localhost",
        protected: true,
        authType: "oauth2-proxy",
        icon: "rocket",
        requiredRealmRoles: ["admin", "dev"],
      },
    ];

    const descriptor1 = generateDescriptor(testConfig, services);
    const descriptor2 = generateDescriptor(testConfig, services);

    const json1 = serializeDescriptor(descriptor1);
    const json2 = serializeDescriptor(descriptor2);

    expect(json1).toBe(json2);
  });

  it("uses 2-space indentation", () => {
    const descriptor = generateDescriptor(testConfig, []);
    const json = serializeDescriptor(descriptor);

    // Check that it has proper indentation
    expect(json).toContain('  "version"');
    expect(json).toContain('  "portal"');
  });
});

describe("integration: full descriptor generation", () => {
  it("generates a complete, valid descriptor", () => {
    const services: PortalService[] = [
      {
        id: "demo",
        name: "Demo App",
        url: "https://demo.example.com",
        protected: true,
        authType: "oauth2-proxy",
        group: "apps",
        icon: "rocket",
        description: "Demo application",
        requiredRealmRoles: ["admin", "dev"],
      },
      {
        id: "docs",
        name: "Documentation",
        url: "https://docs.example.com",
        protected: false,
        authType: "none",
        group: "docs",
        icon: "book",
      },
      {
        id: "api",
        name: "API Gateway",
        url: "https://api.example.com",
        protected: true,
        authType: "portal",
        group: "apps",
        icon: "server",
        description: "Main API",
        requiredRealmRoles: ["admin", "dev"],
      },
    ];

    const descriptor = generateDescriptor(testConfigHttps, services);
    const json = serializeDescriptor(descriptor);
    const parsed = JSON.parse(json) as PortalDescriptor;

    // Verify structure
    expect(parsed.version).toBe("1");
    expect(parsed.deploymentId).toBe("prod");
    expect(parsed.environment).toBe("prod");
    expect(parsed.baseDomain).toBe("example.com");

    // Verify URLs are HTTPS
    expect(parsed.portal.publicUrl).toBe("https://portal.example.com");
    expect(parsed.keycloak.publicUrl).toBe("https://keycloak.example.com");

    // Verify services are sorted (apps group first, then docs)
    // Within apps: API Gateway, Demo App (alphabetical by name)
    expect(parsed.services.map((s) => s.id)).toEqual(["api", "demo", "docs"]);

    // Verify protected flags match authType
    const apiService = parsed.services.find((s) => s.id === "api");
    const demoService = parsed.services.find((s) => s.id === "demo");
    const docsService = parsed.services.find((s) => s.id === "docs");
    if (!apiService || !demoService || !docsService) {
      throw new Error("Expected services not found");
    }

    expect(apiService.protected).toBe(true);
    expect(apiService.authType).toBe("portal");

    expect(demoService.protected).toBe(true);
    expect(demoService.authType).toBe("oauth2-proxy");
    expect(demoService.requiredRealmRoles).toEqual(["admin", "dev"]);

    expect(docsService.protected).toBe(false);
    expect(docsService.authType).toBe("none");
    expect(docsService.requiredRealmRoles).toBeUndefined();
  });
});
