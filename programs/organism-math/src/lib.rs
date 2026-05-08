use anchor_lang::prelude::*;
use organism_math::{self as math, NUM_RUNGS};

declare_id!("AFQ8VKgobymzFYCv4NpcSZRpjVyjW9o1uYusRsrgdcqk");

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

pub const SEVERITY_SEED: &[u8] = b"severity";
pub const LADDER_SEED: &[u8] = b"ladder";
pub const INTENSITY_SEED: &[u8] = b"intensity";
pub const ACTIVE_SET_SEED: &[u8] = b"active_set";
pub const PARAMS_SEED: &[u8] = b"params";

// ---------------------------------------------------------------------------
// On-chain accounts (B1–B5 mapped to anchor accounts)
// ---------------------------------------------------------------------------

/// B1: Severity state
#[account]
#[derive(InitSpace)]
pub struct SeverityState {
    pub s: u64,
    pub previous_s: u64,
    pub s_obs_start: u64,
    pub s_obs_start_slot: u64,
}

/// B2: Ladder state
#[account]
#[derive(InitSpace)]
pub struct LadderState {
    pub rung: u8,
    pub tau: u64,
    pub permutations_tried: u32,
}

/// B3: Intensity state
#[account]
#[derive(InitSpace)]
pub struct IntensityState {
    pub values: [u64; NUM_RUNGS],
}

/// B6 (added §2.9): Active-set state — current ordering of active rungs.
#[account]
#[derive(InitSpace)]
pub struct ActiveSetState {
    pub order: [u8; NUM_RUNGS],
}

/// B5: Parameters
#[account]
#[derive(InitSpace)]
pub struct ParameterAccount {
    pub delta: u64,
    pub alpha: u32,
    pub lambda: u64,
    pub f0: u64,
    pub tau_wait: u64,
    pub tau_cool: u64,
    pub tau_obs: u64,
    pub eta: u64,
    pub gamma: u64,
    pub i_min: u64,
    pub theta: [u64; NUM_RUNGS],
    pub theta_low: u64,
    pub theta_high: u64,
}

// ---------------------------------------------------------------------------
// Directive (serialized into return data for the CPI caller)
// ---------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct DirectiveResponse {
    pub execution_mode: u8,
    pub fee_adjustment: i64,
    pub spread_adjustment: u64,
    pub throttle_factor: u16,
    pub mint_burn_delta: i64,
    pub collateral_ratio_target: u32,
}

// ---------------------------------------------------------------------------
// Conversion: on-chain accounts → math lib types and back
// ---------------------------------------------------------------------------

fn to_math_params(p: &ParameterAccount) -> math::Params {
    math::Params {
        delta: p.delta,
        alpha: p.alpha,
        lambda: p.lambda,
        f0: p.f0,
        tau_wait: p.tau_wait,
        tau_cool: p.tau_cool,
        tau_obs: p.tau_obs,
        eta: p.eta,
        gamma: p.gamma,
        i_min: p.i_min,
        theta: p.theta,
        theta_low: p.theta_low,
        theta_high: p.theta_high,
    }
}

fn to_brain_state(
    sev: &SeverityState,
    lad: &LadderState,
    int: &IntensityState,
    act: &ActiveSetState,
) -> math::BrainState {
    math::BrainState {
        severity: sev.s,
        prev_severity: sev.previous_s,
        s_obs_start: sev.s_obs_start,
        s_obs_start_slot: sev.s_obs_start_slot,
        rung: lad.rung,
        tau: lad.tau,
        intensity: int.values,
        permutations_tried: lad.permutations_tried,
        active_set: act.order,
    }
}

fn write_back(
    brain: &math::BrainState,
    sev: &mut SeverityState,
    lad: &mut LadderState,
    int: &mut IntensityState,
    act: &mut ActiveSetState,
) {
    sev.s = brain.severity;
    sev.previous_s = brain.prev_severity;
    sev.s_obs_start = brain.s_obs_start;
    sev.s_obs_start_slot = brain.s_obs_start_slot;
    lad.rung = brain.rung;
    lad.tau = brain.tau;
    lad.permutations_tried = brain.permutations_tried;
    int.values = brain.intensity;
    act.order = brain.active_set;
}

fn to_directive_response(d: &math::Directive) -> DirectiveResponse {
    DirectiveResponse {
        execution_mode: d.mode as u8,
        fee_adjustment: d.fee_adjustment,
        spread_adjustment: d.spread_adjustment,
        throttle_factor: d.throttle_factor,
        mint_burn_delta: d.mint_burn_delta,
        collateral_ratio_target: d.collateral_ratio_target,
    }
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

#[program]
pub mod organism_brain {
    use super::*;

    /// Initialize parameters (B5). Birth step 3.
    pub fn initialize_params(
        ctx: Context<InitializeParams>,
        delta: u64,
        alpha: u32,
        lambda: u64,
        f0: u64,
        tau_wait: u64,
        tau_cool: u64,
        tau_obs: u64,
        eta: u64,
        gamma: u64,
        i_min: u64,
        theta: [u64; NUM_RUNGS],
        theta_low: u64,
        theta_high: u64,
    ) -> Result<()> {
        require!(tau_cool > tau_wait, BrainError::InvalidHysteresis);
        require!(delta > 0, BrainError::InvalidParam);
        require!(alpha > 0, BrainError::InvalidParam);
        require!(theta_low < theta_high, BrainError::InvalidParam);
        for i in 1..NUM_RUNGS {
            require!(theta[i] > theta[i - 1], BrainError::InvalidThresholds);
        }

        let p = &mut ctx.accounts.params;
        p.delta = delta;
        p.alpha = alpha;
        p.lambda = lambda;
        p.f0 = f0;
        p.tau_wait = tau_wait;
        p.tau_cool = tau_cool;
        p.tau_obs = tau_obs;
        p.eta = eta;
        p.gamma = gamma;
        p.i_min = i_min;
        p.theta = theta;
        p.theta_low = theta_low;
        p.theta_high = theta_high;

        Ok(())
    }

    /// Initialize brain state (B1–B3). Birth step 4.
    pub fn initialize_brain(ctx: Context<InitializeBrain>) -> Result<()> {
        // All zeroed by Anchor init — dormant genesis.
        let int = &mut ctx.accounts.intensity;
        int.values = [0u64; NUM_RUNGS];
        Ok(())
    }

    /// §2.9 init: create the active-set account separately (so existing
    /// brain-state PDAs on devnet don't need to be wiped/migrated).
    pub fn initialize_active_set(ctx: Context<InitializeActiveSet>) -> Result<()> {
        let acc = &mut ctx.accounts.active_set;
        acc.order = [1, 2, 3, 4, 5, 6, 7, 8];
        Ok(())
    }

    /// §4.1 — Heartbeat. The single entry point Contract A calls per transaction.
    pub fn evaluate_transaction(
        ctx: Context<EvaluateTransaction>,
        current_price: u64,
        direction_hint: i8,
        current_slot: u64,
    ) -> Result<()> {
        let params = to_math_params(&ctx.accounts.params);
        let mut brain = to_brain_state(
            &ctx.accounts.severity,
            &ctx.accounts.ladder,
            &ctx.accounts.intensity,
            &ctx.accounts.active_set,
        );

        let directive = math::evaluate(&mut brain, current_price, direction_hint, current_slot, &params);

        // Write state back to accounts
        let sev = &mut ctx.accounts.severity;
        let lad = &mut ctx.accounts.ladder;
        let int = &mut ctx.accounts.intensity;
        let act = &mut ctx.accounts.active_set;
        write_back(&brain, sev, lad, int, act);

        // Return directive via set_return_data
        let resp = to_directive_response(&directive);
        let data = resp.try_to_vec()?;
        anchor_lang::solana_program::program::set_return_data(&data);

        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Account contexts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeParams<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + ParameterAccount::INIT_SPACE,
        seeds = [PARAMS_SEED],
        bump,
    )]
    pub params: Account<'info, ParameterAccount>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializeBrain<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + SeverityState::INIT_SPACE,
        seeds = [SEVERITY_SEED],
        bump,
    )]
    pub severity: Account<'info, SeverityState>,
    #[account(
        init,
        payer = authority,
        space = 8 + LadderState::INIT_SPACE,
        seeds = [LADDER_SEED],
        bump,
    )]
    pub ladder: Account<'info, LadderState>,
    #[account(
        init,
        payer = authority,
        space = 8 + IntensityState::INIT_SPACE,
        seeds = [INTENSITY_SEED],
        bump,
    )]
    pub intensity: Account<'info, IntensityState>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializeActiveSet<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + ActiveSetState::INIT_SPACE,
        seeds = [ACTIVE_SET_SEED],
        bump,
    )]
    pub active_set: Account<'info, ActiveSetState>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct EvaluateTransaction<'info> {
    #[account(
        mut,
        seeds = [SEVERITY_SEED],
        bump,
    )]
    pub severity: Account<'info, SeverityState>,
    #[account(
        mut,
        seeds = [LADDER_SEED],
        bump,
    )]
    pub ladder: Account<'info, LadderState>,
    #[account(
        mut,
        seeds = [INTENSITY_SEED],
        bump,
    )]
    pub intensity: Account<'info, IntensityState>,
    #[account(
        mut,
        seeds = [ACTIVE_SET_SEED],
        bump,
    )]
    pub active_set: Account<'info, ActiveSetState>,
    #[account(
        seeds = [PARAMS_SEED],
        bump,
    )]
    pub params: Account<'info, ParameterAccount>,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum BrainError {
    #[msg("tau_cool must exceed tau_wait (hysteresis)")]
    InvalidHysteresis,
    #[msg("Invalid parameter value")]
    InvalidParam,
    #[msg("Thresholds must be strictly increasing")]
    InvalidThresholds,
}
