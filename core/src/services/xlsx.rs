// A minimal .xlsx writer (one sheet, a bold header row, text and numbers) and reader (first sheet: shared strings,
// inline strings and numbers). An .xlsx is a zip of XML parts.
use crate::error::{internal, Res};
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::Value;
use std::io::{Cursor, Read, Write};

#[derive(Debug, Clone, PartialEq)]
pub enum Cell {
    Null,
    Num(f64),
    Text(String),
}

impl Cell {
    pub fn from_json(v: &Value) -> Cell {
        match v {
            Value::Number(n) => Cell::Num(n.as_f64().unwrap_or(0.0)),
            Value::String(s) => Cell::Text(s.clone()),
            _ => Cell::Null,
        }
    }
}

// XML 1.0 cannot hold most control characters, so they are dropped.
fn escape_xml(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        let n = c as u32;
        if n < 32 && n != 9 && n != 10 && n != 13 {
            continue;
        }
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
    out
}

/// 0 -> A, 25 -> Z, 26 -> AA
pub fn column_name(index: usize) -> String {
    let mut n = index as i64;
    let mut name = String::new();
    loop {
        name.insert(0, (b'A' + (n % 26) as u8) as char);
        n = n / 26 - 1;
        if n < 0 {
            break;
        }
    }
    name
}

/// A -> 0, Z -> 25, AA -> 26
pub fn column_index(name: &str) -> usize {
    let mut n: usize = 0;
    for ch in name.bytes() {
        n = n * 26 + (ch - 64) as usize;
    }
    n.saturating_sub(1)
}

fn num_text(v: f64) -> String {
    if v.is_finite() {
        crate::util::js_number_text(v)
    } else {
        "0".into()
    }
}

pub fn build_xlsx(title: &str, headers: &[String], rows: &[Vec<Cell>], money_columns: &[usize]) -> Res<Vec<u8>> {
    let cell = |value: &Cell, col: usize, row: usize, style: u8| -> String {
        let r = format!("{}{row}", column_name(col));
        let s = if style > 0 { format!(" s=\"{style}\"") } else { String::new() };
        match value {
            Cell::Null => String::new(),
            Cell::Text(t) if t.is_empty() => String::new(),
            Cell::Num(n) => format!("<c r=\"{r}\"{s}><v>{}</v></c>", num_text(*n)),
            Cell::Text(t) => format!("<c r=\"{r}\" t=\"inlineStr\"{s}><is><t xml:space=\"preserve\">{}</t></is></c>", escape_xml(t)),
        }
    };
    let header = format!("<row r=\"1\">{}</row>", headers.iter().enumerate().map(|(c, h)| cell(&Cell::Text(h.clone()), c, 1, 1)).collect::<String>());
    let body: String = rows
        .iter()
        .enumerate()
        .map(|(i, r)| {
            format!(
                "<row r=\"{}\">{}</row>",
                i + 2,
                r.iter().enumerate().map(|(c, v)| cell(v, c, i + 2, if money_columns.contains(&c) { 2 } else { 0 })).collect::<String>()
            )
        })
        .collect();
    let widths: String = headers
        .iter()
        .enumerate()
        .map(|(c, h)| format!("<col min=\"{0}\" max=\"{0}\" width=\"{1}\" customWidth=\"1\"/>", c + 1, (h.encode_utf16().count() + 4).clamp(12, 50)))
        .collect();
    let cleaned: String = title.chars().map(|c| if "\\/?*[]:".contains(c) { ' ' } else { c }).collect();
    let short = String::from_utf16_lossy(&cleaned.encode_utf16().take(31).collect::<Vec<u16>>());
    let sheet_name = escape_xml(if short.is_empty() { "Sheet1" } else { &short });

    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let mut add = |name: &str, xml: &str| -> Res<()> {
        zip.start_file(name, opts).map_err(internal)?;
        zip.write_all(format!("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n{xml}").as_bytes())?;
        Ok(())
    };
    add(
        "[Content_Types].xml",
        r#"<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>"#,
    )?;
    add(
        "_rels/.rels",
        r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#,
    )?;
    add(
        "xl/workbook.xml",
        &format!(
            r#"<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="{sheet_name}" sheetId="1" r:id="rId1"/></sheets></workbook>"#
        ),
    )?;
    add(
        "xl/_rels/workbook.xml.rels",
        r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>"#,
    )?;
    // Styles: 0 plain, 1 bold header, 2 two decimals with a thousands separator (built-in format 4).
    add(
        "xl/styles.xml",
        r#"<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>"#,
    )?;
    add(
        "xl/worksheets/sheet1.xml",
        &format!(
            r#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0" rightToLeft="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>{widths}</cols><sheetData>{header}{body}</sheetData></worksheet>"#
        ),
    )?;
    let cursor = zip.finish().map_err(internal)?;
    Ok(cursor.into_inner())
}

// ---------- reading ----------

const MAX_BYTES: usize = 5 * 1024 * 1024;
const MAX_ROWS: usize = 5_000;

#[derive(Debug, PartialEq)]
pub enum ReadError {
    TooLarge,
    NotXlsx,
}

static ENTITY_HEX: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)&#x([0-9a-f]+);").unwrap());
static ENTITY_DEC: Lazy<Regex> = Lazy::new(|| Regex::new(r"&#(\d+);").unwrap());
static RPH: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?s)<rPh.*?</rPh>").unwrap());
static T: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?s)<t(?:\s[^>]*)?>(.*?)</t>").unwrap());
static SI: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?s)<si(?:\s[^>]*)?>(.*?)</si>").unwrap());
static SHEET_RID: Lazy<Regex> = Lazy::new(|| Regex::new(r#"<sheet\b[^>]*\br:id="([^"]+)""#).unwrap());
static REL: Lazy<Regex> = Lazy::new(|| Regex::new(r"<Relationship\b[^>]*>").unwrap());
static TARGET: Lazy<Regex> = Lazy::new(|| Regex::new(r#"Target="([^"]+)""#).unwrap());
static TARGET_PREFIX: Lazy<Regex> = Lazy::new(|| Regex::new(r"^/?(xl/)?").unwrap());
static ROW: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?s)<row\b([^>]*?)(?:/>|>(.*?)</row>)").unwrap());
static ROW_R: Lazy<Regex> = Lazy::new(|| Regex::new(r#"\br="(\d+)""#).unwrap());
static C: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?s)<c\b([^>]*?)(?:/>|>(.*?)</c>)").unwrap());
static C_REF: Lazy<Regex> = Lazy::new(|| Regex::new(r#"\br="([A-Z]+)\d+""#).unwrap());
static C_TYPE: Lazy<Regex> = Lazy::new(|| Regex::new(r#"\bt="([^"]+)""#).unwrap());
static V: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?s)<v>(.*?)</v>").unwrap());

fn decode_xml(text: &str) -> String {
    let s =
        ENTITY_HEX.replace_all(text, |c: &regex::Captures| u32::from_str_radix(&c[1], 16).ok().and_then(char::from_u32).map(String::from).unwrap_or_default());
    let s = ENTITY_DEC.replace_all(&s, |c: &regex::Captures| c[1].parse::<u32>().ok().and_then(char::from_u32).map(String::from).unwrap_or_default());
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
}

/// The text of a <si> or <is> element: every <t>, skipping phonetic hints.
fn text_of(xml: &str) -> String {
    let clean = RPH.replace_all(xml, "");
    T.captures_iter(&clean).map(|m| decode_xml(&m[1])).collect()
}

/// JavaScript's Number(text) for what a spreadsheet stores.
fn js_number(text: &str) -> Option<f64> {
    let t = text.trim();
    if t.is_empty() {
        return Some(0.0);
    }
    t.parse::<f64>().ok().filter(|v| v.is_finite())
}

pub fn read_xlsx(file: &[u8]) -> Result<Vec<Vec<Cell>>, ReadError> {
    if file.len() > MAX_BYTES {
        return Err(ReadError::TooLarge);
    }
    let mut zip = zip::ZipArchive::new(Cursor::new(file)).map_err(|_| ReadError::NotXlsx)?;
    let mut read = |name: &str| -> Option<String> {
        let mut f = zip.by_name(name).ok()?;
        let mut s = String::new();
        f.read_to_string(&mut s).ok()?;
        Some(s)
    };
    let workbook = read("xl/workbook.xml").ok_or(ReadError::NotXlsx)?;
    let shared: Vec<String> = read("xl/sharedStrings.xml").map(|x| SI.captures_iter(&x).map(|m| text_of(&m[1])).collect()).unwrap_or_default();

    // The first sheet, found through the workbook relationships (its file is not always sheet1.xml).
    let mut target = "worksheets/sheet1.xml".to_owned();
    let rid = SHEET_RID.captures(&workbook).map(|c| c[1].to_owned());
    if let (Some(rid), Some(rels)) = (rid, read("xl/_rels/workbook.xml.rels")) {
        for rel in REL.find_iter(&rels) {
            if rel.as_str().contains(&format!("Id=\"{rid}\"")) {
                if let Some(t) = TARGET.captures(rel.as_str()) {
                    target = TARGET_PREFIX.replace(&t[1], "").into_owned();
                }
            }
        }
    }
    let sheet = read(&format!("xl/{target}")).ok_or(ReadError::NotXlsx)?;

    let mut rows: Vec<Vec<Cell>> = Vec::new();
    for row in ROW.captures_iter(&sheet) {
        let attrs = row.get(1).map(|m| m.as_str()).unwrap_or("");
        let number: usize = ROW_R.captures(attrs).and_then(|c| c[1].parse().ok()).unwrap_or(rows.len() + 1);
        if number > MAX_ROWS + 1 {
            break;
        }
        let mut cells: Vec<Cell> = Vec::new();
        for c in C.captures_iter(row.get(2).map(|m| m.as_str()).unwrap_or("")) {
            let attrs = c.get(1).map(|m| m.as_str()).unwrap_or("");
            let Some(r) = C_REF.captures(attrs) else { continue };
            let kind = C_TYPE.captures(attrs).map(|t| t[1].to_owned()).unwrap_or_else(|| "n".into());
            let body = c.get(2).map(|m| m.as_str()).unwrap_or("");
            let v = V.captures(body).map(|m| m[1].to_owned());
            let value = match (kind.as_str(), v) {
                ("inlineStr", _) => Cell::Text(text_of(body)),
                ("s", Some(v)) => v.trim().parse::<usize>().ok().and_then(|i| shared.get(i).cloned()).map(Cell::Text).unwrap_or(Cell::Null),
                ("str" | "e", Some(v)) => Cell::Text(decode_xml(&v)),
                ("b", Some(v)) => js_number(&v).map(Cell::Num).unwrap_or(Cell::Null),
                (_, Some(v)) if !v.is_empty() => match js_number(&v) {
                    Some(n) => Cell::Num(n),
                    None => Cell::Text(decode_xml(&v)),
                },
                _ => Cell::Null,
            };
            let col = column_index(&r[1]);
            if cells.len() <= col {
                cells.resize(col + 1, Cell::Null);
            }
            cells[col] = value;
        }
        // Rows may be sparse: keep the row number so errors can name the right line.
        while rows.len() < number.saturating_sub(1) {
            rows.push(Vec::new());
        }
        if rows.len() >= number {
            rows[number - 1] = cells;
        } else {
            rows.push(cells);
        }
    }
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn round_trip() {
        assert_eq!(column_name(0), "A");
        assert_eq!(column_name(26), "AA");
        assert_eq!(column_index("AA"), 26);
        let file = build_xlsx(
            "Report: test",
            &["name".into(), "qty".into()],
            &[vec![Cell::Text("A & <b>".into()), Cell::Num(3.0)], vec![Cell::Null, Cell::Num(1.5)]],
            &[1],
        )
        .unwrap();
        let rows = read_xlsx(&file).unwrap();
        assert_eq!(rows[0], vec![Cell::Text("name".into()), Cell::Text("qty".into())]);
        assert_eq!(rows[1], vec![Cell::Text("A & <b>".into()), Cell::Num(3.0)]);
        assert_eq!(rows[2], vec![Cell::Null, Cell::Num(1.5)]);
    }
}
