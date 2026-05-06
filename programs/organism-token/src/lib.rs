use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, MintTo, Burn, Token, TokenAccount, Transfer};

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
}
