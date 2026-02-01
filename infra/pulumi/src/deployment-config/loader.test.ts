/**
 * Tests for deployment configuration loader
 *
 * Note: loadDeploymentConfigFile reads from Pulumi config, which requires
 * a Pulumi runtime. These tests focus on the error classes and helper functions.
 */

import { describe, it, expect } from "vitest";
import {
  getDeploymentConfigPath,
  DeploymentConfigNotFoundError,
  DeploymentConfigParseError,
} from "./loader";

describe("getDeploymentConfigPath", () => {
  it("returns config filename for local stack", () => {
    const result = getDeploymentConfigPath("local");
    expect(result).toBe("config.local.yaml");
  });

  it("returns config filename for prod stack", () => {
    const result = getDeploymentConfigPath("prod");
    expect(result).toBe("config.prod.yaml");
  });

  it("returns config filename for any stack name", () => {
    const result = getDeploymentConfigPath("staging");
    expect(result).toBe("config.staging.yaml");
  });
});

describe("DeploymentConfigNotFoundError", () => {
  it("has correct name property", () => {
    const error = new DeploymentConfigNotFoundError("test");
    expect(error.name).toBe("DeploymentConfigNotFoundError");
  });

  it("exposes stackName", () => {
    const error = new DeploymentConfigNotFoundError("prod");
    expect(error.stackName).toBe("prod");
  });

  it("includes stack name in message", () => {
    const error = new DeploymentConfigNotFoundError("prod");
    expect(error.message).toContain("prod");
  });

  it("suggests running config:load", () => {
    const error = new DeploymentConfigNotFoundError("local");
    expect(error.message).toContain("npm run config:load");
  });

  it("mentions config file name", () => {
    const error = new DeploymentConfigNotFoundError("staging");
    expect(error.message).toContain("config.staging.yaml");
  });
});

describe("DeploymentConfigParseError", () => {
  it("has correct name property", () => {
    const error = new DeploymentConfigParseError("Unexpected token");
    expect(error.name).toBe("DeploymentConfigParseError");
  });

  it("exposes parseError", () => {
    const error = new DeploymentConfigParseError("Unexpected end of JSON");
    expect(error.parseError).toBe("Unexpected end of JSON");
  });

  it("includes parse error in message", () => {
    const error = new DeploymentConfigParseError("bad indentation");
    expect(error.message).toContain("bad indentation");
  });

  it("suggests running config:load", () => {
    const error = new DeploymentConfigParseError("Invalid YAML");
    expect(error.message).toContain("npm run config:load");
  });
});
