use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, MintTo, Burn, Token, TokenAccount, Transfer};
use anchor_lang::solana_program::program::get_return_data;
use organism_brain::{
    self,
    cpi::accounts::EvaluateTransaction as BrainEvaluate,
    program::OrganismBrain,
    DirectiveResponse,
};

declare_id!("4x2VEu8TGdiJdFqBEdnXAG2EvZPn5m27AoDThbtmLiv5");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

pub const MINT_SEED: &[u8] = b"mint";
pub const RESERVE_VAULT_SEED: &[u8] = b"reserve_vault";
pub const BODY_STATE_SEED: &[u8] = b"body_state";
pub const FEE_COLLECTOR_SEED: &[u8] = b"fee_collector";
pub const POOL_REGISTRY_SEED: &[u8] = b"pool_registry";
pub const MINT_AUTHORITY_SEED: &[u8] = b"mint_authority";
pub const LP_STATE_SEED: &[u8] = b"lp_state";
pub const COLLATERAL_VAULT_SEED: &[u8] = b"collateral_vault";

pub const UNIT: u64 = 1_000_000;
pub const FEE_DENOMINATOR: u64 = 1_000_000; // fee_adjustment is per-million
pub const THROTTLE_DENOMINATOR: u64 = 10_000;
pub const TOKEN_DECIMALS: u8 = 6;

// ---------------------------------------------------------------------------
// Embedded Directive (mirror of organism-math::Directive, simplified)
// ---------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
#[repr(u8)]
pub enum ExecutionMode {
    Execute = 0,
    Throttle = 1,
    Route = 2,
    Halt = 3,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, InitSpace)]
pub struct Directive {
    pub execution_mode: ExecutionMode,
    pub fee_adjustment: i64,
    pub spread_adjustment: u64,
    pub throttle_factor: u16,
    pub mint_burn_delta: i64,
    pub collateral_ratio_target: u32,
}

impl Default for Directive {
    fn default() -> Self {
        Self {
            execution_mode: ExecutionMode::Execute,
            fee_adjustment: 0,
            spread_adjustment: 0,
            throttle_factor: THROTTLE_DENOMINATOR as u16,
            mint_burn_delta: 0,
            collateral_ratio_target: 0,
        }
    }
}

// ---------------------------------------------------------------------------
// Accounts (A1 is the SPL Mint, created via init in InitializeMint)
// A3: Body State
// A5: Pool Registry (placeholder — list of pool pubkeys)
// ---------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct BodyState {
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub reserve_vault: Pubkey,
    pub fee_collector: Pubkey,
    pub current_directive: Directive,
    pub last_price: u64,
    pub last_slot: u64,
    /// Tokens permitted in the current throttle window
    pub throttle_window_remaining: u64,
    /// Slot at which the current throttle window started
    pub throttle_window_start: u64,
}

/// Internal AMM state. Tracks the chosen collateral mint + one-shot seed flag.
#[account]
#[derive(InitSpace)]
pub struct LpState {
    pub collateral_mint: Pubkey,
    pub seeded: bool,
    pub total_swap_in_volume: u64,
    pub total_swap_out_volume: u64,
}

#[account]
#[derive(InitSpace)]
pub struct PoolRegistry {
    pub authority: Pubkey,
    #[max_len(8)]
    pub pools: Vec<Pubkey>,
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

#[program]
pub mod organism_token {
    use super::*;

    /// Birth step 5: initialize the SPL Mint (A1) with PDA authority.
    pub fn initialize_mint(_ctx: Context<InitializeMint>) -> Result<()> {
        Ok(())
    }

    /// Birth steps 6-7: initialize body state (A3), reserve vault (A2),
    /// fee collector (A4), pool registry (A5).
    pub fn initialize_body(ctx: Context<InitializeBody>) -> Result<()> {
        let body = &mut ctx.accounts.body_state;
        body.authority = ctx.accounts.authority.key();
        body.mint = ctx.accounts.mint.key();
        body.reserve_vault = ctx.accounts.reserve_vault.key();
        body.fee_collector = ctx.accounts.fee_collector.key();
        body.current_directive = Directive::default();
        body.last_price = 1_000_000;
        body.last_slot = 0;
        body.throttle_window_remaining = u64::MAX;
        body.throttle_window_start = 0;

        let registry = &mut ctx.accounts.pool_registry;
        registry.authority = ctx.accounts.authority.key();
        registry.pools = Vec::new();

        Ok(())
    }

    /// Test-only: inject a directive directly into body state.
    /// In production this is replaced by CPI return from organism-brain.
    pub fn apply_directive(
        ctx: Context<ApplyDirective>,
        directive: Directive,
        observed_price: u64,
        slot: u64,
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.authority.key(),
            ctx.accounts.body_state.authority,
            BodyError::Unauthorized
        );

        let body = &mut ctx.accounts.body_state;
        body.current_directive = directive;
        body.last_price = observed_price;
        body.last_slot = slot;
        // New throttle window opens
        body.throttle_window_start = slot;
        body.throttle_window_remaining = throttle_capacity(&body.current_directive);
        Ok(())
    }

    /// Mint tokens to the recipient. Honors halt + fee + throttle.
    /// Apply mint_burn_delta supply correction first when active.
    pub fn mint_tokens(ctx: Context<MintTokens>, amount: u64) -> Result<()> {
        let directive = ctx.accounts.body_state.current_directive.clone();
        check_halt(&directive)?;
        check_throttle(&mut ctx.accounts.body_state, amount)?;

        let fee = compute_fee(amount, directive.fee_adjustment)?;
        let net = amount.checked_sub(fee).ok_or(BodyError::Overflow)?;

        let bump = ctx.bumps.mint_authority;
        let seeds: &[&[u8]] = &[MINT_AUTHORITY_SEED, &[bump]];
        let signer = &[seeds];

        // Mint net amount to recipient
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.recipient.to_account_info(),
                    authority: ctx.accounts.mint_authority.to_account_info(),
                },
                signer,
            ),
            net,
        )?;

        // Mint fee to fee collector
        if fee > 0 {
            token::mint_to(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    MintTo {
                        mint: ctx.accounts.mint.to_account_info(),
                        to: ctx.accounts.fee_collector.to_account_info(),
                        authority: ctx.accounts.mint_authority.to_account_info(),
                    },
                    signer,
                ),
                fee,
            )?;
        }

        emit!(MintEvent { amount: net, fee });
        Ok(())
    }

    /// Burn tokens from a holder. Honors halt + fee.
    /// Fee is taken from the burned amount, transferred to fee collector before burning.
    pub fn burn_tokens(ctx: Context<BurnTokens>, amount: u64) -> Result<()> {
        let directive = ctx.accounts.body_state.current_directive.clone();
        check_halt(&directive)?;
        check_throttle(&mut ctx.accounts.body_state, amount)?;

        let fee = compute_fee(amount, directive.fee_adjustment)?;
        let net = amount.checked_sub(fee).ok_or(BodyError::Overflow)?;

        // Transfer fee portion to collector
        if fee > 0 {
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.holder.to_account_info(),
                        to: ctx.accounts.fee_collector.to_account_info(),
                        authority: ctx.accounts.holder_authority.to_account_info(),
                    },
                ),
                fee,
            )?;
        }

        // Burn the remaining net
        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.mint.to_account_info(),
                    from: ctx.accounts.holder.to_account_info(),
                    authority: ctx.accounts.holder_authority.to_account_info(),
                },
            ),
            net,
        )?;

        emit!(BurnEvent { burned: net, fee });
        Ok(())
    }

    /// Transfer between two token accounts. Honors halt + fee + throttle.
    pub fn transfer_tokens(ctx: Context<TransferTokens>, amount: u64) -> Result<()> {
        let directive = ctx.accounts.body_state.current_directive.clone();
        check_halt(&directive)?;
        check_throttle(&mut ctx.accounts.body_state, amount)?;

        let fee = compute_fee(amount, directive.fee_adjustment)?;
        let net = amount.checked_sub(fee).ok_or(BodyError::Overflow)?;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.source.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                    authority: ctx.accounts.source_authority.to_account_info(),
                },
            ),
            net,
        )?;

        if fee > 0 {
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.source.to_account_info(),
                        to: ctx.accounts.fee_collector.to_account_info(),
                        authority: ctx.accounts.source_authority.to_account_info(),
                    },
                ),
                fee,
            )?;
        }

        emit!(TransferEvent { amount: net, fee });
        Ok(())
    }

    /// Custom internal LP: swap collateral (SOL/USDC stub) for organism tokens
    /// against the reserve vault. Applies spread + fee + halt.
    /// Reserve vault holds organism tokens to give out; collateral comes in via
    /// `collateral_in` token account (any SPL token), which the reserve receives.
    pub fn swap_in(
        ctx: Context<SwapAgainstReserve>,
        collateral_amount: u64,
    ) -> Result<()> {
        let directive = ctx.accounts.body_state.current_directive.clone();
        check_halt(&directive)?;
        check_throttle(&mut ctx.accounts.body_state, collateral_amount)?;

        // Apply spread: amount_after_spread = amount * (UNIT - spread) / UNIT
        let after_spread = apply_spread(collateral_amount, directive.spread_adjustment)?;
        let fee = compute_fee(after_spread, directive.fee_adjustment)?;
        let net_out = after_spread.checked_sub(fee).ok_or(BodyError::Overflow)?;

        // 1:1 exchange (simple stub)
        let bump = ctx.bumps.mint_authority;
        let seeds: &[&[u8]] = &[MINT_AUTHORITY_SEED, &[bump]];
        let signer = &[seeds];

        // Move collateral in
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.collateral_in.to_account_info(),
                    to: ctx.accounts.reserve_vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            collateral_amount,
        )?;

        // Mint net organism tokens to user
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.recipient.to_account_info(),
                    authority: ctx.accounts.mint_authority.to_account_info(),
                },
                signer,
            ),
            net_out,
        )?;

        // Mint spread + fee to fee collector
        let extracted = collateral_amount.checked_sub(net_out).ok_or(BodyError::Overflow)?;
        if extracted > 0 {
            token::mint_to(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    MintTo {
                        mint: ctx.accounts.mint.to_account_info(),
                        to: ctx.accounts.fee_collector.to_account_info(),
                        authority: ctx.accounts.mint_authority.to_account_info(),
                    },
                    signer,
                ),
                extracted,
            )?;
        }

        emit!(SwapEvent { in_amount: collateral_amount, out_amount: net_out, extracted });
        Ok(())
    }

    /// §4.1 — Heartbeat. Body invokes brain via CPI, reads the returned
    /// Directive, stores it in body_state. This replaces apply_directive
    /// for production use — no admin authority required.
    ///
    /// On any CPI/parse failure, applies the default (Execute) directive
    /// and emits a BrainFailure event (defensive fallback, §4.4).
    pub fn heartbeat(
        ctx: Context<Heartbeat>,
        current_price: u64,
        direction_hint: i8,
        current_slot: u64,
    ) -> Result<()> {
        let cpi_ctx = CpiContext::new(
            ctx.accounts.brain_program.to_account_info(),
            BrainEvaluate {
                severity: ctx.accounts.brain_severity.to_account_info(),
                ladder: ctx.accounts.brain_ladder.to_account_info(),
                intensity: ctx.accounts.brain_intensity.to_account_info(),
                active_set: ctx.accounts.brain_active_set.to_account_info(),
                params: ctx.accounts.brain_params.to_account_info(),
            },
        );

        let cpi_result = organism_brain::cpi::evaluate_transaction(
            cpi_ctx,
            current_price,
            direction_hint,
            current_slot,
        );

        let body = &mut ctx.accounts.body_state;

        let directive = match cpi_result {
            Ok(()) => {
                match get_return_data() {
                    Some((program_id, data)) if program_id == ctx.accounts.brain_program.key() => {
                        match DirectiveResponse::try_from_slice(&data) {
                            Ok(resp) => Directive {
                                execution_mode: match resp.execution_mode {
                                    0 => ExecutionMode::Execute,
                                    1 => ExecutionMode::Throttle,
                                    2 => ExecutionMode::Route,
                                    _ => ExecutionMode::Halt,
                                },
                                fee_adjustment: resp.fee_adjustment,
                                spread_adjustment: resp.spread_adjustment,
                                throttle_factor: resp.throttle_factor,
                                mint_burn_delta: resp.mint_burn_delta,
                                collateral_ratio_target: resp.collateral_ratio_target,
                            },
                            Err(_) => {
                                emit!(BrainFailure { reason: 1 }); // parse error
                                Directive::default()
                            }
                        }
                    }
                    _ => {
                        emit!(BrainFailure { reason: 2 }); // no return data
                        Directive::default()
                    }
                }
            }
            Err(_) => {
                emit!(BrainFailure { reason: 3 }); // CPI failure
                Directive::default()
            }
        };

        body.current_directive = directive;
        body.last_price = current_price;
        body.last_slot = current_slot;
        body.throttle_window_start = current_slot;
        body.throttle_window_remaining = throttle_capacity(&body.current_directive);

        emit!(HeartbeatEvent {
            mode: body.current_directive.execution_mode as u8,
            fee_adjustment: body.current_directive.fee_adjustment,
            throttle_factor: body.current_directive.throttle_factor,
            slot: current_slot,
            price: current_price,
        });

        Ok(())
    }

    /// §6 step 9 — Authority handoff. Deployer surrenders all admin power.
    /// Nullifies body_state.authority and pool_registry.authority by setting
    /// them to Pubkey::default(). After this, no signer can satisfy the
    /// authority checks on apply_directive or register_pool — both are dead.
    /// Heartbeat (CPI-driven) continues to function. This is irreversible.
    pub fn seal_body(ctx: Context<SealBody>) -> Result<()> {
        let body = &mut ctx.accounts.body_state;
        let registry = &mut ctx.accounts.pool_registry;
        require_keys_eq!(
            ctx.accounts.authority.key(),
            body.authority,
            BodyError::Unauthorized
        );
        body.authority = Pubkey::default();
        registry.authority = Pubkey::default();
        emit!(BodySealed {});
        Ok(())
    }

    /// Trustless heartbeat. Derives the observed price from internal state
    /// (collateral_vault.amount / mint.supply, scaled to PRICE_SCALE) instead
    /// of trusting a caller-supplied price. CPIs to brain with the derived
    /// price + automatic direction hint, stores returned directive.
    ///
    /// This is the production path. The plain `heartbeat()` instruction
    /// (caller-supplied price) is kept for testing and for use cases where an
    /// external oracle is preferred.
    pub fn heartbeat_observed(ctx: Context<HeartbeatObserved>, current_slot: u64) -> Result<()> {
        let supply = ctx.accounts.mint.supply;
        let vault_amt = ctx.accounts.collateral_vault.amount;

        // Derive observed price = vault·PRICE_SCALE / supply.
        // If supply==0 (pre-first-breath), default to peg.
        let observed_price: u64 = if supply == 0 {
            UNIT
        } else {
            let scaled = (vault_amt as u128).saturating_mul(UNIT as u128) / (supply as u128);
            scaled.min(u64::MAX as u128) as u64
        };

        // Direction: if observed > peg, downward force needed (-1);
        //            if observed < peg, upward force needed (+1)
        let direction: i8 = if observed_price > UNIT {
            -1
        } else if observed_price < UNIT {
            1
        } else {
            0
        };

        let cpi_ctx = CpiContext::new(
            ctx.accounts.brain_program.to_account_info(),
            BrainEvaluate {
                severity: ctx.accounts.brain_severity.to_account_info(),
                ladder: ctx.accounts.brain_ladder.to_account_info(),
                intensity: ctx.accounts.brain_intensity.to_account_info(),
                active_set: ctx.accounts.brain_active_set.to_account_info(),
                params: ctx.accounts.brain_params.to_account_info(),
            },
        );

        let cpi_result = organism_brain::cpi::evaluate_transaction(
            cpi_ctx,
            observed_price,
            direction,
            current_slot,
        );

        let body = &mut ctx.accounts.body_state;
        let directive = match cpi_result {
            Ok(()) => match get_return_data() {
                Some((program_id, data)) if program_id == ctx.accounts.brain_program.key() => {
                    match DirectiveResponse::try_from_slice(&data) {
                        Ok(resp) => Directive {
                            execution_mode: match resp.execution_mode {
                                0 => ExecutionMode::Execute,
                                1 => ExecutionMode::Throttle,
                                2 => ExecutionMode::Route,
                                _ => ExecutionMode::Halt,
                            },
                            fee_adjustment: resp.fee_adjustment,
                            spread_adjustment: resp.spread_adjustment,
                            throttle_factor: resp.throttle_factor,
                            mint_burn_delta: resp.mint_burn_delta,
                            collateral_ratio_target: resp.collateral_ratio_target,
                        },
                        Err(_) => {
                            emit!(BrainFailure { reason: 1 });
                            Directive::default()
                        }
                    }
                }
                _ => {
                    emit!(BrainFailure { reason: 2 });
                    Directive::default()
                }
            },
            Err(_) => {
                emit!(BrainFailure { reason: 3 });
                Directive::default()
            }
        };

        body.current_directive = directive;
        body.last_price = observed_price;
        body.last_slot = current_slot;
        body.throttle_window_start = current_slot;
        body.throttle_window_remaining = throttle_capacity(&body.current_directive);

        emit!(ObservedHeartbeat {
            observed_price,
            vault_amount: vault_amt,
            supply,
            slot: current_slot,
        });

        Ok(())
    }

    /// Internal AMM bootstrap: register the collateral mint and create the
    /// collateral vault (held by mint_authority PDA). Called once.
    pub fn initialize_lp(ctx: Context<InitializeLp>) -> Result<()> {
        let lp = &mut ctx.accounts.lp_state;
        lp.collateral_mint = ctx.accounts.collateral_mint.key();
        lp.seeded = false;
        lp.total_swap_in_volume = 0;
        lp.total_swap_out_volume = 0;
        Ok(())
    }

    /// §6 step 10 — First Breath. Initial liquidity provider deposits seed
    /// collateral; an equal amount of ORG is minted to them. Sets the 1:1
    /// reserve baseline. One-shot: gated by lp_state.seeded.
    pub fn first_breath(ctx: Context<FirstBreath>, seed_amount: u64) -> Result<()> {
        require!(!ctx.accounts.lp_state.seeded, BodyError::AlreadySeeded);
        require!(seed_amount > 0, BodyError::Overflow);

        // Move collateral user → vault
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_collateral.to_account_info(),
                    to: ctx.accounts.collateral_vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            seed_amount,
        )?;

        // Mint matching ORG to user
        let bump = ctx.bumps.mint_authority;
        let seeds: &[&[u8]] = &[MINT_AUTHORITY_SEED, &[bump]];
        let signer = &[seeds];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.user_org.to_account_info(),
                    authority: ctx.accounts.mint_authority.to_account_info(),
                },
                signer,
            ),
            seed_amount,
        )?;

        ctx.accounts.lp_state.seeded = true;
        emit!(FirstBreathEvent { amount: seed_amount });
        Ok(())
    }

    /// LP swap: collateral → ORG. Honors halt/throttle, applies spread + fee
    /// per current directive. The extracted spread+fee remains in the
    /// collateral vault as over-collateralization growth (self-sustainability).
    pub fn lp_swap_in(ctx: Context<LpSwapIn>, collateral_amount: u64) -> Result<()> {
        let directive = ctx.accounts.body_state.current_directive.clone();
        check_halt(&directive)?;
        check_throttle(&mut ctx.accounts.body_state, collateral_amount)?;
        require!(ctx.accounts.lp_state.seeded, BodyError::NotSeeded);

        // 1:1 base ratio, then spread, then fee
        let after_spread = apply_spread(collateral_amount, directive.spread_adjustment)?;
        let fee = compute_fee(after_spread, directive.fee_adjustment)?;
        let user_gets_org = after_spread.checked_sub(fee).ok_or(BodyError::Overflow)?;

        // Move all collateral into vault
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_collateral.to_account_info(),
                    to: ctx.accounts.collateral_vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            collateral_amount,
        )?;

        // Mint ORG to user
        let bump = ctx.bumps.mint_authority;
        let seeds: &[&[u8]] = &[MINT_AUTHORITY_SEED, &[bump]];
        let signer = &[seeds];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.user_org.to_account_info(),
                    authority: ctx.accounts.mint_authority.to_account_info(),
                },
                signer,
            ),
            user_gets_org,
        )?;

        let lp = &mut ctx.accounts.lp_state;
        lp.total_swap_in_volume = lp.total_swap_in_volume.saturating_add(collateral_amount);

        emit!(LpSwapEvent {
            direction: 0, // in: collateral → ORG
            in_amount: collateral_amount,
            out_amount: user_gets_org,
            extracted: collateral_amount.saturating_sub(user_gets_org),
        });
        Ok(())
    }

    /// LP swap: ORG → collateral. Honors halt/throttle, applies spread + fee.
    /// User burns full org_amount but only receives the post-spread/fee portion
    /// of collateral. Difference stays in vault.
    pub fn lp_swap_out(ctx: Context<LpSwapOut>, org_amount: u64) -> Result<()> {
        let directive = ctx.accounts.body_state.current_directive.clone();
        check_halt(&directive)?;
        check_throttle(&mut ctx.accounts.body_state, org_amount)?;
        require!(ctx.accounts.lp_state.seeded, BodyError::NotSeeded);

        let after_spread = apply_spread(org_amount, directive.spread_adjustment)?;
        let fee = compute_fee(after_spread, directive.fee_adjustment)?;
        let user_gets_collateral = after_spread.checked_sub(fee).ok_or(BodyError::Overflow)?;

        require!(
            ctx.accounts.collateral_vault.amount >= user_gets_collateral,
            BodyError::InsufficientReserves
        );

        // Burn full org_amount from user
        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.mint.to_account_info(),
                    from: ctx.accounts.user_org.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            org_amount,
        )?;

        // Transfer collateral from vault to user (signed by mint_authority PDA)
        let bump = ctx.bumps.mint_authority;
        let seeds: &[&[u8]] = &[MINT_AUTHORITY_SEED, &[bump]];
        let signer = &[seeds];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.collateral_vault.to_account_info(),
                    to: ctx.accounts.user_collateral.to_account_info(),
                    authority: ctx.accounts.mint_authority.to_account_info(),
                },
                signer,
            ),
            user_gets_collateral,
        )?;

        let lp = &mut ctx.accounts.lp_state;
        lp.total_swap_out_volume = lp.total_swap_out_volume.saturating_add(org_amount);

        emit!(LpSwapEvent {
            direction: 1, // out: ORG → collateral
            in_amount: org_amount,
            out_amount: user_gets_collateral,
            extracted: org_amount.saturating_sub(user_gets_collateral),
        });
        Ok(())
    }

    /// Register a pool address into the registry (admin only).
    /// Used at rung ℓ5 (Liquidity Routing).
    pub fn register_pool(ctx: Context<RegisterPool>, pool: Pubkey) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.authority.key(),
            ctx.accounts.pool_registry.authority,
            BodyError::Unauthorized
        );
        let registry = &mut ctx.accounts.pool_registry;
        require!(registry.pools.len() < 8, BodyError::RegistryFull);
        registry.pools.push(pool);
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn check_halt(directive: &Directive) -> Result<()> {
    require!(
        directive.execution_mode != ExecutionMode::Halt,
        BodyError::Halted
    );
    Ok(())
}

fn check_throttle(body: &mut BodyState, amount: u64) -> Result<()> {
    if matches!(body.current_directive.execution_mode, ExecutionMode::Execute) {
        return Ok(());
    }
    // Reset window every 100 slots
    let clock = Clock::get()?;
    if clock.slot >= body.throttle_window_start + 100 {
        body.throttle_window_start = clock.slot;
        body.throttle_window_remaining = throttle_capacity(&body.current_directive);
    }
    require!(
        body.throttle_window_remaining >= amount,
        BodyError::Throttled
    );
    body.throttle_window_remaining -= amount;
    Ok(())
}

fn throttle_capacity(directive: &Directive) -> u64 {
    if directive.throttle_factor as u64 >= THROTTLE_DENOMINATOR {
        return u64::MAX;
    }
    // Capacity scales with throttle_factor; full = 100M tokens per window
    let base: u64 = 100_000_000 * (10u64.pow(TOKEN_DECIMALS as u32));
    (base as u128 * directive.throttle_factor as u128 / THROTTLE_DENOMINATOR as u128) as u64
}

fn compute_fee(amount: u64, fee_adjustment: i64) -> Result<u64> {
    if fee_adjustment <= 0 {
        return Ok(0);
    }
    Ok((amount as u128 * fee_adjustment as u128 / FEE_DENOMINATOR as u128) as u64)
}

fn apply_spread(amount: u64, spread: u64) -> Result<u64> {
    if spread == 0 {
        return Ok(amount);
    }
    let spread = spread.min(UNIT);
    Ok((amount as u128 * (UNIT - spread) as u128 / UNIT as u128) as u64)
}

// ---------------------------------------------------------------------------
// Account contexts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeMint<'info> {
    #[account(
        init,
        payer = authority,
        mint::decimals = TOKEN_DECIMALS,
        mint::authority = mint_authority,
        seeds = [MINT_SEED],
        bump,
    )]
    pub mint: Account<'info, Mint>,
    /// CHECK: PDA used as the mint authority
    #[account(
        seeds = [MINT_AUTHORITY_SEED],
        bump,
    )]
    pub mint_authority: AccountInfo<'info>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct InitializeBody<'info> {
    #[account(seeds = [MINT_SEED], bump)]
    pub mint: Account<'info, Mint>,
    /// CHECK: PDA mint authority
    #[account(seeds = [MINT_AUTHORITY_SEED], bump)]
    pub mint_authority: AccountInfo<'info>,
    #[account(
        init,
        payer = authority,
        token::mint = mint,
        token::authority = mint_authority,
        seeds = [RESERVE_VAULT_SEED],
        bump,
    )]
    pub reserve_vault: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = authority,
        token::mint = mint,
        token::authority = mint_authority,
        seeds = [FEE_COLLECTOR_SEED],
        bump,
    )]
    pub fee_collector: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = authority,
        space = 8 + BodyState::INIT_SPACE,
        seeds = [BODY_STATE_SEED],
        bump,
    )]
    pub body_state: Account<'info, BodyState>,
    #[account(
        init,
        payer = authority,
        space = 8 + PoolRegistry::INIT_SPACE,
        seeds = [POOL_REGISTRY_SEED],
        bump,
    )]
    pub pool_registry: Account<'info, PoolRegistry>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct ApplyDirective<'info> {
    #[account(mut, seeds = [BODY_STATE_SEED], bump)]
    pub body_state: Account<'info, BodyState>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct MintTokens<'info> {
    #[account(mut, seeds = [MINT_SEED], bump)]
    pub mint: Account<'info, Mint>,
    /// CHECK: PDA mint authority
    #[account(seeds = [MINT_AUTHORITY_SEED], bump)]
    pub mint_authority: AccountInfo<'info>,
    #[account(mut, seeds = [BODY_STATE_SEED], bump)]
    pub body_state: Account<'info, BodyState>,
    #[account(mut)]
    pub recipient: Account<'info, TokenAccount>,
    #[account(mut, seeds = [FEE_COLLECTOR_SEED], bump)]
    pub fee_collector: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct BurnTokens<'info> {
    #[account(mut, seeds = [MINT_SEED], bump)]
    pub mint: Account<'info, Mint>,
    #[account(mut, seeds = [BODY_STATE_SEED], bump)]
    pub body_state: Account<'info, BodyState>,
    #[account(mut)]
    pub holder: Account<'info, TokenAccount>,
    pub holder_authority: Signer<'info>,
    #[account(mut, seeds = [FEE_COLLECTOR_SEED], bump)]
    pub fee_collector: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct TransferTokens<'info> {
    #[account(mut, seeds = [BODY_STATE_SEED], bump)]
    pub body_state: Account<'info, BodyState>,
    #[account(mut)]
    pub source: Account<'info, TokenAccount>,
    pub source_authority: Signer<'info>,
    #[account(mut)]
    pub destination: Account<'info, TokenAccount>,
    #[account(mut, seeds = [FEE_COLLECTOR_SEED], bump)]
    pub fee_collector: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SwapAgainstReserve<'info> {
    #[account(mut, seeds = [MINT_SEED], bump)]
    pub mint: Account<'info, Mint>,
    /// CHECK: PDA mint authority
    #[account(seeds = [MINT_AUTHORITY_SEED], bump)]
    pub mint_authority: AccountInfo<'info>,
    #[account(mut, seeds = [BODY_STATE_SEED], bump)]
    pub body_state: Account<'info, BodyState>,
    #[account(mut, seeds = [RESERVE_VAULT_SEED], bump)]
    pub reserve_vault: Account<'info, TokenAccount>,
    #[account(mut, seeds = [FEE_COLLECTOR_SEED], bump)]
    pub fee_collector: Account<'info, TokenAccount>,
    #[account(mut)]
    pub collateral_in: Account<'info, TokenAccount>,
    #[account(mut)]
    pub recipient: Account<'info, TokenAccount>,
    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Heartbeat<'info> {
    #[account(mut, seeds = [BODY_STATE_SEED], bump)]
    pub body_state: Account<'info, BodyState>,

    /// CHECK: Brain's severity state — validated by brain on its end via PDA seeds
    #[account(mut)]
    pub brain_severity: AccountInfo<'info>,
    /// CHECK: Brain's ladder state — validated by brain
    #[account(mut)]
    pub brain_ladder: AccountInfo<'info>,
    /// CHECK: Brain's intensity state — validated by brain
    #[account(mut)]
    pub brain_intensity: AccountInfo<'info>,
    /// CHECK: Brain's active-set state — validated by brain
    #[account(mut)]
    pub brain_active_set: AccountInfo<'info>,
    /// CHECK: Brain's parameter account — validated by brain
    pub brain_params: AccountInfo<'info>,

    pub brain_program: Program<'info, OrganismBrain>,
}

#[derive(Accounts)]
pub struct HeartbeatObserved<'info> {
    #[account(seeds = [MINT_SEED], bump)]
    pub mint: Account<'info, Mint>,
    #[account(seeds = [COLLATERAL_VAULT_SEED], bump)]
    pub collateral_vault: Account<'info, TokenAccount>,
    #[account(mut, seeds = [BODY_STATE_SEED], bump)]
    pub body_state: Account<'info, BodyState>,

    /// CHECK: brain severity
    #[account(mut)]
    pub brain_severity: AccountInfo<'info>,
    /// CHECK: brain ladder
    #[account(mut)]
    pub brain_ladder: AccountInfo<'info>,
    /// CHECK: brain intensity
    #[account(mut)]
    pub brain_intensity: AccountInfo<'info>,
    /// CHECK: brain active_set
    #[account(mut)]
    pub brain_active_set: AccountInfo<'info>,
    /// CHECK: brain params
    pub brain_params: AccountInfo<'info>,

    pub brain_program: Program<'info, OrganismBrain>,
}

#[derive(Accounts)]
pub struct InitializeLp<'info> {
    pub collateral_mint: Account<'info, Mint>,
    /// CHECK: PDA mint authority for ORG (signs collateral transfers out)
    #[account(seeds = [MINT_AUTHORITY_SEED], bump)]
    pub mint_authority: AccountInfo<'info>,
    #[account(
        init,
        payer = payer,
        token::mint = collateral_mint,
        token::authority = mint_authority,
        seeds = [COLLATERAL_VAULT_SEED],
        bump,
    )]
    pub collateral_vault: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = payer,
        space = 8 + LpState::INIT_SPACE,
        seeds = [LP_STATE_SEED],
        bump,
    )]
    pub lp_state: Account<'info, LpState>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct FirstBreath<'info> {
    #[account(mut, seeds = [MINT_SEED], bump)]
    pub mint: Account<'info, Mint>,
    /// CHECK: PDA mint authority
    #[account(seeds = [MINT_AUTHORITY_SEED], bump)]
    pub mint_authority: AccountInfo<'info>,
    #[account(mut, seeds = [LP_STATE_SEED], bump)]
    pub lp_state: Account<'info, LpState>,
    #[account(
        mut,
        seeds = [COLLATERAL_VAULT_SEED],
        bump,
        constraint = collateral_vault.mint == lp_state.collateral_mint @ BodyError::WrongCollateral,
    )]
    pub collateral_vault: Account<'info, TokenAccount>,
    #[account(mut, constraint = user_collateral.mint == lp_state.collateral_mint @ BodyError::WrongCollateral)]
    pub user_collateral: Account<'info, TokenAccount>,
    #[account(mut, constraint = user_org.mint == mint.key() @ BodyError::WrongCollateral)]
    pub user_org: Account<'info, TokenAccount>,
    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct LpSwapIn<'info> {
    #[account(mut, seeds = [MINT_SEED], bump)]
    pub mint: Account<'info, Mint>,
    /// CHECK: PDA mint authority
    #[account(seeds = [MINT_AUTHORITY_SEED], bump)]
    pub mint_authority: AccountInfo<'info>,
    #[account(mut, seeds = [BODY_STATE_SEED], bump)]
    pub body_state: Account<'info, BodyState>,
    #[account(mut, seeds = [LP_STATE_SEED], bump)]
    pub lp_state: Account<'info, LpState>,
    #[account(
        mut,
        seeds = [COLLATERAL_VAULT_SEED],
        bump,
        constraint = collateral_vault.mint == lp_state.collateral_mint @ BodyError::WrongCollateral,
    )]
    pub collateral_vault: Account<'info, TokenAccount>,
    #[account(mut, constraint = user_collateral.mint == lp_state.collateral_mint @ BodyError::WrongCollateral)]
    pub user_collateral: Account<'info, TokenAccount>,
    #[account(mut, constraint = user_org.mint == mint.key() @ BodyError::WrongCollateral)]
    pub user_org: Account<'info, TokenAccount>,
    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct LpSwapOut<'info> {
    #[account(mut, seeds = [MINT_SEED], bump)]
    pub mint: Account<'info, Mint>,
    /// CHECK: PDA mint authority
    #[account(seeds = [MINT_AUTHORITY_SEED], bump)]
    pub mint_authority: AccountInfo<'info>,
    #[account(mut, seeds = [BODY_STATE_SEED], bump)]
    pub body_state: Account<'info, BodyState>,
    #[account(mut, seeds = [LP_STATE_SEED], bump)]
    pub lp_state: Account<'info, LpState>,
    #[account(
        mut,
        seeds = [COLLATERAL_VAULT_SEED],
        bump,
        constraint = collateral_vault.mint == lp_state.collateral_mint @ BodyError::WrongCollateral,
    )]
    pub collateral_vault: Account<'info, TokenAccount>,
    #[account(mut, constraint = user_collateral.mint == lp_state.collateral_mint @ BodyError::WrongCollateral)]
    pub user_collateral: Account<'info, TokenAccount>,
    #[account(mut, constraint = user_org.mint == mint.key() @ BodyError::WrongCollateral)]
    pub user_org: Account<'info, TokenAccount>,
    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SealBody<'info> {
    #[account(mut, seeds = [BODY_STATE_SEED], bump)]
    pub body_state: Account<'info, BodyState>,
    #[account(mut, seeds = [POOL_REGISTRY_SEED], bump)]
    pub pool_registry: Account<'info, PoolRegistry>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct RegisterPool<'info> {
    #[account(mut, seeds = [POOL_REGISTRY_SEED], bump)]
    pub pool_registry: Account<'info, PoolRegistry>,
    pub authority: Signer<'info>,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[event]
pub struct MintEvent { pub amount: u64, pub fee: u64 }
#[event]
pub struct BurnEvent { pub burned: u64, pub fee: u64 }
#[event]
pub struct TransferEvent { pub amount: u64, pub fee: u64 }
#[event]
pub struct SwapEvent { pub in_amount: u64, pub out_amount: u64, pub extracted: u64 }
#[event]
pub struct HeartbeatEvent {
    pub mode: u8,
    pub fee_adjustment: i64,
    pub throttle_factor: u16,
    pub slot: u64,
    pub price: u64,
}
#[event]
pub struct BrainFailure { pub reason: u8 }
#[event]
pub struct BodySealed {}
#[event]
pub struct FirstBreathEvent { pub amount: u64 }
#[event]
pub struct ObservedHeartbeat {
    pub observed_price: u64,
    pub vault_amount: u64,
    pub supply: u64,
    pub slot: u64,
}
#[event]
pub struct LpSwapEvent {
    pub direction: u8, // 0 = in (col→ORG), 1 = out (ORG→col)
    pub in_amount: u64,
    pub out_amount: u64,
    pub extracted: u64,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum BodyError {
    #[msg("Operation halted by current directive")]
    Halted,
    #[msg("Operation throttled — exceeds remaining capacity in current window")]
    Throttled,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Pool registry full")]
    RegistryFull,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("LP already seeded")]
    AlreadySeeded,
    #[msg("LP not seeded yet")]
    NotSeeded,
    #[msg("Wrong collateral mint")]
    WrongCollateral,
    #[msg("Insufficient reserves in collateral vault")]
    InsufficientReserves,
}
