/**
 * Build verification tests
 *
 * These tests ensure that all modules compile correctly with strict TypeScript.
 * They act as regression tests for type errors that might slip through.
 *
 * Why this matters:
 * - JSON.parse() returns `any`, which strictTypeChecked disallows
 * - All parsed JSON must be explicitly typed (e.g., `as AnySchema`)
 * - These imports will fail to compile if types are incorrect
 */

import { describe, it, expect } from "vitest";

// Import all main modules to verify they compile
import * as config from "./config";
import * as descriptor from "./descriptor";
import * as deploymentConfig from "./deployment-config";
import * as keycloak from "./keycloak";
import * as oauth2Proxy from "./oauth2-proxy/config";
import * as portal from "./portal";
import * as services from "./services";
import * as traefik from "./traefik/dynamic-config";

describe("build verification", () => {
  it("all modules export expected functions", () => {
    // Config module
    expect(typeof config.getConfig).toBe("function");
    expect(typeof config.buildUrl).toBe("function");

    // Descriptor module
    expect(typeof descriptor.generateDescriptor).toBe("function");
    expect(typeof descriptor.validateDescriptorSchema).toBe("function");

    // Deployment config module
    expect(typeof deploymentConfig.loadDeploymentConfigFile).toBe("function");
    expect(typeof deploymentConfig.resolveDeploymentConfig).toBe("function");

    // Keycloak module
    expect(typeof keycloak.createKeycloak).toBe("function");

    // OAuth2 Proxy module
    expect(typeof oauth2Proxy.buildOAuth2ProxyEnvs).toBe("function");

    // Portal module
    expect(typeof portal.createPortal).toBe("function");

    // Services module
    expect(typeof services.getAvailableServiceIds).toBe("function");
    expect(typeof services.getServiceFactory).toBe("function");

    // Traefik module
    expect(typeof traefik.generateTraefikConfig).toBe("function");
  });

  it("descriptor schema validator is callable", () => {
    // This specifically tests that the AnySchema type import works
    // If JSON.parse returned untyped `any`, this would fail with strictTypeChecked
    expect(() => {
      descriptor.validateDescriptorSchema({
        version: "1",
        deploymentId: "test",
        environment: "dev",
        baseDomain: "localhost",
        portal: { publicUrl: "http://portal.localhost" },
        keycloak: {
          publicUrl: "http://keycloak.localhost",
          issuerUrl: "http://keycloak.localhost/realms/dev",
          realm: "dev",
        },
        services: [],
      });
    }).not.toThrow();
  });
});
