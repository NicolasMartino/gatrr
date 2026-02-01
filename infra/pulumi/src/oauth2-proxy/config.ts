/**
 * OAuth2-Proxy configuration generation - pure functions
 *
 * These functions build the oauth2-proxy environment variables.
 * They are pure (no side effects, deterministic) and unit-testable.
 */

import { DeploymentConfig, buildUrl } from "../config";

/**
 * Build redirect whitelist domains for oauth2-proxy.
 *
 * Required when using `rd=...` redirects on `/oauth2/sign_out`.
 * See: https://oauth2-proxy.github.io/oauth2-proxy/features/endpoints/#sign-out
 */
function buildWhitelistDomains(baseDomain: string): string {
  return baseDomain === "localhost" ? ".localhost" : `.${baseDomain}`;
}

/**
 * Inputs for building oauth2-proxy environment variables
 */
export interface OAuth2ProxyEnvInputs {
  /** Deployment configuration */
  config: DeploymentConfig;
  /** Service identifier (used for client ID and cookie name) */
  serviceId: string;
  /**
   * Host subdomain for redirect URL (defaults to serviceId if not provided)
   * Use when the public-facing host differs from the service ID
   * e.g., serviceId="logs" but host="grafana" → redirect to grafana.<domain>
   */
  host?: string;
  /**
   * Keycloak internal issuer URL (e.g., http://local-keycloak:8080/realms/dev)
   * Used for OIDC discovery in development where public URL isn't resolvable from Docker
   */
  keycloakInternalIssuerUrl: string;
  /**
   * Keycloak public issuer URL (e.g., https://keycloak.example.com/realms/prod)
   * Used for OIDC discovery in production where issuer verification is enabled
   * and public DNS is resolvable from within Docker containers
   */
  keycloakPublicIssuerUrl: string;
  /** OAuth2 client secret */
  clientSecret: string;
  /** Cookie secret (must be exactly 16, 24, or 32 bytes) */
  cookieSecret: string;
  /** Upstream container name */
  upstreamContainerName: string;
  /** Upstream port */
  upstreamPort: number;
  /** Required realm roles for authorization */
  requiredRealmRoles: string[];
}

/**
 * Build oauth2-proxy environment variables
 *
 * This is a pure function - same inputs always produce same output.
 * Returns an array of environment variable strings (KEY=value format).
 */
export function buildOAuth2ProxyEnvs(inputs: OAuth2ProxyEnvInputs): string[] {
  const {
    config,
    serviceId,
    host,
    keycloakInternalIssuerUrl,
    keycloakPublicIssuerUrl,
    clientSecret,
    cookieSecret,
    upstreamContainerName,
    upstreamPort,
    requiredRealmRoles,
  } = inputs;

  // Use host for URL if provided, otherwise default to serviceId
  const serviceUrl = buildUrl(config, host ?? serviceId);

  // In dev: use internal URL (Keycloak not resolvable via public DNS from Docker)
  // In prod: use public URL (matches what Keycloak advertises in tokens)
  const oidcIssuerUrl =
    config.environment === "dev"
      ? keycloakInternalIssuerUrl
      : keycloakPublicIssuerUrl;

  const envs: string[] = [
    // Provider configuration
    "OAUTH2_PROXY_PROVIDER=oidc",
    `OAUTH2_PROXY_OIDC_ISSUER_URL=${oidcIssuerUrl}`,
    `OAUTH2_PROXY_CLIENT_ID=oauth2-proxy-${serviceId}`,
    `OAUTH2_PROXY_CLIENT_SECRET=${clientSecret}`,
    // Skip issuer verification only in dev - internal URL doesn't match token issuer
    // In production, issuer verification is enabled since we use the public URL
    config.environment === "dev"
      ? "OAUTH2_PROXY_INSECURE_OIDC_SKIP_ISSUER_VERIFICATION=true"
      : "OAUTH2_PROXY_INSECURE_OIDC_SKIP_ISSUER_VERIFICATION=false",
    // Request only standard OIDC scopes (Keycloak doesn't have 'groups' scope by default)
    // Realm roles are mapped to 'groups' claim via protocol mapper, not via scope
    "OAUTH2_PROXY_SCOPE=openid email profile",

    // Cookie configuration
    `OAUTH2_PROXY_COOKIE_SECRET=${cookieSecret}`,
    `OAUTH2_PROXY_COOKIE_NAME=_oauth2_proxy_${serviceId}`,
    "OAUTH2_PROXY_COOKIE_SAMESITE=lax",
    config.useHttps
      ? "OAUTH2_PROXY_COOKIE_SECURE=true"
      : "OAUTH2_PROXY_COOKIE_SECURE=false",

    // Upstream configuration
    `OAUTH2_PROXY_UPSTREAMS=http://${upstreamContainerName}:${upstreamPort}/`,

    // Redirect configuration
    `OAUTH2_PROXY_REDIRECT_URL=${serviceUrl}/oauth2/callback`,

    // Redirect whitelist (required for rd=... on /oauth2/sign_out)
    `OAUTH2_PROXY_WHITELIST_DOMAINS=${buildWhitelistDomains(config.baseDomain)}`,

    // Listener configuration
    "OAUTH2_PROXY_HTTP_ADDRESS=0.0.0.0:4180",

    // Email domain (allow all for dev)
    "OAUTH2_PROXY_EMAIL_DOMAINS=*",

    // Skip provider button (go straight to Keycloak)
    "OAUTH2_PROXY_SKIP_PROVIDER_BUTTON=true",

    // Pass auth headers to upstream
    "OAUTH2_PROXY_PASS_ACCESS_TOKEN=true",
    "OAUTH2_PROXY_PASS_AUTHORIZATION_HEADER=true",
    "OAUTH2_PROXY_SET_XAUTHREQUEST=true",

    // Silence some logs
    "OAUTH2_PROXY_SILENCE_PING_LOGGING=true",

    // Realm role authorization (mapped to groups claim)
    // Explicitly set the groups claim name to avoid relying on provider defaults
    // This ensures consistent behavior across oauth2-proxy versions
    "OAUTH2_PROXY_OIDC_GROUPS_CLAIM=groups",
    `OAUTH2_PROXY_ALLOWED_GROUPS=${requiredRealmRoles.join(",")}`,
  ];

  // Cookie domain configuration
  // Security: Default to host-only cookies (no OAUTH2_PROXY_COOKIE_DOMAINS)
  // oauth2-proxy will use the request host automatically.
  // This limits cookie exposure surface - cookies from demo.example.com
  // won't be sent to other subdomains.
  //
  // If cross-subdomain SSO is explicitly required, set OAUTH2_PROXY_COOKIE_DOMAINS
  // to ".example.com" in the deployment config.

  return envs;
}

/**
 * Get a specific environment variable value from the envs array
 *
 * Utility function for testing.
 */
export function getEnvValue(envs: string[], key: string): string | undefined {
  const prefix = `${key}=`;
  const env = envs.find((e) => e.startsWith(prefix));
  return env ? env.slice(prefix.length) : undefined;
}
