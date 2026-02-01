/**
 * Traefik dynamic configuration generation
 *
 * Generates the file provider configuration for Traefik.
 * This replaces label-based discovery with explicit routing rules.
 *
 * Pure functions - deterministic output for same input.
 */

import * as yaml from "yaml";
import { DeploymentConfig } from "../config";
import { RESERVED_HOSTS, isValidSlug } from "../constants";
import { RouteRequest, shortName } from "../types";

/** Traefik HTTP router configuration */
interface TraefikRouter {
  rule: string;
  service: string;
  entryPoints: string[];
  middlewares?: string[];
  tls?: {
    certResolver?: string;
  };
}

/** Traefik HTTP service configuration */
interface TraefikService {
  loadBalancer: {
    servers: Array<{ url: string }>;
  };
}

/** Traefik middleware configuration */
interface TraefikMiddleware {
  redirectRegex?: {
    regex: string;
    replacement: string;
    permanent: boolean;
  };
  headers?: {
    // Security headers
    contentTypeNosniff?: boolean;
    browserXssFilter?: boolean;
    frameDeny?: boolean;
    referrerPolicy?: string;
    contentSecurityPolicy?: string;
    // HSTS (only meaningful with HTTPS)
    stsSeconds?: number;
    stsIncludeSubdomains?: boolean;
    stsPreload?: boolean;
  };
  rateLimit?: {
    average: number;
    burst: number;
    period?: string;
  };
  inFlightReq?: {
    amount: number;
  };
}

/** Complete Traefik dynamic config structure */
interface TraefikDynamicConfig {
  http: {
    routers: Record<string, TraefikRouter>;
    services: Record<string, TraefikService>;
    middlewares?: Record<string, TraefikMiddleware>;
  };
}

/** Validation error for route requests */
export interface RouteValidationError {
  host: string;
  message: string;
}

/**
 * Validate route requests
 *
 * Checks for:
 * - Duplicate hosts
 * - Invalid host slugs
 * - Reserved hosts (portal, keycloak)
 *
 * Returns array of validation errors (empty if valid).
 */
export function validateRouteRequests(
  routes: RouteRequest[]
): RouteValidationError[] {
  const errors: RouteValidationError[] = [];
  const seenHosts = new Set<string>();

  for (const route of routes) {
    const { host } = route;

    // Check for duplicate hosts
    if (seenHosts.has(host)) {
      errors.push({
        host,
        message: `Duplicate host: "${host}" is defined multiple times`,
      });
    }
    seenHosts.add(host);

    // Check for invalid slug format
    if (!isValidSlug(host)) {
      errors.push({
        host,
        message: `Invalid host slug: "${host}" must be lowercase alphanumeric with hyphens`,
      });
    }

    // Check for reserved hosts
    if (RESERVED_HOSTS.includes(host)) {
      errors.push({
        host,
        message: `Reserved host: "${host}" is reserved for core infrastructure`,
      });
    }
  }

  return errors;
}

/**
 * Build security headers middleware for production
 * Only adds HSTS when HTTPS is enabled
 */
function buildSecurityHeadersMiddleware(config: DeploymentConfig): TraefikMiddleware {
  const middleware: TraefikMiddleware = {
    headers: {
      // Prevent MIME type sniffing
      contentTypeNosniff: true,
      // Legacy XSS filter (mostly superseded by CSP but harmless)
      browserXssFilter: true,
      // Prevent clickjacking
      frameDeny: true,
      // Control referrer header leakage
      referrerPolicy: "strict-origin-when-cross-origin",
      // Content Security Policy - restrictive baseline
      // Note: 'unsafe-inline' for styles needed for Tailwind's runtime styles if any
      contentSecurityPolicy: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'",
    },
  };

  // Add HSTS only when HTTPS is enabled (meaningless over HTTP)
  if (config.useHttps && middleware.headers) {
    middleware.headers.stsSeconds = 31536000; // 1 year
    middleware.headers.stsIncludeSubdomains = true;
    middleware.headers.stsPreload = true;
  }

  return middleware;
}

/**
 * Build security headers middleware for Keycloak with relaxed CSP
 *
 * Keycloak's login pages use inline scripts and dynamic styles that require
 * a more permissive CSP than regular application routes. Without this,
 * login flows break in production when strict CSP is applied.
 */
function buildKeycloakSecurityHeadersMiddleware(config: DeploymentConfig): TraefikMiddleware {
  const middleware: TraefikMiddleware = {
    headers: {
      // Prevent MIME type sniffing
      contentTypeNosniff: true,
      // Legacy XSS filter
      browserXssFilter: true,
      // Allow Keycloak to be framed (by itself for auth flows)
      // Note: frameDeny=false, but we could use frameOptions with SAMEORIGIN if needed
      frameDeny: false,
      // Control referrer header leakage
      referrerPolicy: "strict-origin-when-cross-origin",
      // Relaxed CSP for Keycloak: allows inline scripts/styles needed for login UI
      // Keycloak uses inline scripts for form handling and dynamic styles
      contentSecurityPolicy: "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; frame-ancestors 'self'",
    },
  };

  // Add HSTS only when HTTPS is enabled
  if (config.useHttps && middleware.headers) {
    middleware.headers.stsSeconds = 31536000;
    middleware.headers.stsIncludeSubdomains = true;
    middleware.headers.stsPreload = true;
  }

  return middleware;
}

/**
 * Build rate limiting middleware
 * Limits requests per source IP to prevent abuse
 */
function buildRateLimitMiddleware(): TraefikMiddleware {
  return {
    rateLimit: {
      average: 100, // requests per period
      burst: 50,    // allow burst above average
      period: "1s", // per second
    },
  };
}

/**
 * Build in-flight request limiting middleware
 * Limits concurrent connections per source IP to prevent slowloris-style attacks
 */
function buildInFlightReqMiddleware(): TraefikMiddleware {
  return {
    inFlightReq: {
      amount: 100, // max concurrent requests per source
    },
  };
}

/**
 * Check if security headers should be applied
 * Apply in production OR when HTTPS is enabled
 */
function shouldApplySecurityHeaders(config: DeploymentConfig): boolean {
  return config.environment === "prod" || config.useHttps;
}

/**
 * Check if rate limiting should be applied
 * Apply in production only (avoid dev friction)
 */
function shouldApplyRateLimiting(config: DeploymentConfig): boolean {
  return config.environment === "prod";
}

/**
 * Build router configuration with optional TLS, security headers, and rate limiting
 */
function buildRouter(
  config: DeploymentConfig,
  rule: string,
  service: string,
  additionalMiddlewares: string[] = []
): TraefikRouter {
  const middlewares = [...additionalMiddlewares];

  // Add rate limiting middleware in production (order matters: rate limit first)
  if (shouldApplyRateLimiting(config)) {
    middlewares.push("rate-limit");
    middlewares.push("in-flight-req");
  }

  // Add security headers middleware in production
  if (shouldApplySecurityHeaders(config)) {
    middlewares.push("security-headers");
  }

  const router: TraefikRouter = {
    rule,
    service,
    entryPoints: config.useHttps ? ["websecure"] : ["web"],
    ...(middlewares.length > 0 && { middlewares }),
  };

  // Add TLS configuration for HTTPS
  if (config.useHttps) {
    router.tls = { certResolver: "letsencrypt" };
  }

  return router;
}

/**
 * Core route for portal
 */
function buildPortalRoute(config: DeploymentConfig): {
  router: TraefikRouter;
  service: TraefikService;
} {
  const portalContainer = shortName(config.deploymentId, "portal");
  return {
    router: buildRouter(
      config,
      `Host(\`portal.${config.baseDomain}\`)`,
      "core-portal"
    ),
    service: {
      loadBalancer: {
        servers: [{ url: `http://${portalContainer}:3000` }],
      },
    },
  };
}

/**
 * Core route for Keycloak
 *
 * Uses keycloak-specific security headers with relaxed CSP to avoid
 * breaking login flows (Keycloak uses inline scripts/styles).
 */
function buildKeycloakRoute(config: DeploymentConfig): {
  router: TraefikRouter;
  service: TraefikService;
} {
  const keycloakContainer = shortName(config.deploymentId, "keycloak");

  // Build router manually to use keycloak-specific middleware instead of default
  const middlewares: string[] = [];

  // Add rate limiting middleware in production (order matters: rate limit first)
  if (shouldApplyRateLimiting(config)) {
    middlewares.push("rate-limit");
    middlewares.push("in-flight-req");
  }

  // Use Keycloak-specific security headers (relaxed CSP)
  if (shouldApplySecurityHeaders(config)) {
    middlewares.push("keycloak-security-headers");
  }

  const router: TraefikRouter = {
    rule: `Host(\`keycloak.${config.baseDomain}\`)`,
    service: "core-keycloak",
    entryPoints: config.useHttps ? ["websecure"] : ["web"],
    ...(middlewares.length > 0 && { middlewares }),
  };

  if (config.useHttps) {
    router.tls = { certResolver: "letsencrypt" };
  }

  return {
    router,
    service: {
      loadBalancer: {
        servers: [{ url: `http://${keycloakContainer}:8080` }],
      },
    },
  };
}

/**
 * Base domain redirect to portal
 * Redirects bare domain (e.g., localhost) to portal subdomain (e.g., portal.localhost)
 */
function buildBaseDomainRedirect(config: DeploymentConfig): {
  router: TraefikRouter;
  middleware: TraefikMiddleware;
} {
  const scheme = config.useHttps ? "https" : "http";
  const portalUrl = `${scheme}://portal.${config.baseDomain}`;

  const router: TraefikRouter = {
    rule: `Host(\`${config.baseDomain}\`)`,
    service: "noop@internal", // Traefik internal service (not used due to redirect)
    entryPoints: config.useHttps ? ["websecure"] : ["web"],
    middlewares: ["redirect-to-portal"],
  };

  if (config.useHttps) {
    router.tls = { certResolver: "letsencrypt" };
  }

  return {
    router,
    middleware: {
      redirectRegex: {
        regex: "^.*$",
        replacement: portalUrl,
        permanent: false, // Use 302 for flexibility
      },
    },
  };
}

/**
 * Build service route from RouteRequest
 *
 * Per architecture.md canonical naming:
 * - router name: host-${host}
 * - service name: svc-${host}
 */
function buildServiceRoute(
  config: DeploymentConfig,
  route: RouteRequest
): {
  routerName: string;
  serviceName: string;
  router: TraefikRouter;
  service: TraefikService;
} {
  const routerName = `host-${route.host}`;
  const serviceName = `svc-${route.host}`;

  return {
    routerName,
    serviceName,
    router: buildRouter(
      config,
      `Host(\`${route.host}.${config.baseDomain}\`)`,
      serviceName
    ),
    service: {
      loadBalancer: {
        servers: [
          { url: `http://${route.upstream.containerName}:${String(route.upstream.port)}` },
        ],
      },
    },
  };
}

/**
 * Sort routes by host for deterministic output
 */
function sortRoutes(routes: RouteRequest[]): RouteRequest[] {
  return [...routes].sort((a, b) => a.host.localeCompare(b.host, "en-US"));
}

/**
 * Generate Traefik dynamic configuration from deployment config and route requests
 *
 * This is a pure function - same inputs always produce same output.
 * Validates routes and throws on validation errors.
 */
export function generateTraefikConfig(
  config: DeploymentConfig,
  routes: RouteRequest[]
): TraefikDynamicConfig {
  // Validate routes first
  const validationErrors = validateRouteRequests(routes);
  if (validationErrors.length > 0) {
    const errorMessages = validationErrors
      .map((e) => `  - ${e.message}`)
      .join("\n");
    throw new Error(`Invalid route requests:\n${errorMessages}`);
  }

  const routers: Record<string, TraefikRouter> = {};
  const traefikServices: Record<string, TraefikService> = {};
  const middlewares: Record<string, TraefikMiddleware> = {};

  // Add security headers middleware in production
  if (shouldApplySecurityHeaders(config)) {
    middlewares["security-headers"] = buildSecurityHeadersMiddleware(config);
    // Keycloak needs relaxed CSP (inline scripts/styles for login UI)
    middlewares["keycloak-security-headers"] = buildKeycloakSecurityHeadersMiddleware(config);
  }

  // Add rate limiting middleware in production
  if (shouldApplyRateLimiting(config)) {
    middlewares["rate-limit"] = buildRateLimitMiddleware();
    middlewares["in-flight-req"] = buildInFlightReqMiddleware();
  }

  // Add base domain redirect to portal
  const baseDomainRedirect = buildBaseDomainRedirect(config);
  routers["redirect-base"] = baseDomainRedirect.router;
  middlewares["redirect-to-portal"] = baseDomainRedirect.middleware;

  // Add core routes (portal and keycloak)
  const portalRoute = buildPortalRoute(config);
  routers["core-portal"] = portalRoute.router;
  traefikServices["core-portal"] = portalRoute.service;

  const keycloakRoute = buildKeycloakRoute(config);
  routers["core-keycloak"] = keycloakRoute.router;
  traefikServices["core-keycloak"] = keycloakRoute.service;

  // Add service routes (sorted for deterministic output)
  for (const route of sortRoutes(routes)) {
    const serviceRoute = buildServiceRoute(config, route);
    routers[serviceRoute.routerName] = serviceRoute.router;
    traefikServices[serviceRoute.serviceName] = serviceRoute.service;
  }

  return {
    http: {
      routers,
      services: traefikServices,
      middlewares,
    },
  };
}

/**
 * Serialize Traefik config to YAML
 */
export function serializeTraefikConfig(config: TraefikDynamicConfig): string {
  return yaml.stringify(config);
}

/**
 * Generate complete Traefik dynamic config as YAML string
 */
export function generateTraefikConfigYaml(
  config: DeploymentConfig,
  routes: RouteRequest[]
): string {
  const traefikConfig = generateTraefikConfig(config, routes);
  return serializeTraefikConfig(traefikConfig);
}
