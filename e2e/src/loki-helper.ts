/**
 * Loki Helper for E2E Tests
 *
 * Queries Loki from inside the Docker network using an ephemeral curl container.
 * This avoids exposing Loki ports to the host while still allowing E2E tests
 * to verify log ingestion.
 */

import { execSync } from "child_process";

const DEPLOYMENT_ID = process.env.E2E_DEPLOYMENT_ID || "local";
const DOCKER_NETWORK = process.env.E2E_DOCKER_NETWORK || `gatrr-${DEPLOYMENT_ID}`;
const LOKI_CONTAINER = process.env.E2E_LOKI_CONTAINER || `${DEPLOYMENT_ID}-loki`;
const LOKI_PORT = 3100;

// Pin curl image version for CI stability
const CURL_IMAGE = "curlimages/curl:8.5.0";

export interface LokiQueryResult {
  status: string;
  data: {
    resultType: string;
    result: Array<{
      stream: Record<string, string>;
      values: Array<[string, string]>;
    }>;
  };
}

export interface LokiLabelsResult {
  status: string;
  data: string[];
}

/**
 * Execute a curl command inside the Docker network
 */
function dockerCurl(url: string, timeout = 10): string {
  const cmd = `docker run --rm --network ${DOCKER_NETWORK} ${CURL_IMAGE} -s --max-time ${timeout} "${url}"`;
  try {
    return execSync(cmd, { encoding: "utf-8", timeout: (timeout + 5) * 1000 });
  } catch (error) {
    const err = error as { stderr?: string; message?: string };
    throw new Error(`Loki query failed: ${err.stderr || err.message}`);
  }
}

/**
 * Check if Loki is ready
 */
export async function lokiIsReady(): Promise<boolean> {
  try {
    const result = dockerCurl(`http://${LOKI_CONTAINER}:${LOKI_PORT}/ready`);
    return result.includes("ready");
  } catch {
    return false;
  }
}

/**
 * Get available labels from Loki
 */
export async function getLokiLabels(): Promise<LokiLabelsResult> {
  const result = dockerCurl(
    `http://${LOKI_CONTAINER}:${LOKI_PORT}/loki/api/v1/labels`
  );
  return JSON.parse(result);
}

/**
 * Query Loki for logs
 */
export async function queryLoki(
  logql: string,
  limit = 10
): Promise<LokiQueryResult> {
  // Calculate time range (last 5 minutes)
  const end = Date.now() * 1_000_000; // nanoseconds
  const start = end - 5 * 60 * 1_000_000_000; // 5 minutes ago

  const params = new URLSearchParams({
    query: logql,
    start: start.toString(),
    end: end.toString(),
    limit: limit.toString(),
  });

  const result = dockerCurl(
    `http://${LOKI_CONTAINER}:${LOKI_PORT}/loki/api/v1/query_range?${params}`
  );
  return JSON.parse(result);
}

/**
 * Check if Loki has any logs for the given job
 */
export async function lokiHasLogs(job = "docker"): Promise<boolean> {
  try {
    const result = await queryLoki(`{job="${job}"}`, 1);
    return result.status === "success" && result.data.result.length > 0;
  } catch {
    return false;
  }
}

/**
 * Wait for Loki to have logs (with retries)
 */
export async function waitForLokiLogs(
  job = "docker",
  maxRetries = 30,
  delayMs = 2000
): Promise<boolean> {
  for (let i = 0; i < maxRetries; i++) {
    if (await lokiHasLogs(job)) {
      return true;
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}
