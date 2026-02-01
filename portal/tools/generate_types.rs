//! Generate Rust types from JSON Schema
//!
//! Usage: cargo run --bin generate-types
//!
//! This tool reads the canonical JSON schema and generates Rust types.
//! The generated file uses serde for serialization with camelCase field names.

use serde::Deserialize;
use std::fs;
use std::path::Path;

const SCHEMA_PATH: &str = "../schema/portal-descriptor.schema.json";
const OUTPUT_PATH: &str = "src/services/descriptor_gen.rs";

#[derive(Debug, Deserialize)]
struct JsonSchema {
    #[serde(rename = "$defs")]
    defs: Option<Defs>,
}

#[derive(Debug, Deserialize)]
struct Defs {
    #[serde(rename = "authType")]
    auth_type: Option<AuthTypeDef>,
    // Note: Rust generator only extracts authType enum values
    // Pattern validation (slug, httpUrl) is handled by serde's deny_unknown_fields
    // and the portal's business logic rather than regex validation
}

#[derive(Debug, Deserialize)]
struct AuthTypeDef {
    #[serde(rename = "enum")]
    enum_values: Option<Vec<String>>,
}

fn generate_header() -> String {
    r#"//! GENERATED FILE - DO NOT EDIT
//!
//! Generated from: schema/portal-descriptor.schema.json
//!
//! To regenerate, run: cargo run --bin generate-types

use serde::{Deserialize, Serialize};

"#
    .to_string()
}

fn generate_auth_type(schema: &JsonSchema) -> String {
    let enum_values = schema
        .defs
        .as_ref()
        .and_then(|d| d.auth_type.as_ref())
        .and_then(|a| a.enum_values.as_ref())
        .expect("authType enum not found in schema");

    let variants: Vec<String> = enum_values
        .iter()
        .map(|v| {
            let variant_name = match v.as_str() {
                "none" => "None",
                "oauth2-proxy" => "Oauth2Proxy",
                "portal" => "Portal",
                other => panic!("Unknown authType variant: {}", other),
            };
            format!("    /// Service has {} authentication\n    {},",
                if v == "none" { "no" } else { v },
                variant_name
            )
        })
        .collect();

    format!(
        r#"/// Authentication type for a service
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AuthType {{
{}
}}

"#,
        variants.join("\n")
    )
}

fn generate_portal_config() -> String {
    r#"/// Portal configuration within the descriptor
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortalConfig {
    /// Browser-visible URL for the portal
    pub public_url: String,
}

"#
    .to_string()
}

fn generate_keycloak_config() -> String {
    r#"/// Keycloak configuration within the descriptor
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

"#
    .to_string()
}

fn generate_service() -> String {
    r#"/// A service entry in the descriptor
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

"#
    .to_string()
}

fn generate_descriptor() -> String {
    r#"/// Portal Descriptor v1 - Complete deployment descriptor
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
    /// Portal configuration
    pub portal: PortalConfig,
    /// Keycloak configuration
    pub keycloak: KeycloakConfig,
    /// Services to display (order is display order)
    pub services: Vec<Service>,
}

"#
    .to_string()
}

fn main() {
    println!("Generating Rust types from JSON Schema...");
    println!("  Schema: {}", SCHEMA_PATH);
    println!("  Output: {}", OUTPUT_PATH);

    let schema_content = fs::read_to_string(SCHEMA_PATH)
        .expect("Failed to read schema file");
    let schema: JsonSchema = serde_json::from_str(&schema_content)
        .expect("Failed to parse schema JSON");

    let output = format!(
        "{}{}{}{}{}{}",
        generate_header(),
        generate_auth_type(&schema),
        generate_portal_config(),
        generate_keycloak_config(),
        generate_service(),
        generate_descriptor(),
    );

    // Ensure output directory exists
    if let Some(parent) = Path::new(OUTPUT_PATH).parent() {
        fs::create_dir_all(parent).expect("Failed to create output directory");
    }

    fs::write(OUTPUT_PATH, output).expect("Failed to write output file");
    println!("Done!");
}
