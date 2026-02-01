import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as yaml from "js-yaml";

/**
 * Load stack configuration from config.<stack>.yaml into Pulumi.
 *
 * This script:
 * 1. Detects the current Pulumi stack
 * 2. Looks for config.<stack>.yaml
 * 3. If missing, creates an example file and exits
 * 4. If present, loads stack config, services, and secrets into Pulumi
 */

// =============================================================================
// Types
// =============================================================================

interface StackConfig {
  deploymentId: string;
  baseDomain: string;
  environment: string;
  keycloakRealm: string;
  keycloakDevMode?: boolean;
  useHttps?: boolean;
  acmeEmail?: string;
  buildPlatform?: string;
}

interface ServiceConfig {
  portalName?: string;
  host?: string;
  requiredRoles?: string[];
  authType?: string;
  group?: string;
  icon?: string;
  description?: string;
}

interface UserConfig {
  username: string;
  password: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  roles?: string | string[];
}

interface CredentialsConfig {
  keycloakAdminUsername: string;
  keycloakAdminPassword: string;
  users: UserConfig[];
}

interface ConfigFile {
  stack: StackConfig;
  services: Record<string, ServiceConfig>;
  credentials: CredentialsConfig;
}

// =============================================================================
// Pulumi Commands
// =============================================================================

function runPulumi(args: string[], input?: string): string {
  try {
    return execFileSync("pulumi", args, {
      input,
      encoding: "utf-8",
      stdio: input ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const err = error as { stderr?: string };
    const stderr = typeof err.stderr === "string" ? err.stderr.trim() : "";
    throw new Error(`Pulumi command failed: pulumi ${args.join(" ")}${stderr ? `\n${stderr}` : ""}`);
  }
}

function getSelectedStack(): string {
  const stack = runPulumi(["stack", "--show-name"]);
  if (!stack) {
    throw new Error("No Pulumi stack selected. Run: pulumi stack select <stack>");
  }
  return stack;
}

function setConfig(key: string, value: string): void {
  runPulumi(["config", "set", `gatrr:${key}`, "--", value]);
}

function setSecret(key: string, value: string): void {
  runPulumi(["config", "set", "--secret", `secrets:${key}`, "--"], value);
}

// =============================================================================
// Config File Handling
// =============================================================================

function getConfigFilePath(stack: string): string {
  const pulumiDir = path.resolve(__dirname, "..");
  return path.join(pulumiDir, `config.${stack}.yaml`);
}

function generateExampleConfig(stack: string): string {
  return `# Stack configuration for "${stack}"
# Fill in the values and run: npm run config:load

stack:
  deploymentId: ${stack}
  baseDomain: localhost          # Your domain (e.g., localhost, example.com)
  environment: dev               # dev or prod
  keycloakRealm: ${stack}
  keycloakDevMode: true          # false for production
  # useHttps: false              # true for production
  # acmeEmail: admin@example.com # Required if useHttps is true

services:
  demo:
    portalName: Demo App
    requiredRoles: [admin, dev]
    group: apps
    icon: rocket
    description: Demo application with OAuth2 protection
  docs:
    portalName: Documentation
    group: docs
    icon: book
    description: Public documentation (no auth required)
  dozzle:
    portalName: Dozzle
    requiredRoles: [admin]
    group: admin
    icon: file-text
    description: Container log viewer
  logs:
    portalName: Logs
    requiredRoles: [admin]
    group: admin
    icon: activity
    description: Centralized logs (Grafana + Loki)

credentials:
  keycloakAdminUsername: admin
  keycloakAdminPassword: CHANGE_ME
  users:
    - username: admin
      password: CHANGE_ME
      roles: admin
      email: admin@example.com
    - username: dev
      password: CHANGE_ME
      roles: dev
`;
}

function readConfigFile(filePath: string): unknown {
  const raw = fs.readFileSync(filePath, "utf-8");
  return yaml.load(raw);
}

// =============================================================================
// Validation
// =============================================================================

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(obj: Record<string, unknown>, key: string, context: string): string {
  const value = obj[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Invalid ${context}: '${key}' must be a non-empty string`);
  }
  return value;
}

function validateStackConfig(value: unknown): StackConfig {
  if (!isPlainObject(value)) {
    throw new Error("Invalid config: 'stack' must be an object");
  }

  return {
    deploymentId: requireString(value, "deploymentId", "stack"),
    baseDomain: requireString(value, "baseDomain", "stack"),
    environment: requireString(value, "environment", "stack"),
    keycloakRealm: requireString(value, "keycloakRealm", "stack"),
    keycloakDevMode: value.keycloakDevMode === true,
    useHttps: value.useHttps === true,
    acmeEmail: typeof value.acmeEmail === "string" ? value.acmeEmail : undefined,
    buildPlatform: typeof value.buildPlatform === "string" ? value.buildPlatform : undefined,
  };
}

function validateServices(value: unknown): Record<string, ServiceConfig> {
  if (!isPlainObject(value)) {
    throw new Error("Invalid config: 'services' must be an object");
  }

  const services: Record<string, ServiceConfig> = {};
  for (const [serviceId, config] of Object.entries(value)) {
    if (!isPlainObject(config)) {
      throw new Error(`Invalid config: services.${serviceId} must be an object`);
    }
    services[serviceId] = config as ServiceConfig;
  }

  return services;
}

function validateUser(value: unknown, index: number): UserConfig {
  if (!isPlainObject(value)) {
    throw new Error(`Invalid credentials.users[${index}]: must be an object`);
  }

  const username = requireString(value, "username", `credentials.users[${index}]`);
  const password = requireString(value, "password", `credentials.users[${index}]`);

  if (!/^[a-z][a-z0-9-]*$/.test(username)) {
    throw new Error(`Invalid credentials.users[${index}].username: "${username}" must be a valid slug`);
  }

  return {
    username,
    password,
    email: typeof value.email === "string" ? value.email : undefined,
    firstName: typeof value.firstName === "string" ? value.firstName : undefined,
    lastName: typeof value.lastName === "string" ? value.lastName : undefined,
    roles: value.roles as string | string[] | undefined,
  };
}

function validateCredentials(value: unknown): CredentialsConfig {
  if (!isPlainObject(value)) {
    throw new Error("Invalid config: 'credentials' must be an object");
  }

  const keycloakAdminUsername = requireString(value, "keycloakAdminUsername", "credentials");
  const keycloakAdminPassword = requireString(value, "keycloakAdminPassword", "credentials");

  if (!Array.isArray(value.users) || value.users.length === 0) {
    throw new Error("Invalid config: 'credentials.users' must be a non-empty array");
  }

  const users = value.users.map((u, i) => validateUser(u, i));

  // Check for duplicate usernames
  const seen = new Set<string>();
  for (const user of users) {
    if (seen.has(user.username)) {
      throw new Error(`Duplicate username in credentials.users: "${user.username}"`);
    }
    seen.add(user.username);
  }

  return { keycloakAdminUsername, keycloakAdminPassword, users };
}

function validateConfigFile(value: unknown): ConfigFile {
  if (!isPlainObject(value)) {
    throw new Error("Invalid config file: expected YAML object");
  }

  return {
    stack: validateStackConfig(value.stack),
    services: validateServices(value.services),
    credentials: validateCredentials(value.credentials),
  };
}

// =============================================================================
// Main
// =============================================================================

function main(): void {
  // Check for passphrase
  const hasPassphrase =
    process.env.PULUMI_CONFIG_PASSPHRASE !== undefined ||
    process.env.PULUMI_CONFIG_PASSPHRASE_FILE !== undefined;

  if (!hasPassphrase) {
    console.error("\nError: Pulumi passphrase not set.\n");
    console.error("Run with passphrase:");
    console.error("  PULUMI_CONFIG_PASSPHRASE=<passphrase> npm run config:load\n");
    console.error("Or export it for the session:");
    console.error("  export PULUMI_CONFIG_PASSPHRASE=<passphrase>");
    console.error("  npm run config:load\n");
    process.exit(1);
  }

  // Get current stack
  const stack = getSelectedStack();
  const configFilePath = getConfigFilePath(stack);

  // Check if config file exists
  if (!fs.existsSync(configFilePath)) {
    const exampleContent = generateExampleConfig(stack);
    fs.writeFileSync(configFilePath, exampleContent, "utf-8");

    console.log(`\nCreated example config file: config.${stack}.yaml\n`);
    console.log("Please edit the file with your configuration, then run:");
    console.log("  npm run config:load\n");
    process.exit(0);
  }

  // Read and validate config
  const parsed = readConfigFile(configFilePath);
  const config = validateConfigFile(parsed);

  // Set stack config
  setConfig("deploymentId", config.stack.deploymentId);
  setConfig("baseDomain", config.stack.baseDomain);
  setConfig("environment", config.stack.environment);
  setConfig("keycloakRealm", config.stack.keycloakRealm);
  setConfig("keycloakDevMode", String(config.stack.keycloakDevMode));

  if (config.stack.useHttps) {
    setConfig("useHttps", "true");
  }
  if (config.stack.acmeEmail) {
    setConfig("acmeEmail", config.stack.acmeEmail);
  }
  if (config.stack.buildPlatform) {
    setConfig("buildPlatform", config.stack.buildPlatform);
  }

  // Set services as YAML
  const servicesYaml = yaml.dump(config.services, { flowLevel: -1 });
  setConfig("services", servicesYaml);

  // Set credentials (as Pulumi secrets)
  setSecret("keycloakAdminUsername", config.credentials.keycloakAdminUsername);
  setSecret("keycloakAdminPassword", config.credentials.keycloakAdminPassword);

  // Set unified users as YAML
  const usersYaml = yaml.dump(config.credentials.users, { flowLevel: -1 });
  setSecret("unifiedUsers", usersYaml);

  console.log(
    `\nLoaded config for stack '${stack}':\n` +
      `  Stack: ${config.stack.deploymentId} (${config.stack.environment})\n` +
      `  Domain: ${config.stack.baseDomain}\n` +
      `  Services: ${Object.keys(config.services).join(", ")}\n` +
      `  Users: ${config.credentials.users.map((u) => u.username).join(", ")}\n`
  );
}

main();
