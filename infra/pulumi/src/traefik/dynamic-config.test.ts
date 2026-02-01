/**
 * Tests for Traefik dynamic config generation
 *
 * These tests verify:
 * - Routers exist for portal, keycloak, and each service
 * - Routes are generated from RouteRequest[]
 * - TLS configuration when useHttps=true
 * - Deterministic output ordering
 * - Validation of route requests
 */

import { describe, it, expect } from "vitest";
import {
  generateTraefikConfig,
  serializeTraefikConfig,
  validateRouteRequests,
} from "./dynamic-config";
import { DeploymentConfig } from "../config";
import { RouteRequest } from "../types";

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

describe("generateTraefikConfig", () => {
  it("generates portal and keycloak routers with empty routes", () => {
    const config = generateTraefikConfig(testConfig, []);

    expect(config.http.routers).toHaveProperty("core-portal");
    expect(config.http.routers).toHaveProperty("core-keycloak");
    expect(config.http.services).toHaveProperty("core-portal");
    expect(config.http.services).toHaveProperty("core-keycloak");
  });

  it("generates correct portal router", () => {
    const config = generateTraefikConfig(testConfig, []);

    expect(config.http.routers["core-portal"]).toEqual({
      rule: "Host(`portal.localhost`)",
      service: "core-portal",
      entryPoints: ["web"],
    });
  });

  it("generates correct keycloak router", () => {
    const config = generateTraefikConfig(testConfig, []);

    expect(config.http.routers["core-keycloak"]).toEqual({
      rule: "Host(`keycloak.localhost`)",
      service: "core-keycloak",
      entryPoints: ["web"],
    });
  });

  it("generates correct portal service pointing to container", () => {
    const config = generateTraefikConfig(testConfig, []);

    expect(config.http.services["core-portal"]).toEqual({
      loadBalancer: {
        servers: [{ url: "http://local-gatrr-portal:3000" }],
      },
    });
  });

  it("generates correct keycloak service pointing to container", () => {
    const config = generateTraefikConfig(testConfig, []);

    expect(config.http.services["core-keycloak"]).toEqual({
      loadBalancer: {
        servers: [{ url: "http://local-gatrr-keycloak:8080" }],
      },
    });
  });

  it("routes service based on RouteRequest", () => {
    const routes: RouteRequest[] = [
      {
        host: "docs",
        upstream: {
          containerName: "local-docs",
          port: 80,
        },
      },
    ];

    const config = generateTraefikConfig(testConfig, routes);

    // Per architecture.md: router name is host-${host}, service name is svc-${host}
    expect(config.http.routers["host-docs"]).toEqual({
      rule: "Host(`docs.localhost`)",
      service: "svc-docs",
      entryPoints: ["web"],
    });

    expect(config.http.services["svc-docs"]).toEqual({
      loadBalancer: {
        servers: [{ url: "http://local-docs:80" }],
      },
    });
  });

  it("routes oauth2-proxy protected service through proxy container", () => {
    const routes: RouteRequest[] = [
      {
        host: "demo",
        upstream: {
          containerName: "local-oauth2-proxy-demo",
          port: 4180,
        },
      },
    ];

    const config = generateTraefikConfig(testConfig, routes);

    // Per architecture.md: router name is host-${host}, service name is svc-${host}
    expect(config.http.routers["host-demo"]).toEqual({
      rule: "Host(`demo.localhost`)",
      service: "svc-demo",
      entryPoints: ["web"],
    });

    // Service points to oauth2-proxy container
    expect(config.http.services["svc-demo"]).toEqual({
      loadBalancer: {
        servers: [{ url: "http://local-oauth2-proxy-demo:4180" }],
      },
    });
  });

  it("adds TLS configuration and security headers when useHttps is true", () => {
    const config = generateTraefikConfig(testConfigHttps, []);

    expect(config.http.routers["core-portal"]).toEqual({
      rule: "Host(`portal.example.com`)",
      service: "core-portal",
      entryPoints: ["websecure"],
      middlewares: ["rate-limit", "in-flight-req", "security-headers"],
      tls: { certResolver: "letsencrypt" },
    });

    // Keycloak uses its own security headers with relaxed CSP (inline scripts/styles)
    expect(config.http.routers["core-keycloak"]).toEqual({
      rule: "Host(`keycloak.example.com`)",
      service: "core-keycloak",
      entryPoints: ["websecure"],
      middlewares: ["rate-limit", "in-flight-req", "keycloak-security-headers"],
      tls: { certResolver: "letsencrypt" },
    });

    // Verify security headers middleware is defined for regular routes
    expect(config.http.middlewares?.["security-headers"]).toBeDefined();
    expect(config.http.middlewares?.["security-headers"]?.headers).toMatchObject({
      contentTypeNosniff: true,
      frameDeny: true,
      stsSeconds: 31536000,
    });

    // Verify Keycloak-specific security headers middleware with relaxed CSP
    expect(config.http.middlewares?.["keycloak-security-headers"]).toBeDefined();
    expect(config.http.middlewares?.["keycloak-security-headers"]?.headers).toMatchObject({
      contentTypeNosniff: true,
      frameDeny: false, // Allow framing for auth flows
      stsSeconds: 31536000,
    });
    // Verify Keycloak CSP allows inline scripts (needed for login UI)
    expect(
      config.http.middlewares?.["keycloak-security-headers"]?.headers?.contentSecurityPolicy
    ).toContain("'unsafe-inline'");
  });

  it("uses correct container names from RouteRequest", () => {
    const routes: RouteRequest[] = [
      {
        host: "api",
        upstream: {
          containerName: "prod-api",
          port: 8080,
        },
      },
    ];

    const config = generateTraefikConfig(testConfigHttps, routes);

    expect(config.http.services["svc-api"].loadBalancer.servers[0].url).toBe(
      "http://prod-api:8080"
    );
  });
});

describe("rate limiting middleware", () => {
  it("does not add rate limiting in dev environment", () => {
    const config = generateTraefikConfig(testConfig, []);

    // Dev environment should not have rate limiting middleware
    expect(config.http.middlewares?.["rate-limit"]).toBeUndefined();
    expect(config.http.middlewares?.["in-flight-req"]).toBeUndefined();

    // Routers should not reference rate limiting middleware
    expect(config.http.routers["core-portal"].middlewares).toBeUndefined();
    expect(config.http.routers["core-keycloak"].middlewares).toBeUndefined();
  });

  it("adds rate limiting middleware in prod environment", () => {
    const config = generateTraefikConfig(testConfigHttps, []);

    // Prod environment should have rate limiting middleware defined
    expect(config.http.middlewares?.["rate-limit"]).toBeDefined();
    expect(config.http.middlewares?.["in-flight-req"]).toBeDefined();
  });

  it("configures rate-limit middleware with correct values", () => {
    const config = generateTraefikConfig(testConfigHttps, []);

    expect(config.http.middlewares?.["rate-limit"]).toEqual({
      rateLimit: {
        average: 100,
        burst: 50,
        period: "1s",
      },
    });
  });

  it("configures in-flight-req middleware with correct values", () => {
    const config = generateTraefikConfig(testConfigHttps, []);

    expect(config.http.middlewares?.["in-flight-req"]).toEqual({
      inFlightReq: {
        amount: 100,
      },
    });
  });

  it("applies rate limiting before security headers (middleware order)", () => {
    const config = generateTraefikConfig(testConfigHttps, []);

    const middlewares = config.http.routers["core-portal"].middlewares;
    expect(middlewares).toBeDefined();
    if (!middlewares) throw new Error("Expected middlewares");
    expect(middlewares[0]).toBe("rate-limit");
    expect(middlewares[1]).toBe("in-flight-req");
    expect(middlewares[2]).toBe("security-headers");
  });

  it("applies rate limiting to service routes in prod", () => {
    const routes: RouteRequest[] = [
      { host: "api", upstream: { containerName: "prod-api", port: 8080 } },
    ];

    const config = generateTraefikConfig(testConfigHttps, routes);

    expect(config.http.routers["host-api"].middlewares).toEqual([
      "rate-limit",
      "in-flight-req",
      "security-headers",
    ]);
  });
});

describe("validateRouteRequests", () => {
  it("returns empty array for valid routes", () => {
    const routes: RouteRequest[] = [
      { host: "demo", upstream: { containerName: "demo", port: 80 } },
      { host: "docs", upstream: { containerName: "docs", port: 80 } },
    ];

    const errors = validateRouteRequests(routes);

    expect(errors).toEqual([]);
  });

  it("detects duplicate hosts", () => {
    const routes: RouteRequest[] = [
      { host: "demo", upstream: { containerName: "demo1", port: 80 } },
      { host: "demo", upstream: { containerName: "demo2", port: 80 } },
    ];

    const errors = validateRouteRequests(routes);

    expect(errors).toHaveLength(1);
    expect(errors[0].host).toBe("demo");
    expect(errors[0].message).toContain("Duplicate host");
  });

  it("detects invalid host slugs", () => {
    const routes: RouteRequest[] = [
      { host: "Demo", upstream: { containerName: "demo", port: 80 } },
      { host: "my_service", upstream: { containerName: "svc", port: 80 } },
      { host: "-invalid", upstream: { containerName: "inv", port: 80 } },
    ];

    const errors = validateRouteRequests(routes);

    expect(errors).toHaveLength(3);
    expect(errors.every((e) => e.message.includes("Invalid host slug"))).toBe(true);
  });

  it("detects reserved hosts", () => {
    const routes: RouteRequest[] = [
      { host: "portal", upstream: { containerName: "portal", port: 80 } },
      { host: "keycloak", upstream: { containerName: "kc", port: 80 } },
    ];

    const errors = validateRouteRequests(routes);

    expect(errors).toHaveLength(2);
    expect(errors.every((e) => e.message.includes("Reserved host"))).toBe(true);
  });

  it("throws on validation errors in generateTraefikConfig", () => {
    const routes: RouteRequest[] = [
      { host: "portal", upstream: { containerName: "portal", port: 80 } },
    ];

    expect(() => generateTraefikConfig(testConfig, routes)).toThrow(
      "Invalid route requests"
    );
  });
});

describe("serializeTraefikConfig", () => {
  it("produces valid YAML", () => {
    const config = generateTraefikConfig(testConfig, []);
    const yaml = serializeTraefikConfig(config);

    expect(yaml).toContain("http:");
    expect(yaml).toContain("routers:");
    expect(yaml).toContain("services:");
    expect(yaml).toContain("core-portal:");
    expect(yaml).toContain("core-keycloak:");
  });
});

describe("deterministic output", () => {
  it("produces same output for same input regardless of route order", () => {
    const routes: RouteRequest[] = [
      { host: "c-service", upstream: { containerName: "c", port: 80 } },
      { host: "a-service", upstream: { containerName: "a", port: 80 } },
      { host: "b-service", upstream: { containerName: "b", port: 80 } },
    ];

    const config1 = generateTraefikConfig(testConfig, routes);
    const config2 = generateTraefikConfig(testConfig, [...routes].reverse());

    const yaml1 = serializeTraefikConfig(config1);
    const yaml2 = serializeTraefikConfig(config2);

    expect(yaml1).toBe(yaml2);
  });

  it("produces stable output across multiple calls", () => {
    const routes: RouteRequest[] = [
      { host: "demo", upstream: { containerName: "demo", port: 80 } },
      { host: "docs", upstream: { containerName: "docs", port: 80 } },
    ];

    const yaml1 = serializeTraefikConfig(generateTraefikConfig(testConfig, routes));
    const yaml2 = serializeTraefikConfig(generateTraefikConfig(testConfig, routes));
    const yaml3 = serializeTraefikConfig(generateTraefikConfig(testConfig, routes));

    expect(yaml1).toBe(yaml2);
    expect(yaml2).toBe(yaml3);
  });
});
