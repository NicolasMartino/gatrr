use super::templates::{DashboardTemplate, DeploymentDisplay, FormattedTime, LandingTemplate};
use crate::{auth::extractors::AuthenticatedUser, services::filter_services_for_user, AppState};
use askama::Template;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{Html, IntoResponse};
use std::sync::Arc;

/// Returns the number of days in a given month for a given year
/// Handles leap years correctly
fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            // Leap year: divisible by 4, except centuries unless divisible by 400
            if (year.is_multiple_of(4) && !year.is_multiple_of(100)) || year.is_multiple_of(400) {
                29
            } else {
                28
            }
        }
        _ => 0, // Invalid month
    }
}

/// Format an ISO 8601 UTC datetime string to display format
///
/// Strict parsing: requires exact format matching the JSON schema.
/// Includes calendar validation (rejects Feb 30, etc.)
/// Input: "2026-02-02T15:30:00Z" (must end with Z)
/// Output: FormattedTime { display: "2026-02-02 15:30 UTC", iso: "2026-02-02T15:30:00Z" }
fn format_utc_datetime(iso_datetime: &str) -> Option<FormattedTime> {
    // Strict: must end with Z (UTC)
    if !iso_datetime.ends_with('Z') {
        return None;
    }

    // Expected format: YYYY-MM-DDTHH:MM:SSZ
    let without_z = &iso_datetime[..iso_datetime.len() - 1];
    let parts: Vec<&str> = without_z.split('T').collect();
    if parts.len() != 2 {
        return None;
    }

    let date_part = parts[0];
    let time_part = parts[1];

    // Validate date: YYYY-MM-DD
    let date_components: Vec<&str> = date_part.split('-').collect();
    if date_components.len() != 3 {
        return None;
    }
    let year: u32 = date_components[0].parse().ok()?;
    let month: u32 = date_components[1].parse().ok()?;
    let day: u32 = date_components[2].parse().ok()?;

    // Validate month range
    if !(1..=12).contains(&month) {
        return None;
    }

    // Validate day with calendar-accurate check
    let max_days = days_in_month(year, month);
    if day < 1 || day > max_days {
        return None;
    }

    // Validate time: HH:MM:SS
    let time_components: Vec<&str> = time_part.split(':').collect();
    if time_components.len() != 3 {
        return None;
    }
    let hour: u32 = time_components[0].parse().ok()?;
    let minute: u32 = time_components[1].parse().ok()?;
    let second: u32 = time_components[2].parse().ok()?;

    if hour > 23 || minute > 59 || second > 59 {
        return None;
    }

    Some(FormattedTime {
        display: format!(
            "{:04}-{:02}-{:02} {:02}:{:02} UTC",
            year, month, day, hour, minute
        ),
        iso: iso_datetime.to_string(),
    })
}

/// Liveness probe - always returns OK if the process is running
pub async fn healthz_handler() -> impl IntoResponse {
    StatusCode::OK
}

/// Readiness probe - checks if the service is ready to handle requests
///
/// Returns 200 OK if:
/// - JWKS cache has been populated (Keycloak is reachable)
///
/// Returns 503 Service Unavailable if:
/// - JWKS cache is empty (Keycloak not yet contacted or unreachable)
pub async fn readyz_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    // Check if JWKS has been cached (indicates Keycloak connectivity)
    let jwks_cached = state.jwt_validator.is_jwks_cached().await;

    if jwks_cached {
        (StatusCode::OK, "ready")
    } else {
        tracing::warn!("Readiness check failed: JWKS not cached");
        (StatusCode::SERVICE_UNAVAILABLE, "not ready: JWKS not cached")
    }
}

pub async fn landing_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    // Pick a random logo each time the landing page is loaded
    let logo_url = if !state.logos.is_empty() {
        let random_index = fastrand::usize(..state.logos.len());
        Some(format!("/static/logos/{}", state.logos[random_index]))
    } else {
        None
    };

    let template = LandingTemplate { logo_url };
    match template.render() {
        Ok(html) => Html(html).into_response(),
        Err(_) => (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "Template error",
        )
            .into_response(),
    }
}

pub async fn dashboard_handler(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser { claims, .. }: AuthenticatedUser,
) -> impl IntoResponse {
    // Get user's realm roles from JWT claims
    let user_roles = claims.roles();

    // Filter services to only those the user can access (per plan.md 2.7)
    let accessible_services = filter_services_for_user(&state.services, &user_roles);

    tracing::debug!(
        username = ?claims.preferred_username,
        user_roles = ?user_roles,
        total_services = state.services.len(),
        accessible_services = accessible_services.len(),
        "Filtered services for user"
    );

    // Build deployment display - always shown for authenticated users
    // deployment_id is always present, metadata fields are optional
    let deployment = {
        let (short_sha, commit_time, deployed_time) =
            if let Some(d) = state.descriptor.deployment.as_ref() {
                (
                    d.commit_sha
                        .as_ref()
                        .map(|sha| sha.chars().take(7).collect::<String>()),
                    d.commit_at.as_ref().and_then(|dt| format_utc_datetime(dt)),
                    d.deployed_at
                        .as_ref()
                        .and_then(|dt| format_utc_datetime(dt)),
                )
            } else {
                (None, None, None)
            };

        DeploymentDisplay {
            deployment_id: state.descriptor.deployment_id.clone(),
            short_sha,
            commit_time,
            deployed_time,
        }
    };

    let template = DashboardTemplate {
        username: claims
            .preferred_username
            .clone()
            .unwrap_or_else(|| claims.sub.clone()),
        email: claims.email.clone(),
        services: accessible_services,
        deployment,
    };

    match template.render() {
        Ok(html) => Html(html).into_response(),
        Err(_) => (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "Template error",
        )
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_days_in_month() {
        // Regular months
        assert_eq!(days_in_month(2026, 1), 31); // Jan
        assert_eq!(days_in_month(2026, 4), 30); // Apr
        assert_eq!(days_in_month(2026, 12), 31); // Dec

        // February - non-leap year
        assert_eq!(days_in_month(2026, 2), 28);
        assert_eq!(days_in_month(2023, 2), 28);

        // February - leap year (divisible by 4)
        assert_eq!(days_in_month(2024, 2), 29);
        assert_eq!(days_in_month(2028, 2), 29);

        // February - century years (not leap unless divisible by 400)
        assert_eq!(days_in_month(1900, 2), 28); // Not leap
        assert_eq!(days_in_month(2000, 2), 29); // Leap (divisible by 400)
        assert_eq!(days_in_month(2100, 2), 28); // Not leap
    }

    #[test]
    fn test_format_utc_datetime_valid() {
        let result = format_utc_datetime("2026-02-02T15:30:00Z");
        assert!(result.is_some());
        let ft = result.unwrap();
        assert_eq!(ft.display, "2026-02-02 15:30 UTC");
        assert_eq!(ft.iso, "2026-02-02T15:30:00Z");

        let result = format_utc_datetime("2025-12-25T00:00:00Z");
        assert!(result.is_some());
        let ft = result.unwrap();
        assert_eq!(ft.display, "2025-12-25 00:00 UTC");

        let result = format_utc_datetime("2024-01-01T23:59:59Z");
        assert!(result.is_some());
        let ft = result.unwrap();
        assert_eq!(ft.display, "2024-01-01 23:59 UTC");
    }

    #[test]
    fn test_format_utc_datetime_all_months() {
        for month in 1..=12 {
            let input = format!("2026-{:02}-15T12:00:00Z", month);
            let expected_display = format!("2026-{:02}-15 12:00 UTC", month);
            let result = format_utc_datetime(&input);
            assert!(result.is_some(), "Month {} should be valid", month);
            assert_eq!(result.unwrap().display, expected_display);
        }
    }

    #[test]
    fn test_format_utc_datetime_rejects_non_utc() {
        // Must end with Z - reject timezone offsets
        assert!(format_utc_datetime("2026-02-02T15:30:00+00:00").is_none());
        assert!(format_utc_datetime("2026-02-02T15:30:00-05:00").is_none());
        assert!(format_utc_datetime("2026-02-02T15:30:00").is_none());
    }

    #[test]
    fn test_format_utc_datetime_rejects_date_only() {
        // Strict: requires full datetime with time component
        assert!(format_utc_datetime("2026-02-02").is_none());
        assert!(format_utc_datetime("2026-02-02Z").is_none());
    }

    #[test]
    fn test_format_utc_datetime_calendar_validation() {
        // Valid edge cases
        assert!(format_utc_datetime("2024-02-29T12:00:00Z").is_some()); // Leap year
        assert!(format_utc_datetime("2026-01-31T12:00:00Z").is_some()); // Jan 31
        assert!(format_utc_datetime("2026-04-30T12:00:00Z").is_some()); // Apr 30

        // Invalid dates - calendar errors
        assert!(format_utc_datetime("2026-02-29T12:00:00Z").is_none()); // Non-leap year
        assert!(format_utc_datetime("2026-02-30T12:00:00Z").is_none()); // Feb 30
        assert!(format_utc_datetime("2026-02-31T12:00:00Z").is_none()); // Feb 31
        assert!(format_utc_datetime("2026-04-31T12:00:00Z").is_none()); // Apr 31
        assert!(format_utc_datetime("2026-06-31T12:00:00Z").is_none()); // Jun 31
        assert!(format_utc_datetime("2026-09-31T12:00:00Z").is_none()); // Sep 31
        assert!(format_utc_datetime("2026-11-31T12:00:00Z").is_none()); // Nov 31

        // Century leap year edge cases
        assert!(format_utc_datetime("2000-02-29T12:00:00Z").is_some()); // 2000 is leap
        assert!(format_utc_datetime("1900-02-29T12:00:00Z").is_none()); // 1900 not leap
    }

    #[test]
    fn test_format_utc_datetime_invalid_inputs() {
        // Completely wrong
        assert!(format_utc_datetime("invalid").is_none());
        assert!(format_utc_datetime("").is_none());

        // Invalid month
        assert!(format_utc_datetime("2026-13-02T15:30:00Z").is_none());
        assert!(format_utc_datetime("2026-00-02T15:30:00Z").is_none());

        // Invalid day
        assert!(format_utc_datetime("2026-02-00T15:30:00Z").is_none());
        assert!(format_utc_datetime("2026-02-32T15:30:00Z").is_none());

        // Invalid hour/minute/second
        assert!(format_utc_datetime("2026-02-02T24:00:00Z").is_none());
        assert!(format_utc_datetime("2026-02-02T15:60:00Z").is_none());
        assert!(format_utc_datetime("2026-02-02T15:30:60Z").is_none());
        assert!(format_utc_datetime("2026-02-02T15:30:xxZ").is_none());

        // Malformed components
        assert!(format_utc_datetime("2026-ab-02T15:30:00Z").is_none());
        assert!(format_utc_datetime("abcd-02-02T15:30:00Z").is_none());
        assert!(format_utc_datetime("2026-02-xxT15:30:00Z").is_none());
        assert!(format_utc_datetime("2026-02-02Tab:30:00Z").is_none());
    }
}
