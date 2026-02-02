//! GENERATED FILE - DO NOT EDIT
//!
//! Generated from: schema/portal-descriptor.schema.json
//!
//! To regenerate, run: cargo run --bin generate-types

use serde::{Deserialize, Serialize};

/// Authentication type for a service
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AuthType {
    /// Service has no authentication
    None,
    /// Service has oauth2-proxy authentication
    Oauth2Proxy,
    /// Service has portal authentication
    Portal,
}

/// Portal configuration within the descriptor
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortalConfig {
    /// Browser-visible URL for the portal
    pub public_url: String,
}

/// Keycloak configuration within the descriptor
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KeycloakConfig {
    /// Browser-visible URL for Keycloak
    pub public_url: String,
    /// OIDC issuer URL (e.g., https://keycloak.example.com/realms/dev)
    pub issuer_url: String,
    /// Realm name
    pub realm: String,
}

/// Deployment metadata for tracking what/when was deployed
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeploymentInfo {
    /// Git commit SHA that was deployed (40-character hex)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit_sha: Option<String>,
    /// When the commit was made (git committer date, ISO 8601 UTC)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit_at: Option<String>,
    /// When the deployment happened (ISO 8601 UTC)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deployed_at: Option<String>,
}

/// A service entry in the descriptor
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Service {
    /// Stable identifier / slug (e.g., "demo", "api", "docs")
    pub id: String,
    /// Display name (e.g., "Demo App", "API Documentation")
    pub name: String,
    /// Fully-qualified, browser-visible URL
    pub url: String,
    /// Whether the service requires authentication
    pub protected: bool,
    /// How authentication is handled
    pub auth_type: AuthType,
    /// Optional grouping for UI organization
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    /// Optional icon (emoji or icon name)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// Optional description
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Required realm roles to access this service (for UI filtering)
    ///
    /// Rules (enforced by schema):
    /// - Required for authType: Oauth2Proxy and Portal services
    /// - Forbidden for authType: None services
    #[serde(skip_serializing_if = "Option::is_none")]
    pub required_realm_roles: Option<Vec<String>>,
}

/// Portal Descriptor v1 - Complete deployment descriptor
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Descriptor {
    /// Schema version (currently "1")
    pub version: String,
    /// Deployment identifier (e.g., "prod", "staging", "local")
    pub deployment_id: String,
    /// Environment type (e.g., "prod", "dev")
    pub environment: String,
    /// Base domain (e.g., "localhost", "example.com")
    pub base_domain: String,
    /// Deployment metadata (commit, timestamps) - optional
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deployment: Option<DeploymentInfo>,
    /// Portal configuration
    pub portal: PortalConfig,
    /// Keycloak configuration
    pub keycloak: KeycloakConfig,
    /// Services to display (order is display order)
    pub services: Vec<Service>,
}

