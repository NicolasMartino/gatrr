/**
 * Stack configuration parsing and validation
 *
 * Configuration is loaded from Pulumi stack config (Pulumi.<stack>.yaml)
 * and validated at program start.
 */

import * as pulumi from "@pulumi/pulumi";
import * as fs from "fs";
import * as path from "path";
import { isValidSlug } from "./constants";

/**
 * Read portal version from Cargo.toml
 *
 * Parses the version field from the portal's Cargo.toml.
 * Falls back to "0.0.0" if file cannot be read or parsed.
 */
export function getPortalVersion(repoRoot: string): string {
  const cargoPath = path.join(repoRoot, "portal", "Cargo.toml");
  try {
    const content = fs.readFileSync(cargoPath, "utf-8");
    const match = content.match(/^version\s*=\s*"([^"]+)"/m);
    if (match && match[1]) {
      return match[1];
    }
    throw new Error("Version field not found in Cargo.toml");
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.warn(`Warning: Could not read portal version from ${cargoPath}: ${errorMessage}`);
    return "0.0.0";
  }
}

/** ACME (Let's Encrypt) configuration */
export interface AcmeConfig {
  /** Email for Let's Encrypt registration */
  email: string;
  /** Use staging server (for testing) */
  staging?: boolean;
}

/**
 * Descriptor injection method
 *
 * Per plan.md, both mechanisms are first-class:
 * - "json": Inject via PORTAL_DESCRIPTOR_JSON env var (small descriptors only, 64KB limit)
 * - "file": Inject via PORTAL_DESCRIPTOR_PATH (preferred for real deployments, no size limit)
 */
export type DescriptorInjectionMethod = "json" | "file";

/** Maximum descriptor size for JSON env var injection (64KB per plan.md) */
export const DESCRIPTOR_JSON_MAX_SIZE = 64 * 1024;

/**
 * Build platform for Docker images
 *
 * - "linux/amd64": Build for x86_64 (standard servers, default)
 * - "linux/arm64": Build for ARM64 (Apple Silicon native, ARM servers)
 * - "native": Build for the host platform (fastest for local dev)
 */
export type BuildPlatform = "linux/amd64" | "linux/arm64" | "native";

/** Deployment configuration */
export interface DeploymentConfig {
  /** Deployment identifier (e.g., "prod", "staging", "local") */
  deploymentId: string;
  /** Environment type (e.g., "prod", "dev") */
  environment: string;
  /** Base domain (e.g., "localhost", "example.com") */
  baseDomain: string;
  /** Use HTTPS (true for prod, false for local) */
  useHttps: boolean;
  /** Keycloak realm name */
  keycloakRealm: string;
  /** ACME configuration (required when useHttps=true) */
  acme?: AcmeConfig;
  /**
   * Descriptor injection method for portal container
   * - "file": Use PORTAL_DESCRIPTOR_PATH (default, preferred for real deployments)
   * - "json": Use PORTAL_DESCRIPTOR_JSON (for small descriptors, 64KB limit enforced)
   */
  descriptorInjection: DescriptorInjectionMethod;
  /**
   * Build platform for Docker images
   * - "linux/amd64": Build for x86_64 (default, standard servers)
   * - "linux/arm64": Build for ARM64 (Apple Silicon native, ARM servers)
   * - "native": Build for host platform (fastest for local dev on Apple Silicon)
   */
  buildPlatform: BuildPlatform;
  /**
   * Run Keycloak in development mode (start-dev)
   * - true: Use start-dev with relaxed hostname validation (for local dev)
   * - false: Use production start with strict hostname validation (default)
   */
  keycloakDevMode: boolean;
}

/**
 * Load and validate configuration from Pulumi stack config
 */
export function getConfig(): DeploymentConfig {
  const config = new pulumi.Config();

  const deploymentId = config.require("deploymentId");
  const environment = config.require("environment");
  const baseDomain = config.require("baseDomain");
  const useHttps = config.getBoolean("useHttps") ?? false;
  const keycloakRealm = config.get("keycloakRealm") ?? "dev";

  // Keycloak development mode (default: false for production-safe defaults)
  const keycloakDevMode = config.getBoolean("keycloakDevMode") ?? false;

  // Descriptor injection method (default: file, which is preferred for real deployments)
  const descriptorInjectionRaw = config.get("descriptorInjection") ?? "file";
  if (descriptorInjectionRaw !== "json" && descriptorInjectionRaw !== "file") {
    throw new Error(
      `Invalid descriptorInjection "${descriptorInjectionRaw}": must be "json" or "file"`
    );
  }
  const descriptorInjection: DescriptorInjectionMethod = descriptorInjectionRaw;

  // Build platform (default: linux/amd64 for standard server deployments)
  const buildPlatformRaw = config.get("buildPlatform") ?? "linux/amd64";
  if (
    buildPlatformRaw !== "linux/amd64" &&
    buildPlatformRaw !== "linux/arm64" &&
    buildPlatformRaw !== "native"
  ) {
    throw new Error(
      `Invalid buildPlatform "${buildPlatformRaw}": must be "linux/amd64", "linux/arm64", or "native"`
    );
  }
  const buildPlatform: BuildPlatform = buildPlatformRaw;

  // ACME configuration (required when useHttps=true)
  const acmeEmail = config.get("acmeEmail");
  const acmeStaging = config.getBoolean("acmeStaging") ?? false;
  const acme: AcmeConfig | undefined =
    useHttps && acmeEmail ? { email: acmeEmail, staging: acmeStaging } : undefined;

  // Validate ACME config when HTTPS is enabled
  if (useHttps && !acme) {
    throw new Error(
      "ACME email (acmeEmail) is required when useHttps is true"
    );
  }

  // Validate slug format for deploymentId
  if (!isValidSlug(deploymentId)) {
    throw new Error(
      `Invalid deploymentId "${deploymentId}": must be lowercase alphanumeric with hyphens`
    );
  }

  // Validate slug format for environment
  if (!isValidSlug(environment)) {
    throw new Error(
      `Invalid environment "${environment}": must be lowercase alphanumeric with hyphens`
    );
  }

  return {
    deploymentId,
    environment,
    baseDomain,
    useHttps,
    keycloakRealm,
    keycloakDevMode,
    acme,
    descriptorInjection,
    buildPlatform,
  };
}

/**
 * Build a URL with the correct scheme based on config
 */
export function buildUrl(
  config: DeploymentConfig,
  subdomain?: string
): string {
  const scheme = config.useHttps ? "https" : "http";
  const host = subdomain
    ? `${subdomain}.${config.baseDomain}`
    : config.baseDomain;
  return `${scheme}://${host}`;
}
