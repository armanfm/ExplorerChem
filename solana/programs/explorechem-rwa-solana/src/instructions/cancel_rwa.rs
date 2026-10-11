use anchor_lang::prelude::*;
use anchor_spl::{token_2022::{self, Burn, Token2022}, token_interface::{Mint, TokenAccount}};
use crate::{state::*, instructions::lineage::LineageRegistry};

// The attestor certifies complete unsold history, including legacy purchases and
// direct SPL transfers. Current ownership alone does NOT prove absence of sales.
#[derive(Accounts)]
pub struct CancelRwa<'info> {
    pub holder: Signer<'info>,
    #[account(seeds=[b"config"], bump=config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(address=config.trusted_attestor)]
    pub attestor: Signer<'info>,
    #[account(mut, seeds=[b"series", series.series_id.as_ref()], bump=series.bump,
        constraint=series.economic_status==1, constraint=series.reserved==0)]
    pub series: Box<Account<'info, Series>>,
    #[account(seeds=[b"rwa-mint", series.series_id.as_ref()], bump=mint_record.bump,
        constraint=mint_record.series_id==series.series_id,
        constraint=mint_record.mint==mint.key(), constraint=mint_record.initial_holder==holder.key())]
    pub mint_record: Box<Account<'info, RwaMintRecord>>,
    #[account(seeds=[b"redemption-authority", series.series_id.as_ref()], bump=issuer.bump,
        constraint=issuer.series_id==series.series_id, constraint=issuer.issuer_wallet==holder.key())]
    pub issuer: Box<Account<'info, RedemptionAuthority>>,
    #[account(mut, address=mint_record.mint, constraint=mint.supply==1, constraint=mint.decimals==0)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint=mint, token::authority=holder, token::token_program=token_program,
        constraint=holder_token.amount==1)]
    pub holder_token: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: PDA must be uninitialized; no pending or settled redemption allowed.
    #[account(seeds=[b"redemption", series.series_id.as_ref()], bump,
        constraint=redemption.data_is_empty())]
    pub redemption: UncheckedAccount<'info>,
    /// CHECK: offer cancellation must precede this instruction in the same transaction.
    #[account(seeds=[b"listing", series.series_id.as_ref()], bump,
        constraint=listing.data_is_empty())]
    pub listing: UncheckedAccount<'info>,
    #[account(mut, seeds=[b"credit-lineage-v2"], bump=lineage.bump)]
    pub lineage: Box<Account<'info, LineageRegistry>>,
    pub token_program: Program<'info, Token2022>,
}

pub fn handle_cancel_rwa(ctx: Context<CancelRwa>, history_hash: [u8;32]) -> Result<()> {
    require!(history_hash != [0;32], crate::error::ExploreChemRwaError::Invalid);
    ctx.accounts.lineage.require_reserved(ctx.accounts.series.series_id)?;
    token_2022::burn(CpiContext::new(ctx.accounts.token_program.key(), Burn {
        mint: ctx.accounts.mint.to_account_info(), from: ctx.accounts.holder_token.to_account_info(),
        authority: ctx.accounts.holder.to_account_info(),
    }), 1)?;
    ctx.accounts.series.economic_status = 3;
    ctx.accounts.lineage.release(ctx.accounts.series.series_id);
    emit!(RwaCancelled { series_id: ctx.accounts.series.series_id, mint: ctx.accounts.mint.key(),
        holder: ctx.accounts.holder.key(), history_hash });
    Ok(())
}

#[event]
pub struct RwaCancelled { pub series_id: [u8;32], pub mint: Pubkey, pub holder: Pubkey, pub history_hash: [u8;32] }