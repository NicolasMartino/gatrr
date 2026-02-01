/**
 * Service registry
 *
 * Central registry for all service modules.
 * This is the single place to register new services.
 *
 * Adding a new service:
 * 1. Create module at services/<serviceId>/index.ts
 * 2. Import and add to SERVICE_CATALOG in catalog.ts
 * 3. Run: npm test && npm run build && pulumi preview
 */

import {
  ServiceModuleResult,
  OAuth2ProxyAuthzPolicy,
} from "../types";

// Re-export catalog types and functions
export {
  ServiceFactory,
  ServiceCatalogEntry,
  ServiceCatalog,
  SERVICE_CATALOG,
  getAvailableServiceIds,
  getServiceFactory,
  isServiceAvailable,
} from "./catalog";

/**
 * Derive authorization policies from service module results
 *
 * Extracts oauth2ProxyAuthz from services that have it.
 * This is the source of truth for realm role requirements.
 */
export function deriveAuthzPolicies(
  services: ServiceModuleResult[]
): Array<{ serviceId: string; policy: OAuth2ProxyAuthzPolicy }> {
  return services
    .filter((svc): svc is ServiceModuleResult & { oauth2ProxyAuthz: OAuth2ProxyAuthzPolicy } =>
      svc.oauth2ProxyAuthz !== undefined)
    .map((svc) => ({
      serviceId: svc.id,
      policy: svc.oauth2ProxyAuthz,
    }))
    .sort((a, b) => a.serviceId.localeCompare(b.serviceId, "en-US")); // Deterministic
}
