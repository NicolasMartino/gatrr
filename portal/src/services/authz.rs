//! Authorization helpers for service access control
//!
//! This module provides the single source of truth for authorization constants
//! and helper functions used for UI-level service filtering.
//!
//! Note: This is UI-only filtering; oauth2-proxy remains the enforcement point.

use std::collections::HashSet;

use super::descriptor::AuthType;

/// Admin role name - users with this role can access all services (superuser)
pub const ADMIN_ROLE: &str = "admin";

/// Check if a user can access a service based on their roles
///
/// Per plan.md 2.7:
/// - authType: None services are always accessible
/// - authType: Oauth2Proxy services require at least one matching role
/// - Users with "admin" role can access all services (superuser)
///
/// # Arguments
/// * `user_roles` - Set of roles the user has (precomputed for efficiency)
/// * `auth_type` - The service's authentication type
/// * `required_roles` - The roles required to access the service (if any)
///
/// # Returns
/// `true` if the user can access the service, `false` otherwise
pub fn can_access_service(
    user_roles: &HashSet<&str>,
    auth_type: &AuthType,
    required_roles: Option<&[String]>,
) -> bool {
    // Admin is superuser - can access everything
    if user_roles.contains(ADMIN_ROLE) {
        return true;
    }

    // Public services (authType: None) are always accessible
    if *auth_type == AuthType::None {
        return true;
    }

    // For protected services, check if user has at least one required role
    match required_roles {
        Some(required) => {
            // User needs at least one of the required roles
            required.iter().any(|r| user_roles.contains(r.as_str()))
        }
        // If no required roles specified, deny access (fail-safe)
        // This guards against future regressions where oauth2-proxy services
        // might be missing requiredRealmRoles (descriptor validation should prevent this)
        None => false,
    }
}

/// Build a HashSet of roles from a slice for efficient lookups
///
/// Use this to precompute the role set once per request, then pass it
/// to `can_access_service` for each service check.
pub fn build_role_set(roles: &[String]) -> HashSet<&str> {
    roles.iter().map(|s| s.as_str()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Helper to create a role set from string literals
    fn roles<'a>(r: &[&'a str]) -> HashSet<&'a str> {
        r.iter().copied().collect()
    }

    // =========================================================================
    // Phase 2.7 acceptance criteria tests
    // =========================================================================

    #[test]
    fn test_dev_role_sees_demo_oauth2_proxy_with_admin_dev() {
        // demo service: oauth2-proxy, required roles: ["admin", "dev"]
        let user_roles = roles(&["dev"]);
        let required = vec!["admin".to_string(), "dev".to_string()];

        assert!(can_access_service(
            &user_roles,
            &AuthType::Oauth2Proxy,
            Some(&required)
        ));
    }

    #[test]
    fn test_dev_role_sees_docs_public() {
        // docs service: public (authType: None)
        let user_roles = roles(&["dev"]);

        assert!(can_access_service(&user_roles, &AuthType::None, None));
    }

    #[test]
    fn test_dev_role_cannot_see_dozzle_admin_only() {
        // dozzle service: oauth2-proxy, required roles: ["admin"]
        let user_roles = roles(&["dev"]);
        let required = vec!["admin".to_string()];

        assert!(!can_access_service(
            &user_roles,
            &AuthType::Oauth2Proxy,
            Some(&required)
        ));
    }

    #[test]
    fn test_admin_role_sees_everything() {
        let user_roles = roles(&["admin"]);

        // Admin can see oauth2-proxy service with any required roles
        let required_dev = vec!["dev".to_string()];
        assert!(can_access_service(
            &user_roles,
            &AuthType::Oauth2Proxy,
            Some(&required_dev)
        ));

        // Admin can see admin-only service
        let required_admin = vec!["admin".to_string()];
        assert!(can_access_service(
            &user_roles,
            &AuthType::Oauth2Proxy,
            Some(&required_admin)
        ));

        // Admin can see public services
        assert!(can_access_service(&user_roles, &AuthType::None, None));
    }

    #[test]
    fn test_public_service_visible_with_no_roles() {
        // Public service always visible even when user has no roles
        let user_roles: HashSet<&str> = HashSet::new();

        assert!(can_access_service(&user_roles, &AuthType::None, None));
    }

    #[test]
    fn test_failsafe_oauth2_proxy_without_required_roles_returns_false() {
        // Fail-safe behavior: oauth2-proxy service with required_realm_roles=None
        // returns false (even though descriptor validation should prevent this)
        let user_roles = roles(&["dev"]);

        assert!(!can_access_service(
            &user_roles,
            &AuthType::Oauth2Proxy,
            None
        ));

        // Even admin cannot bypass if we somehow have a malformed service
        // (but admin check happens first, so admin still gets access)
        let admin_roles = roles(&["admin"]);
        assert!(can_access_service(
            &admin_roles,
            &AuthType::Oauth2Proxy,
            None
        ));
    }

    // =========================================================================
    // Additional edge case tests
    // =========================================================================

    #[test]
    fn test_user_with_multiple_roles() {
        let user_roles = roles(&["dev", "ops"]);
        let required = vec!["ops".to_string()];

        assert!(can_access_service(
            &user_roles,
            &AuthType::Oauth2Proxy,
            Some(&required)
        ));
    }

    #[test]
    fn test_user_with_no_matching_roles() {
        let user_roles = roles(&["viewer"]);
        let required = vec!["admin".to_string(), "dev".to_string()];

        assert!(!can_access_service(
            &user_roles,
            &AuthType::Oauth2Proxy,
            Some(&required)
        ));
    }

    #[test]
    fn test_portal_auth_type_without_roles_is_denied() {
        // Portal auth type without required roles should be denied (fail-safe)
        let user_roles = roles(&["dev"]);

        assert!(!can_access_service(&user_roles, &AuthType::Portal, None));
    }

    #[test]
    fn test_portal_auth_type_with_matching_role() {
        let user_roles = roles(&["dev"]);
        let required = vec!["dev".to_string()];

        assert!(can_access_service(
            &user_roles,
            &AuthType::Portal,
            Some(&required)
        ));
    }

    #[test]
    fn test_build_role_set() {
        let roles_vec = vec!["admin".to_string(), "dev".to_string()];
        let role_set = build_role_set(&roles_vec);

        assert!(role_set.contains("admin"));
        assert!(role_set.contains("dev"));
        assert!(!role_set.contains("ops"));
    }
}
