use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
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
        let reservation_id = reservation_id.into();
        if self.active_reservations.contains_key(&reservation_id) {
            return BudgetDecision::DuplicateReservation { reservation_id };
        }
        let current = self.spent(policy.id.as_str()) + self.reserved(policy.id.as_str());
        let remaining = policy.hard_limit_micros.saturating_sub(current);
        if requested_micros > remaining {
            return BudgetDecision::Denied {
                policy_id: policy.id.clone(),
                remaining_micros: remaining,
                requested_micros,
            };
        }
        *self.reserved.entry(policy.id.clone()).or_default() += requested_micros;
        let reservation = Reservation {
            id: reservation_id,
            policy_id: policy.id.clone(),
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
        let reserved = self.reserved.entry(active.policy_id.clone()).or_default();
        *reserved = reserved.saturating_sub(active.reserved_micros);
        let charged_micros = actual_micros;
        let overage_micros = actual_micros.saturating_sub(active.reserved_micros);
        let spent = self.spent.entry(active.policy_id.clone()).or_default();
        *spent = spent.saturating_add(charged_micros);
        Ok(BudgetSettlement {
            charged_micros,
            overage_micros,
        })
    }

    pub fn spent(&self, policy_id: &str) -> u64 {
        self.spent.get(policy_id).copied().unwrap_or_default()
    }

    pub fn reserved(&self, policy_id: &str) -> u64 {
        self.reserved.get(policy_id).copied().unwrap_or_default()
    }

    pub fn active_reservation_ids(&self) -> BTreeSet<String> {
        self.active_reservations.keys().cloned().collect()
    }
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
        let BudgetDecision::Allowed(reservation) = ledger.reserve(&policy, "r1", 50) else {
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
        let BudgetDecision::Allowed(reservation) = ledger.reserve(&policy, "r1", 100) else {
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
            ledger.reserve(&policy, "r2", 1),
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
        let BudgetDecision::Allowed(first) = ledger.reserve(&policy, "r1", 50) else {
            panic!("expected reservation");
        };
        let BudgetDecision::Allowed(second) = ledger.reserve(&policy, "r2", 50) else {
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
}
