use crate::services::ServiceCard;
use askama::Template;

#[derive(Template)]
#[template(path = "landing.html")]
pub struct LandingTemplate {
    pub logo_url: Option<String>,
}

#[derive(Template)]
#[template(path = "dashboard.html")]
pub struct DashboardTemplate {
    pub username: String,
    pub email: Option<String>,
    pub services: Vec<ServiceCard>,
}
