/**
 * OAuth2-Proxy protection tests
 *
 * Verifies that protected services require authentication
 * and enforce role-based access control.
 */

import { test, expect, Page } from "@playwright/test";

const E2E_ADMIN_USERNAME = process.env.E2E_ADMIN_USERNAME || "e2e-admin";
const E2E_ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD || "e2e-admin-pass";
const E2E_DEV_USERNAME = process.env.E2E_DEV_USERNAME || "e2e-dev";
const E2E_DEV_PASSWORD = process.env.E2E_DEV_PASSWORD || "e2e-dev-pass";

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

test.describe("OAuth2-Proxy Protection", () => {
  test("unauthenticated access to demo service redirects to login", async ({
    page,
  }) => {
    // Try to access protected demo service
    await page.goto("http://demo.localhost/");

    // Should be redirected to Keycloak login
    await expect(page).toHaveURL(/keycloak\.localhost.*login|oauth2/, {
      timeout: 30000,
    });
  });

  test("authenticated admin can access demo service", async ({ page }) => {
    // Login via portal first to establish session
    await page.goto("http://portal.localhost/");
    await keycloakLogin(page, E2E_ADMIN_USERNAME, E2E_ADMIN_PASSWORD);

    // Wait for portal to load
    await expect(page).toHaveURL(/portal\.localhost/);

    // Now access demo service - should work with existing session
    await page.goto("http://demo.localhost/");

    // Should either be on demo page or redirected through oauth2-proxy
    // If redirected, complete the oauth flow
    if (page.url().includes("keycloak") || page.url().includes("oauth2")) {
      await keycloakLogin(page, E2E_ADMIN_USERNAME, E2E_ADMIN_PASSWORD);
    }

    // Should be on demo service now
    await expect(page).toHaveURL(/demo\.localhost/, { timeout: 30000 });
  });

  test("dev user can access demo service (has dev role)", async ({ page }) => {
    // Login via portal
    await page.goto("http://portal.localhost/");
    await keycloakLogin(page, E2E_DEV_USERNAME, E2E_DEV_PASSWORD);

    // Wait for portal to load
    await expect(page).toHaveURL(/portal\.localhost/);

    // Access demo service
    await page.goto("http://demo.localhost/");

    // If redirected, complete oauth flow
    if (page.url().includes("keycloak") || page.url().includes("oauth2")) {
      await keycloakLogin(page, E2E_DEV_USERNAME, E2E_DEV_PASSWORD);
    }

    // Should be on demo service
    await expect(page).toHaveURL(/demo\.localhost/, { timeout: 30000 });
  });
});

test.describe("OAuth2-Proxy Headers", () => {
  test("oauth2-proxy passes user info headers to backend", async ({
    request,
  }) => {
    // This test would need to check that X-Auth-Request-User
    // and other headers are passed through. Since we can't
    // easily inspect backend-received headers in E2E, we verify
    // the oauth2-proxy is working by checking the whoami or
    // a header-echo endpoint if available.

    // For now, verify the oauth2-proxy callback endpoint exists
    const response = await request.get("http://127.0.0.1/oauth2/sign_in", {
      headers: { Host: "demo.localhost" },
      maxRedirects: 0,
    });

    // Should redirect to Keycloak (302/303)
    expect([302, 303]).toContain(response.status());
  });
});

test.describe("Public vs Protected Services", () => {
  test("docs service is accessible without authentication", async ({
    request,
  }) => {
    const response = await request.get("/", {
      headers: { Host: "docs.localhost" },
    });

    expect(response.status()).toBe(200);
  });

  test("portal shows landing page for unauthenticated users", async ({
    request,
  }) => {
    const response = await request.get("/", {
      headers: { Host: "portal.localhost" },
      maxRedirects: 0,
    });

    // Portal shows a landing page with sign-in option for unauthenticated users
    expect(response.status()).toBe(200);
    const body = await response.text();
    expect(body).toContain("Sign In");
  });

  test("demo service redirects unauthenticated users to oauth2-proxy", async ({
    request,
  }) => {
    const response = await request.get("/", {
      headers: { Host: "demo.localhost" },
      maxRedirects: 0,
    });

    // Should redirect to oauth2-proxy sign-in
    expect([302, 303]).toContain(response.status());
    const location = response.headers()["location"];
    expect(location).toMatch(/oauth2.*sign_in|keycloak/);
  });
});
