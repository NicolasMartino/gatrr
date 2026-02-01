/**
 * Service catalog
 *
 * Registry of available service modules that CAN be deployed.
 * The deployment config determines which services ARE deployed.
 *
 * @see plan.md section 2.9.4 for catalog vs deployed services distinction
 */

import * as pulumi from "@pulumi/pulumi";
import { ServiceContext, ServiceModuleResult } from "../types";

// Import service factories
import { createDemoService } from "./demo";
import { createDocsService } from "./docs";
import { createDozzleService } from "./dozzle";
import { createLogsService } from "./logs";

/**
 * Service factory function type
 *
 * Services that need oauth2-proxy protection receive a clientSecret.
 * Public services don't need one.
 */
export type ServiceFactory = (inputs: {
  context: ServiceContext;
  clientSecret?: pulumi.Input<string>;
}) => ServiceModuleResult;

/**
 * Entry in the service catalog
 */
export interface ServiceCatalogEntry {
  /** Factory function to create the service */
  factory: ServiceFactory;
  /** Optional description of the service module */
  description?: string;
}

/**
 * Service catalog type
 */
export type ServiceCatalog = Record<string, ServiceCatalogEntry>;

/**
 * Service catalog - available service modules
 *
 * This is the registry of all services that CAN be deployed.
 * Add new services here to make them available for deployment.
 *
 * Note: Whether a service IS deployed is determined by deployment config,
 * not by presence in this catalog.
 */
export const SERVICE_CATALOG: ServiceCatalog = {
  demo: {
    factory: createDemoService,
    description: "Demo application with OAuth2 protection",
  },
  docs: {
    factory: createDocsService,
    description: "Public documentation (no auth required)",
  },
  dozzle: {
    factory: createDozzleService,
    description: "Container log viewer (admin only)",
  },
  logs: {
    factory: createLogsService,
    description: "Centralized logs (Grafana + Loki)",
  },
};

/**
 * Get list of available service IDs from catalog
 *
 * @returns Sorted array of service IDs
 */
export function getAvailableServiceIds(): string[] {
  return Object.keys(SERVICE_CATALOG).sort();
}

/**
 * Get factory for a service ID
 *
 * @param id - Service ID
 * @returns Factory function or undefined if not in catalog
 */
export function getServiceFactory(id: string): ServiceFactory | undefined {
  return SERVICE_CATALOG[id]?.factory;
}

/**
 * Check if a service ID exists in the catalog
 *
 * @param id - Service ID to check
 * @returns true if service is available
 */
export function isServiceAvailable(id: string): boolean {
  return id in SERVICE_CATALOG;
}
