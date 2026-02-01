/**
 * Log ingestion tests
 *
 * Verifies that Loki is ingesting logs from containers
 * and that they can be queried via Grafana.
 *
 * Important: Loki is internal-only (no host port mapping).
 * We query Loki from inside the Docker network using an ephemeral curl container.
 */

import { test, expect, Page } from "@playwright/test";
import {
  lokiIsReady,
  getLokiLabels,
  queryLoki,
  waitForLokiLogs,
} from "../src/loki-helper";

const E2E_ADMIN_USERNAME = process.env.E2E_ADMIN_USERNAME || "e2e-admin";
const E2E_ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD || "e2e-admin-pass";

/**
 * Helper to perform Keycloak login
 * Handles both portal landing page and direct Keycloak redirect
 */
async function keycloakLogin(
  page: Page,
  username: string,
  password: string
): Promise<void> {
  // If on portal login page, click sign in first
  const signInLink = page.locator('a:has-text("Sign In")');
  if (await signInLink.isVisible({ timeout: 2000 }).catch(() => false)) {
    await signInLink.click();
  }

  // Wait for Keycloak login form
  await page.waitForSelector('input[name="username"]', { timeout: 30000 });
  await page.fill('input[name="username"]', username);
  await page.fill('input[name="password"]', password);
  await page.click('input[type="submit"], button[type="submit"]');
}

test.describe("Loki Log Ingestion", () => {
  test("Loki health endpoint returns ready", async () => {
    // Query Loki health via Docker network (not localhost)
    const ready = await lokiIsReady();
    expect(ready).toBe(true);
  });

  test("Loki has labels available", async () => {
    // Query Loki labels via Docker network
    const result = await getLokiLabels();

    expect(result.status).toBe("success");
    // Should have deployment and job labels from Promtail
    expect(result.data).toContain("deployment");
    expect(result.data).toContain("job");
  });

  test("Loki has ingested logs from containers", async () => {
    // Wait for logs to be ingested (Promtail needs time to scrape)
    const hasLogs = await waitForLokiLogs("docker", 30, 2000);
    expect(hasLogs).toBe(true);

    // Query for any logs
    const result = await queryLoki('{job="docker"}', 10);

    expect(result.status).toBe("success");
    // Should have some log streams
    expect(result.data.result.length).toBeGreaterThan(0);
  });

  test("Loki has container_id labels", async ({ request }) => {
    // First, make a request to generate logs
    await request.get("/", {
      headers: { Host: "portal.localhost" },
    });

    // Wait for log to be ingested
    await new Promise((r) => setTimeout(r, 5000));

    // Query for logs with container_id label
    const labels = await getLokiLabels();

    expect(labels.status).toBe("success");
    // Should have container_id label from file-based scraping
    expect(labels.data).toContain("container_id");
  });
});

test.describe("Grafana Logs Dashboard", () => {
  test("Grafana is accessible via oauth2-proxy", async ({ page }) => {
    // Login via portal first
    await page.goto("http://portal.localhost/");
    await keycloakLogin(page, E2E_ADMIN_USERNAME, E2E_ADMIN_PASSWORD);

    // Wait for portal to load
    await expect(page).toHaveURL(/portal\.localhost/);

    // Access logs service (Grafana behind oauth2-proxy)
    await page.goto("http://logs.localhost/");

    // If redirected through oauth2, complete flow
    if (page.url().includes("keycloak") || page.url().includes("oauth2")) {
      await keycloakLogin(page, E2E_ADMIN_USERNAME, E2E_ADMIN_PASSWORD);
    }

    // Should be on Grafana
    await expect(page).toHaveURL(/logs\.localhost/, { timeout: 30000 });
  });

  test("unauthenticated access to logs.localhost redirects to login", async ({
    request,
  }) => {
    // Try to access Grafana without authentication
    const response = await request.get("/", {
      headers: { Host: "logs.localhost" },
      maxRedirects: 0,
    });

    // Should redirect to oauth2-proxy sign-in (not serve Grafana directly)
    expect([302, 303]).toContain(response.status());
    const location = response.headers()["location"];
    expect(location).toMatch(/oauth2.*sign_in|keycloak/);
  });

  test("Grafana Loki datasource is configured", async ({ page }) => {
    // Login and access Grafana
    await page.goto("http://portal.localhost/");
    await keycloakLogin(page, E2E_ADMIN_USERNAME, E2E_ADMIN_PASSWORD);
    await expect(page).toHaveURL(/portal\.localhost/);

    await page.goto("http://logs.localhost/");
    if (page.url().includes("keycloak") || page.url().includes("oauth2")) {
      await keycloakLogin(page, E2E_ADMIN_USERNAME, E2E_ADMIN_PASSWORD);
    }
    await expect(page).toHaveURL(/logs\.localhost/, { timeout: 30000 });

    // Navigate to datasources
    await page.goto("http://logs.localhost/connections/datasources");

    // Should see Loki datasource (use .first() since Loki appears multiple times)
    await expect(page.locator("text=Loki").first()).toBeVisible({ timeout: 10000 });
  });

  test("Docker Logs dashboard is provisioned", async ({ page }) => {
    // Login and access Grafana
    await page.goto("http://portal.localhost/");
    await keycloakLogin(page, E2E_ADMIN_USERNAME, E2E_ADMIN_PASSWORD);
    await expect(page).toHaveURL(/portal\.localhost/);

    await page.goto("http://logs.localhost/");
    if (page.url().includes("keycloak") || page.url().includes("oauth2")) {
      await keycloakLogin(page, E2E_ADMIN_USERNAME, E2E_ADMIN_PASSWORD);
    }
    await expect(page).toHaveURL(/logs\.localhost/, { timeout: 30000 });

    // Navigate to dashboards
    await page.goto("http://logs.localhost/dashboards");

    // Should see the Docker Logs dashboard
    await expect(page.locator("text=Docker Logs")).toBeVisible({ timeout: 10000 });
  });
});
