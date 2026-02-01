/**
 * Docker network definition
 *
 * Creates a bridge network for all containers in the deployment.
 * All services communicate over this network using container names as hostnames.
 */

import * as docker from "@pulumi/docker";
import { DeploymentConfig } from "./config";
import { networkName } from "./types";

export interface NetworkResources {
  network: docker.Network;
}

/**
 * Create the Docker network for the deployment
 */
export function createNetwork(config: DeploymentConfig): NetworkResources {
  const name = networkName(config.deploymentId);
  const network = new docker.Network(name, {
    name,
    driver: "bridge",
  });

  return { network };
}
