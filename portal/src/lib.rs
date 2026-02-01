//! Portal service library
//!
//! Provides the core functionality for the portal web service.

#![deny(dead_code)]

pub mod assets;
pub mod auth;
pub mod config;
pub mod services;
pub mod web;

use auth::jwt::JwtValidator;
use config::Config;
use services::{Descriptor, ServiceCard};
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    pub services: Vec<ServiceCard>,
    pub logos: Vec<String>,
    pub jwt_validator: Arc<JwtValidator>,
    pub config: Arc<Config>,
    /// Full descriptor for logout fan-out (oauth2-proxy service URLs)
    pub descriptor: Arc<Descriptor>,
}
