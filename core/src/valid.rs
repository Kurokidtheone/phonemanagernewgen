// Input checks mirroring the Zod schemas in src/shared/schemas.ts (which the renderer still uses for its
// forms and for the TypeScript input types). Every channel input is checked here before a service runs.
use crate::error::{invalid, Res};
use once_cell::sync::Lazy;
use regex::Regex;

pub const MAX_CENTIMES: i64 = 100_000_000_000;

/// Length the way JavaScript counts it (UTF-16 code units).
fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Zod's trim(): JavaScript's whitespace set is close enough to Rust's.
fn trim_in_place(s: &mut String) {
    let t = s.trim();
    if t.len() != s.len() {
        *s = t.to_owned();
    }
}

/// z.string().trim().min(min).max(max)
pub fn text(s: &mut String, min: usize, max: usize, field: &str) -> Res<()> {
    trim_in_place(s);
    len(s, min, max, field)
}

/// z.string().min(min).max(max) (no trim)
pub fn len(s: &str, min: usize, max: usize, field: &str) -> Res<()> {
    let n = js_len(s);
    if n < min || n > max {
        return Err(invalid(format!("{field}: length {n} not in {min}..={max}")));
    }
    Ok(())
}

/// z.string().min(1)
pub fn id(s: &str, field: &str) -> Res<()> {
    len(s, 1, usize::MAX, field)
}

pub fn opt_id(s: &Option<String>, field: &str) -> Res<()> {
    match s {
        Some(s) => id(s, field),
        None => Ok(()),
    }
}

/// z.string().nullish().transform(v => v || null)
pub fn empty_to_none(s: &mut Option<String>) {
    if s.as_deref() == Some("") {
        *s = None;
    }
}

/// optionalText(max): trim, max length, empty becomes null.
pub fn opt_text(s: &mut Option<String>, max: usize, field: &str) -> Res<()> {
    if let Some(v) = s {
        text(v, 0, max, field)?;
        if v.is_empty() {
            *s = None;
        }
    }
    Ok(())
}

/// A string that may be absent (not nullish-to-null, just optional), trimmed when present.
pub fn opt_trimmed(s: &mut Option<String>, min: usize, max: usize, field: &str) -> Res<()> {
    if let Some(v) = s {
        text(v, min, max, field)?;
    }
    Ok(())
}

pub fn range(v: i64, min: i64, max: i64, field: &str) -> Res<()> {
    if v < min || v > max {
        return Err(invalid(format!("{field}: {v} not in {min}..={max}")));
    }
    Ok(())
}

/// centimes: an integer from 0 to 1e11.
pub fn centimes(v: i64, field: &str) -> Res<()> {
    range(v, 0, MAX_CENTIMES, field)
}

/// centimes.refine(v > 0)
pub fn pos_centimes(v: i64, field: &str) -> Res<()> {
    range(v, 1, MAX_CENTIMES, field)
}

pub fn one_of(v: &str, allowed: &[&str], field: &str) -> Res<()> {
    if allowed.contains(&v) {
        Ok(())
    } else {
        Err(invalid(format!("{field}: {v:?} not allowed")))
    }
}

pub fn opt_one_of(v: &Option<String>, allowed: &[&str], field: &str) -> Res<()> {
    match v {
        Some(v) => one_of(v, allowed, field),
        None => Ok(()),
    }
}

static DATETIME: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$").unwrap());
static DATE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\d{4}-\d{2}-\d{2}$").unwrap());
static STORED: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[0-9a-f-]{36}\.(jpe?g|png|webp)$").unwrap());
pub static QR_TOKEN: Lazy<Regex> = Lazy::new(|| Regex::new(r"^PSM-[A-Za-z0-9_-]{12}$").unwrap());

/// z.string().datetime(): ISO 8601 in UTC with a Z.
pub fn datetime(s: &str, field: &str) -> Res<()> {
    if DATETIME.is_match(s) && chrono::DateTime::parse_from_rfc3339(&normalize_dt(s)).is_ok() {
        Ok(())
    } else {
        Err(invalid(format!("{field}: not a datetime")))
    }
}

fn normalize_dt(s: &str) -> String {
    // "2024-01-01T10:00Z" (no seconds) is valid for Zod but not RFC 3339.
    if s.len() == 17 {
        format!("{}:00Z", &s[..16])
    } else {
        s.to_owned()
    }
}

pub fn opt_datetime(s: &Option<String>, field: &str) -> Res<()> {
    match s {
        Some(s) => datetime(s, field),
        None => Ok(()),
    }
}

/// YYYY-MM-DD
pub fn date(s: &str, field: &str) -> Res<()> {
    if DATE.is_match(s) {
        Ok(())
    } else {
        Err(invalid(format!("{field}: not a date")))
    }
}

pub fn opt_date(s: &Option<String>, field: &str) -> Res<()> {
    match s {
        Some(s) => date(s, field),
        None => Ok(()),
    }
}

/// A file name the PC stored itself: <uuid>.jpg|png|webp
pub fn stored_file(s: &str, field: &str) -> Res<()> {
    if STORED.is_match(s) {
        Ok(())
    } else {
        Err(invalid(format!("{field}: not a stored file name")))
    }
}

pub fn max_items<T>(v: &[T], min: usize, max: usize, field: &str) -> Res<()> {
    if v.len() < min || v.len() > max {
        return Err(invalid(format!("{field}: {} items not in {min}..={max}", v.len())));
    }
    Ok(())
}

pub fn check(cond: bool, why: &str) -> Res<()> {
    if cond {
        Ok(())
    } else {
        Err(invalid(why))
    }
}

/// Every channel input implements this: trims, applies defaults that need code, and checks limits.
pub trait Validate {
    fn validate(&mut self) -> Res<()>;
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn datetimes() {
        assert!(datetime("2024-05-01T10:00:00.000Z", "d").is_ok());
        assert!(datetime("2024-05-01T10:00:00Z", "d").is_ok());
        assert!(datetime("2024-05-01T10:00Z", "d").is_ok());
        assert!(datetime("2024-05-01T10:00:00+01:00", "d").is_err());
        assert!(datetime("2024-05-01", "d").is_err());
    }
    #[test]
    fn texts() {
        let mut s = "  ab ".to_owned();
        text(&mut s, 1, 2, "s").unwrap();
        assert_eq!(s, "ab");
        let mut o = Some("   ".to_owned());
        opt_text(&mut o, 5, "o").unwrap();
        assert_eq!(o, None);
    }
}
