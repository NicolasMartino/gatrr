/**
 * Unified user configuration types and parsing
 *
 * Supports reading complete user config (including passwords) from:
 * 1. Local YAML file (secrets.local.yaml)
 * 2. Pulumi config secret (secrets:unifiedUsers)
 * 3. Pulumi ESC environment
 *
 * This replaces the split model where user metadata came from deployment config
 * and passwords came from separate Pulumi secrets.
 */

import * as yaml from "js-yaml";
import { isValidUsername, isValidEmail, isValidRole } from "./types";

// =============================================================================
// Types
// =============================================================================

/**
 * Raw unified user config as read from YAML
 *
 * All fields except username and password are optional.
 */
export interface UnifiedUserInput {
  readonly username: string;
  readonly password: string;
  readonly email?: string;
  readonly firstName?: string;
  readonly lastName?: string;
  /** Can be a single role string or array of roles */
  readonly roles?: string | readonly string[];
}

/**
 * Raw unified secrets config as read from YAML
 */
export interface UnifiedSecretsInput {
  readonly keycloakAdminUsername: string;
  readonly keycloakAdminPassword: string;
  readonly users: readonly UnifiedUserInput[];
}

/**
 * Resolved unified user config with all defaults applied
 */
export interface ResolvedUnifiedUser {
  readonly username: string;
  readonly password: string;
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly roles: readonly string[];
}

/**
 * Resolved unified secrets config
 */
export interface ResolvedUnifiedSecrets {
  readonly keycloakAdminUsername: string;
  readonly keycloakAdminPassword: string;
  readonly users: readonly ResolvedUnifiedUser[];
}

// =============================================================================
// Parsing and Validation
// =============================================================================

/**
 * Normalize roles to an array
 *
 * Accepts:
 * - undefined -> []
 * - "admin" -> ["admin"]
 * - ["admin", "dev"] -> ["admin", "dev"]
 */
export function normalizeRoles(
  roles: string | readonly string[] | undefined
): readonly string[] {
  if (roles === undefined) {
    return [];
  }
  if (typeof roles === "string") {
    return [roles];
  }
  return roles;
}

/**
 * Capitalize first letter of a string
 */
function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Resolve a unified user input to a fully-populated user
 *
 * Applies defaults for optional fields:
 * - email: {username}@{stackName}.local
 * - firstName: Capitalized username
 * - lastName: "User"
 * - roles: [] (empty array)
 */
export function resolveUnifiedUser(
  user: UnifiedUserInput,
  stackName: string
): ResolvedUnifiedUser {
  return {
    username: user.username,
    password: user.password,
    email: user.email ?? `${user.username}@${stackName}.local`,
    firstName: user.firstName ?? capitalize(user.username),
    lastName: user.lastName ?? "User",
    roles: normalizeRoles(user.roles),
  };
}

// =============================================================================
// Validation Helpers
// =============================================================================

type ValidationError = { path: string; message: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateUnifiedUserInput(
  value: unknown,
  index: number
): { user: UnifiedUserInput; errors: ValidationError[] } | { user: null; errors: ValidationError[] } {
  const errors: ValidationError[] = [];
  const path = `users[${String(index)}]`;

  if (!isPlainObject(value)) {
    errors.push({ path, message: "must be an object" });
    return { user: null, errors };
  }

  // Required: username
  if (typeof value.username !== "string" || value.username.trim() === "") {
    errors.push({ path: `${path}.username`, message: "must be a non-empty string" });
  } else if (!isValidUsername(value.username)) {
    errors.push({
      path: `${path}.username`,
      message: `"${value.username}" is not a valid username (must be lowercase slug)`,
    });
  }

  // Required: password
  if (typeof value.password !== "string" || value.password.trim() === "") {
    errors.push({ path: `${path}.password`, message: "must be a non-empty string" });
  }

  // Optional: email
  if (value.email !== undefined) {
    if (typeof value.email !== "string") {
      errors.push({ path: `${path}.email`, message: "must be a string" });
    } else if (!isValidEmail(value.email)) {
      errors.push({ path: `${path}.email`, message: `"${value.email}" is not a valid email` });
    }
  }

  // Optional: firstName
  if (value.firstName !== undefined && typeof value.firstName !== "string") {
    errors.push({ path: `${path}.firstName`, message: "must be a string" });
  }

  // Optional: lastName
  if (value.lastName !== undefined && typeof value.lastName !== "string") {
    errors.push({ path: `${path}.lastName`, message: "must be a string" });
  }

  // Optional: roles (string or array)
  if (value.roles !== undefined) {
    if (typeof value.roles === "string") {
      if (!isValidRole(value.roles)) {
        errors.push({
          path: `${path}.roles`,
          message: `"${value.roles}" is not a valid role (must be lowercase slug)`,
        });
      }
    } else if (Array.isArray(value.roles)) {
      for (let i = 0; i < value.roles.length; i++) {
        const role: unknown = value.roles[i];
        if (typeof role !== "string") {
          errors.push({ path: `${path}.roles[${String(i)}]`, message: "must be a string" });
        } else if (!isValidRole(role)) {
          errors.push({
            path: `${path}.roles[${String(i)}]`,
            message: `"${role}" is not a valid role (must be lowercase slug)`,
          });
        }
      }
    } else {
      errors.push({ path: `${path}.roles`, message: "must be a string or array of strings" });
    }
  }

  if (errors.length > 0) {
    return { user: null, errors };
  }

  return {
    user: {
      username: value.username as string,
      password: value.password as string,
      email: value.email as string | undefined,
      firstName: value.firstName as string | undefined,
      lastName: value.lastName as string | undefined,
      roles: value.roles as string | readonly string[] | undefined,
    },
    errors: [],
  };
}

// =============================================================================
// Main Parsing Functions
// =============================================================================

/**
 * Parse and validate unified secrets from a parsed YAML/JSON object
 */
export function parseUnifiedSecretsConfig(value: unknown): UnifiedSecretsInput {
  const errors: ValidationError[] = [];

  if (!isPlainObject(value)) {
    throw new Error("Invalid secrets config: expected an object");
  }

  // Required: keycloakAdminUsername
  if (typeof value.keycloakAdminUsername !== "string" || value.keycloakAdminUsername.trim() === "") {
    errors.push({ path: "keycloakAdminUsername", message: "must be a non-empty string" });
  }

  // Required: keycloakAdminPassword
  if (typeof value.keycloakAdminPassword !== "string" || value.keycloakAdminPassword.trim() === "") {
    errors.push({ path: "keycloakAdminPassword", message: "must be a non-empty string" });
  }

  // Required: users array
  if (!Array.isArray(value.users)) {
    errors.push({ path: "users", message: "must be an array" });
  } else if (value.users.length === 0) {
    errors.push({ path: "users", message: "must have at least one user" });
  } else {
    // Validate each user
    for (let i = 0; i < value.users.length; i++) {
      const result = validateUnifiedUserInput(value.users[i], i);
      errors.push(...result.errors);
    }

    // Check for duplicate usernames
    const usernames = new Set<string>();
    for (let i = 0; i < value.users.length; i++) {
      const user: unknown = value.users[i];
      if (isPlainObject(user) && typeof user.username === "string") {
        if (usernames.has(user.username)) {
          errors.push({
            path: `users[${String(i)}].username`,
            message: `duplicate username "${user.username}"`,
          });
        }
        usernames.add(user.username);
      }
    }
  }

  if (errors.length > 0) {
    const errorMessages = errors.map((e) => `  - ${e.path}: ${e.message}`).join("\n");
    throw new Error(`Invalid secrets config:\n${errorMessages}`);
  }

  return {
    keycloakAdminUsername: value.keycloakAdminUsername as string,
    keycloakAdminPassword: value.keycloakAdminPassword as string,
    users: (value.users as unknown[]).map((u, i) => {
      const result = validateUnifiedUserInput(u, i);
      // We've already validated above, so user is guaranteed to exist
      if (!result.user) {
        throw new Error(`Unexpected validation failure for user at index ${String(i)}`);
      }
      return result.user;
    }),
  };
}

/**
 * Parse unified secrets from a YAML string
 */
export function parseUnifiedSecretsYaml(yamlString: string): UnifiedSecretsInput {
  const parsed = yaml.load(yamlString);
  return parseUnifiedSecretsConfig(parsed);
}

/**
 * Parse unified users from a YAML string (users array only)
 *
 * This is for parsing the secrets:unifiedUsers value which contains
 * just the users array, not the full secrets config.
 */
export function parseUnifiedUsersYaml(yamlString: string): readonly UnifiedUserInput[] {
  const parsed = yaml.load(yamlString);

  if (!Array.isArray(parsed)) {
    throw new Error("Invalid unifiedUsers config: expected an array of users");
  }

  if (parsed.length === 0) {
    throw new Error("Invalid unifiedUsers config: must have at least one user");
  }

  const errors: ValidationError[] = [];
  const users: UnifiedUserInput[] = [];

  for (let i = 0; i < parsed.length; i++) {
    const result = validateUnifiedUserInput(parsed[i], i);
    errors.push(...result.errors);
    if (result.user) {
      users.push(result.user);
    }
  }

  // Check for duplicate usernames
  const usernames = new Set<string>();
  for (let i = 0; i < users.length; i++) {
    const user = users[i];
    if (usernames.has(user.username)) {
      errors.push({
        path: `users[${String(i)}].username`,
        message: `duplicate username "${user.username}"`,
      });
    }
    usernames.add(user.username);
  }

  if (errors.length > 0) {
    const errorMessages = errors.map((e) => `  - ${e.path}: ${e.message}`).join("\n");
    throw new Error(`Invalid unifiedUsers config:\n${errorMessages}`);
  }

  return users;
}

/**
 * Resolve all users in a unified secrets config
 */
export function resolveUnifiedSecrets(
  input: UnifiedSecretsInput,
  stackName: string
): ResolvedUnifiedSecrets {
  return {
    keycloakAdminUsername: input.keycloakAdminUsername,
    keycloakAdminPassword: input.keycloakAdminPassword,
    users: input.users.map((u) => resolveUnifiedUser(u, stackName)),
  };
}
