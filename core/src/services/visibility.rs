// Who may see costs and profit. While the Finance section is locked and "hide cost and profit when Finance is
// locked" is on (the default), the core strips cost and profit from what it sends, so no screen can show them.
// A phone is governed by its role, not by the desktop lock: only an owner phone sees costs.
use super::auth::is_locked;
use super::settings::get_public;
use crate::caller::Caller;
use crate::core::Ctx;
use crate::error::Res;

pub fn costs_visible(ctx: &Ctx) -> Res<bool> {
    if let Caller::Device(d) = &ctx.caller {
        return Ok(d.role.as_deref() == Some("OWNER"));
    }
    Ok(!(get_public(ctx.db)?.hide_cost_when_locked && is_locked(ctx, "finance")?))
}
