/**
 * Authentication flow tests
 *
 * Tests login via Keycloak and session management.
 */

import { test, expect, Page } from "@playwright/test";

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

  // Fill credentials
  await page.fill('input[name="username"]', username);
  await page.fill('input[name="password"]', password);

  // Submit
  await page.click('input[type="submit"], button[type="submit"]');

  // Wait for redirect back to portal
  await page.waitForURL(/portal\.localhost/, { timeout: 30000 });
}

test.describe("Authentication Flow", () => {
  test("unauthenticated user sees login page", async ({ page }) => {
    // Navigate to portal
    await page.goto("http://portal.localhost/", {
      waitUntil: "networkidle",
    });

    // Should see portal landing page with sign-in option
    // Portal shows a landing page for unauthenticated users
    await expect(page.locator('a:has-text("Sign In")')).toBeVisible({ timeout: 10000 });
  });

  test("user can login via Keycloak", async ({ page }) => {
    // Navigate to portal
    await page.goto("http://portal.localhost/");

    // Wait for redirect to Keycloak and login
    await keycloakLogin(page, E2E_ADMIN_USERNAME, E2E_ADMIN_PASSWORD);

    // Should be on portal dashboard now
    await expect(page).toHaveURL(/portal\.localhost/);

    // Dashboard should show user info
    const pageContent = await page.content();
    expect(pageContent).toContain(E2E_ADMIN_USERNAME);
  });

  test("authenticated user sees dashboard with services", async ({ page }) => {
    // Login first
    await page.goto("http://portal.localhost/");
    await keycloakLogin(page, E2E_ADMIN_USERNAME, E2E_ADMIN_PASSWORD);

    // Check for service cards (use .first() since text appears multiple times)
    await expect(page.locator("text=Demo App").first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator("text=Documentation").first()).toBeVisible({
      timeout: 10000,
    });
  });
});

test.describe("Logout Flow", () => {
  test("user can logout", async ({ page }) => {
    // Login first
    await page.goto("http://portal.localhost/");
    await keycloakLogin(page, E2E_ADMIN_USERNAME, E2E_ADMIN_PASSWORD);

    // Find and click logout button/link
    await page.click('button:has-text("Logout"), a:has-text("Logout")');

    // Should be logged out - either on logout complete page or redirected
    await page.waitForURL(/logout|portal\.localhost/, { timeout: 30000 });
  });

  test("after logout, protected services require login again", async ({
    page,
  }) => {
    // Login first
    await page.goto("http://portal.localhost/");
    await keycloakLogin(page, E2E_ADMIN_USERNAME, E2E_ADMIN_PASSWORD);

    // Logout
    await page.click('button:has-text("Logout"), a:has-text("Logout")');
    await page.waitForURL(/logout|portal\.localhost/, { timeout: 30000 });

    // Try to access protected service
    await page.goto("http://demo.localhost/");

    // Should be redirected to login
    await expect(page).toHaveURL(/keycloak\.localhost.*login|oauth2/, {
      timeout: 30000,
    });
  });
});
