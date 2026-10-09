use crate::state::RedemptionAuthority;
use crate::state::CreditLock;
use crate::instructions::lineage::{LineageRegistry, LineageError};
use anchor_lang::prelude::*;

use crate::constants::{
    ATTESTATION_VERSION,
    ECONOMIC_STATUS_ACTIVE,
};
use crate::error::ExploreChemRwaError;
use crate::state::{
    Config,
    CreateSeriesArgs,
    NonceRecord,
    OriginLock,
    Series,
};

#[derive(Accounts)]
#[instruction(args: CreateSeriesArgs)]
pub struct CreateSeries<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        seeds = [b"config"],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,

    pub trusted_attestor: Signer<'info>,

    // A emissora confirma na emissao a carteira que aceitara os resgates.
    pub issuer_wallet: Signer<'info>,
    #[account(init, payer=payer, space=8+RedemptionAuthority::INIT_SPACE,
        seeds=[b"redemption-authority", args.series_id.as_ref()], bump)]
    pub redemption_authority: Account<'info, RedemptionAuthority>,

    #[account(
        init,
        payer = payer,
        space = 8 + Series::INIT_SPACE,
        seeds = [
            b"series",
            args.series_id.as_ref()
        ],
        bump
    )]
    pub series: Account<'info, Series>,

    #[account(
        init,
        payer = payer,
        space = 8 + OriginLock::INIT_SPACE,
        seeds = [
            b"origin",
            args.origin_commitment.as_ref()
        ],
        bump
    )]
    pub origin_lock: Account<'info, OriginLock>,

    #[account(
        init,
        payer = payer,
        space = 8 + NonceRecord::INIT_SPACE,
        seeds = [
            b"nonce",
            args.nonce.to_le_bytes().as_ref()
        ],
        bump
    )]
    pub nonce_record: Account<'info, NonceRecord>,

    pub system_program: Program<'info, System>,
    #[account(mut, seeds=[b"credit-lineage-v2"], bump=lineage.bump)]
    pub lineage: Account<'info, LineageRegistry>,

    #[account(init, payer=payer, space=8+CreditLock::INIT_SPACE,
        seeds=[b"credit", args.issuer_actor_id.as_ref(), args.credit_id.as_ref()], bump)]
    pub credit_lock: Account<'info, CreditLock>,

}

pub fn handle_create_series(
    ctx: Context<CreateSeries>,
    args: CreateSeriesArgs,
) -> Result<()> {
    let config = &ctx.accounts.config;

    require!(
        !config.paused,
        ExploreChemRwaError::ProgramPaused
    );

    require!(
        ctx.accounts.trusted_attestor.key() == config.trusted_attestor,
        ExploreChemRwaError::UnauthorizedAttestor
    );

    require!(
        args.version == ATTESTATION_VERSION,
        ExploreChemRwaError::UnsupportedAttestationVersion
    );

    let now = Clock::get()?.unix_timestamp;

    require!(
        args.expires_at >= now,
        ExploreChemRwaError::AttestationExpired
    );

    require!(
        args.source_chain_id == config.source_chain_id,
        ExploreChemRwaError::WrongSourceChain
    );

    require!(
        args.source_lots_contract == config.source_lots_contract,
        ExploreChemRwaError::WrongSourceContract
    );

    require!(
        args.series_id != [0u8; 32],
        ExploreChemRwaError::ZeroSeriesId
    );

    require!(
        args.issuer_actor_id != [0u8; 32],
        ExploreChemRwaError::ZeroIssuerActorId
    );

    require!(
        args.origin_commitment != [0u8; 32],
        ExploreChemRwaError::ZeroOriginCommitment
    );

    require!(
        args.claim_commitment != [0u8; 32],
        ExploreChemRwaError::ZeroClaimCommitment
    );

    require!(ctx.accounts.lineage.ready, LineageError::NotReady);
    require!(args.credit_id != [0;32], LineageError::Invalid);
    ctx.accounts.lineage.reserve(args.source_lot_id, args.issuer_actor_id, args.series_id)?;
    let credit = &mut ctx.accounts.credit_lock;
    credit.issuer = args.issuer_actor_id;
    credit.credit_id = args.credit_id;
    credit.terms_commitment = args.claim_commitment;
    credit.series_id = args.series_id;
    credit.source_lot_id = args.source_lot_id;
    credit.bump = ctx.bumps.credit_lock;

    let authority = &mut ctx.accounts.redemption_authority;
    authority.series_id = args.series_id;
    authority.issuer_wallet = ctx.accounts.issuer_wallet.key();
    authority.bump = ctx.bumps.redemption_authority;

    let series = &mut ctx.accounts.series;

    series.series_id = args.series_id;
    series.issuer_actor_id = args.issuer_actor_id;
    series.origin_commitment = args.origin_commitment;
    series.claim_commitment = args.claim_commitment;
    series.source_chain_id = args.source_chain_id;
    series.source_lots_contract = args.source_lots_contract;
    series.nonce = args.nonce;
    series.created_at = now;

    // O RWA já nasce economicamente ativo.
    series.economic_status = ECONOMIC_STATUS_ACTIVE;

    // Byte reservado, sem significado de status.
    series.reserved = 0;

    series.bump = ctx.bumps.series;

    let origin_lock = &mut ctx.accounts.origin_lock;

    origin_lock.origin_commitment = args.origin_commitment;
    origin_lock.series_id = args.series_id;
    origin_lock.created_at = now;
    origin_lock.bump = ctx.bumps.origin_lock;

    let nonce_record = &mut ctx.accounts.nonce_record;

    nonce_record.nonce = args.nonce;
    nonce_record.series_id = args.series_id;
    nonce_record.used_at = now;
    nonce_record.bump = ctx.bumps.nonce_record;

    emit!(SeriesCreated {
        series_id: args.series_id,
        issuer_actor_id: args.issuer_actor_id,
        origin_commitment: args.origin_commitment,
        claim_commitment: args.claim_commitment,
        economic_status: ECONOMIC_STATUS_ACTIVE,
        reserved: 0,
        nonce: args.nonce,
        created_at: now,
    });

    Ok(())
}

#[event]
pub struct SeriesCreated {
    pub series_id: [u8; 32],
    pub issuer_actor_id: [u8; 32],
    pub origin_commitment: [u8; 32],
    pub claim_commitment: [u8; 32],
    pub economic_status: u8,
    // Preserva também o layout binário do evento legado.
    pub reserved: u8,
    pub nonce: u64,
    pub created_at: i64,
}

