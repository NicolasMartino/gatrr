/**
 * Tests for OAuth2-Proxy configuration generation
 *
 * These tests verify:
 * - OAUTH2_PROXY_ALLOWED_GROUPS is set correctly from required realm roles
 * - Redirect URL is correct
 * - Cookie domain logic is correct for localhost vs real domains
 * - Cookie secure flag matches useHttps
 */

import { describe, it, expect } from "vitest";
import {
  buildOAuth2ProxyEnvs,
  getEnvValue,
  OAuth2ProxyEnvInputs,
} from "./config";
import { DeploymentConfig } from "../config";

const testConfig: DeploymentConfig = {
  deploymentId: "local",
  environment: "dev",
  baseDomain: "localhost",
  useHttps: false,
  keycloakRealm: "dev",
  descriptorInjection: "file",
  buildPlatform: "linux/amd64",
};

const testConfigHttps: DeploymentConfig = {
  ...testConfig,
  deploymentId: "prod",
  environment: "prod",
  baseDomain: "example.com",
  useHttps: true,
};

const baseInputs: OAuth2ProxyEnvInputs = {
  config: testConfig,
  serviceId: "demo",
  keycloakInternalIssuerUrl: "http://local-keycloak:8080/realms/dev",
  keycloakPublicIssuerUrl: "http://keycloak.localhost/realms/dev",
  clientSecret: "test-client-secret",
  cookieSecret: "abcdefghijklmnopqrstuvwxyz123456",  // 32 chars
  upstreamContainerName: "local-demo",
  upstreamPort: 80,
  requiredRealmRoles: ["demo"],
};

describe("buildOAuth2ProxyEnvs", () => {
  describe("OIDC groups claim", () => {
    it("explicitly sets groups claim name for version stability", () => {
      // Per plan.md A2: Make oauth2-proxy "groups claim" handling explicit
      // This ensures behavior doesn't vary by oauth2-proxy version/provider defaults
      const envs = buildOAuth2ProxyEnvs(baseInputs);

      expect(getEnvValue(envs, "OAUTH2_PROXY_OIDC_GROUPS_CLAIM")).toBe("groups");
    });
  });

  describe("OAUTH2_PROXY_ALLOWED_GROUPS", () => {
    it("sets allowed groups from single required role", () => {
      const envs = buildOAuth2ProxyEnvs(baseInputs);

      expect(getEnvValue(envs, "OAUTH2_PROXY_ALLOWED_GROUPS")).toBe("demo");
    });

    it("sets allowed groups from multiple required roles (comma-joined)", () => {
      const inputs: OAuth2ProxyEnvInputs = {
        ...baseInputs,
        requiredRealmRoles: ["admin", "ops"],
      };

      const envs = buildOAuth2ProxyEnvs(inputs);

      expect(getEnvValue(envs, "OAUTH2_PROXY_ALLOWED_GROUPS")).toBe("admin,ops");
    });

    it("handles empty roles array", () => {
      const inputs: OAuth2ProxyEnvInputs = {
        ...baseInputs,
        requiredRealmRoles: [],
      };

      const envs = buildOAuth2ProxyEnvs(inputs);

      expect(getEnvValue(envs, "OAUTH2_PROXY_ALLOWED_GROUPS")).toBe("");
    });
  });

  describe("redirect URL", () => {
    it("sets correct redirect URL for localhost", () => {
      const envs = buildOAuth2ProxyEnvs(baseInputs);

      expect(getEnvValue(envs, "OAUTH2_PROXY_REDIRECT_URL")).toBe(
        "http://demo.localhost/oauth2/callback"
      );
    });

    it("sets correct redirect URL for real domain with HTTPS", () => {
      const inputs: OAuth2ProxyEnvInputs = {
        ...baseInputs,
        config: testConfigHttps,
        serviceId: "admin",
      };

      const envs = buildOAuth2ProxyEnvs(inputs);

      expect(getEnvValue(envs, "OAUTH2_PROXY_REDIRECT_URL")).toBe(
        "https://admin.example.com/oauth2/callback"
      );
    });
  });

  describe("cookie domain", () => {
    it("does not set cookie domain for localhost (host-only cookies)", () => {
      const envs = buildOAuth2ProxyEnvs(baseInputs);

      // Security: No cookie domain = host-only cookies
      expect(getEnvValue(envs, "OAUTH2_PROXY_COOKIE_DOMAINS")).toBeUndefined();
    });

    it("does not set cookie domain for real domains (host-only cookies)", () => {
      // Security: Default to host-only cookies to limit cookie exposure surface.
      // Cross-subdomain SSO requires explicit configuration if needed.
      const inputs: OAuth2ProxyEnvInputs = {
        ...baseInputs,
        config: testConfigHttps,
      };

      const envs = buildOAuth2ProxyEnvs(inputs);

      expect(getEnvValue(envs, "OAUTH2_PROXY_COOKIE_DOMAINS")).toBeUndefined();
    });
  });

  describe("cookie secure flag", () => {
    it("sets cookie secure to false when useHttps is false", () => {
      const envs = buildOAuth2ProxyEnvs(baseInputs);

      expect(getEnvValue(envs, "OAUTH2_PROXY_COOKIE_SECURE")).toBe("false");
    });

    it("sets cookie secure to true when useHttps is true", () => {
      const inputs: OAuth2ProxyEnvInputs = {
        ...baseInputs,
        config: testConfigHttps,
      };

      const envs = buildOAuth2ProxyEnvs(inputs);

      expect(getEnvValue(envs, "OAUTH2_PROXY_COOKIE_SECURE")).toBe("true");
    });
  });

  describe("OIDC configuration", () => {
    it("uses internal issuer URL in dev environment", () => {
      const envs = buildOAuth2ProxyEnvs(baseInputs);

      expect(getEnvValue(envs, "OAUTH2_PROXY_OIDC_ISSUER_URL")).toBe(
        "http://local-keycloak:8080/realms/dev"
      );
    });

    it("uses public issuer URL in prod environment", () => {
      const inputs: OAuth2ProxyEnvInputs = {
        ...baseInputs,
        config: testConfigHttps,
        keycloakPublicIssuerUrl: "https://keycloak.example.com/realms/prod",
      };

      const envs = buildOAuth2ProxyEnvs(inputs);

      expect(getEnvValue(envs, "OAUTH2_PROXY_OIDC_ISSUER_URL")).toBe(
        "https://keycloak.example.com/realms/prod"
      );
    });

    it("sets correct client ID based on service ID", () => {
      const envs = buildOAuth2ProxyEnvs(baseInputs);

      expect(getEnvValue(envs, "OAUTH2_PROXY_CLIENT_ID")).toBe("oauth2-proxy-demo");
    });

    it("sets client secret", () => {
      const envs = buildOAuth2ProxyEnvs(baseInputs);

      expect(getEnvValue(envs, "OAUTH2_PROXY_CLIENT_SECRET")).toBe("test-client-secret");
    });

    it("skips issuer verification in dev (internal/external URL mismatch)", () => {
      const envs = buildOAuth2ProxyEnvs(baseInputs);

      expect(getEnvValue(envs, "OAUTH2_PROXY_INSECURE_OIDC_SKIP_ISSUER_VERIFICATION")).toBe(
        "true"
      );
    });

    it("enables issuer verification in prod", () => {
      const inputs: OAuth2ProxyEnvInputs = {
        ...baseInputs,
        config: testConfigHttps,
        keycloakPublicIssuerUrl: "https://keycloak.example.com/realms/prod",
      };

      const envs = buildOAuth2ProxyEnvs(inputs);

      expect(getEnvValue(envs, "OAUTH2_PROXY_INSECURE_OIDC_SKIP_ISSUER_VERIFICATION")).toBe(
        "false"
      );
    });

    it("requests standard OIDC scopes", () => {
      const envs = buildOAuth2ProxyEnvs(baseInputs);

      expect(getEnvValue(envs, "OAUTH2_PROXY_SCOPE")).toBe("openid email profile");
    });
  });

  describe("upstream configuration", () => {
    it("sets correct upstream URL", () => {
      const envs = buildOAuth2ProxyEnvs(baseInputs);

      expect(getEnvValue(envs, "OAUTH2_PROXY_UPSTREAMS")).toBe(
        "http://local-demo:80/"
      );
    });

    it("uses custom upstream port", () => {
      const inputs: OAuth2ProxyEnvInputs = {
        ...baseInputs,
        upstreamContainerName: "my-app",
        upstreamPort: 8080,
      };

      const envs = buildOAuth2ProxyEnvs(inputs);

      expect(getEnvValue(envs, "OAUTH2_PROXY_UPSTREAMS")).toBe(
        "http://my-app:8080/"
      );
    });
  });

  describe("cookie configuration", () => {
    it("sets unique cookie name per service", () => {
      const envs = buildOAuth2ProxyEnvs(baseInputs);

      expect(getEnvValue(envs, "OAUTH2_PROXY_COOKIE_NAME")).toBe("_oauth2_proxy_demo");
    });

    it("sets cookie secret", () => {
      const envs = buildOAuth2ProxyEnvs(baseInputs);

      expect(getEnvValue(envs, "OAUTH2_PROXY_COOKIE_SECRET")).toBe(
        "abcdefghijklmnopqrstuvwxyz123456"
      );
    });

    it("sets cookie samesite to lax", () => {
      const envs = buildOAuth2ProxyEnvs(baseInputs);

      expect(getEnvValue(envs, "OAUTH2_PROXY_COOKIE_SAMESITE")).toBe("lax");
    });
  });

  describe("other settings", () => {
    it("sets provider to oidc", () => {
      const envs = buildOAuth2ProxyEnvs(baseInputs);

      expect(getEnvValue(envs, "OAUTH2_PROXY_PROVIDER")).toBe("oidc");
    });

    it("allows all email domains", () => {
      const envs = buildOAuth2ProxyEnvs(baseInputs);

      expect(getEnvValue(envs, "OAUTH2_PROXY_EMAIL_DOMAINS")).toBe("*");
    });

    it("skips provider button", () => {
      const envs = buildOAuth2ProxyEnvs(baseInputs);

      expect(getEnvValue(envs, "OAUTH2_PROXY_SKIP_PROVIDER_BUTTON")).toBe("true");
    });

    it("passes access token to upstream", () => {
      const envs = buildOAuth2ProxyEnvs(baseInputs);

      expect(getEnvValue(envs, "OAUTH2_PROXY_PASS_ACCESS_TOKEN")).toBe("true");
      expect(getEnvValue(envs, "OAUTH2_PROXY_PASS_AUTHORIZATION_HEADER")).toBe("true");
      expect(getEnvValue(envs, "OAUTH2_PROXY_SET_XAUTHREQUEST")).toBe("true");
    });

    it("listens on correct address", () => {
      const envs = buildOAuth2ProxyEnvs(baseInputs);

      expect(getEnvValue(envs, "OAUTH2_PROXY_HTTP_ADDRESS")).toBe("0.0.0.0:4180");
    });
  });
});

describe("getEnvValue", () => {
  it("returns value for existing key", () => {
    const envs = ["FOO=bar", "BAZ=qux"];

    expect(getEnvValue(envs, "FOO")).toBe("bar");
    expect(getEnvValue(envs, "BAZ")).toBe("qux");
  });

  it("returns undefined for missing key", () => {
    const envs = ["FOO=bar"];

    expect(getEnvValue(envs, "MISSING")).toBeUndefined();
  });

  it("handles values with equals signs", () => {
    const envs = ["URL=http://example.com?foo=bar"];

    expect(getEnvValue(envs, "URL")).toBe("http://example.com?foo=bar");
  });

  it("handles empty values", () => {
    const envs = ["EMPTY="];

    expect(getEnvValue(envs, "EMPTY")).toBe("");
  });
});
