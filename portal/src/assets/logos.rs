use anyhow::Result;
use std::fs;

pub fn discover_logos() -> Result<Vec<String>> {
    let logo_dir = "static/logos";

    if !std::path::Path::new(logo_dir).exists() {
        return Ok(Vec::new());
    }

    let mut logos = Vec::new();

    for entry in fs::read_dir(logo_dir)? {
        let entry = entry?;
        let path = entry.path();

        if let Some(ext) = path.extension() {
            let ext = ext.to_string_lossy().to_lowercase();
            if matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "svg" | "webp") {
                if let Some(filename) = path.file_name() {
                    logos.push(filename.to_string_lossy().to_string());
                }
            }
        }
    }

    Ok(logos)
}

pub fn select_random_logo(logos: &[String]) -> Option<String> {
    if logos.is_empty() {
        return None;
    }

    let index = fastrand::usize(..logos.len());
    Some(logos[index].clone())
}
