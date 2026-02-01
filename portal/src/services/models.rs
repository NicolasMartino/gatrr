use std::collections::HashSet;

use super::authz::{build_role_set, can_access_service};
use super::descriptor::AuthType;
use serde::{Deserialize, Serialize};

/// Service card for UI rendering
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServiceCard {
    /// Stable identifier / slug
    pub id: String,
    /// Display name
    pub name: String,
    /// Browser-visible URL
    pub url: String,
    /// Icon (emoji or icon name)
    pub icon: String,
    /// Optional description
    pub description: Option<String>,
    /// Whether the service requires authentication
    pub protected: bool,
    /// How authentication is handled
    pub auth_type: AuthType,
    /// Required realm roles to access this service (for UI filtering)
    pub required_realm_roles: Option<Vec<String>>,
}

impl ServiceCard {
    /// Check if a user with the given roles can access this service
    ///
    /// Per plan.md 2.7:
    /// - authType: None services are always accessible
    /// - authType: Oauth2Proxy services require at least one matching role
    /// - Users with "admin" role can access all services (superuser)
    ///
    /// For better efficiency when checking multiple services, use
    /// `is_accessible_by_role_set` with a precomputed HashSet.
    pub fn is_accessible_by(&self, user_roles: &[String]) -> bool {
        let role_set = build_role_set(user_roles);
        self.is_accessible_by_role_set(&role_set)
    }

    /// Check if a user can access this service using a precomputed role set
    ///
    /// This is more efficient when filtering multiple services for the same user,
    /// as the HashSet is built once and reused.
    pub fn is_accessible_by_role_set(&self, user_roles: &HashSet<&str>) -> bool {
        can_access_service(
            user_roles,
            &self.auth_type,
            self.required_realm_roles.as_deref(),
        )
    }
}
