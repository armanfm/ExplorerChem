use anchor_lang::prelude::*;

use crate::error::ExploreChemRwaError;
use crate::state::Config;

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + Config::INIT_SPACE,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,

    pub system_program: Program<'info, System>,
}

pub fn handle_initialize_config(
    ctx: Context<InitializeConfig>,
    trusted_attestor: Pubkey,
    source_chain_id: u64,
    source_lots_contract: [u8; 20],
) -> Result<()> {
    require!(
        trusted_attestor != Pubkey::default(),
        ExploreChemRwaError::InvalidAttestor
    );

    require!(
        source_chain_id != 0,
        ExploreChemRwaError::InvalidSource
    );

    require!(
        source_lots_contract != [0u8; 20],
        ExploreChemRwaError::InvalidSource
    );

    let config = &mut ctx.accounts.config;

    config.authority = ctx.accounts.authority.key();
    config.trusted_attestor = trusted_attestor;
    config.source_chain_id = source_chain_id;
    config.source_lots_contract = source_lots_contract;
    config.paused = false;
    config.bump = ctx.bumps.config;

    emit!(ConfigInitialized {
        authority: config.authority,
        trusted_attestor,
        source_chain_id,
        source_lots_contract,
    });

    Ok(())
}

#[event]
pub struct ConfigInitialized {
    pub authority: Pubkey,
    pub trusted_attestor: Pubkey,
    pub source_chain_id: u64,
    pub source_lots_contract: [u8; 20],
}
