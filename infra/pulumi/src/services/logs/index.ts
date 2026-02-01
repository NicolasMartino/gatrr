/**
 * Logs service module (Loki + Grafana + Promtail)
 *
 * A lightweight centralized logging stack:
 * - Loki: log aggregation (internal only)
 * - Grafana: visualization UI (protected by oauth2-proxy)
 * - Promtail: log shipper (reads Docker container logs)
 *
 * Admin-only access - only users with the 'admin' role can view logs.
 */

import * as docker from "@pulumi/docker";
import * as pulumi from "@pulumi/pulumi";
import * as fs from "fs";
import * as path from "path";
import { buildUrl } from "../../config";
import {
  ServiceContext,
  ServiceModuleResult,
  ContainerIdentity,
  createContainer,
  shortName,
  volumeName,
} from "../../types";
import {
  createProtectedService,
  ProtectedServiceConfig,
  ProtectedServiceContext,
} from "../protected-service-helper";

/** Logs service configuration */
const SERVICE_ID = "logs";
const SERVICE_NAME = "Logs";
const SERVICE_GROUP = "admin";
const SERVICE_ICON = "activity";
const SERVICE_DESCRIPTION = "Centralized logs (Grafana + Loki)";

/** Container versions (pinned) */
const LOKI_VERSION = "2.9.4";
const GRAFANA_VERSION = "10.3.1";
const PROMTAIL_VERSION = "2.9.4";

/** Container images */
const LOKI_IMAGE = `grafana/loki:${LOKI_VERSION}`;
const GRAFANA_IMAGE = `grafana/grafana:${GRAFANA_VERSION}`;
const PROMTAIL_IMAGE = `grafana/promtail:${PROMTAIL_VERSION}`;

/** Ports */
const GRAFANA_PORT = 3000;
const LOKI_PORT = "3100";

/** Required realm roles to access this service (admin only) */
const REQUIRED_REALM_ROLES = ["admin"];

export interface LogsServiceInputs {
  context: ServiceContext;
  /** OAuth2-Proxy client secret (per-service client) - required for this protected service */
  clientSecret?: pulumi.Input<string>;
}

/**
 * Load config file from the config directory
 */
function loadConfigFile(filename: string): string {
  const configPath = path.join(__dirname, "config", filename);
  return fs.readFileSync(configPath, "utf-8");
}

/**
 * Create the logs service module
 */
export function createLogsService(inputs: LogsServiceInputs): ServiceModuleResult {
  const { context, clientSecret } = inputs;

  // Validate required client secret for protected service
  if (!clientSecret) {
    throw new Error(`Logs service requires a client secret for oauth2-proxy`);
  }

  const { config, network, keycloakInternalIssuerUrl, keycloakPublicIssuerUrl, oauth2ProxyCookieSecret } = context;

  // Build container identities for internal services
  const lokiIdentity: ContainerIdentity = {
    deploymentId: config.deploymentId,
    serviceId: "loki",
    version: LOKI_VERSION,
  };
  const grafanaIdentity: ContainerIdentity = {
    deploymentId: config.deploymentId,
    serviceId: "grafana",
    version: GRAFANA_VERSION,
  };
  const promtailIdentity: ContainerIdentity = {
    deploymentId: config.deploymentId,
    serviceId: "promtail",
    version: PROMTAIL_VERSION,
  };

  // Stable addresses for internal routing (without version)
  const lokiContainerAddress = shortName(config.deploymentId, "loki");
  const grafanaContainerAddress = shortName(config.deploymentId, "grafana");

  // Service URL for Grafana ROOT_URL configuration
  const serviceUrl = buildUrl(config, SERVICE_ID);

  // ==========================================================================
  // LOKI (log storage)
  // ==========================================================================

  // Create persistent volume for Loki data
  const lokiVolumeName = volumeName(config.deploymentId, "loki-data");
  const lokiVolume = new docker.Volume(lokiVolumeName, {
    name: lokiVolumeName,
  });

  // Load Loki config
  const lokiConfig = loadConfigFile("loki-config.yaml");

  const lokiContainer = createContainer(
    lokiIdentity,
    {
      network,
      image: LOKI_IMAGE,
      command: ["-config.file=/etc/loki/loki-config.yaml"],
      uploads: [
        {
          file: "/etc/loki/loki-config.yaml",
          content: lokiConfig,
        },
      ],
      volumes: [
        {
          volumeName: lokiVolume.name,
          containerPath: "/loki",
        },
      ],
      restart: "unless-stopped",
    },
    {
      dependsOn: [network, lokiVolume],
    }
  );

  // ==========================================================================
  // GRAFANA (visualization UI)
  // ==========================================================================

  // Create persistent volume for Grafana data (dashboards, settings)
  const grafanaVolumeName = volumeName(config.deploymentId, "grafana-data");
  const grafanaVolume = new docker.Volume(grafanaVolumeName, {
    name: grafanaVolumeName,
  });

  // Grafana datasource provisioning (points to Loki)
  const grafanaDatasources = `apiVersion: 1
datasources:
  - name: Loki
    type: loki
    uid: loki
    access: proxy
    url: http://${lokiContainerAddress}:${LOKI_PORT}
    isDefault: true
`;

  // Grafana dashboard provider config
  const grafanaDashboardProvider = `apiVersion: 1
providers:
  - name: 'default'
    orgId: 1
    folder: ''
    type: file
    disableDeletion: false
    updateIntervalSeconds: 10
    options:
      path: /etc/grafana/provisioning/dashboards/json
`;

  // Default Docker Logs dashboard
  const dockerLogsDashboard = JSON.stringify({
    annotations: { list: [] },
    editable: true,
    fiscalYearStartMonth: 0,
    graphTooltip: 0,
    links: [],
    panels: [
      {
        datasource: { type: "loki", uid: "loki" },
        gridPos: { h: 16, w: 24, x: 0, y: 0 },
        id: 1,
        options: {
          dedupStrategy: "none",
          enableLogDetails: true,
          prettifyLogMessage: false,
          showCommonLabels: false,
          showLabels: true,
          showTime: true,
          sortOrder: "Descending",
          wrapLogMessage: false,
        },
        targets: [
          {
            datasource: { type: "loki", uid: "loki" },
            expr: '{job="docker"} | json',
            refId: "A",
          },
        ],
        title: "All Container Logs",
        type: "logs",
      },
      {
        datasource: { type: "loki", uid: "loki" },
        fieldConfig: {
          defaults: {
            color: { mode: "palette-classic" },
            mappings: [],
            thresholds: { mode: "absolute", steps: [{ color: "green", value: null }] },
          },
          overrides: [],
        },
        gridPos: { h: 8, w: 12, x: 0, y: 16 },
        id: 2,
        options: {
          legend: { displayMode: "list", placement: "bottom", showLegend: true },
          tooltip: { mode: "single", sort: "none" },
        },
        targets: [
          {
            datasource: { type: "loki", uid: "loki" },
            expr: 'sum by (container) (count_over_time({job="docker"}[1m]))',
            refId: "A",
          },
        ],
        title: "Log Volume by Container",
        type: "timeseries",
      },
      {
        datasource: { type: "loki", uid: "loki" },
        gridPos: { h: 8, w: 12, x: 12, y: 16 },
        id: 3,
        options: {
          dedupStrategy: "none",
          enableLogDetails: true,
          prettifyLogMessage: false,
          showCommonLabels: false,
          showLabels: true,
          showTime: true,
          sortOrder: "Descending",
          wrapLogMessage: false,
        },
        targets: [
          {
            datasource: { type: "loki", uid: "loki" },
            expr: '{job="docker"} |~ "(?i)error|panic|fatal|fail"',
            refId: "A",
          },
        ],
        title: "Errors & Failures",
        type: "logs",
      },
    ],
    schemaVersion: 39,
    tags: ["docker", "logs"],
    templating: { list: [] },
    time: { from: "now-1h", to: "now" },
    timepicker: {},
    timezone: "browser",
    title: "Docker Logs",
    uid: "docker-logs",
    version: 1,
  }, null, 2);

  const grafanaContainer = createContainer(
    grafanaIdentity,
    {
      network,
      image: GRAFANA_IMAGE,
      envs: [
        // No auth needed - oauth2-proxy handles it (admin-only access)
        "GF_AUTH_ANONYMOUS_ENABLED=true",
        "GF_AUTH_ANONYMOUS_ORG_ROLE=Admin",
        "GF_AUTH_DISABLE_LOGIN_FORM=true",
        // Server settings
        `GF_SERVER_ROOT_URL=${serviceUrl}`,
        "GF_SERVER_SERVE_FROM_SUB_PATH=false",
      ],
      uploads: [
        {
          file: "/etc/grafana/provisioning/datasources/datasources.yaml",
          content: grafanaDatasources,
        },
        {
          file: "/etc/grafana/provisioning/dashboards/dashboards.yaml",
          content: grafanaDashboardProvider,
        },
        {
          file: "/etc/grafana/provisioning/dashboards/json/docker-logs.json",
          content: dockerLogsDashboard,
        },
      ],
      volumes: [
        {
          volumeName: grafanaVolume.name,
          containerPath: "/var/lib/grafana",
        },
      ],
      restart: "unless-stopped",
    },
    {
      dependsOn: [network, grafanaVolume, lokiContainer],
    }
  );

  // ==========================================================================
  // PROMTAIL (log shipper)
  // ==========================================================================

  // Generate Promtail config with Docker service discovery
  // Uses Docker socket (read-only) to get container names and metadata
  const promtailConfig = `server:
  http_listen_port: 9080
  grpc_listen_port: 0

positions:
  filename: /tmp/positions.yaml

clients:
  - url: http://${lokiContainerAddress}:${LOKI_PORT}/loki/api/v1/push

scrape_configs:
  - job_name: docker
    docker_sd_configs:
      - host: unix:///var/run/docker.sock
        refresh_interval: 5s
    relabel_configs:
      # Use container name as the primary label
      - source_labels: ['__meta_docker_container_name']
        regex: '/?(.*)'
        target_label: container
      # Add container ID (short form)
      - source_labels: ['__meta_docker_container_id']
        regex: '(.{12}).*'
        target_label: container_id
      # Add deployment label
      - target_label: deployment
        replacement: ${config.deploymentId}
      # Add job label
      - target_label: job
        replacement: docker
    pipeline_stages:
      # Parse Docker JSON log format
      - json:
          expressions:
            log: log
            stream: stream
            time: time
      # Drop Traefik access logs (contain RouterName field)
      - drop:
          source: log
          expression: '"RouterName":'
      # Add stream as label
      - labels:
          stream:
      # Use the extracted log line as output
      - output:
          source: log
`;

  const promtailContainer = createContainer(
    promtailIdentity,
    {
      network,
      image: PROMTAIL_IMAGE,
      command: ["-config.file=/etc/promtail/promtail-config.yaml"],
      uploads: [
        {
          file: "/etc/promtail/promtail-config.yaml",
          content: promtailConfig,
        },
      ],
      volumes: [
        {
          // Docker socket for container discovery (read-only)
          hostPath: "/var/run/docker.sock",
          containerPath: "/var/run/docker.sock",
          readOnly: true,
        },
        {
          // Docker container logs (read-only)
          hostPath: "/var/lib/docker/containers",
          containerPath: "/var/lib/docker/containers",
          readOnly: true,
        },
      ],
      restart: "unless-stopped",
    },
    {
      dependsOn: [network, lokiContainer],
    }
  );

  // ==========================================================================
  // OAUTH2-PROXY (via shared helper)
  // ==========================================================================

  // Service configuration for protected service helper
  const serviceConfig: ProtectedServiceConfig = {
    serviceId: SERVICE_ID,
    serviceName: SERVICE_NAME,
    serviceGroup: SERVICE_GROUP,
    serviceIcon: SERVICE_ICON,
    serviceDescription: SERVICE_DESCRIPTION,
    requiredRealmRoles: REQUIRED_REALM_ROLES,
  };

  // Context for protected service helper
  const protectedContext: ProtectedServiceContext = {
    config,
    network,
    keycloakInternalIssuerUrl,
    keycloakPublicIssuerUrl,
    oauth2ProxyCookieSecret,
    clientSecret,
  };

  // Create OAuth2-Proxy sidecar and get standard portal/routes/authz
  const protectedResult = createProtectedService(
    serviceConfig,
    protectedContext,
    {
      container: grafanaContainer,
      port: GRAFANA_PORT,
      containerAddress: grafanaContainerAddress,
    }
  );

  // Additional containers are registered with Pulumi but not directly exported
  // (Loki and Promtail are supporting infrastructure, not exposed via routes)
  void lokiContainer;
  void promtailContainer;

  return {
    id: SERVICE_ID,
    portal: protectedResult.portal,
    routes: protectedResult.routes,
    oauth2ProxyAuthz: protectedResult.oauth2ProxyAuthz,
    resources: {
      container: grafanaContainer, // Primary container is Grafana
      oauth2ProxyContainer: protectedResult.oauth2ProxyContainer,
    },
  };
}
