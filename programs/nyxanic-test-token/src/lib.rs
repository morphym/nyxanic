//! Nyxanic Test Token (NTT)
//!
//! A standalone, permissionless, mintable SPL token used as test collateral
//! for the Organism on devnet. Anyone can call `airdrop` to mint tokens to
//! their own associated token account. There is no admin authority.
//!
//! NOT FOR PRODUCTION USE — anyone can dilute the supply at will.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount};

declare_id!("CwgFaQX7APeKvLGiJAxLUGCReooTeM3YzzocQ6bvNYow");

pub const MINT_SEED: &[u8] = b"ntt_mint";
pub const MINT_AUTHORITY_SEED: &[u8] = b"ntt_mint_authority";
pub const TOKEN_DECIMALS: u8 = 6;

/// Maximum amount per airdrop call. ~1B tokens per call (with 6 decimals).
pub const AIRDROP_MAX_PER_CALL: u64 = 1_000_000_000_000_000;

#[program]
pub mod nyxanic_test_token {
    use super::*;

    /// Birth: create the SPL Mint PDA. Mint authority is a PDA — no signing
    /// key controls it. Decimals fixed at 6.
    pub fn initialize(_ctx: Context<Initialize>) -> Result<()> {
        Ok(())
    }

    /// Permissionless airdrop. Anyone can mint up to AIRDROP_MAX_PER_CALL
    /// tokens into any token account whose mint matches this program's mint.
    /// The program signs via mint_authority PDA.
    pub fn airdrop(ctx: Context<Airdrop>, amount: u64) -> Result<()> {
        require!(amount > 0 && amount <= AIRDROP_MAX_PER_CALL, NttError::InvalidAmount);

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

        emit!(AirdropEvent {
            recipient: ctx.accounts.recipient.key(),
            amount,
        });
        Ok(())
    }
}

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
    #[account(mut)]
    pub payer: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Airdrop<'info> {
    #[account(mut, seeds = [MINT_SEED], bump)]
    pub mint: Account<'info, Mint>,
    /// CHECK: PDA mint authority
    #[account(seeds = [MINT_AUTHORITY_SEED], bump)]
    pub mint_authority: AccountInfo<'info>,
    #[account(mut, constraint = recipient.mint == mint.key() @ NttError::WrongMint)]
    pub recipient: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[event]
pub struct AirdropEvent {
    pub recipient: Pubkey,
    pub amount: u64,
}

#[error_code]
pub enum NttError {
    #[msg("Invalid airdrop amount")]
    InvalidAmount,
    #[msg("Token account is for the wrong mint")]
    WrongMint,
}
