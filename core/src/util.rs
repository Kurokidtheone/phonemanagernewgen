use chrono::{DateTime, SecondsFormat, Utc};

/// The current moment as an ISO string in UTC with milliseconds, like JavaScript's toISOString().
pub fn now() -> String {
    iso(Utc::now())
}

thread_local! {
    static EVENT_AT: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
    static SYNC_MODE: std::cell::Cell<SyncMode> = const { std::cell::Cell::new(SyncMode { allow_negative: false, hold_cash: false }) };
}

/// How an operation that a phone made offline is applied (see services::sync): the quantity of an accessory may go
/// below zero, and cash goes to "phone cash to hand over" instead of the open drawer.
#[derive(Clone, Copy, Default)]
pub struct SyncMode {
    pub allow_negative: bool,
    pub hold_cash: bool,
}

pub fn sync_mode() -> SyncMode {
    SYNC_MODE.with(|m| m.get())
}

/// Runs `f` with the sync mode set (restored afterwards, also when `f` fails).
pub fn with_sync_mode<T>(mode: SyncMode, f: impl FnOnce() -> T) -> T {
    let before = SYNC_MODE.with(|m| m.replace(mode));
    let out = f();
    SYNC_MODE.with(|m| m.set(before));
    out
}

/// When something happened: the moment a phone made an offline operation while it is applied, otherwise now.
/// Used for the date of a sale, a repair's received time and status log, and a stock movement's `at`.
pub fn event_now() -> String {
    EVENT_AT.with(|e| e.borrow().clone()).unwrap_or_else(now)
}

/// Runs `f` with `event_now()` returning `at`.
pub fn with_event_at<T>(at: &str, f: impl FnOnce() -> T) -> T {
    let before = EVENT_AT.with(|e| e.replace(Some(at.to_owned())));
    let out = f();
    EVENT_AT.with(|e| *e.borrow_mut() = before);
    out
}

pub fn iso(t: DateTime<Utc>) -> String {
    t.to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

/// Milliseconds since 1970 of an ISO string (any offset), like `new Date(s).getTime()`. Unparseable: None.
pub fn parse_ms(s: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(s)
        .map(|d| d.timestamp_millis())
        .ok()
        .or_else(|| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").ok().map(|d| d.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp_millis()))
}

pub fn ms_to_iso(ms: i64) -> String {
    iso(DateTime::<Utc>::from_timestamp_millis(ms).unwrap_or_default())
}

pub const DAY_MS: i64 = 86_400_000;

/// Math.round for halves away from zero on positive values, like JavaScript (which rounds .5 up).
pub fn js_round(x: f64) -> i64 {
    (x + 0.5).floor() as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn iso_has_millis_and_z() {
        let s = now();
        assert_eq!(s.len(), 24);
        assert!(s.ends_with('Z'));
        assert_eq!(parse_ms(&ms_to_iso(1_700_000_000_123)), Some(1_700_000_000_123));
        assert_eq!(js_round(-2.5), -2);
        assert_eq!(js_round(2.5), 3);
    }
}

/// "2400", "2 400,50", "2.400,5" or 2400.5 -> centimes, like src/shared/money.ts toCentimes. None when it is not a number.
pub fn to_centimes_text(input: &str) -> Option<i64> {
    let mut s: String = input.trim().chars().filter(|c| !c.is_whitespace() && *c != '\u{a0}').collect();
    if s.is_empty() {
        return None;
    }
    let last_comma = s.rfind(',');
    let last_dot = s.rfind('.');
    match (last_comma, last_dot) {
        (Some(c), Some(d)) => {
            // Both present: the last one is the decimal separator.
            s = if c > d { s.replace('.', "").replacen(',', ".", 1) } else { s.replace(',', "") };
        }
        (Some(_), None) => s = s.replacen(',', ".", 1),
        (None, Some(d)) => {
            static THOUSANDS: once_cell::sync::Lazy<regex::Regex> = once_cell::sync::Lazy::new(|| regex::Regex::new(r"^\d{1,3}(\.\d{3})+$").unwrap());
            if s.len() - d == 4 && THOUSANDS.is_match(&s) {
                s = s.replace('.', ""); // "2.400" typed as thousands
            }
        }
        (None, None) => {}
    }
    static NUMBER: once_cell::sync::Lazy<regex::Regex> = once_cell::sync::Lazy::new(|| regex::Regex::new(r"^-?\d+(\.\d+)?$").unwrap());
    if !NUMBER.is_match(&s) {
        return None;
    }
    s.parse::<f64>().ok().map(|v| js_round(v * 100.0))
}

pub fn to_centimes_number(v: f64) -> Option<i64> {
    v.is_finite().then(|| js_round(v * 100.0))
}

/// JavaScript's String(number) for the numbers a spreadsheet holds.
pub fn js_number_text(v: f64) -> String {
    if v.fract() == 0.0 && v.abs() < 1e21 {
        format!("{}", v as i128)
    } else {
        format!("{v}")
    }
}

#[cfg(test)]
mod money_tests {
    use super::*;
    #[test]
    fn centimes() {
        assert_eq!(to_centimes_text("2400"), Some(240000));
        assert_eq!(to_centimes_text("2 400,50"), Some(240050));
        assert_eq!(to_centimes_text("2.400,5"), Some(240050));
        assert_eq!(to_centimes_text("2.400"), Some(240000));
        assert_eq!(to_centimes_text("1,200.75"), Some(120075));
        assert_eq!(to_centimes_text("abc"), None);
        assert_eq!(to_centimes_number(2400.5), Some(240050));
        assert_eq!(js_number_text(6130000000012.0), "6130000000012");
        assert_eq!(js_number_text(1.5), "1.5");
    }
}
