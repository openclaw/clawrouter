use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

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
}

#[derive(Debug, Default)]
pub struct BudgetLedger {
    spent: BTreeMap<String, u64>,
    reserved: BTreeMap<String, u64>,
}

impl BudgetLedger {
    pub fn reserve(
        &mut self,
        policy: &BudgetPolicy,
        reservation_id: impl Into<String>,
        requested_micros: u64,
    ) -> BudgetDecision {
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
        BudgetDecision::Allowed(Reservation {
            id: reservation_id.into(),
            policy_id: policy.id.clone(),
            reserved_micros: requested_micros,
        })
    }

    pub fn finalize(&mut self, reservation: &Reservation, actual_micros: u64) {
        let reserved = self
            .reserved
            .entry(reservation.policy_id.clone())
            .or_default();
        *reserved = reserved.saturating_sub(reservation.reserved_micros);
        *self.spent.entry(reservation.policy_id.clone()).or_default() += actual_micros;
    }

    pub fn spent(&self, policy_id: &str) -> u64 {
        self.spent.get(policy_id).copied().unwrap_or_default()
    }

    pub fn reserved(&self, policy_id: &str) -> u64 {
        self.reserved.get(policy_id).copied().unwrap_or_default()
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
        ledger.finalize(&reservation, 25);
        assert_eq!(ledger.spent("budget_docs"), 25);
        assert_eq!(ledger.reserved("budget_docs"), 0);
    }
}
