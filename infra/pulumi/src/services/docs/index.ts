/**
 * Docs service module
 *
 * A public documentation service (no authentication required).
 * This module creates:
 * - App container (nginx as placeholder)
 *
 * Returns portal entry and route requests (no authorization policy).
 */

import { buildUrl, getPortalVersion } from "../../config";
import {
  ServiceContext,
  ServiceModuleResult,
  PortalService,
  RouteRequest,
  createContainer,
  ContainerIdentity,
  shortName,
} from "../../types";
import * as path from "path";

// Compute repo root from this file's location
const repoRoot = path.resolve(__dirname, "../../../../..");

/** Docs service configuration */
const SERVICE_ID = "docs";
const SERVICE_NAME = "Documentation";
const SERVICE_GROUP = "docs";
const SERVICE_ICON = "book";
const SERVICE_DESCRIPTION = "Public documentation (no auth required)";
const APP_IMAGE = "nginx:alpine";
const APP_PORT = 80;

/** Project version from portal's Cargo.toml */
const PROJECT_VERSION = getPortalVersion(repoRoot);

export interface DocsServiceInputs {
  context: ServiceContext;
  /** Not used - docs is a public service (ignored if provided) */
  clientSecret?: unknown;
}

/**
 * Create the docs service module
 */
export function createDocsService(inputs: DocsServiceInputs): ServiceModuleResult {
  const { context } = inputs;
  const { config, network } = context;

  // Build container identity
  const identity: ContainerIdentity = {
    deploymentId: config.deploymentId,
    serviceId: SERVICE_ID,
    version: PROJECT_VERSION,
  };

  // Service URL
  const serviceUrl = buildUrl(config, SERVICE_ID);

  // Create app container
  const appContainer = createContainer(
    identity,
    {
      network,
      image: APP_IMAGE,
      restart: "unless-stopped",
    },
    {
      dependsOn: [network],
    }
  );

  // Stable address for routing
  const appContainerAddress = shortName(config.deploymentId, SERVICE_ID);

  // Build portal entry
  const portal: PortalService = {
    id: SERVICE_ID,
    name: SERVICE_NAME,
    url: serviceUrl,
    protected: false,
    authType: "none",
    group: SERVICE_GROUP,
    icon: SERVICE_ICON,
    description: SERVICE_DESCRIPTION,
  };

  // Build route request (Traefik routes directly to the app)
  const routes: RouteRequest[] = [
    {
      host: SERVICE_ID,
      upstream: {
        containerName: appContainerAddress,
        port: APP_PORT,
      },
    },
  ];

  return {
    id: SERVICE_ID,
    portal,
    routes,
    // No oauth2ProxyAuthz - this is a public service
    resources: {
      container: appContainer,
    },
  };
}
