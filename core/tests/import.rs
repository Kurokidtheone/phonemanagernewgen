mod common;
use common::*;
use psm_core::services::catalog;
use psm_core::services::import::{import_items, preview_items, template_file};
use psm_core::services::xlsx::{build_xlsx, column_name, read_xlsx, Cell, ReadError};
use serde::Deserialize;
use std::io::{Cursor, Read, Write};

fn t(s: &str) -> Cell {
    Cell::Text(s.into())
}
fn n(v: f64) -> Cell {
    Cell::Num(v)
}

fn headers(h: &[&str]) -> Vec<String> {
    h.iter().map(|s| s.to_string()).collect()
}

fn file(app: &App, rows: Vec<Vec<Cell>>, head: &[&str]) -> String {
    let path = app.dir.path().join(format!("items-{}.xlsx", psm_core::util::uuid()));
    std::fs::write(&path, build_xlsx("Items", &headers(head), &rows, &[]).unwrap()).unwrap();
    path.display().to_string()
}

const HEADERS: &[&str] = &["name", "category", "barcode", "quantity", "cost", "price"];

fn zip_entries(bytes: &[u8]) -> zip::ZipArchive<Cursor<&[u8]>> {
    zip::ZipArchive::new(Cursor::new(bytes)).unwrap()
}

fn entry_text(bytes: &[u8], name: &str) -> String {
    let mut z = zip_entries(bytes);
    let mut s = String::new();
    z.by_name(name).unwrap().read_to_string(&mut s).unwrap();
    s
}

#[test]
fn names_columns_like_a_spreadsheet() {
    let names: Vec<String> = [0, 1, 25, 26, 27, 701, 702].iter().map(|i| column_name(*i)).collect();
    assert_eq!(names, vec!["A", "B", "Z", "AA", "AB", "ZZ", "AAA"]);
}

#[test]
fn writes_a_workbook_with_header_text_numbers_and_escaped_characters() {
    let file = build_xlsx(
        "Best <models>",
        &headers(&["Model", "Qty", "Revenue"]),
        &[vec![t("Galaxy A15 & \"case\""), n(3.0), n(12345.5)], vec![t("Écran"), n(0.0), Cell::Null]],
        &[2],
    )
    .unwrap();
    let mut names: Vec<String> = zip_entries(&file).file_names().map(str::to_owned).collect();
    names.sort();
    assert_eq!(names, vec!["[Content_Types].xml", "_rels/.rels", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml"]);
    let sheet = entry_text(&file, "xl/worksheets/sheet1.xml");
    assert!(sheet.contains(r#"<c r="A1" t="inlineStr" s="1"><is><t xml:space="preserve">Model</t></is></c>"#));
    assert!(sheet.contains("Galaxy A15 &amp; &quot;case&quot;"));
    assert!(sheet.contains(r#"<c r="B2"><v>3</v></c>"#));
    assert!(sheet.contains(r#"<c r="C2" s="2"><v>12345.5</v></c>"#));
    assert!(sheet.contains(r#"<c r="B3"><v>0</v></c>"#));
    assert!(!sheet.contains("C3")); // an empty cell is left out
    assert!(entry_text(&file, "xl/workbook.xml").contains(r#"name="Best &lt;models&gt;""#));
}

#[test]
fn keeps_arabic_text_and_sheet_names_within_the_limits() {
    let file = build_xlsx(&"x".repeat(50), &headers(&["الاسم"]), &[vec![t("هاتف")]], &[]).unwrap();
    assert!(entry_text(&file, "xl/worksheets/sheet1.xml").contains("هاتف"));
    assert!(entry_text(&file, "xl/workbook.xml").contains(&format!("name=\"{}\"", "x".repeat(31))));
}

#[test]
fn reads_back_what_the_exporter_wrote() {
    let bytes = build_xlsx("T", &headers(&["الاسم", "qty"]), &[vec![t("هاتف & \"x\""), n(3.0)], vec![t("b"), Cell::Null]], &[]).unwrap();
    assert_eq!(read_xlsx(&bytes).unwrap(), vec![vec![t("الاسم"), t("qty")], vec![t("هاتف & \"x\""), n(3.0)], vec![t("b")]]);
}

#[test]
fn reads_a_file_written_by_excel() {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let opts = zip::write::SimpleFileOptions::default();
    let mut add = |name: &str, xml: &str| {
        zip.start_file(name, opts).unwrap();
        zip.write_all(xml.as_bytes()).unwrap();
    };
    add("xl/workbook.xml", r#"<workbook xmlns:r="r"><sheets><sheet name="Data" sheetId="3" r:id="rId9"/></sheets></workbook>"#);
    add("xl/_rels/workbook.xml.rels", r#"<Relationships><Relationship Id="rId9" Type="x" Target="worksheets/sheet3.xml"/></Relationships>"#);
    add("xl/sharedStrings.xml", "<sst><si><t>Nom</t></si><si><r><t>Écran </t></r><r><t>A15</t></r></si><si><t>Caf&#233; &amp; Co</t></si></sst>");
    add(
        "xl/worksheets/sheet3.xml",
        r#"<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>2</v></c></row><row r="3"><c r="A3" t="s"><v>1</v></c><c r="B3"><v>12.5</v></c><c r="D3" t="b"><v>1</v></c></row></sheetData></worksheet>"#,
    );
    let bytes = zip.finish().unwrap().into_inner();
    assert_eq!(read_xlsx(&bytes).unwrap(), vec![vec![t("Nom"), Cell::Null, t("Café & Co")], vec![], vec![t("Écran A15"), n(12.5), Cell::Null, n(1.0)]]);
}

#[test]
fn refuses_what_is_not_an_excel_file() {
    assert_eq!(read_xlsx(b"hello").unwrap_err(), ReadError::NotXlsx);
    assert_eq!(read_xlsx(&vec![0u8; 6 * 1024 * 1024]).unwrap_err(), ReadError::TooLarge);
}

#[test]
fn previews_every_row_with_its_errors_without_writing() {
    let app = fresh();
    app.ok(|c| catalog::create_category(c, "Chargeurs", "ACCESSORY"));
    let path = file(
        &app,
        vec![
            vec![t("Chargeur 25W"), t("chargeurs"), n(6130000000012.0), n(20.0), n(1100.0), n(1800.0)],
            vec![t("Coque A15"), t("Coques"), t(""), n(15.0), n(350.0), n(600.0)],
            vec![t(""), t("Coques"), t(""), n(1.0), n(1.0), n(1.0)],
            vec![t("Câble"), t(""), t("6130000000029"), n(5.0), n(100.0), t("abc")],
            vec![t("Câble 2"), t("Câbles"), t("6130000000012"), n(5.0), n(100.0), n(200.0)],
            vec![t("Verre"), t("Verres"), t("bad barcode!"), n(-2.0), t("x"), n(400.0)],
        ],
        HEADERS,
    );
    let p = app.ok(|c| preview_items(c, &path));
    assert_eq!((p.valid, p.invalid, p.new_categories.clone()), (2, 4, vec!["Coques".to_owned()]));
    let errors: Vec<(i64, Vec<String>)> = p.rows.iter().map(|r| (r.line, r.errors.clone())).collect();
    let e = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    assert_eq!(
        errors,
        vec![
            (2, e(&[])),
            (3, e(&[])),
            (4, e(&["name_required"])),
            (5, e(&["category_required", "price_invalid"])),
            (6, e(&["barcode_repeated"])),
            (7, e(&["cost_invalid", "quantity_invalid", "barcode_invalid"])),
        ]
    );
    let r = &p.rows[0];
    assert_eq!(
        (r.category.as_str(), r.barcode.as_deref(), r.quantity, r.cost, r.price, r.new_category),
        ("Chargeurs", Some("6130000000012"), 20.0, 110_000, 180_000, false)
    );
    assert_eq!(app.val::<i64>("SELECT count(*) FROM products"), 0);
}

#[test]
fn imports_the_valid_rows_with_their_movements_and_new_categories() {
    let app = fresh();
    let path = file(
        &app,
        vec![
            vec![t("Chargeur 25W"), t("Chargeurs"), t("6130000000012"), n(20.0), t("1 100,50"), n(1800.0)],
            vec![t("Coque A15"), t("Coques"), t(""), n(15.0), n(350.0), n(600.0)],
            vec![t(""), t("Coques"), t(""), n(1.0), n(1.0), n(1.0)],
        ],
        HEADERS,
    );
    let r = app.ok(|c| import_items(c, &path));
    assert_eq!((r.imported, r.skipped, r.categories_created), (2, 1, 2));
    #[derive(Deserialize, Debug, PartialEq)]
    struct I {
        name: String,
        barcode: Option<String>,
        quantity: i64,
        cost: i64,
        price: i64,
    }
    let items: Vec<I> = app.rows("SELECT name, barcode, quantity, avg_cost AS cost, sale_price AS price FROM products WHERE kind = 'ITEM' ORDER BY name");
    assert_eq!(
        items,
        vec![
            I { name: "Chargeur 25W".into(), barcode: Some("6130000000012".into()), quantity: 20, cost: 110_050, price: 180_000 },
            I { name: "Coque A15".into(), barcode: None, quantity: 15, cost: 35_000, price: 60_000 },
        ]
    );
    #[derive(Deserialize, Debug, PartialEq)]
    struct M {
        quantity: i64,
        reason: String,
        cost: i64,
    }
    let moves: Vec<M> = app.rows("SELECT quantity, reason, unit_cost AS cost FROM stock_movements ORDER BY quantity DESC");
    assert_eq!(moves, vec![M { quantity: 20, reason: "IMPORT".into(), cost: 110_050 }, M { quantity: 15, reason: "IMPORT".into(), cost: 35_000 }]);
    let mut cats: Vec<String> = app.ok(catalog::list_categories).into_iter().map(|c| c.name).collect();
    cats.sort();
    assert_eq!(cats, vec!["Chargeurs", "Coques"]);
    // Importing the same file again flags the rows that have a barcode.
    assert_eq!(app.ok(|c| preview_items(c, &path)).rows[0].errors, vec!["barcode_exists"]);
}

#[test]
fn accepts_french_and_arabic_columns_and_needs_name_and_price() {
    let app = fresh();
    let path = file(&app, vec![vec![t("Chargeur"), t("Chargeurs"), n(20.0), n(1800.0)]], &["Nom", "Catégorie", "Quantité", "السعر"]);
    let rows = app.ok(|c| preview_items(c, &path)).rows;
    assert_eq!((rows[0].name.as_str(), rows[0].quantity, rows[0].price, rows[0].errors.len()), ("Chargeur", 20.0, 180_000, 0));
    let bad = file(&app, vec![vec![t("x")]], &["foo"]);
    assert_eq!(code(app.ctx(|c| preview_items(c, &bad))), "import_bad_header");
    let txt = app.dir.path().join("notes.txt").display().to_string();
    assert_eq!(code(app.ctx(|c| preview_items(c, &txt))), "import_not_xlsx");
}

#[test]
fn writes_a_template_the_importer_reads_back() {
    let app = fresh();
    let path = app.dir.path().join("template.xlsx");
    std::fs::write(&path, template_file().unwrap()).unwrap();
    let p = app.ok(|c| preview_items(c, &path.display().to_string()));
    assert_eq!((p.valid, p.invalid), (2, 0));
    assert_eq!(read_xlsx(&template_file().unwrap()).unwrap()[0], HEADERS.iter().map(|h| t(h)).collect::<Vec<_>>());
}
