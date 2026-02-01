/**
 * Docker image building
 *
 * Builds Docker images as part of the Pulumi deployment.
 * Uses git SHA tagging for deterministic, reproducible builds.
 */

import * as docker from "@pulumi/docker";
import * as pulumi from "@pulumi/pulumi";
import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { BuildPlatform } from "../config";
import { shortName } from "../types";

/** Get short git SHA for image tagging */
function getGitSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
  } catch {
    // Fallback for non-git environments (e.g., CI without git)
    return "dev";
  }
}

function isGitDirty(): boolean {
  try {
    // "--porcelain" is stable, machine-readable output.
    // Any output here indicates a dirty working tree (including untracked files).
    const status = execSync("git status --porcelain", { encoding: "utf-8" }).trim();
    const changes = status
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    return changes.length > 0;
  } catch {
    return false;
  }
}

function sanitizeForFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function createDirtyDeployNonce(): string {
  // Docker tags allow [A-Za-z0-9_.-]. Keep it short to avoid huge tags.
  const time = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${time}${rand}`;
}

function getDirtyNonceFilePath(): string {
  // Prefer Pulumi-provided sync dir (unique per invocation and shared across preview+update).
  const syncDir = process.env.PULUMI_NODEJS_SYNC?.trim();
  const baseDir = syncDir && syncDir.length > 0 ? syncDir : os.tmpdir();

  const project = sanitizeForFileName(pulumi.getProject());
  const stack = sanitizeForFileName(pulumi.getStack());

  return path.join(baseDir, `portal-image-dirty-nonce-${project}-${stack}.json`);
}

function readDirtyNonce(filePath: string): string | undefined {
  try {
    const raw = fs.readFileSync(filePath, { encoding: "utf-8" });
    const parsed = JSON.parse(raw) as { nonce?: string };
    return parsed.nonce && parsed.nonce.length > 0
      ? parsed.nonce
      : undefined;
  } catch {
    return undefined;
  }
}

function writeDirtyNonce(filePath: string, nonce: string): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({ nonce, createdAt: new Date().toISOString() }),
      { encoding: "utf-8" }
    );
  } catch {
    // Best-effort. If this fails, we'll still return a tag, but preview/update may not match.
  }
}

function getOrCreateDirtyDeployNonce(): string {
  const nonceFilePath = getDirtyNonceFilePath();

  // In a normal `pulumi up`, the program is run once for preview and then again for update.
  // We must ensure we generate the nonce during preview and reuse it during the update.
  if (pulumi.runtime.isDryRun()) {
    const nonce = createDirtyDeployNonce();
    writeDirtyNonce(nonceFilePath, nonce);
    return nonce;
  }

  const existing = readDirtyNonce(nonceFilePath);
  if (existing) return existing;

  const nonce = createDirtyDeployNonce();
  writeDirtyNonce(nonceFilePath, nonce);
  return nonce;
}

function buildImageTag(tagOverride?: string): string {
  if (tagOverride) return tagOverride;

  const sha = getGitSha();

  if (!isGitDirty()) return sha;

  const nonce = getOrCreateDirtyDeployNonce();
  return `${sha}-dirty-${nonce}`;
}

export interface PortalImageInputs {
  /** Deployment ID for resource naming */
  deploymentId: string;
  /** Path to repository root (where Dockerfile context is) */
  contextPath: string;
  /** Optional: force a specific tag instead of git SHA */
  tag?: string;
  /**
   * Build platform (default: "linux/amd64")
   * - "linux/amd64": Build for x86_64 (standard servers)
   * - "linux/arm64": Build for ARM64 (Apple Silicon, ARM servers)
   * - "native": Build for the host platform (fastest, but may not match deploy target)
   *
   * Note: Cross-platform builds require Docker buildx with QEMU emulation.
   * On Apple Silicon, building for linux/amd64 requires: docker buildx create --use
   */
  platform?: BuildPlatform;
}

export interface PortalImageResources {
  /** The built image resource */
  image: docker.Image;
  /** Full image name with tag (e.g., "portal:abc1234") */
  imageName: pulumi.Output<string>;
}

/**
 * Build the portal Docker image
 *
 * Uses the Dockerfile at portal/Dockerfile with the repo root as context.
 * Tags with git SHA for deterministic builds.
 */
export function buildPortalImage(
  inputs: PortalImageInputs
): PortalImageResources {
  const { deploymentId, contextPath, tag, platform = "linux/amd64" } = inputs;

  const imageTag = buildImageTag(tag);
  const imageName = `portal:${imageTag}`;

  // Determine platform string for Docker build
  // "native" means don't specify platform (use host default)
  const platformArg = platform === "native" ? undefined : platform;

  const image = new docker.Image(shortName(deploymentId, "portal-image"), {
    imageName,
    build: {
      context: contextPath,
      dockerfile: `${contextPath}/portal/Dockerfile`,
      ...(platformArg && { platform: platformArg }),
    },
    skipPush: true, // Local build only, no registry push
  });

  return {
    image,
    imageName: image.imageName,
  };
}
