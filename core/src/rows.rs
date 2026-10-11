// Full table rows, as `SELECT * FROM <table>` returns them (drizzle's select() in the Electron app).
row! { pub struct ExpenseCategory { pub id: String, pub name: String, pub created_at: String, pub updated_at: String } }
row! { pub struct Brand { pub id: String, pub name: String, pub created_at: String, pub updated_at: String } }
row! {
    pub struct Category {
        pub id: String,
        pub name: String,
        #[ts(type = "'PHONE' | 'ACCESSORY' | 'PART'")]
        pub kind: String,
        pub created_at: String,
        pub updated_at: String,
    }
}

row! {
    pub struct Supplier {
        pub id: String,
        pub name: String,
        pub phone: String,
        pub address: String,
        #[ts(type = "'COMPANY' | 'INDIVIDUAL'")]
        pub kind: String,
        pub id_document_number: Option<String>,
        pub notes: String,
        pub deleted_at: Option<String>,
        pub created_at: String,
        pub updated_at: String,
    }
}

row! {
    pub struct SupplierPayment {
        pub id: String,
        pub supplier_id: String,
        pub amount: i64,
        pub date: String,
        pub method: String,
        pub note: String,
        pub created_at: String,
        pub updated_at: String,
    }
}

row! {
    pub struct CashSession {
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
    }
}

row! {
    pub struct CashMovement {
        pub id: String,
        pub session_id: Option<String>,
        pub r#type: String,
        #[ts(type = "'IN' | 'OUT'")]
        pub direction: String,
        pub amount: i64,
        pub ref_table: Option<String>,
        pub ref_id: Option<String>,
        pub note: String,
        pub at: String,
        pub created_at: String,
        pub updated_at: String,
        /// The phone whose cash this is, until the manager confirms receiving it.
        pub held_by_device: Option<String>,
    }
}

row! {
    pub struct Service {
        pub id: String,
        pub name: String,
        #[ts(type = "'FLEXY' | 'OTHER'")]
        pub kind: String,
        #[ts(type = "'PERCENT' | 'FIXED'")]
        pub margin_type: String,
        pub margin_value: i64,
        pub default_price: i64,
        pub active: bool,
        pub created_at: String,
        pub updated_at: String,
    }
}

row! {
    pub struct Customer {
        pub id: String,
        pub name: String,
        pub phone: String,
        pub whatsapp: String,
        pub address: String,
        pub notes: String,
        pub deleted_at: Option<String>,
        pub created_at: String,
        pub updated_at: String,
    }
}

row! {
    pub struct Employee {
        pub id: String,
        pub name: String,
        pub role: String,
        pub phone: String,
        pub monthly_salary: i64,
        pub commission_sales_bp: i64,
        pub commission_repairs_bp: i64,
        pub deleted_at: Option<String>,
        pub created_at: String,
        pub updated_at: String,
    }
}

row! {
    pub struct EmployeeLedger {
        pub id: String,
        pub employee_id: String,
        #[ts(type = "'SALARY' | 'ADVANCE' | 'ADVANCE_REPAYMENT'")]
        pub r#type: String,
        pub amount: i64,
        pub note: String,
        pub date: Option<String>,
        pub method: String,
        pub group_id: Option<String>,
        pub created_at: String,
        pub updated_at: String,
    }
}

row! {
    pub struct Product {
        pub id: String,
        #[ts(type = "'PHONE_MODEL' | 'ITEM'")]
        pub kind: String,
        pub brand_id: Option<String>,
        pub category_id: String,
        pub name: String,
        pub model: String,
        pub storage: String,
        pub color: String,
        pub barcode: Option<String>,
        pub sale_price: i64,
        pub min_price: i64,
        pub avg_cost: i64,
        pub quantity: i64,
        pub low_stock_threshold: i64,
        pub is_repair_part: bool,
        pub default_warranty_days: i64,
        pub deleted_at: Option<String>,
        pub created_at: String,
        pub updated_at: String,
    }
}

row! {
    pub struct PhoneUnit {
        pub id: String,
        pub product_id: String,
        pub imei1: Option<String>,
        pub imei2: Option<String>,
        #[ts(type = "'NEW' | 'USED' | 'REFURBISHED'")]
        pub condition: String,
        pub battery_health: Option<i64>,
        pub grade: Option<String>,
        pub cost: i64,
        pub sale_price: i64,
        #[ts(type = "'IN_STOCK' | 'SOLD' | 'IN_REPAIR' | 'RETURNED' | 'WRITTEN_OFF'")]
        pub status: String,
        pub notes: String,
        pub source_purchase_line_id: Option<String>,
        pub deleted_at: Option<String>,
        pub created_at: String,
        pub updated_at: String,
    }
}

row! {
    pub struct StockMovement {
        pub id: String,
        pub product_id: String,
        pub unit_id: Option<String>,
        #[ts(type = "'PURCHASE' | 'SALE' | 'RETURN' | 'REPAIR_USE' | 'TRADE_IN' | 'ADJUSTMENT' | 'WRITE_OFF'")]
        pub r#type: String,
        pub quantity: i64,
        pub unit_cost: i64,
        pub reason: String,
        pub ref_table: Option<String>,
        pub ref_id: Option<String>,
        pub at: String,
        pub employee_id: Option<String>,
        pub via: Option<String>,
        pub created_at: String,
        pub updated_at: String,
    }
}

row! {
    pub struct Purchase {
        pub id: String,
        pub supplier_id: String,
        pub date: String,
        pub total: i64,
        pub paid: i64,
        pub note: String,
        pub invoice_file: Option<String>,
        pub request_id: Option<String>,
        pub cancelled_at: Option<String>,
        pub created_at: String,
        pub updated_at: String,
    }
}

row! {
    pub struct Sale {
        pub id: String,
        pub receipt_number: String,
        pub customer_id: Option<String>,
        pub employee_id: Option<String>,
        pub date: String,
        pub subtotal: i64,
        pub discount: i64,
        pub total: i64,
        pub paid: i64,
        pub trade_in_value: i64,
        pub payment_method: String,
        pub exchange_return_id: Option<String>,
        pub request_id: Option<String>,
        pub device_id: Option<String>,
        pub via: Option<String>,
        #[ts(type = "'COMPLETED' | 'PARTIALLY_RETURNED' | 'RETURNED'")]
        pub status: String,
        pub created_at: String,
        pub updated_at: String,
    }
}

row! {
    pub struct SaleLine {
        pub id: String,
        pub sale_id: String,
        pub product_id: String,
        pub unit_id: Option<String>,
        pub quantity: i64,
        pub unit_price: i64,
        pub discount: i64,
        pub unit_cost_at_sale: i64,
        pub warranty_days: i64,
        pub returned_quantity: i64,
        pub created_at: String,
        pub updated_at: String,
    }
}

row! {
    pub struct SaleReturn {
        pub id: String,
        pub sale_id: String,
        pub date: String,
        pub refund_amount: i64,
        pub returned_value: i64,
        pub debt_cancelled: i64,
        pub refund_cash: i64,
        pub exchange_sale_id: Option<String>,
        pub reason: String,
        pub created_at: String,
        pub updated_at: String,
    }
}

row! {
    pub struct CustomerPayment {
        pub id: String,
        pub customer_id: String,
        pub amount: i64,
        pub date: String,
        pub method: String,
        pub note: String,
        pub sale_id: Option<String>,
        pub repair_id: Option<String>,
        pub group_id: Option<String>,
        pub balance_before: Option<i64>,
        pub balance_after: Option<i64>,
        pub employee_id: Option<String>,
        pub via: Option<String>,
        pub created_at: String,
        pub updated_at: String,
    }
}

row! {
    pub struct Repair {
        pub id: String,
        pub ticket_number: String,
        pub customer_id: String,
        pub employee_id: Option<String>,
        pub brand: String,
        pub model: String,
        pub imei: Option<String>,
        pub fault: String,
        pub arrival_state: String,
        pub accessories_left: String,
        pub unlock_note: String,
        pub estimated_price: i64,
        pub final_price: Option<i64>,
        pub deposit: i64,
        #[ts(type = "'RECEIVED' | 'DIAGNOSING' | 'WAITING_PARTS' | 'READY' | 'DELIVERED' | 'CANCELLED' | 'UNREPAIRABLE'")]
        pub status: String,
        pub received_at: String,
        pub due_at: Option<String>,
        pub delivered_at: Option<String>,
        pub warranty_days: i64,
        pub qr_token: String,
        pub notes: String,
        pub closed_at: Option<String>,
        pub created_at: String,
        pub updated_at: String,
    }
}

row! {
    pub struct MobileDevice {
        pub id: String,
        pub name: String,
        #[ts(type = "'OWNER' | 'SELLER' | 'TECHNICIAN' | 'STOCK' | null")]
        pub role: Option<String>,
        pub employee_id: Option<String>,
        pub token_hash: String,
        pub remote_allowed: bool,
        pub mailbox: Option<String>,
        pub wire_key: Option<String>,
        pub last_seen_via: Option<String>,
        pub last_seen_at: Option<String>,
        pub revoked_at: Option<String>,
        pub created_at: String,
        pub updated_at: String,
    }
}

row! {
    pub struct StockCount {
        pub id: String,
        pub started_by_device: Option<String>,
        #[ts(type = "'PHONES' | 'ITEMS' | 'CATEGORY'")]
        pub scope: String,
        pub category_id: Option<String>,
        #[ts(type = "'OPEN' | 'CLOSED'")]
        pub status: String,
        pub started_at: String,
        pub closed_at: Option<String>,
        pub applied: bool,
        pub created_at: String,
        pub updated_at: String,
    }
}

row! {
    pub struct StockCountLine {
        pub id: String,
        pub count_id: String,
        pub unit_id: Option<String>,
        pub product_id: Option<String>,
        pub code: Option<String>,
        pub counted_quantity: i64,
        pub expected_quantity: Option<i64>,
        pub flag: Option<String>,
        #[ts(type = "'WRITE_OFF' | 'KEEP' | null")]
        pub decision: Option<String>,
        pub device_id: Option<String>,
        pub created_at: String,
        pub updated_at: String,
    }
}

// `{ id }`, what most create calls return.
row! { pub struct Id { pub id: String } }
