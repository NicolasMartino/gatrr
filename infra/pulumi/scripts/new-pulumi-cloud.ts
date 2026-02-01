#!/usr/bin/env npx ts-node
/**
 * Generate a Pulumi Cloud Environment example file
 *
 * Usage: npm run new:pulumiCloud <stack-name>
 * Example: npm run new:pulumiCloud prod
 *
 * This generates a YAML file formatted for Pulumi Cloud Environments (ESC).
 * Copy the contents into the Pulumi Cloud web UI (Environments → New → YAML editor).
 *
 * Structure:
 * - Clean, readable values at top (stack settings, services, secrets, ssh)
 * - pulumiConfig section at bottom references values above
 * - Only actual secrets (passwords, keys) use fn::secret
 */

import * as fs from "node:fs";
import * as path from "node:path";

function generateEscExample(stack: string): string {
  return `# Pulumi Cloud Environment for "${stack}"
# Copy this into Pulumi Cloud: Environments → Create Environment → YAML editor
# Docs: https://www.pulumi.com/docs/esc/

values:
  # ==========================================================================
  # Stack Settings
  # ==========================================================================
  stack:
    deploymentId: ${stack}
    baseDomain: example.com           # Your domain
    environment: prod                 # dev or prod
    keycloakRealm: ${stack}
    keycloakDevMode: false            # true for dev, false for prod
    useHttps: true                    # Enable for production
    acmeEmail: admin@example.com      # Required if useHttps is true

  # ==========================================================================
  # Services
  # ==========================================================================
  services:
    demo:
      portalName: Demo App
      requiredRoles:
        - admin
        - dev
      group: apps
      icon: rocket
      description: Demo application
    docs:
      portalName: Documentation
      group: docs
      icon: book
      description: Public documentation
    dozzle:
      portalName: Dozzle
      requiredRoles:
        - admin
      group: admin
      icon: file-text
      description: Container log viewer
    logs:
      portalName: Logs
      requiredRoles:
        - admin
      group: admin
      icon: activity
      description: Centralized logs

  # ==========================================================================
  # Credentials (only passwords use fn::secret)
  # ==========================================================================
  credentials:
    keycloakAdminUsername: admin
    keycloakAdminPassword:
      fn::secret: CHANGE_ME
    users:
      - username: admin
        password:
          fn::secret: CHANGE_ME
        roles: admin
        email: admin@example.com
      - username: dev
        password:
          fn::secret: CHANGE_ME
        roles: dev
        email: dev@example.com

  # ==========================================================================
  # SSH Credentials (for CI/CD deployment)
  # ==========================================================================
  # Generate key: ssh-keygen -t ed25519 -f deploy_key -N "" -C "ci-deploy"
  # Get known_hosts: ssh-keyscan -t ed25519 your-server.com
  ssh:
    privateKey:
      fn::secret: |
        -----BEGIN OPENSSH PRIVATE KEY-----
        CHANGE_ME: paste your deploy_key private key here
        -----END OPENSSH PRIVATE KEY-----
    knownHosts: "your-server.com ssh-ed25519 AAAA..."
    deployHost: "deployer@your-server.com"

  # ==========================================================================
  # Pulumi Config Mapping (references values above)
  # ==========================================================================
  pulumiConfig:
    # Stack settings
    gatrr:deploymentId: \${stack.deploymentId}
    gatrr:baseDomain: \${stack.baseDomain}
    gatrr:environment: \${stack.environment}
    gatrr:keycloakRealm: \${stack.keycloakRealm}
    gatrr:keycloakDevMode: \${stack.keycloakDevMode}
    gatrr:useHttps: \${stack.useHttps}
    gatrr:acmeEmail: \${stack.acmeEmail}
    # Services (as YAML string)
    gatrr:services:
      fn::toJSON: \${services}
    # Credentials (mapped to secrets: namespace in Pulumi)
    secrets:keycloakAdminUsername: \${credentials.keycloakAdminUsername}
    secrets:keycloakAdminPassword: \${credentials.keycloakAdminPassword}
    secrets:unifiedUsers:
      fn::toJSON: \${credentials.users}
`;
}

function main(): void {
  const stackName = process.argv[2];

  if (!stackName) {
    console.error("Usage: npm run new:pulumiCloud <stack-name>");
    console.error("Example: npm run new:pulumiCloud prod");
    process.exit(1);
  }

  // Validate stack name
  if (!/^[a-z][a-z0-9-]*$/.test(stackName)) {
    console.error(
      `Invalid stack name: "${stackName}". Use lowercase letters, numbers, and hyphens.`
    );
    process.exit(1);
  }

  const outputPath = path.resolve(__dirname, "..", `esc.${stackName}.yaml`);
  const content = generateEscExample(stackName);

  fs.writeFileSync(outputPath, content, "utf-8");

  console.log(`\nCreated Pulumi ESC example: esc.${stackName}.yaml\n`);
  console.log("To use with Pulumi Cloud:");
  console.log("1. Go to https://app.pulumi.com → Environments → Create Environment");
  console.log("2. Name it (e.g., '" + stackName + "')");
  console.log("3. Switch to YAML editor and paste the contents of the file");
  console.log("4. Update the values (especially secrets marked CHANGE_ME)");
  console.log("5. Save the environment");
  console.log("6. Import it in your stack: pulumi config env add <org>/<env-name>\n");
}

main();
