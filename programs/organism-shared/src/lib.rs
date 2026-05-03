use anchor_lang::prelude::*;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

pub const PRICE_SCALE: u64 = 1_000_000;
pub const UNIT: u64 = 1_000_000;
pub const PEG: u64 = PRICE_SCALE; // $1.000000
pub const NUM_RUNGS: usize = 8;

// ---------------------------------------------------------------------------
// EvaluateTransactionIx — 37-byte payload from A → B
// ---------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct EvaluateTransactionIx {
    pub version: u8,
    pub current_price: u64,
    pub last_price: u64,
    pub transaction_size: u64,
    pub direction_hint: i8,
    pub current_slot: u64,
    pub transaction_kind: u8,
    pub flags: u8,
}

// ---------------------------------------------------------------------------
// Transaction kinds
// ---------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum TransactionKind {
    Swap = 0,
    Mint = 1,
    Burn = 2,
    Transfer = 3,
}

// ---------------------------------------------------------------------------
// ExecutionMode — what the body should do
// ---------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
#[repr(u8)]
pub enum ExecutionMode {
    Execute = 0,
    Throttle = 1,
    Route = 2,
    Halt = 3,
}

impl Default for ExecutionMode {
    fn default() -> Self {
        Self::Execute
    }
}

// ---------------------------------------------------------------------------
// Directive — 68-byte response from B → A via return data
// ---------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, InitSpace)]
pub struct Directive {
    pub execution_mode: ExecutionMode,
    pub fee_adjustment: i64,
    pub spread_adjustment: u64,
    pub throttle_factor: u16,
    pub routing_target: [u8; 32], // Option<Pubkey> as raw bytes, zeroed = none
    pub mint_burn_delta: i64,
    pub collateral_ratio_target: u32,
    pub telemetry_hint: u32,
}

impl Default for Directive {
    fn default() -> Self {
        Self {
            execution_mode: ExecutionMode::Execute,
            fee_adjustment: 0,
            spread_adjustment: 0,
            throttle_factor: 10_000,
            routing_target: [0u8; 32],
            mint_burn_delta: 0,
            collateral_ratio_target: 0,
            telemetry_hint: 0,
        }
    }
}

// ---------------------------------------------------------------------------
// Seeds for PDA derivation
// ---------------------------------------------------------------------------

pub const SEVERITY_STATE_SEED: &[u8] = b"severity_state";
pub const LADDER_STATE_SEED: &[u8] = b"ladder_state";
pub const INTENSITY_STATE_SEED: &[u8] = b"intensity_state";
pub const HISTORY_SEED: &[u8] = b"history";
pub const PARAMETER_SEED: &[u8] = b"parameters";

pub const BODY_STATE_SEED: &[u8] = b"body_state";
pub const FEE_COLLECTOR_SEED: &[u8] = b"fee_collector";
pub const POOL_REGISTRY_SEED: &[u8] = b"pool_registry";
pub const RESERVE_VAULT_SEED: &[u8] = b"reserve_vault";
