/**
 * E2E Test Runner
 *
 * Uses Pulumi Automation API to:
 * 1. Create an ephemeral stack
 * 2. Deploy the infrastructure
 * 3. Run Playwright tests
 * 4. Tear down (always, even on failure)
 */

import * as automation from "@pulumi/pulumi/automation";
import { execSync } from "child_process";
import * as path from "path";
import * as crypto from "crypto";

// Configuration
const PULUMI_PROJECT_DIR = path.resolve(__dirname, "../../infra/pulumi");
const SHORT_SHA = crypto.randomBytes(4).toString("hex");
const STACK_NAME = `e2e-${SHORT_SHA}`;
const DEPLOYMENT_ID = `e2e-${SHORT_SHA}`;

// Secrets from environment (set in CI or locally)
const KEYCLOAK_ADMIN_USERNAME = process.env.KEYCLOAK_ADMIN_USERNAME || "admin";
const KEYCLOAK_ADMIN_PASSWORD = process.env.KEYCLOAK_ADMIN_PASSWORD || "admin";
const E2E_ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD || "e2e-admin-pass";
const E2E_DEV_PASSWORD = process.env.E2E_DEV_PASSWORD || "e2e-dev-pass";

// Docker network name for E2E deployment
const DOCKER_NETWORK = `gatrr-${DEPLOYMENT_ID}`;

// Generate a random passphrase for Pulumi secrets
const PULUMI_PASSPHRASE = crypto.randomBytes(32).toString("hex");

interface RunnerResult {
  success: boolean;
  error?: Error;
}

async function createStack(): Promise<automation.Stack> {
  console.log(`Creating ephemeral stack: ${STACK_NAME}`);

  const stack = await automation.LocalWorkspace.createOrSelectStack(
    {
      stackName: STACK_NAME,
      workDir: PULUMI_PROJECT_DIR,
    },
    {
      envVars: {
        PULUMI_CONFIG_PASSPHRASE: PULUMI_PASSPHRASE,
      },
    }
  );

  // Configure the stack for E2E (prod-like but no HTTPS)
  await stack.setConfig("gatrr:deploymentId", { value: DEPLOYMENT_ID });
  await stack.setConfig("gatrr:environment", { value: "prod" });
  await stack.setConfig("gatrr:baseDomain", { value: "localhost" });
  await stack.setConfig("gatrr:useHttps", { value: "false" });
  await stack.setConfig("gatrr:keycloakRealm", { value: "e2e" });
  await stack.setConfig("gatrr:keycloakDevMode", { value: "false" });
  await stack.setConfig("gatrr:descriptorInjection", { value: "file" });
  await stack.setConfig("gatrr:buildPlatform", { value: "linux/amd64" });
  await stack.setConfig("gatrr:deploymentConfigFile", { value: "deployment.e2e.json" });

  // Set secrets
  await stack.setConfig("secrets:keycloakAdminUsername", {
    value: KEYCLOAK_ADMIN_USERNAME,
    secret: true,
  });
  await stack.setConfig("secrets:keycloakAdminPassword", {
    value: KEYCLOAK_ADMIN_PASSWORD,
    secret: true,
  });

  // User passwords - Pulumi expects secrets:realm<CapitalizedUsername>Password
  // The capitalize function in index.ts: s.charAt(0).toUpperCase() + s.slice(1)
  // For "e2e-admin" → "realmE2e-adminPassword"
  // For "e2e-dev" → "realmE2e-devPassword"
  await stack.setConfig("secrets:realmE2e-adminPassword", {
    value: E2E_ADMIN_PASSWORD,
    secret: true,
  });
  await stack.setConfig("secrets:realmE2e-devPassword", {
    value: E2E_DEV_PASSWORD,
    secret: true,
  });

  return stack;
}

async function deployStack(stack: automation.Stack): Promise<void> {
  console.log("Deploying infrastructure...");

  const upResult = await stack.up({
    onOutput: console.log,
  });

  console.log(`Deployment complete. Outputs:`);
  console.log(JSON.stringify(upResult.outputs, null, 2));
}

async function runTests(): Promise<void> {
  console.log("Running Playwright tests...");

  // Pass config to Playwright via environment
  const env = {
    ...process.env,
    E2E_BASE_URL: "http://127.0.0.1",
    E2E_DEPLOYMENT_ID: DEPLOYMENT_ID,
    E2E_DOCKER_NETWORK: DOCKER_NETWORK,
    E2E_LOKI_CONTAINER: `${DEPLOYMENT_ID}-loki`,
    E2E_ADMIN_USERNAME: "e2e-admin",
    E2E_ADMIN_PASSWORD: E2E_ADMIN_PASSWORD,
    E2E_DEV_USERNAME: "e2e-dev",
    E2E_DEV_PASSWORD: E2E_DEV_PASSWORD,
  };

  execSync("npx playwright test", {
    cwd: path.resolve(__dirname, ".."),
    stdio: "inherit",
    env,
  });
}

async function destroyStack(stack: automation.Stack): Promise<void> {
  console.log("Destroying infrastructure...");

  await stack.destroy({
    onOutput: console.log,
  });

  console.log("Removing stack...");
  await stack.workspace.removeStack(STACK_NAME);
}

async function waitForServices(): Promise<void> {
  console.log("Waiting for services to be ready...");

  const maxRetries = 60;
  const retryDelay = 2000;

  // Wait for portal health
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch("http://127.0.0.1/healthz", {
        headers: { Host: "portal.localhost" },
      });
      if (response.ok) {
        console.log("Portal is healthy");
        break;
      }
    } catch {
      // Ignore errors, keep retrying
    }
    if (i === maxRetries - 1) {
      throw new Error("Portal did not become healthy in time");
    }
    await new Promise((r) => setTimeout(r, retryDelay));
  }

  // Wait for Keycloak health
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch("http://127.0.0.1/health/ready", {
        headers: { Host: "keycloak.localhost" },
      });
      if (response.ok) {
        console.log("Keycloak is healthy");
        return;
      }
    } catch {
      // Ignore errors, keep retrying
    }
    if (i === maxRetries - 1) {
      throw new Error("Keycloak did not become healthy in time");
    }
    await new Promise((r) => setTimeout(r, retryDelay));
  }
}

async function main(): Promise<RunnerResult> {
  let stack: automation.Stack | undefined;

  try {
    stack = await createStack();
    await deployStack(stack);
    await waitForServices();
    await runTests();

    return { success: true };
  } catch (error) {
    console.error("E2E failed:", error);
    return { success: false, error: error as Error };
  } finally {
    // Always clean up
    if (stack) {
      try {
        await destroyStack(stack);
      } catch (cleanupError) {
        console.error("Cleanup failed:", cleanupError);
      }
    }
  }
}

main().then((result) => {
  process.exit(result.success ? 0 : 1);
});
