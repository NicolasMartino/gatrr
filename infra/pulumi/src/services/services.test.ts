/**
 * Tests for services registry and catalog
 *
 * These tests verify:
 * - Service catalog contains expected services
 * - Catalog functions work correctly
 * - deriveAuthzPolicies extracts policies correctly
 */

import { describe, it, expect } from "vitest";
import {
  SERVICE_CATALOG,
  getAvailableServiceIds,
  getServiceFactory,
  isServiceAvailable,
  deriveAuthzPolicies,
} from "./index";
import { ServiceModuleResult } from "../types";

// =============================================================================
// SERVICE_CATALOG tests
// =============================================================================

describe("SERVICE_CATALOG", () => {
  it("has expected services", () => {
    expect(SERVICE_CATALOG.demo).toBeDefined();
    expect(SERVICE_CATALOG.docs).toBeDefined();
    expect(SERVICE_CATALOG.dozzle).toBeDefined();
  });

  it("all entries have factory functions", () => {
    for (const [id, entry] of Object.entries(SERVICE_CATALOG)) {
      expect(entry.factory).toBeDefined();
      expect(typeof entry.factory).toBe("function");
    }
  });

  it("entries have optional descriptions", () => {
    // At least some entries should have descriptions
    const hasDescriptions = Object.values(SERVICE_CATALOG).some(
      (entry) => entry.description !== undefined
    );
    expect(hasDescriptions).toBe(true);
  });
});

describe("getAvailableServiceIds", () => {
  it("returns array of service IDs", () => {
    const ids = getAvailableServiceIds();
    expect(Array.isArray(ids)).toBe(true);
    expect(ids.length).toBeGreaterThan(0);
  });

  it("includes all catalog entries", () => {
    const ids = getAvailableServiceIds();
    expect(ids).toContain("demo");
    expect(ids).toContain("docs");
    expect(ids).toContain("dozzle");
  });

  it("returns sorted array", () => {
    const ids = getAvailableServiceIds();
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });

  it("is deterministic (same result on multiple calls)", () => {
    const ids1 = getAvailableServiceIds();
    const ids2 = getAvailableServiceIds();
    expect(ids1).toEqual(ids2);
  });
});

describe("getServiceFactory", () => {
  it("returns factory for known service", () => {
    const factory = getServiceFactory("demo");
    expect(factory).toBeDefined();
    expect(typeof factory).toBe("function");
  });

  it("returns undefined for unknown service", () => {
    const factory = getServiceFactory("nonexistent");
    expect(factory).toBeUndefined();
  });

  it("returns correct factory for each service", () => {
    expect(getServiceFactory("demo")).toBe(SERVICE_CATALOG.demo.factory);
    expect(getServiceFactory("docs")).toBe(SERVICE_CATALOG.docs.factory);
    expect(getServiceFactory("dozzle")).toBe(SERVICE_CATALOG.dozzle.factory);
  });
});

describe("isServiceAvailable", () => {
  it("returns true for catalog services", () => {
    expect(isServiceAvailable("demo")).toBe(true);
    expect(isServiceAvailable("docs")).toBe(true);
    expect(isServiceAvailable("dozzle")).toBe(true);
  });

  it("returns false for unknown services", () => {
    expect(isServiceAvailable("nonexistent")).toBe(false);
    expect(isServiceAvailable("")).toBe(false);
    expect(isServiceAvailable("DEMO")).toBe(false); // Case sensitive
  });
});

// =============================================================================
// deriveAuthzPolicies tests
// =============================================================================

describe("deriveAuthzPolicies", () => {
  it("returns empty array for services without authz policies", () => {
    const services: ServiceModuleResult[] = [
      {
        id: "public",
        portal: {
          id: "public",
          name: "Public",
          url: "http://public.localhost",
          protected: false,
          authType: "none",
        },
        routes: [],
        resources: { container: {} as any },
      },
    ];

    const policies = deriveAuthzPolicies(services);
    expect(policies).toEqual([]);
  });

  it("extracts authz policies from protected services", () => {
    const services: ServiceModuleResult[] = [
      {
        id: "demo",
        portal: {
          id: "demo",
          name: "Demo",
          url: "http://demo.localhost",
          protected: true,
          authType: "oauth2-proxy",
        },
        routes: [],
        oauth2ProxyAuthz: { requiredRealmRoles: ["demo"] },
        resources: { container: {} as any },
      },
    ];

    const policies = deriveAuthzPolicies(services);
    expect(policies).toHaveLength(1);
    expect(policies[0].serviceId).toBe("demo");
    expect(policies[0].policy.requiredRealmRoles).toEqual(["demo"]);
  });

  it("extracts policies from multiple protected services", () => {
    const services: ServiceModuleResult[] = [
      {
        id: "demo",
        portal: {
          id: "demo",
          name: "Demo",
          url: "http://demo.localhost",
          protected: true,
          authType: "oauth2-proxy",
        },
        routes: [],
        oauth2ProxyAuthz: { requiredRealmRoles: ["demo"] },
        resources: { container: {} as any },
      },
      {
        id: "admin",
        portal: {
          id: "admin",
          name: "Admin",
          url: "http://admin.localhost",
          protected: true,
          authType: "oauth2-proxy",
        },
        routes: [],
        oauth2ProxyAuthz: { requiredRealmRoles: ["admin", "ops"] },
        resources: { container: {} as any },
      },
      {
        id: "docs",
        portal: {
          id: "docs",
          name: "Docs",
          url: "http://docs.localhost",
          protected: false,
          authType: "none",
        },
        routes: [],
        resources: { container: {} as any },
      },
    ];

    const policies = deriveAuthzPolicies(services);
    expect(policies).toHaveLength(2);
    expect(policies.map((p) => p.serviceId)).toEqual(["admin", "demo"]); // Sorted
  });

  it("returns sorted array for determinism", () => {
    const services: ServiceModuleResult[] = [
      {
        id: "z-service",
        portal: {
          id: "z-service",
          name: "Z",
          url: "http://z.localhost",
          protected: true,
          authType: "oauth2-proxy",
        },
        routes: [],
        oauth2ProxyAuthz: { requiredRealmRoles: ["z"] },
        resources: { container: {} as any },
      },
      {
        id: "a-service",
        portal: {
          id: "a-service",
          name: "A",
          url: "http://a.localhost",
          protected: true,
          authType: "oauth2-proxy",
        },
        routes: [],
        oauth2ProxyAuthz: { requiredRealmRoles: ["a"] },
        resources: { container: {} as any },
      },
    ];

    const policies = deriveAuthzPolicies(services);
    expect(policies.map((p) => p.serviceId)).toEqual(["a-service", "z-service"]);
  });
});
