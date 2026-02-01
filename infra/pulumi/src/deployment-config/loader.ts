/**
 * Deployment configuration loader
 *
 * Loads services configuration from Pulumi config (gatrr:services).
 * Configuration is set via `npm run config:load` which reads from config.<stack>.yaml.
 */

import * as pulumi from "@pulumi/pulumi";
import * as yaml from "js-yaml";
import { DeploymentConfigFile, ServiceConfig } from "./types";

/**
 * Error thrown when services config is not found in Pulumi config
 */
export class DeploymentConfigNotFoundError extends Error {
  constructor(public readonly stackName: string) {
    super(
      `Services configuration not found for stack "${stackName}"\n` +
        `Run: npm run config:load\n` +
        `This will create config.${stackName}.yaml if it doesn't exist.`
    );
    this.name = "DeploymentConfigNotFoundError";
  }
}

/**
 * Error thrown when services config contains invalid YAML
 */
export class DeploymentConfigParseError extends Error {
  constructor(public readonly parseError: string) {
    super(
      `Failed to parse services configuration from Pulumi config\n` +
        `YAML parse error: ${parseError}\n` +
        `Run: npm run config:load`
    );
    this.name = "DeploymentConfigParseError";
  }
}

/**
 * Load deployment configuration from Pulumi config
 *
 * Services are stored as YAML in gatrr:services config key.
 *
 * @param stackName - Pulumi stack name (used for error messages)
 * @returns Parsed deployment configuration (services only, no users)
 * @throws DeploymentConfigNotFoundError if config doesn't exist
 * @throws DeploymentConfigParseError if YAML is malformed
 */
export function loadDeploymentConfigFile(stackName: string): DeploymentConfigFile {
  const pulumiConfig = new pulumi.Config("gatrr");
  const servicesYaml = pulumiConfig.get("services");

  if (!servicesYaml) {
    throw new DeploymentConfigNotFoundError(stackName);
  }

  try {
    const services = yaml.load(servicesYaml) as Record<string, ServiceConfig>;
    return { services };
  } catch (error) {
    const parseError = error instanceof Error ? error.message : String(error);
    throw new DeploymentConfigParseError(parseError);
  }
}

// Legacy exports for compatibility (no longer used but kept for type imports)
export function getDeploymentConfigPath(stackName: string): string {
  return `config.${stackName}.yaml`;
}
