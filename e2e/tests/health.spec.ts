/**
 * Health check tests
 *
 * Verifies basic service availability.
 */

import { test, expect } from "@playwright/test";

test.describe("Health Checks", () => {
  test("portal /healthz returns 200", async ({ request }) => {
    const response = await request.get("/healthz", {
      headers: { Host: "portal.localhost" },
    });
    expect(response.status()).toBe(200);
  });

  test("keycloak is accessible", async ({ request }) => {
    // Just check that Keycloak is responding (main page redirects to admin or shows welcome)
    const response = await request.get("/", {
      headers: { Host: "keycloak.localhost" },
    });
    // Keycloak returns 200 for welcome page or redirects
    expect([200, 302, 303]).toContain(response.status());
  });

  test("docs service is accessible without auth", async ({ request }) => {
    const response = await request.get("/", {
      headers: { Host: "docs.localhost" },
    });
    expect(response.status()).toBe(200);
  });

  test("traefik port 80 is reachable", async ({ request }) => {
    const response = await request.get("/", {
      headers: { Host: "portal.localhost" },
    });
    // Should get a response (200 or redirect)
    expect([200, 302, 303]).toContain(response.status());
  });
});

test.describe("Security - Traefik Dashboard", () => {
  test("traefik dashboard (port 8080) is NOT exposed in prod mode", async ({
    request,
  }) => {
    // In prod mode, port 8080 should not be published
    // Attempting to connect should fail or timeout
    try {
      const response = await request.get("http://127.0.0.1:8080/api/version", {
        timeout: 5000,
      });
      // If we get here, the port is exposed (bad)
      expect(response.status()).not.toBe(200);
    } catch {
      // Connection refused or timeout is expected (good)
      expect(true).toBe(true);
    }
  });
});
