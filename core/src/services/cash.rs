// The cash drawer. Every operation that moves cash writes a cash_movements row (record_cash), only for cash
// payments: CCP, BaridiMob and the like never touch the drawer.
//
// A session is one trading day: opened with a float, closed with a count.
//   expected = opening_float + sum(IN) - sum(OUT) of the cash movements of the session.
// Movements made while no session is open have no session; opening the next session adopts them.
use crate::core::Ctx;
use crate::db::DbExt;
use crate::error::{bail, Res};
use crate::rows::{CashMovement, CashSession};
use crate::util::{now, uuid};
use crate::valid::{self, Validate};
use rusqlite::params;

pub fn open_session_row(ctx: &Ctx) -> Res<Option<CashSession>> {
    ctx.db.get("SELECT * FROM cash_sessions WHERE closed_at IS NULL ORDER BY opened_at DESC LIMIT 1", [])
}

pub fn open_session_id(ctx: &Ctx) -> Res<Option<String>> {
    Ok(open_session_row(ctx)?.map(|s| s.id))
}

/// Selling needs an open day: the till asks for the opening float first.
pub fn require_open_session(ctx: &Ctx) -> Res<String> {
    match open_session_id(ctx)? {
        Some(id) => Ok(id),
        None => bail!("no_cash_session"),
    }
}

pub struct CashEntry<'a> {
    pub direction: &'a str,
    pub amount: i64,
    pub kind: &'a str,
    pub ref_table: &'a str,
    pub ref_id: &'a str,
    pub note: &'a str,
    pub at: Option<&'a str>,
}

pub fn record_cash(ctx: &Ctx, m: CashEntry) -> Res<()> {
    if m.amount <= 0 {
        return Ok(());
    }
    let t = now();
    // Cash taken by a phone (applied from its outbox) is held: it joins the drawer only when the manager confirms it.
    let held = if crate::util::sync_mode().hold_cash { ctx.caller.device().map(str::to_owned) } else { None };
    ctx.db.exec(
        "INSERT INTO cash_movements (id, session_id, type, direction, amount, ref_table, ref_id, note, at, created_at, updated_at, held_by_device)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?11)",
        params![
            uuid(),
            if held.is_some() { None } else { open_session_id(ctx)? },
            m.kind,
            m.direction,
            m.amount,
            m.ref_table,
            m.ref_id,
            m.note,
            m.at.map(str::to_owned).unwrap_or_else(|| t.clone()),
            t,
            held
        ],
    )?;
    Ok(())
}

/// Shorthand for record_cash.
#[allow(clippy::too_many_arguments)]
pub fn cash(ctx: &Ctx, direction: &str, amount: i64, kind: &str, ref_table: &str, ref_id: &str, note: &str, at: Option<&str>) -> Res<()> {
    record_cash(ctx, CashEntry { direction, amount, kind, ref_table, ref_id, note, at })
}

fn totals(ctx: &Ctx, session_id: &str) -> Res<(i64, i64)> {
    Ok(ctx.db.prepare_cached(
        "SELECT COALESCE(SUM(CASE WHEN direction = 'IN' THEN amount END), 0), COALESCE(SUM(CASE WHEN direction = 'OUT' THEN amount END), 0) FROM cash_movements WHERE session_id = ?1",
    )?
    .query_row([session_id], |r| Ok((r.get(0)?, r.get(1)?)))?)
}

pub fn expected_cash(ctx: &Ctx, session_id: &str) -> Res<i64> {
    let Some(s) = ctx.db.get::<CashSession>("SELECT * FROM cash_sessions WHERE id = ?1", [session_id])? else { bail!("not_found") };
    let (i, o) = totals(ctx, session_id)?;
    Ok(s.opening_float + i - o)
}

row! {
    pub struct CashState {
        pub open: bool,
        pub session_id: Option<String>,
        pub last_counted: i64,
    }
}

/// What to offer as the next opening float: the cash counted when the last day was closed.
pub fn state(ctx: &Ctx) -> Res<CashState> {
    let open = open_session_row(ctx)?;
    let last: Option<i64> = ctx
        .db
        .opt_val("SELECT counted_amount FROM cash_sessions WHERE closed_at IS NOT NULL AND counted_amount IS NOT NULL ORDER BY opened_at DESC LIMIT 1", [])?;
    Ok(CashState { open: open.is_some(), session_id: open.map(|s| s.id), last_counted: last.unwrap_or(0) })
}

input! { pub struct CashOpenInput { pub opening_float: i64 } }
impl Validate for CashOpenInput {
    fn validate(&mut self) -> Res<()> {
        valid::centimes(self.opening_float, "openingFloat")
    }
}

pub fn open_session(ctx: &Ctx, input: &CashOpenInput) -> Res<crate::rows::Id> {
    ctx.tx(|| {
        if open_session_id(ctx)?.is_some() {
            bail!("session_already_open");
        }
        let id = uuid();
        let t = now();
        ctx.db.exec(
            "INSERT INTO cash_sessions (id, opened_at, opening_float, note, created_at, updated_at) VALUES (?1, ?2, ?3, '', ?2, ?2)",
            params![id, t, input.opening_float],
        )?;
        // Cash that moved while the drawer was closed belongs to this day.
        ctx.db.exec("UPDATE cash_movements SET session_id = ?1, updated_at = ?2 WHERE session_id IS NULL AND held_by_device IS NULL", params![id, t])?;
        Ok(crate::rows::Id { id })
    })
}

input! {
    pub struct CashManualInput {
        pub direction: String,
        pub amount: i64,
        pub reason: String,
        #[serde(default)]
        pub note: String,
    }
}
impl Validate for CashManualInput {
    fn validate(&mut self) -> Res<()> {
        valid::one_of(&self.direction, &["IN", "OUT"], "direction")?;
        valid::pos_centimes(self.amount, "amount")?;
        valid::one_of(&self.reason, &["OWNER_WITHDRAWAL", "CHANGE_ADDED", "BANK_DEPOSIT", "OTHER"], "reason")?;
        valid::text(&mut self.note, 0, 200, "note")
    }
}

/// Money put in or taken out by hand. The reason code is kept in ref_id, free text in note.
pub fn add_manual(ctx: &Ctx, input: &CashManualInput) -> Res<()> {
    ctx.tx(|| {
        require_open_session(ctx)?;
        let kind = if input.direction == "IN" { "MANUAL_IN" } else { "MANUAL_OUT" };
        cash(ctx, &input.direction, input.amount, kind, "manual", &input.reason, &input.note, None)
    })
}

input! {
    pub struct CashCloseInput {
        pub counted: i64,
        #[serde(default)]
        pub note: String,
    }
}
impl Validate for CashCloseInput {
    fn validate(&mut self) -> Res<()> {
        valid::centimes(self.counted, "counted")?;
        valid::text(&mut self.note, 0, 300, "note")
    }
}

row! {
    pub struct CloseResult {
        pub id: String,
        pub expected: i64,
        pub counted: i64,
        pub difference: i64,
    }
}

pub fn close_session(ctx: &Ctx, input: &CashCloseInput) -> Res<CloseResult> {
    ctx.tx(|| {
        let Some(open) = open_session_row(ctx)? else { bail!("no_cash_session") };
        let expected = expected_cash(ctx, &open.id)?;
        let difference = input.counted - expected;
        let t = now();
        ctx.db.exec(
            "UPDATE cash_sessions SET closed_at = ?1, counted_amount = ?2, expected_amount = ?3, difference = ?4, note = ?5, updated_at = ?1 WHERE id = ?6",
            params![t, input.counted, expected, difference, input.note, open.id],
        )?;
        Ok(CloseResult { id: open.id, expected, counted: input.counted, difference })
    })
}

row! {
    pub struct CurrentCash {
        pub session: CashSession,
        pub expected: i64,
        pub total_in: i64,
        pub total_out: i64,
        pub movements: Vec<CashMovement>,
    }
}

/// The open day, with its movements: for the Cash drawer page.
pub fn current(ctx: &Ctx) -> Res<Option<CurrentCash>> {
    let Some(s) = open_session_row(ctx)? else { return Ok(None) };
    let movements = ctx.db.all("SELECT * FROM cash_movements WHERE session_id = ?1 ORDER BY at DESC", [&s.id])?;
    let (i, o) = totals(ctx, &s.id)?;
    Ok(Some(CurrentCash { expected: s.opening_float + i - o, total_in: i, total_out: o, movements, session: s }))
}

row! {
    pub struct SessionRow {
        pub id: String,
        pub opened_at: String,
        pub opening_float: i64,
        pub closed_at: Option<String>,
        pub counted_amount: Option<i64>,
        pub expected_amount: Option<i64>,
        pub difference: Option<i64>,
        pub note: String,
        pub created_at: String,
        pub updated_at: String,
        pub expected: i64,
    }
}

pub fn list_sessions(ctx: &Ctx) -> Res<Vec<SessionRow>> {
    let sessions: Vec<CashSession> = ctx.db.all("SELECT * FROM cash_sessions ORDER BY opened_at DESC", [])?;
    sessions
        .into_iter()
        .map(|s| {
            let expected = if s.closed_at.is_some() { s.expected_amount.unwrap_or(0) } else { expected_cash(ctx, &s.id)? };
            Ok(SessionRow {
                id: s.id,
                opened_at: s.opened_at,
                opening_float: s.opening_float,
                closed_at: s.closed_at,
                counted_amount: s.counted_amount,
                expected_amount: s.expected_amount,
                difference: s.difference,
                note: s.note,
                created_at: s.created_at,
                updated_at: s.updated_at,
                expected,
            })
        })
        .collect()
}

row! { pub struct MethodTotal { pub method: String, pub count: i64, pub total: i64, pub paid: i64 } }
row! { pub struct ReturnTotals { pub count: i64, pub value: i64, pub cash: i64 } }
row! { pub struct ServiceTotals { pub count: i64, pub amount: i64, pub margin: i64 } }
row! { pub struct RepairTotals { pub delivered: i64, pub payments: i64 } }
row! {
    pub struct MovementTotal {
        pub r#type: String,
        #[ts(type = "'IN' | 'OUT'")]
        pub direction: String,
        pub count: i64,
        pub amount: i64,
    }
}

row! {
    pub struct ZReport {
        pub session: CashSession,
        pub from: String,
        pub to: String,
        pub sales_by_method: Vec<MethodTotal>,
        pub sales_count: i64,
        pub sales_total: i64,
        pub returns: ReturnTotals,
        pub services: ServiceTotals,
        pub repairs: RepairTotals,
        pub debt_payments: i64,
        pub expenses: i64,
        pub movements: Vec<MovementTotal>,
        pub opening_float: i64,
        pub total_in: i64,
        pub total_out: i64,
        pub expected: i64,
        pub counted: Option<i64>,
        pub difference: Option<i64>,
        pub note: String,
    }
}

/// The daily closing report (Z report): everything that happened between opening and closing.
pub fn z_report(ctx: &Ctx, session_id: &str) -> Res<ZReport> {
    let Some(s) = ctx.db.get::<CashSession>("SELECT * FROM cash_sessions WHERE id = ?1", [session_id])? else { bail!("not_found") };
    let from = s.opened_at.clone();
    let to = s.closed_at.clone().unwrap_or_else(now);
    let sales_by_method: Vec<MethodTotal> = ctx.db.all(
        "SELECT payment_method AS method, COUNT(*) AS count, SUM(total) AS total, SUM(paid) AS paid FROM sales WHERE date >= ?1 AND date <= ?2 GROUP BY payment_method ORDER BY method",
        params![from, to],
    )?;
    let returns: ReturnTotals = ctx.db.get("SELECT COUNT(*) AS count, COALESCE(SUM(returned_value), 0) AS value, COALESCE(SUM(refund_cash), 0) AS cash FROM sale_returns WHERE date >= ?1 AND date <= ?2", params![from, to])?.unwrap();
    let services: ServiceTotals = ctx.db.get("SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS amount, COALESCE(SUM(margin), 0) AS margin FROM service_sales WHERE date >= ?1 AND date <= ?2", params![from, to])?.unwrap();
    let delivered: i64 =
        ctx.db.val("SELECT COUNT(*) FROM repairs WHERE status = 'DELIVERED' AND delivered_at >= ?1 AND delivered_at <= ?2", params![from, to])?;
    let repair_payments: i64 =
        ctx.db.val("SELECT COALESCE(SUM(amount), 0) FROM customer_payments WHERE repair_id IS NOT NULL AND date >= ?1 AND date <= ?2", params![from, to])?;
    let debt_payments: i64 =
        ctx.db.val("SELECT COALESCE(SUM(amount), 0) FROM customer_payments WHERE repair_id IS NULL AND date >= ?1 AND date <= ?2", params![from, to])?;
    let movements: Vec<MovementTotal> = ctx.db.all(
        "SELECT type, direction, COUNT(*) AS count, SUM(amount) AS amount FROM cash_movements WHERE session_id = ?1 GROUP BY type, direction ORDER BY direction DESC, type",
        [session_id],
    )?;
    let sum = |kind: &str, direction: &str| movements.iter().find(|m| m.r#type == kind && m.direction == direction).map(|m| m.amount).unwrap_or(0);
    let expenses = sum("EXPENSE", "OUT") - sum("EXPENSE_CANCEL", "IN");
    let (i, o) = totals(ctx, session_id)?;
    let expected = if s.closed_at.is_some() { s.expected_amount.unwrap_or(0) } else { s.opening_float + i - o };
    Ok(ZReport {
        sales_count: sales_by_method.iter().map(|m| m.count).sum(),
        sales_total: sales_by_method.iter().map(|m| m.total).sum(),
        from,
        to,
        sales_by_method,
        returns,
        services,
        repairs: RepairTotals { delivered, payments: repair_payments },
        debt_payments,
        expenses,
        movements,
        opening_float: s.opening_float,
        total_in: i,
        total_out: o,
        expected,
        counted: s.counted_amount,
        difference: if s.closed_at.is_some() { s.difference } else { None },
        note: s.note.clone(),
        session: s,
    })
}
