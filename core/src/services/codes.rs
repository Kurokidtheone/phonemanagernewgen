// IMEI (Luhn) and EAN-13 helpers, the same rules as src/shared/imei.ts and src/shared/barcode.ts.

pub fn luhn_check_digit(body: &str) -> u32 {
    let mut sum = 0;
    for (i, c) in body.chars().rev().enumerate() {
        let mut d = c.to_digit(10).unwrap_or(0);
        if i % 2 == 0 {
            d *= 2;
            if d > 9 {
                d -= 9;
            }
        }
        sum += d;
    }
    (10 - (sum % 10)) % 10
}

pub fn is_valid_imei(v: &str) -> bool {
    v.len() == 15 && v.bytes().all(|b| b.is_ascii_digit()) && luhn_check_digit(&v[..14]) == v[14..].parse::<u32>().unwrap_or(99)
}

/// Completes 14 digits into a valid 15-digit IMEI. Seed data and tests.
pub fn make_imei(body14: &str) -> String {
    assert!(body14.len() == 14 && body14.bytes().all(|b| b.is_ascii_digit()), "An IMEI body is exactly 14 digits");
    format!("{body14}{}", luhn_check_digit(body14))
}

pub const INTERNAL_PREFIX: &str = "200";

pub fn ean13_check_digit(body12: &str) -> u32 {
    let sum: u32 = body12.chars().enumerate().map(|(i, c)| c.to_digit(10).unwrap_or(0) * if i % 2 == 0 { 1 } else { 3 }).sum();
    (10 - (sum % 10)) % 10
}

pub fn is_valid_ean13(v: &str) -> bool {
    v.len() == 13 && v.bytes().all(|b| b.is_ascii_digit()) && ean13_check_digit(&v[..12]) == v[12..].parse::<u32>().unwrap_or(99)
}

/// Internal EAN-13 for a running number: "200" + 9 digits + check digit.
pub fn internal_barcode(counter: i64) -> String {
    let body = format!("{INTERNAL_PREFIX}{counter:09}");
    format!("{body}{}", ean13_check_digit(&body))
}

pub const LOCKABLE_SECTIONS: &[&str] = &["sell", "stock", "repairs", "people", "finance", "settings"];
pub const SECTION_IDS: &[&str] = &["overview", "sell", "stock", "repairs", "people", "finance", "settings"];

pub const POPULAR_BRANDS: &[&str] = &[
    "Samsung",
    "Apple",
    "Xiaomi",
    "Redmi",
    "Poco",
    "Huawei",
    "Honor",
    "Oppo",
    "Realme",
    "OnePlus",
    "Vivo",
    "iQOO",
    "Motorola",
    "Nokia",
    "HMD",
    "Google",
    "Sony",
    "LG",
    "Asus",
    "Lenovo",
    "Infinix",
    "Tecno",
    "itel",
    "ZTE",
    "Nothing",
    "TCL",
    "Alcatel",
    "Meizu",
    "HTC",
    "BlackBerry",
    "Fairphone",
    "Cat",
    "Ulefone",
    "Doogee",
    "Blackview",
    "Oukitel",
    "Cubot",
    "Umidigi",
    "Oscal",
    "Wiko",
    "Sharp",
    "Panasonic",
    "Philips",
    "Microsoft",
    "Gionee",
    "Hisense",
    "Condor",
    "IRIS",
    "Stream System",
    "Anker",
    "Baseus",
    "Ugreen",
    "Hoco",
    "Remax",
    "Joyroom",
    "Belkin",
    "Spigen",
    "OtterBox",
    "JBL",
    "Beats",
    "Bose",
    "Kingston",
    "SanDisk",
    "Lexar",
    "Transcend",
    "Logitech",
    "Aukey",
    "Choetech",
];

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn imei_and_ean() {
        assert!(is_valid_imei("490154203237518"));
        assert!(!is_valid_imei("490154203237519"));
        assert_eq!(make_imei("49015420323751"), "490154203237518");
        assert!(is_valid_ean13(&internal_barcode(1)));
        assert_eq!(internal_barcode(1), "2000000000015");
    }
}
