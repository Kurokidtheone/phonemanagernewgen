mod common;
use chrono::Datelike;
use common::*;
use psm_core::services::{balance, catalog, customers, repairs, settings, stock};
use psm_core::util::{ms_to_iso, now_ms, parse_ms};
use psm_core::Res;
use serde::Deserialize;
use serde_json::{json, Value};

struct T {
    app: App,
    customer: String,
    part: String,
}

fn setup() -> T {
    let app = fresh();
    let customer = app.ok(|c| customers::create_customer(c, &parse(json!({ "name": "Walid", "phone": "0550000000" })))).id;
    let category = app.ok(|c| catalog::create_category(c, "Pièces", "PART")).id;
    let part = app
        .ok(|c| {
            stock::create_item(
                c,
                &parse(json!({ "name": "Écran A15", "categoryId": category, "salePrice": 900_000, "avgCost": 300_000, "isRepairPart": true })),
            )
        })
        .id;
    app.ok(|c| stock::adjust_item(c, &parse(json!({ "id": part, "delta": 5, "reason": "COUNT_CORRECTION" }))));
    T { app, customer, part }
}

#[derive(Deserialize, Debug, PartialEq)]
struct Cash {
    direction: String,
    amount: i64,
    r#type: String,
}
fn cash_row(d: &str, a: i64, t: &str) -> Cash {
    Cash { direction: d.into(), amount: a, r#type: t.into() }
}

impl T {
    fn ticket(&self, over: Value) -> Res<repairs::RepairCreated> {
        let input: repairs::RepairInput = try_parse(merge(
            json!({ "customerId": self.customer, "brand": "Samsung", "model": "A15", "fault": "Écran cassé", "estimatedPrice": 800_000 }),
            over,
        ))?;
        self.app.ctx(|c| repairs::create_repair(c, &input))
    }
    fn use_part(&self, repair: &str, quantity: i64) -> Res<psm_core::rows::Id> {
        self.app.ctx(|c| repairs::add_part(c, &parse(json!({ "repairId": repair, "productId": self.part, "quantity": quantity }))))
    }
    fn deliver(&self, id: &str, over: Value) -> Res<repairs::DeliverResult> {
        let input: repairs::RepairDeliverInput = parse(merge(json!({ "id": id, "finalPrice": 800_000 }), over));
        self.app.ctx(|c| repairs::deliver(c, &input))
    }
    fn cancel(&self, id: &str, over: Value) -> Res<repairs::CancelResult> {
        let input: repairs::RepairCancelInput = parse(merge(json!({ "id": id, "status": "CANCELLED", "refundDeposit": true }), over));
        self.app.ctx(|c| repairs::cancel(c, &input))
    }
    fn status(&self, id: &str, status: &str, note: &str) -> Res<()> {
        self.app.ctx(|c| repairs::set_status(c, &parse(json!({ "id": id, "status": status, "note": note }))))
    }
    fn get(&self, id: &str, profit: bool) -> repairs::RepairDetail {
        self.app.ok(|c| repairs::get_repair(c, id, profit))
    }
    fn qty(&self) -> i64 {
        self.app.ok(|c| stock::get_item(c, &self.part)).quantity
    }
    fn cash(&self) -> Vec<Cash> {
        self.app.rows("SELECT direction, amount, type FROM cash_movements ORDER BY rowid")
    }
    fn balance(&self) -> i64 {
        self.app.ok(|c| balance::customer_balance(c, &self.customer))
    }
    fn list(&self, f: Value) -> Vec<repairs::RepairRow> {
        self.app.ok(|c| repairs::list_repairs(c, &parse(f)))
    }
}

#[test]
fn numbers_tickets_gives_qr_tokens_and_logs_the_first_status() {
    let t = setup();
    let a = t.ticket(json!({})).unwrap();
    let b = t.ticket(json!({})).unwrap();
    let year = chrono::Local::now().year();
    assert_eq!(a.ticket_number, format!("R-{year}-00001"));
    assert_eq!(b.ticket_number, format!("R-{year}-00002"));
    assert!(psm_core::valid::QR_TOKEN.is_match(&a.qr_token));
    assert_ne!(a.qr_token, b.qr_token);
    assert_eq!(t.app.ok(|c| repairs::find_by_token(c, &a.qr_token)).unwrap().id, a.id);
    assert!(t.app.ok(|c| repairs::find_by_token(c, "PSM-aaaaaaaaaaaa")).is_none());
    assert_eq!(t.get(&a.id, true).history.iter().map(|h| h.status.as_str()).collect::<Vec<_>>(), vec!["RECEIVED"]);
}

#[test]
fn keeps_arrival_state_and_accessories_and_checks_the_imei() {
    let t = setup();
    let imei = make_imei("35000000000001");
    let r = t.ticket(json!({ "imei": imei, "arrival": { "flags": ["SCREEN_CRACKED", "POWERS_ON"], "note": "scratches" }, "accessories": { "items": ["SIM", "CASE"], "note": "" } })).unwrap();
    let d = t.get(&r.id, true);
    assert_eq!(d.imei, Some(imei));
    assert_eq!(d.arrival.flags, vec!["SCREEN_CRACKED", "POWERS_ON"]);
    assert_eq!(d.accessories.items, vec!["SIM", "CASE"]);
    assert_eq!(code(t.ticket(json!({ "imei": "123" }))), "imei_invalid");
    assert_eq!(code(t.ticket(json!({ "customerId": "nope" }))), "not_found");
    assert!(try_parse::<repairs::RepairInput>(json!({ "customerId": t.customer, "fault": "   " })).is_err());
}

#[test]
fn a_deposit_is_a_payment_tied_to_the_repair() {
    let t = setup();
    let r = t.ticket(json!({ "deposit": 200_000 })).unwrap();
    assert_eq!(t.cash(), vec![cash_row("IN", 200_000, "REPAIR_DEPOSIT")]);
    let d = t.get(&r.id, true);
    assert_eq!((d.paid, d.remaining), (200_000, 600_000)); // against the estimate while open
    t.ticket(json!({ "deposit": 100_000, "depositMethod": "CCP" })).unwrap();
    assert_eq!(t.cash().len(), 1);
}

#[test]
fn moves_between_open_statuses_and_refuses_changes_once_closed() {
    let t = setup();
    let r = t.ticket(json!({})).unwrap();
    for s in ["DIAGNOSING", "WAITING_PARTS", "READY", "DIAGNOSING"] {
        t.status(&r.id, s, if s == "READY" { "tested" } else { "" }).unwrap();
    }
    assert_eq!(
        t.get(&r.id, true).history.iter().map(|h| h.status.as_str()).collect::<Vec<_>>(),
        vec!["RECEIVED", "DIAGNOSING", "WAITING_PARTS", "READY", "DIAGNOSING"]
    );
    assert!(try_parse::<repairs::RepairStatusInput>(json!({ "id": r.id, "status": "DELIVERED" })).is_err()); // delivery has its own step
    t.deliver(&r.id, json!({})).unwrap();
    assert_eq!(code(t.status(&r.id, "READY", "")), "repair_closed");
    assert_eq!(code(t.deliver(&r.id, json!({}))), "repair_closed");
}

#[test]
fn a_part_leaves_stock_at_average_cost_and_comes_back_when_removed() {
    let t = setup();
    let r = t.ticket(json!({})).unwrap();
    let part = t.use_part(&r.id, 2).unwrap();
    assert_eq!(t.qty(), 3);
    assert_eq!(t.app.val::<String>("SELECT quantity || ':' || unit_cost FROM stock_movements WHERE type = 'REPAIR_USE'"), "-2:300000");
    let parts = t.get(&r.id, true).parts;
    assert_eq!((parts[0].name.as_str(), parts[0].quantity, parts[0].unit_cost), ("Écran A15", 2, Some(300_000)));
    assert_eq!(t.get(&r.id, false).parts[0].unit_cost, None);
    t.app.ok(|c| repairs::remove_part(c, &part.id));
    assert_eq!(t.qty(), 5);
    assert!(t.get(&r.id, true).parts.is_empty());
    assert_eq!(t.app.val::<i64>("SELECT count(*) FROM stock_movements WHERE type = 'REPAIR_USE'"), 2);
}

#[test]
fn refuses_more_than_stock_and_changes_on_a_closed_ticket() {
    let t = setup();
    let r = t.ticket(json!({})).unwrap();
    assert_eq!(code(t.use_part(&r.id, 6)), "insufficient_stock");
    assert_eq!(t.qty(), 5);
    t.app.ok(|c| settings::update_public(c.db, serde_json::from_value(json!({ "allowNegativeStock": true })).unwrap()));
    assert!(t.use_part(&r.id, 6).is_ok());
    let row = t.use_part(&r.id, 1).unwrap();
    t.deliver(&r.id, json!({})).unwrap();
    assert_eq!(code(t.use_part(&r.id, 1)), "repair_closed");
    assert_eq!(code(t.app.ctx(|c| repairs::remove_part(c, &row.id))), "repair_closed");
}

#[test]
fn lists_the_spare_parts_that_can_be_used() {
    let t = setup();
    let parts = t.app.ok(repairs::list_repair_parts);
    assert_eq!(parts.len(), 1);
    assert_eq!((parts[0].name.as_str(), parts[0].quantity), ("Écran A15", 5));
}

#[test]
fn profit_is_final_price_minus_parts_at_their_cost_then() {
    let t = setup();
    let r = t.ticket(json!({})).unwrap();
    t.use_part(&r.id, 1).unwrap();
    let from = ms_to_iso(now_ms() - 1000);
    t.deliver(&r.id, json!({ "finalPrice": 800_000, "paid": 800_000, "warrantyDays": 30 })).unwrap();
    assert_eq!(t.qty(), 4);
    let d = t.get(&r.id, true);
    assert_eq!((d.status.as_str(), d.profit, d.remaining, d.warranty_days), ("DELIVERED", Some(500_000), 0, 30));
    let delivered = parse_ms(d.delivered_at.as_deref().unwrap()).unwrap();
    assert_eq!((parse_ms(d.warranty_end.as_deref().unwrap()).unwrap() - delivered) / 86_400_000, 30);
    assert_eq!(t.app.ok(|c| repairs::repair_profit(c, &from, &ms_to_iso(now_ms() + 1000))), 500_000);
    assert_eq!(t.get(&r.id, false).profit, None);
    // A later change of the part's average cost does not change the profit.
    let item = t.app.ok(|c| stock::get_item(c, &t.part));
    let update: stock::ItemUpdateInput = parse(
        json!({ "id": t.part, "name": item.name, "categoryId": item.category_id, "salePrice": item.sale_price, "avgCost": 900_000, "isRepairPart": true }),
    );
    t.app.ok(|c| stock::update_item(c, &update));
    assert_eq!(t.get(&r.id, true).profit, Some(500_000));
}

#[test]
fn deposit_final_price_and_payment_leave_the_rest_as_debt() {
    let t = setup();
    let r = t.ticket(json!({ "deposit": 200_000 })).unwrap();
    let result = t.deliver(&r.id, json!({ "finalPrice": 800_000, "paid": 400_000 })).unwrap();
    assert_eq!(result.remaining, 200_000);
    let d = t.get(&r.id, true);
    assert_eq!((d.paid, d.remaining), (600_000, 200_000));
    assert_eq!(t.balance(), 200_000);
    assert_eq!(t.cash(), vec![cash_row("IN", 200_000, "REPAIR_DEPOSIT"), cash_row("IN", 400_000, "REPAIR_PAYMENT")]);
    // The customer can settle it later like any debt.
    t.app.ok(|c| customers::receive_payment(c, &parse(json!({ "customerId": t.customer, "amount": 200_000, "date": now() }))));
    assert_eq!(t.balance(), 0);
    assert_eq!(t.get(&r.id, true).remaining, 0);
}

#[test]
fn refuses_paying_more_than_the_final_price() {
    let t = setup();
    let r = t.ticket(json!({ "deposit": 500_000 })).unwrap();
    assert_eq!(code(t.deliver(&r.id, json!({ "finalPrice": 800_000, "paid": 400_000 }))), "paid_exceeds_total");
    assert_eq!(t.get(&r.id, true).status, "RECEIVED");
}

#[test]
fn shows_on_the_customer_page() {
    let t = setup();
    let r = t.ticket(json!({})).unwrap();
    t.deliver(&r.id, json!({ "paid": 800_000 })).unwrap();
    let page = t.app.ok(|c| customers::get_customer(c, &t.customer));
    assert_eq!((page.repairs[0].ticket.as_str(), page.repairs[0].status.as_str(), page.repairs[0].price), (r.ticket_number.as_str(), "DELIVERED", 800_000));
    assert_eq!(page.stats.total_bought, 800_000);
}

#[test]
fn cancelling_returns_the_parts_to_stock() {
    let t = setup();
    let r = t.ticket(json!({})).unwrap();
    t.use_part(&r.id, 2).unwrap();
    assert_eq!(t.qty(), 3);
    t.cancel(&r.id, json!({})).unwrap();
    assert_eq!(t.qty(), 5);
    let d = t.get(&r.id, true);
    assert_eq!((d.status.as_str(), d.parts.len(), d.final_price, d.remaining), ("CANCELLED", 0, Some(0), 0));
    assert_eq!(t.app.val::<String>("SELECT reason FROM stock_movements WHERE type = 'REPAIR_USE' AND quantity > 0"), "CANCELLED");
}

#[test]
fn refunds_the_deposit_less_a_diagnosis_fee() {
    let t = setup();
    let r = t.ticket(json!({ "deposit": 300_000 })).unwrap();
    let res = t.cancel(&r.id, json!({ "status": "UNREPAIRABLE", "fee": 100_000, "refundDeposit": true })).unwrap();
    assert_eq!((res.fee, res.refund, res.remaining), (100_000, 200_000, 0));
    assert_eq!(t.cash().pop().unwrap(), cash_row("OUT", 200_000, "REPAIR_REFUND"));
    let d = t.get(&r.id, true);
    assert_eq!((d.status.as_str(), d.paid, d.remaining), ("UNREPAIRABLE", 100_000, 0));
    assert_eq!(t.balance(), 0);
}

#[test]
fn keeps_the_deposit_as_the_fee() {
    let t = setup();
    let r = t.ticket(json!({ "deposit": 300_000 })).unwrap();
    let res = t.cancel(&r.id, json!({ "refundDeposit": false, "fee": 100_000 })).unwrap();
    assert_eq!((res.fee, res.refund, res.remaining), (300_000, 0, 0));
    assert_eq!(t.cash().len(), 1);
    assert_eq!(t.balance(), 0);
    assert_eq!(t.app.ok(|c| repairs::repair_profit(c, &ms_to_iso(now_ms() - 1000), &ms_to_iso(now_ms() + 1000))), 300_000);
}

#[test]
fn a_fee_larger_than_the_deposit_is_debt() {
    let t = setup();
    let r = t.ticket(json!({ "deposit": 50_000 })).unwrap();
    let res = t.cancel(&r.id, json!({ "fee": 150_000, "refundDeposit": true })).unwrap();
    assert_eq!((res.refund, res.remaining), (0, 100_000));
    assert_eq!(t.balance(), 100_000);
}

#[test]
fn lists_filter_by_status_period_overdue_and_keep_todays_deliveries() {
    let t = setup();
    let late = t.ticket(json!({ "dueAt": ms_to_iso(now_ms() - 2 * 86_400_000) })).unwrap();
    let ontime = t.ticket(json!({ "dueAt": ms_to_iso(now_ms() + 2 * 86_400_000) })).unwrap();
    t.ticket(json!({})).unwrap();
    assert_eq!(t.list(json!({})).len(), 3);
    assert_eq!(t.list(json!({ "overdue": true })).into_iter().map(|r| r.id).collect::<Vec<_>>(), vec![late.id.clone()]);
    assert_eq!(t.list(json!({ "status": "RECEIVED" })).len(), 3);
    t.status(&ontime.id, "READY", "").unwrap();
    assert_eq!(t.list(json!({ "status": "READY" })).into_iter().map(|r| r.id).collect::<Vec<_>>(), vec![ontime.id.clone()]);
    assert!(t.list(json!({ "from": ms_to_iso(now_ms() + 86_400_000) })).is_empty());
    t.deliver(&late.id, json!({})).unwrap();
    assert_eq!(t.list(json!({ "boardSince": ms_to_iso(now_ms() - 3_600_000) })).len(), 3);
    assert_eq!(t.list(json!({ "boardSince": ms_to_iso(now_ms() + 3_600_000) })).len(), 2); // delivered ones drop off later
    assert!(t.list(json!({ "overdue": true })).is_empty()); // delivered tickets are not overdue
}

#[test]
fn suggests_brands_and_models_seen_before() {
    let t = setup();
    t.app.ok(|c| catalog::create_brand(c, "Xiaomi"));
    t.ticket(json!({ "brand": "Tecno", "model": "Spark 20" })).unwrap();
    let s = t.app.ok(repairs::suggestions);
    assert!(s.brands.contains(&"Xiaomi".to_owned()) && s.brands.contains(&"Tecno".to_owned()));
    assert!(s.models.contains(&"Spark 20".to_owned()));
}
