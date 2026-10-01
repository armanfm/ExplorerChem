use crate::instructions::lineage::LineageRegistry;
use anchor_lang::prelude::*;

use anchor_spl::{
    token_2022::{
        self,
        Burn,
        CloseAccount,
        Token2022,
    },

    token_interface::{
        Mint,
        TokenAccount,
    },
};

use crate::{
    constants::{
        ECONOMIC_STATUS_ACTIVE,
        ECONOMIC_STATUS_REDEEMED,
        REDEMPTION_STATUS_REQUESTED,
        REDEMPTION_STATUS_SETTLED,
    },

    error::ExploreChemRwaError,

    state::{
        Config,
        Redemption,
        RwaMintRecord,
        Series,
    },
};

#[derive(Accounts)]
pub struct SettleAndBurn<'info> {
    // ============================================================
    // CONFIG
    // ============================================================

    #[account(
        seeds = [b"config"],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,

    // ============================================================
    // TRUSTED ATTESTOR
    // ============================================================
    //
    // Backend / CRE / TEE confirma que o pagamento
    // realmente ocorreu antes desta instrução.
    //
    pub trusted_attestor: Signer<'info>,

    // ============================================================
    // SERIES
    // ============================================================

    #[account(
        mut,

        seeds = [
            b"series",
            series.series_id.as_ref()
        ],

        bump = series.bump
    )]
    pub series: Account<'info, Series>,

    // ============================================================
    // MINT RECORD
    // ============================================================

    #[account(
        seeds = [
            b"rwa-mint",
            series.series_id.as_ref()
        ],

        bump = mint_record.bump,

        constraint =
            mint_record.series_id
                == series.series_id
                @ ExploreChemRwaError::WrongMint,

        constraint =
            mint_record.mint
                == mint.key()
                @ ExploreChemRwaError::WrongMint
    )]
    pub mint_record: Account<'info, RwaMintRecord>,

    // ============================================================
    // MINT
    // ============================================================

    #[account(
        mut,

        address = mint_record.mint,

        constraint =
            mint.supply == 1
            @ ExploreChemRwaError::InvalidTokenBalance
    )]
    pub mint: InterfaceAccount<'info, Mint>,

    // ============================================================
    // REDEMPTION PDA
    // ============================================================

    #[account(
        mut,

        seeds = [
            b"redemption",
            series.series_id.as_ref()
        ],

        bump = redemption.bump,

        constraint =
            redemption.series_id
                == series.series_id
                @ ExploreChemRwaError::WrongRedemptionSeries,

        constraint =
            redemption.mint
                == mint.key()
                @ ExploreChemRwaError::WrongMint,

        constraint =
            redemption.status
                == REDEMPTION_STATUS_REQUESTED
                @ ExploreChemRwaError::InvalidRedemptionStatus
    )]
    pub redemption: Account<'info, Redemption>,

    // ============================================================
    // HOLDER ORIGINAL DO PEDIDO
    // ============================================================
    //
    // Não precisa assinar.
    //
    // É usado para receber de volta o rent da conta escrow
    // depois que o token é queimado.
    //
    #[account(
        mut,

        address =
            redemption.holder_wallet
                @ ExploreChemRwaError::WrongRedemptionHolder
    )]
    pub holder: SystemAccount<'info>,

    // ============================================================
    // ESCROW
    // ============================================================

    #[account(
        mut,

        associated_token::mint = mint,

        associated_token::authority = redemption,

        associated_token::token_program = token_program,

        constraint =
            escrow_token_account.amount == 1
            @ ExploreChemRwaError::InvalidTokenBalance
    )]
    pub escrow_token_account:
        InterfaceAccount<'info, TokenAccount>,

    pub token_program:
        Program<'info, Token2022>,
    #[account(mut, seeds=[b"credit-lineage-v2"], bump=lineage.bump)]
    pub lineage: Account<'info, LineageRegistry>,

}

pub fn handle_settle_and_burn(
    ctx: Context<SettleAndBurn>,
    settlement_hash: [u8; 32],
) -> Result<()> {
    // ============================================================
    // CONFIG
    // ============================================================

    require!(
        !ctx.accounts.config.paused,
        ExploreChemRwaError::ProgramPaused
    );

    // ============================================================
    // SOMENTE TRUSTED ATTESTOR
    // ============================================================

    require_keys_eq!(
        ctx.accounts.trusted_attestor.key(),
        ctx.accounts.config.trusted_attestor,
        ExploreChemRwaError::UnauthorizedAttestor
    );

    // ============================================================
    // SERIES AINDA PRECISA ESTAR ACTIVE
    // ============================================================

    require!(
        ctx.accounts.series.economic_status
            == ECONOMIC_STATUS_ACTIVE,
        ExploreChemRwaError::SeriesNotActive
    );

    // ============================================================
    // SETTLEMENT HASH
    // ============================================================

    require!(
        settlement_hash != [0u8; 32],
        ExploreChemRwaError::ZeroSettlementHash
    );

    // ============================================================
    // PDA SIGNER DO ESCROW
    // ============================================================

    let series_id =
        ctx.accounts.series.series_id;

    let redemption_bump =
        ctx.accounts.redemption.bump;

    let bump_seed =
        [redemption_bump];

    let redemption_signer_seeds: &[&[u8]] = &[
        b"redemption",
        series_id.as_ref(),
        &bump_seed,
    ];

    let signer_seeds =
        &[redemption_signer_seeds];

    // ============================================================
    // BURN
    // ============================================================
    //
    // O Token-2022 que está no escrow é queimado.
    //
    // Isso NÃO toca no ExploreChemLots da Sepolia.
    //
    // O material físico continua existindo normalmente
    // no sistema ExploreChem.
    //

    token_2022::burn(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),

            Burn {
                mint:
                    ctx.accounts
                        .mint
                        .to_account_info(),

                from:
                    ctx.accounts
                        .escrow_token_account
                        .to_account_info(),

                authority:
                    ctx.accounts
                        .redemption
                        .to_account_info(),
            },

            signer_seeds,
        ),

        1,
    )?;

    // ============================================================
    // FECHA A ATA DE ESCROW
    // ============================================================
    //
    // Depois do burn ela está vazia.
    //
    // O rent volta para a carteira que pediu o redemption.
    //

    token_2022::close_account(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),

            CloseAccount {
                account:
                    ctx.accounts
                        .escrow_token_account
                        .to_account_info(),

                destination:
                    ctx.accounts
                        .holder
                        .to_account_info(),

                authority:
                    ctx.accounts
                        .redemption
                        .to_account_info(),
            },

            signer_seeds,
        ),
    )?;

    // ============================================================
    // FINALIZA REDEMPTION
    // ============================================================

    let now =
        Clock::get()?.unix_timestamp;

    let redemption =
        &mut ctx.accounts.redemption;

    redemption.status =
        REDEMPTION_STATUS_SETTLED;

    redemption.settlement_hash =
        settlement_hash;

    redemption.settled_at =
        now;

    // ============================================================
    // FINALIZA DIREITO ECONÔMICO
    // ============================================================

    ctx.accounts.series.economic_status =
        ECONOMIC_STATUS_REDEEMED;

    ctx.accounts.lineage.release(series_id);

    emit!(RedemptionSettled {
        series_id,

        mint:
            ctx.accounts.mint.key(),

        holder_wallet:
            redemption.holder_wallet,

        holder_actor_id:
            redemption.holder_actor_id,

        settlement_hash,

        settled_at:
            now,
    });

    Ok(())
}

#[event]
pub struct RedemptionSettled {
    pub series_id: [u8; 32],

    pub mint: Pubkey,

    pub holder_wallet: Pubkey,

    pub holder_actor_id: [u8; 32],

    pub settlement_hash: [u8; 32],

    pub settled_at: i64,
}
