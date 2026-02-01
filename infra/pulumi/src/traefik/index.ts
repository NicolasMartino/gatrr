/**
 * Traefik reverse proxy container
 *
 * Traefik handles all incoming HTTP traffic and routes to services
 * based on the file provider configuration (no labels).
 *
 * Supports both HTTP-only (local dev) and HTTPS with ACME (production).
 */

import * as docker from "@pulumi/docker";
import * as pulumi from "@pulumi/pulumi";
import { DeploymentConfig } from "../config";
import { RouteRequest, volumeName, createContainer, ContainerIdentity } from "../types";
import { generateTraefikConfigYaml } from "./dynamic-config";

/** Traefik version (from image tag) */
const TRAEFIK_VERSION = "v3.0";

export interface TraefikInputs {
  config: DeploymentConfig;
  /** Route requests from all service modules */
  routes: RouteRequest[];
  network: docker.Network;
}

export interface TraefikResources {
  container: docker.Container;
  dynamicConfigYaml: string;
  /** ACME storage volume (only created when useHttps=true) */
  acmeVolume?: docker.Volume;
}

/**
 * Build Traefik static configuration command args
 */
function buildStaticConfig(config: DeploymentConfig): string[] {
  const args = [
    "--entrypoints.web.address=:80",
    "--providers.file.filename=/etc/traefik/dynamic.yaml",
    "--providers.file.watch=true",
    "--log.level=INFO",
    // Access logs for request-level visibility (JSON for Loki parsing)
    "--accesslog=true",
    "--accesslog.format=json",
  ];

  // Only enable insecure dashboard API in dev environment
  if (config.environment === "dev") {
    args.push("--api.insecure=true", "--api.dashboard=true");
  }

  if (config.useHttps && config.acme) {
    // Add HTTPS entrypoint
    args.push("--entrypoints.websecure.address=:443");

    // Configure ACME (Let's Encrypt)
    args.push(`--certificatesresolvers.letsencrypt.acme.email=${config.acme.email}`);
    args.push("--certificatesresolvers.letsencrypt.acme.storage=/acme/acme.json");
    args.push("--certificatesresolvers.letsencrypt.acme.httpchallenge.entrypoint=web");

    // Use staging server for testing
    if (config.acme.staging) {
      args.push(
        "--certificatesresolvers.letsencrypt.acme.caserver=https://acme-staging-v02.api.letsencrypt.org/directory"
      );
    }

    // Redirect HTTP to HTTPS
    args.push("--entrypoints.web.http.redirections.entrypoint.to=websecure");
    args.push("--entrypoints.web.http.redirections.entrypoint.scheme=https");
  }

  return args;
}

/**
 * Create ACME storage Docker volume
 *
 * Uses a Docker volume instead of host filesystem to:
 * - Avoid host-side side effects during pulumi up
 * - Prevent permission issues in CI environments
 * - Keep ACME data managed by Docker
 */
function createAcmeVolume(deploymentId: string): docker.Volume {
  const name = volumeName(deploymentId, "acme");
  return new docker.Volume(name, {
    name,
    // Labels for identification
    labels: [
      { label: "deployment", value: deploymentId },
      { label: "purpose", value: "acme-storage" },
    ],
  });
}

/**
 * Create Traefik reverse proxy container
 */
export function createTraefik(inputs: TraefikInputs): TraefikResources {
  const { config, routes, network } = inputs;

  // Generate dynamic config YAML from route requests
  const dynamicConfigYaml = generateTraefikConfigYaml(config, routes);

  // Build static configuration
  const staticConfig = buildStaticConfig(config);

  // Build port mappings
  const ports: docker.types.input.ContainerPort[] = [
    { internal: 80, external: 80 },
  ];

  // Only expose dashboard port in dev environment
  if (config.environment === "dev") {
    ports.push({ internal: 8080, external: 8080 });
  }

  // Add HTTPS port if enabled
  if (config.useHttps) {
    ports.push({ internal: 443, external: 443 });
  }

  // Build volume mounts
  const mounts: docker.types.input.ContainerMount[] = [];
  let acmeVolume: docker.Volume | undefined;

  // Add ACME storage volume if HTTPS is enabled
  // Uses Docker volume instead of host filesystem to avoid side effects
  if (config.useHttps) {
    acmeVolume = createAcmeVolume(config.deploymentId);
    mounts.push({
      type: "volume",
      source: acmeVolume.name,
      target: "/acme",
    });
  }

  // Build container identity
  const identity: ContainerIdentity = {
    deploymentId: config.deploymentId,
    serviceId: "traefik",
    version: TRAEFIK_VERSION,
  };

  // Build dependencies list
  const dependsOn: pulumi.Resource[] = [network];
  if (acmeVolume) {
    dependsOn.push(acmeVolume);
  }

  const container = createContainer(
    identity,
    {
      network,
      image: `traefik:${TRAEFIK_VERSION}`,
      command: staticConfig,
      ports,
      mounts: mounts.length > 0 ? mounts : undefined,
      uploads: [
        {
          file: "/etc/traefik/dynamic.yaml",
          content: dynamicConfigYaml,
        },
      ],
      restart: "unless-stopped",
    },
    {
      dependsOn,
    }
  );

  return {
    container,
    dynamicConfigYaml,
    acmeVolume,
  };
}
