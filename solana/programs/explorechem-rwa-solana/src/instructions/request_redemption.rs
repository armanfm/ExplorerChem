use crate::state::RedemptionQuote;
use anchor_lang::prelude::*;

use anchor_spl::{
    associated_token::AssociatedToken,

    token_2022::{
        self,
        Token2022,
        TransferChecked,
    },

    token_interface::{
        Mint,
        TokenAccount,
    },
};

use crate::{
    constants::{
        ECONOMIC_STATUS_ACTIVE,
        REDEMPTION_STATUS_REQUESTED,
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
pub struct RequestRedemption<'info> {
    // ============================================================
    // HOLDER ATUAL
    // ============================================================
    //
    // Quem possui o RWA é quem pode solicitar o redemption.
    //
    #[account(mut)]
    pub holder: Signer<'info>,
    #[account(init, payer=holder, space=8+RedemptionQuote::INIT_SPACE,
        seeds=[b"redemption-quote", series.series_id.as_ref()], bump)]
    pub redemption_quote: Account<'info, RedemptionQuote>,

    // ============================================================
    // CONFIG
    // ============================================================

    #[account(
        seeds = [b"config"],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,

    // ============================================================
    // SERIES
    // ============================================================

    #[account(
        seeds = [
            b"series",
            series.series_id.as_ref()
        ],
        bump = series.bump
    )]
    pub series: Account<'info, Series>,

    // ============================================================
    // SERIES -> MINT
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
    // TOKEN-2022 MINT
    // ============================================================

    #[account(
        address = mint_record.mint,

        constraint =
            mint.supply == 1
            @ ExploreChemRwaError::InvalidTokenBalance
    )]
    pub mint: InterfaceAccount<'info, Mint>,

    // ============================================================
    // TOKEN DO HOLDER
    // ============================================================

    #[account(
        mut,

        token::mint = mint,

        token::authority = holder,

        token::token_program = token_program,

        constraint =
            holder_token_account.amount == 1
            @ ExploreChemRwaError::InvalidTokenBalance
    )]
    pub holder_token_account:
        InterfaceAccount<'info, TokenAccount>,

    // ============================================================
    // REDEMPTION PDA
    // ============================================================
    //
    // Uma Series só pode possuir um redemption final.
    //
    #[account(
        init,

        payer = holder,

        space = 8 + Redemption::INIT_SPACE,

        seeds = [
            b"redemption",
            series.series_id.as_ref()
        ],

        bump
    )]
    pub redemption: Account<'info, Redemption>,

    // ============================================================
    // ESCROW TOKEN ACCOUNT
    // ============================================================
    //
    // O Token-2022 sai da posse do holder e passa para
    // uma ATA controlada pela Redemption PDA.
    //
    // Enquanto está aqui ele não pode mais ser vendido
    // pelo holder.
    //
    #[account(
        init,

        payer = holder,

        associated_token::mint = mint,

        associated_token::authority = redemption,

        associated_token::token_program = token_program
    )]
    pub escrow_token_account:
        InterfaceAccount<'info, TokenAccount>,

    pub token_program:
        Program<'info, Token2022>,

    pub associated_token_program:
        Program<'info, AssociatedToken>,

    pub system_program:
        Program<'info, System>,
}

pub fn handle_request_redemption(
    ctx: Context<RequestRedemption>,
    holder_actor_id: [u8; 32],
    redemption_lamports: u64,
) -> Result<()> {
    // ============================================================
    // CONFIG
    // ============================================================

    require!(
        !ctx.accounts.config.paused,
        ExploreChemRwaError::ProgramPaused
    );

    // ============================================================
    // SERIES PRECISA ESTAR ACTIVE
    // ============================================================

    require!(
        ctx.accounts.series.economic_status
            == ECONOMIC_STATUS_ACTIVE,
        ExploreChemRwaError::SeriesNotActive
    );

    // ============================================================
    // HOLDER ACTOR ID
    // ============================================================

    require!(
        holder_actor_id != [0u8; 32],
        ExploreChemRwaError::ZeroHolderActorId
    );

    // ============================================================
    // TRANSFERE 1 RWA DO HOLDER PARA O ESCROW
    // ============================================================

    require!(redemption_lamports > 0, ExploreChemRwaError::InvalidRedemptionAmount);
    ctx.accounts.redemption_quote.series_id = ctx.accounts.series.series_id;
    ctx.accounts.redemption_quote.lamports = redemption_lamports;
    ctx.accounts.redemption_quote.bump = ctx.bumps.redemption_quote;

    token_2022::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),

            TransferChecked {
                from:
                    ctx.accounts
                        .holder_token_account
                        .to_account_info(),

                mint:
                    ctx.accounts
                        .mint
                        .to_account_info(),

                to:
                    ctx.accounts
                        .escrow_token_account
                        .to_account_info(),

                authority:
                    ctx.accounts
                        .holder
                        .to_account_info(),
            },
        ),

        1,

        0,
    )?;

    // ============================================================
    // REGISTRA PEDIDO
    // ============================================================

    let now =
        Clock::get()?.unix_timestamp;

    let redemption =
        &mut ctx.accounts.redemption;

    redemption.series_id =
        ctx.accounts.series.series_id;

    redemption.mint =
        ctx.accounts.mint.key();

    redemption.holder_wallet =
        ctx.accounts.holder.key();

    redemption.holder_actor_id =
        holder_actor_id;

    redemption.status =
        REDEMPTION_STATUS_REQUESTED;

    redemption.requested_at =
        now;

    redemption.settled_at =
        0;

    redemption.settlement_hash =
        [0u8; 32];

    redemption.bump =
        ctx.bumps.redemption;

    emit!(RedemptionRequested {
        series_id:
            redemption.series_id,

        mint:
            redemption.mint,

        holder_wallet:
            redemption.holder_wallet,

        holder_actor_id,

        requested_at:
            now,
    });

    Ok(())
}

#[event]
pub struct RedemptionRequested {
    pub series_id: [u8; 32],

    pub mint: Pubkey,

    pub holder_wallet: Pubkey,

    pub holder_actor_id: [u8; 32],

    pub requested_at: i64,
}

// O titular pode ajustar a proposta enquanto aguarda aceite da emissora.
#[derive(Accounts)]
pub struct UpdateRedemptionQuote<'info> {
    pub holder: Signer<'info>,
    #[account(seeds=[b"redemption", redemption.series_id.as_ref()], bump=redemption.bump,
        constraint=redemption.holder_wallet == holder.key() @ ExploreChemRwaError::WrongRedemptionHolder,
        constraint=redemption.status == REDEMPTION_STATUS_REQUESTED @ ExploreChemRwaError::InvalidRedemptionStatus)]
    pub redemption: Account<'info, Redemption>,
    #[account(mut, seeds=[b"redemption-quote", redemption.series_id.as_ref()], bump=redemption_quote.bump,
        constraint=redemption_quote.series_id == redemption.series_id @ ExploreChemRwaError::WrongRedemptionSeries)]
    pub redemption_quote: Account<'info, RedemptionQuote>,
}

pub fn handle_update_redemption_quote(ctx: Context<UpdateRedemptionQuote>, lamports: u64) -> Result<()> {
    require!(lamports > 0, ExploreChemRwaError::InvalidRedemptionAmount);
    ctx.accounts.redemption_quote.lamports = lamports;
    Ok(())
}
