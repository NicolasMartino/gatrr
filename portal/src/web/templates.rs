use crate::services::ServiceCard;
use askama::Template;

#[derive(Template)]
#[template(path = "landing.html")]
pub struct LandingTemplate {
    pub logo_url: Option<String>,
}

/// A formatted time with both display and ISO formats
/// Used for semantic <time datetime="..."> elements
pub struct FormattedTime {
    /// Human-readable display (e.g., "2026-02-02 15:30 UTC")
    pub display: String,
    /// Raw ISO 8601 string (e.g., "2026-02-02T15:30:00Z")
    pub iso: String,
}

/// Deployment info for the footer
/// Always shown for authenticated users (deployment_id is always present)
pub struct DeploymentDisplay {
    /// Deployment ID (e.g., "prod", "staging") - always present
    pub deployment_id: String,
    /// Short commit SHA (first 7 chars)
    pub short_sha: Option<String>,
    /// Commit time with display and ISO formats
    pub commit_time: Option<FormattedTime>,
    /// Deploy time with display and ISO formats
    pub deployed_time: Option<FormattedTime>,
}

#[derive(Template)]
#[template(path = "dashboard.html")]
pub struct DashboardTemplate {
    pub username: String,
    pub email: Option<String>,
    pub services: Vec<ServiceCard>,
    /// Deployment info for footer display
    pub deployment: DeploymentDisplay,
}
