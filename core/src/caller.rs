// Who is making the current call: the desktop window, or a paired phone (on the shop Wi-Fi or through the mailbox).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Via {
    Lan,
    Remote,
}

impl Via {
    pub fn as_str(self) -> &'static str {
        match self {
            Via::Lan => "lan",
            Via::Remote => "remote",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct DeviceCaller {
    pub device_id: String,
    pub role: Option<String>,
    pub employee_id: Option<String>,
    pub via: Via,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub enum Caller {
    #[default]
    Desktop,
    Device(DeviceCaller),
}

impl Caller {
    /// The phone making the call, or None for the desktop.
    pub fn device(&self) -> Option<&str> {
        match self {
            Caller::Device(d) => Some(&d.device_id),
            Caller::Desktop => None,
        }
    }
    /// How the calling phone reached the PC; None for the desktop window.
    pub fn via(&self) -> Option<&'static str> {
        match self {
            Caller::Device(d) => Some(d.via.as_str()),
            Caller::Desktop => None,
        }
    }
    /// The employee to record on sales, payments, repair changes and stock movements made by a phone.
    pub fn actor(&self) -> Option<String> {
        match self {
            Caller::Device(d) => d.employee_id.clone(),
            Caller::Desktop => None,
        }
    }
}
