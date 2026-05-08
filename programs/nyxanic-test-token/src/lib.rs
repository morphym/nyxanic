//! Nyxanic Test Token (NTT)
//!
//! A standalone, mintable SPL token for testing the Organism on devnet.
//! Hard supply cap: 90% reserved for LP seeding (one-shot), 10% available via
//! permissionless airdrop. Each wallet may airdrop at most once per 8 hours.
//!
//! NOT FOR PRODUCTION USE.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount};

declare_id!("CwgFaQX7APeKvLGiJAxLUGCReooTeM3YzzocQ6bvNYow");

// ---------------------------------------------------------------------------
// Seeds + constants
// ---------------------------------------------------------------------------

pub const MINT_SEED: &[u8] = b"ntt_mint";
pub const MINT_AUTHORITY_SEED: &[u8] = b"ntt_mint_authority";
pub const TOKEN_CONFIG_SEED: &[u8] = b"ntt_config";
pub const AIRDROP_RECORD_SEED: &[u8] = b"ntt_airdrop";

pub const TOKEN_DECIMALS: u8 = 6;

/// 1 billion tokens (with 6 decimals = 1e15 base units).
pub const MAX_TOTAL_SUPPLY: u64 = 1_000_000_000_000_000;
/// 90% reserved for LP seeding.
pub const LIQUIDITY_QUOTA: u64 = 900_000_000_000_000;
/// 10% available via airdrop.
pub const AIRDROP_QUOTA: u64 = 100_000_000_000_000;

/// Max per single airdrop call: 50,000 tokens.
pub const AIRDROP_MAX_PER_CALL: u64 = 50_000_000_000;
/// Cooldown per wallet between airdrops: 8 hours.
pub const AIRDROP_COOLDOWN_SECS: i64 = 8 * 60 * 60;

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/// Global token state — supply tracking + quota counters.
#[account]
#[derive(InitSpace)]
pub struct TokenConfig {
    pub liquidity_minted: u64,
    pub airdropped: u64,
}

impl TokenConfig {
    pub fn total_minted(&self) -> u64 {
        self.liquidity_minted.saturating_add(self.airdropped)
    }
}

/// Per-wallet airdrop cooldown record.
#[account]
#[derive(InitSpace)]
pub struct AirdropRecord {
    pub wallet: Pubkey,
    pub last_airdrop_unix: i64,
    pub total_airdropped_to_wallet: u64,
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

#[program]
pub mod nyxanic_test_token {
    use super::*;

    /// Birth: create the SPL Mint PDA and the global token config.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let cfg = &mut ctx.accounts.config;
        cfg.liquidity_minted = 0;
        cfg.airdropped = 0;
        Ok(())
    }

    /// Migration helper: if the mint was created by an older program version
    /// without the TokenConfig PDA, this creates only the config so newer
    /// instructions can run. One-shot, permissionless.
    pub fn initialize_config_only(ctx: Context<InitializeConfigOnly>) -> Result<()> {
        let cfg = &mut ctx.accounts.config;
        cfg.liquidity_minted = 0;
        cfg.airdropped = 0;
        Ok(())
    }

    /// One-shot seed for the LP. Mints up to LIQUIDITY_QUOTA NTT to a
    /// recipient (typically the deployer wallet, which then deposits into
    /// the organism's first_breath). Permissionless but capped.
    pub fn seed_liquidity(ctx: Context<SeedLiquidity>, amount: u64) -> Result<()> {
        require!(amount > 0, NttError::InvalidAmount);

        let cfg = &mut ctx.accounts.config;
        let new_total = cfg.liquidity_minted
            .checked_add(amount)
            .ok_or(NttError::Overflow)?;
        require!(new_total <= LIQUIDITY_QUOTA, NttError::LiquidityQuotaExhausted);

        let bump = ctx.bumps.mint_authority;
        let seeds: &[&[u8]] = &[MINT_AUTHORITY_SEED, &[bump]];
        let signer = &[seeds];
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
            amount,
        )?;

        cfg.liquidity_minted = new_total;
        emit!(LiquiditySeeded {
            amount,
            recipient: ctx.accounts.recipient.key(),
            total_liquidity_minted: cfg.liquidity_minted,
        });
        Ok(())
    }

    /// Permissionless airdrop. Mints up to AIRDROP_MAX_PER_CALL NTT into the
    /// given recipient token account. Constraints:
    ///   - amount > 0 and amount <= AIRDROP_MAX_PER_CALL (50k)
    ///   - global airdropped total + amount <= AIRDROP_QUOTA (10%)
    ///   - per-wallet cooldown: last airdrop must be ≥ 8 hours ago
    pub fn airdrop(ctx: Context<Airdrop>, amount: u64) -> Result<()> {
        require!(amount > 0 && amount <= AIRDROP_MAX_PER_CALL, NttError::InvalidAmount);

        let cfg = &mut ctx.accounts.config;
        let new_airdropped = cfg.airdropped
            .checked_add(amount)
            .ok_or(NttError::Overflow)?;
        require!(new_airdropped <= AIRDROP_QUOTA, NttError::AirdropQuotaExhausted);

        let now = Clock::get()?.unix_timestamp;
        let record = &mut ctx.accounts.airdrop_record;

        // First-time setup: record.last_airdrop_unix == 0
        if record.last_airdrop_unix > 0 {
            let elapsed = now.checked_sub(record.last_airdrop_unix).ok_or(NttError::Overflow)?;
            require!(elapsed >= AIRDROP_COOLDOWN_SECS, NttError::AirdropOnCooldown);
        }

        let bump = ctx.bumps.mint_authority;
        let seeds: &[&[u8]] = &[MINT_AUTHORITY_SEED, &[bump]];
        let signer = &[seeds];
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
            amount,
        )?;

        cfg.airdropped = new_airdropped;
        record.wallet = ctx.accounts.recipient_wallet.key();
        record.last_airdrop_unix = now;
        record.total_airdropped_to_wallet = record.total_airdropped_to_wallet
            .saturating_add(amount);

        emit!(AirdropEvent {
            recipient_wallet: record.wallet,
            recipient_account: ctx.accounts.recipient.key(),
            amount,
            global_airdropped: cfg.airdropped,
            wallet_total: record.total_airdropped_to_wallet,
            next_eligible_unix: now + AIRDROP_COOLDOWN_SECS,
        });
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Account contexts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct Initialize<'info> {
    /// CHECK: PDA mint authority — derived deterministically, no signer
    #[account(seeds = [MINT_AUTHORITY_SEED], bump)]
    pub mint_authority: AccountInfo<'info>,
    #[account(
        init,
        payer = payer,
        mint::decimals = TOKEN_DECIMALS,
        mint::authority = mint_authority,
        seeds = [MINT_SEED],
        bump,
    )]
    pub mint: Account<'info, Mint>,
    #[account(
        init,
        payer = payer,
        space = 8 + TokenConfig::INIT_SPACE,
        seeds = [TOKEN_CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, TokenConfig>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct InitializeConfigOnly<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + TokenConfig::INIT_SPACE,
        seeds = [TOKEN_CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, TokenConfig>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SeedLiquidity<'info> {
    #[account(mut, seeds = [MINT_SEED], bump)]
    pub mint: Account<'info, Mint>,
    /// CHECK: PDA mint authority
    #[account(seeds = [MINT_AUTHORITY_SEED], bump)]
    pub mint_authority: AccountInfo<'info>,
    #[account(mut, seeds = [TOKEN_CONFIG_SEED], bump)]
    pub config: Account<'info, TokenConfig>,
    #[account(mut, constraint = recipient.mint == mint.key() @ NttError::WrongMint)]
    pub recipient: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Airdrop<'info> {
    #[account(mut, seeds = [MINT_SEED], bump)]
    pub mint: Account<'info, Mint>,
    /// CHECK: PDA mint authority
    #[account(seeds = [MINT_AUTHORITY_SEED], bump)]
    pub mint_authority: AccountInfo<'info>,
    #[account(mut, seeds = [TOKEN_CONFIG_SEED], bump)]
    pub config: Account<'info, TokenConfig>,
    #[account(mut, constraint = recipient.mint == mint.key() @ NttError::WrongMint)]
    pub recipient: Account<'info, TokenAccount>,
    /// CHECK: the wallet whose cooldown is enforced. The recipient
    /// TokenAccount must belong to this wallet (see constraint).
    #[account(constraint = recipient.owner == recipient_wallet.key() @ NttError::WalletMismatch)]
    pub recipient_wallet: AccountInfo<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + AirdropRecord::INIT_SPACE,
        seeds = [AIRDROP_RECORD_SEED, recipient_wallet.key().as_ref()],
        bump,
    )]
    pub airdrop_record: Account<'info, AirdropRecord>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[event]
pub struct LiquiditySeeded {
    pub amount: u64,
    pub recipient: Pubkey,
    pub total_liquidity_minted: u64,
}

#[event]
pub struct AirdropEvent {
    pub recipient_wallet: Pubkey,
    pub recipient_account: Pubkey,
    pub amount: u64,
    pub global_airdropped: u64,
    pub wallet_total: u64,
    pub next_eligible_unix: i64,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum NttError {
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("Token account is for the wrong mint")]
    WrongMint,
    #[msg("recipient TokenAccount owner does not match recipient_wallet")]
    WalletMismatch,
    #[msg("Liquidity quota (90% of MAX_TOTAL_SUPPLY) would be exceeded")]
    LiquidityQuotaExhausted,
    #[msg("Airdrop quota (10% of MAX_TOTAL_SUPPLY) would be exceeded")]
    AirdropQuotaExhausted,
    #[msg("Wallet is on airdrop cooldown — try again after 8 hours")]
    AirdropOnCooldown,
    #[msg("Arithmetic overflow")]
    Overflow,
}
