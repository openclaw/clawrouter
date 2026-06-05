use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BudgetPolicy {
    pub id: String,
    pub hard_limit_micros: u64,
    #[serde(default)]
    pub reset: BudgetReset,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BudgetReset {
    Hour,
    Day,
    Week,
    #[default]
    Month,
    Never,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Reservation {
    pub id: String,
    pub policy_id: String,
    #[serde(default)]
    pub window_key: String,
    pub reserved_micros: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum BudgetDecision {
    Allowed(Reservation),
    Denied {
        policy_id: String,
        remaining_micros: u64,
        requested_micros: u64,
    },
    DuplicateReservation {
        reservation_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BudgetSettlement {
    pub charged_micros: u64,
    pub overage_micros: u64,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum BudgetError {
    #[error("reservation {0} is not active")]
    UnknownReservation(String),
}

#[derive(Debug, Default)]
pub struct BudgetLedger {
    spent: BTreeMap<String, u64>,
    reserved: BTreeMap<String, u64>,
    active_reservations: BTreeMap<String, Reservation>,
}

impl BudgetLedger {
    pub fn reserve(
        &mut self,
        policy: &BudgetPolicy,
        reservation_id: impl Into<String>,
        requested_micros: u64,
    ) -> BudgetDecision {
        self.reserve_at(
            policy,
            reservation_id,
            requested_micros,
            current_unix_seconds(),
        )
    }

    pub fn reserve_at(
        &mut self,
        policy: &BudgetPolicy,
        reservation_id: impl Into<String>,
        requested_micros: u64,
        unix_seconds: u64,
    ) -> BudgetDecision {
        let reservation_id = reservation_id.into();
        if self.active_reservations.contains_key(&reservation_id) {
            return BudgetDecision::DuplicateReservation { reservation_id };
        }
        let window_key = budget_window_key(policy, unix_seconds);
        let current = self
            .spent_in_window(&window_key)
            .saturating_add(self.reserved_in_window(&window_key));
        let remaining = policy.hard_limit_micros.saturating_sub(current);
        if requested_micros > remaining {
            return BudgetDecision::Denied {
                policy_id: policy.id.clone(),
                remaining_micros: remaining,
                requested_micros,
            };
        }
        let reserved = self.reserved.entry(window_key.clone()).or_default();
        *reserved = reserved.saturating_add(requested_micros);
        let reservation = Reservation {
            id: reservation_id,
            policy_id: policy.id.clone(),
            window_key,
            reserved_micros: requested_micros,
        };
        self.active_reservations
            .insert(reservation.id.clone(), reservation.clone());
        BudgetDecision::Allowed(reservation)
    }

    pub fn finalize(&mut self, reservation: &Reservation, actual_micros: u64) -> BudgetSettlement {
        self.try_finalize(reservation, actual_micros)
            .expect("reservation must be active")
    }

    pub fn try_finalize(
        &mut self,
        reservation: &Reservation,
        actual_micros: u64,
    ) -> Result<BudgetSettlement, BudgetError> {
        let active = self
            .active_reservations
            .remove(&reservation.id)
            .ok_or_else(|| BudgetError::UnknownReservation(reservation.id.clone()))?;
        let reserved = self.reserved.entry(active.window_key.clone()).or_default();
        *reserved = reserved.saturating_sub(active.reserved_micros);
        let charged_micros = actual_micros;
        let overage_micros = actual_micros.saturating_sub(active.reserved_micros);
        let spent = self.spent.entry(active.window_key.clone()).or_default();
        *spent = spent.saturating_add(charged_micros);
        Ok(BudgetSettlement {
            charged_micros,
            overage_micros,
        })
    }

    pub fn spent(&self, policy_id: &str) -> u64 {
        let prefix = budget_window_prefix(policy_id);
        self.spent
            .iter()
            .filter(|(key, _)| key.starts_with(&prefix))
            .map(|(_, value)| *value)
            .sum()
    }

    pub fn reserved(&self, policy_id: &str) -> u64 {
        let prefix = budget_window_prefix(policy_id);
        self.reserved
            .iter()
            .filter(|(key, _)| key.starts_with(&prefix))
            .map(|(_, value)| *value)
            .sum()
    }

    pub fn spent_for_policy_at(&self, policy: &BudgetPolicy, unix_seconds: u64) -> u64 {
        self.spent_in_window(&budget_window_key(policy, unix_seconds))
    }

    pub fn reserved_for_policy_at(&self, policy: &BudgetPolicy, unix_seconds: u64) -> u64 {
        self.reserved_in_window(&budget_window_key(policy, unix_seconds))
    }

    pub fn active_reservation_ids(&self) -> BTreeSet<String> {
        self.active_reservations.keys().cloned().collect()
    }

    fn spent_in_window(&self, window_key: &str) -> u64 {
        self.spent.get(window_key).copied().unwrap_or_default()
    }

    fn reserved_in_window(&self, window_key: &str) -> u64 {
        self.reserved.get(window_key).copied().unwrap_or_default()
    }
}

fn current_unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

fn budget_window_key(policy: &BudgetPolicy, unix_seconds: u64) -> String {
    let window = match policy.reset {
        BudgetReset::Hour => unix_seconds / 3_600,
        BudgetReset::Day => unix_seconds / 86_400,
        BudgetReset::Week => calendar_week_window(unix_seconds),
        BudgetReset::Month => calendar_month_window(unix_seconds),
        BudgetReset::Never => 0,
    };
    format!("{}{}", budget_window_prefix(&policy.id), window)
}

fn budget_window_prefix(policy_id: &str) -> String {
    format!("{policy_id}\x1f")
}

fn calendar_week_window(unix_seconds: u64) -> u64 {
    let days = unix_seconds / 86_400;
    (days + 3) / 7
}

fn calendar_month_window(unix_seconds: u64) -> u64 {
    let days = (unix_seconds / 86_400) as i64;
    let (year, month, _) = civil_from_unix_days(days);
    (year as u64) * 12 + u64::from(month)
}

fn civil_from_unix_days(days: i64) -> (i32, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    let year = y + if month <= 2 { 1 } else { 0 };
    (year as i32, month as u32, day as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn denies_over_budget_reservation() {
        let policy = BudgetPolicy {
            id: "budget_docs".to_string(),
            hard_limit_micros: 100,
            reset: BudgetReset::Day,
        };
        let mut ledger = BudgetLedger::default();
        assert!(matches!(
            ledger.reserve(&policy, "r1", 101),
            BudgetDecision::Denied { .. }
        ));
    }

    #[test]
    fn finalizes_delta() {
        let policy = BudgetPolicy {
            id: "budget_docs".to_string(),
            hard_limit_micros: 100,
            reset: BudgetReset::Day,
        };
        let mut ledger = BudgetLedger::default();
        let BudgetDecision::Allowed(reservation) = ledger.reserve_at(&policy, "r1", 50, 0) else {
            panic!("expected reservation");
        };
        let settlement = ledger.finalize(&reservation, 25);
        assert_eq!(
            settlement,
            BudgetSettlement {
                charged_micros: 25,
                overage_micros: 0
            }
        );
        assert_eq!(ledger.spent("budget_docs"), 25);
        assert_eq!(ledger.reserved("budget_docs"), 0);
        assert!(ledger.active_reservation_ids().is_empty());
    }

    #[test]
    fn records_actual_usage_when_settlement_exceeds_reservation() {
        let policy = BudgetPolicy {
            id: "budget_docs".to_string(),
            hard_limit_micros: 100,
            reset: BudgetReset::Day,
        };
        let mut ledger = BudgetLedger::default();
        let BudgetDecision::Allowed(reservation) = ledger.reserve_at(&policy, "r1", 100, 0) else {
            panic!("expected reservation");
        };
        let settlement = ledger.finalize(&reservation, 1_000);
        assert_eq!(
            settlement,
            BudgetSettlement {
                charged_micros: 1_000,
                overage_micros: 900
            }
        );
        assert_eq!(ledger.spent("budget_docs"), 1_000);
        assert_eq!(ledger.reserved("budget_docs"), 0);
        assert!(matches!(
            ledger.reserve_at(&policy, "r2", 1, 0),
            BudgetDecision::Denied { .. }
        ));
    }

    #[test]
    fn rejects_duplicate_reservation_finalization() {
        let policy = BudgetPolicy {
            id: "budget_docs".to_string(),
            hard_limit_micros: 100,
            reset: BudgetReset::Day,
        };
        let mut ledger = BudgetLedger::default();
        let BudgetDecision::Allowed(first) = ledger.reserve_at(&policy, "r1", 50, 0) else {
            panic!("expected reservation");
        };
        let BudgetDecision::Allowed(second) = ledger.reserve_at(&policy, "r2", 50, 0) else {
            panic!("expected reservation");
        };
        assert_eq!(ledger.finalize(&first, 50).charged_micros, 50);
        assert_eq!(
            ledger.try_finalize(&first, 50),
            Err(BudgetError::UnknownReservation("r1".to_string()))
        );
        assert_eq!(ledger.reserved("budget_docs"), 50);
        assert_eq!(
            ledger.active_reservation_ids(),
            BTreeSet::from([second.id.clone()])
        );
    }

    #[test]
    fn reset_windows_allow_new_period_reservations() {
        let policy = BudgetPolicy {
            id: "budget_docs".to_string(),
            hard_limit_micros: 100,
            reset: BudgetReset::Day,
        };
        let mut ledger = BudgetLedger::default();
        let BudgetDecision::Allowed(reservation) = ledger.reserve_at(&policy, "r1", 100, 0) else {
            panic!("expected reservation");
        };
        ledger.finalize(&reservation, 100);
        assert!(matches!(
            ledger.reserve_at(&policy, "r2", 1, 0),
            BudgetDecision::Denied { .. }
        ));
        assert!(matches!(
            ledger.reserve_at(&policy, "r3", 100, 86_400),
            BudgetDecision::Allowed(_)
        ));
        assert_eq!(ledger.spent_for_policy_at(&policy, 0), 100);
        assert_eq!(ledger.spent_for_policy_at(&policy, 86_400), 0);
    }

    #[test]
    fn month_windows_reset_on_calendar_months() {
        let policy = BudgetPolicy {
            id: "budget_docs".to_string(),
            hard_limit_micros: 100,
            reset: BudgetReset::Month,
        };
        let mut ledger = BudgetLedger::default();
        let feb_29_2024 = 1_709_164_800;
        let mar_01_2024 = 1_709_251_200;
        let BudgetDecision::Allowed(reservation) =
            ledger.reserve_at(&policy, "r1", 100, feb_29_2024)
        else {
            panic!("expected reservation");
        };
        ledger.finalize(&reservation, 100);
        assert!(matches!(
            ledger.reserve_at(&policy, "r2", 1, feb_29_2024),
            BudgetDecision::Denied { .. }
        ));
        assert!(matches!(
            ledger.reserve_at(&policy, "r3", 100, mar_01_2024),
            BudgetDecision::Allowed(_)
        ));
    }
}
