#!/usr/bin/env npx ts-node
/**
 * Create a new Pulumi stack and initialize config
 *
 * Usage: npm run new <stack-name>
 * Example: npm run new local
 */

import { execSync } from "child_process";

function main(): void {
  const stackName = process.argv[2];

  if (!stackName) {
    console.error("Usage: npm run new <stack-name>");
    console.error("Example: npm run new local");
    process.exit(1);
  }

  // Validate stack name (lowercase alphanumeric with hyphens)
  if (!/^[a-z][a-z0-9-]*$/.test(stackName)) {
    console.error(
      `Invalid stack name: "${stackName}". Use lowercase letters, numbers, and hyphens.`
    );
    process.exit(1);
  }

  console.log(`Creating stack: ${stackName}`);

  // Set empty passphrase for local file backend
  const env = { ...process.env, PULUMI_CONFIG_PASSPHRASE: "" };

  try {
    // Initialize the stack
    execSync(`pulumi stack init ${stackName}`, {
      stdio: "inherit",
      env,
    });

    console.log(`\nStack "${stackName}" created. Loading config...`);

    // Run config:load
    execSync("npm run config:load", {
      stdio: "inherit",
      env,
    });
  } catch (error) {
    // Error already printed by execSync with stdio: inherit
    process.exit(1);
  }
}

main();
