use crate::instructions::lineage::LineageRegistry;
use anchor_lang::prelude::*;

use anchor_spl::{
    associated_token::AssociatedToken,
    token_2022::{
        self,
        spl_token_2022::instruction::AuthorityType,
        MintTo,
        SetAuthority,
        Token2022,
    },
    token_interface::{
        Mint,
        TokenAccount,
    },
};

use crate::{
    constants::ECONOMIC_STATUS_ACTIVE,
    error::ExploreChemRwaError,
    state::{
        Config,
        RwaMintRecord,
        Series,
    },
};

#[derive(Accounts)]
pub struct MintRwa<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        seeds = [b"config"],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,

    pub trusted_attestor: Signer<'info>,

    #[account(
        seeds = [
            b"series",
            series.series_id.as_ref()
        ],
        bump = series.bump
    )]
    pub series: Account<'info, Series>,

    // Carteira Solana que receberá o RWA na emissão inicial.
    pub holder: SystemAccount<'info>,

    // Garante que uma Series só possa possuir um mint RWA.
    #[account(
        init,
        payer = payer,
        space = 8 + RwaMintRecord::INIT_SPACE,
        seeds = [
            b"rwa-mint",
            series.series_id.as_ref()
        ],
        bump
    )]
    pub mint_record: Account<'info, RwaMintRecord>,

    // Mint Token-2022 determinístico da Series.
    //
    // decimals = 0
    // supply final = 1
    //
    // A Series PDA começa como mint authority
    // apenas durante a emissão.
    #[account(
        init,
        payer = payer,
        seeds = [
            b"mint",
            series.series_id.as_ref()
        ],
        bump,
        mint::decimals = 0,
        mint::authority = series,
        mint::freeze_authority = series,
        mint::token_program = token_program
    )]
    pub mint: InterfaceAccount<'info, Mint>,

    // ATA Token-2022 do holder inicial.
    #[account(
        init,
        payer = payer,
        associated_token::mint = mint,
        associated_token::authority = holder,
        associated_token::token_program = token_program
    )]
    pub holder_token_account:
        InterfaceAccount<'info, TokenAccount>,

    pub token_program: Program<'info, Token2022>,

    pub associated_token_program:
        Program<'info, AssociatedToken>,

    pub system_program: Program<'info, System>,
    #[account(seeds=[b"credit-lineage-v2"], bump=lineage.bump)]
    pub lineage: Account<'info, LineageRegistry>,

}

pub fn handle_mint_rwa(
    ctx: Context<MintRwa>,
) -> Result<()> {
    // ============================================================
    // 1. VALIDA CONFIGURAÇÃO
    // ============================================================

    ctx.accounts.lineage.require_reserved(ctx.accounts.series.series_id)?;
    let config = &ctx.accounts.config;

    require!(
        !config.paused,
        ExploreChemRwaError::ProgramPaused
    );

    require_keys_eq!(
        ctx.accounts.trusted_attestor.key(),
        config.trusted_attestor,
        ExploreChemRwaError::UnauthorizedAttestor
    );

    // ============================================================
    // 2. SERIES PRECISA ESTAR ECONOMICAMENTE ATIVA
    // ============================================================

    require!(
        ctx.accounts.series.economic_status
            == ECONOMIC_STATUS_ACTIVE,
        ExploreChemRwaError::SeriesNotActive
    );

    // A emissão usa o estado econômico e a assinatura do attestor.
    // Não existe classificação de verificação nesta versão.

    // ============================================================
    // 3. PREPARA ASSINATURA DA SERIES PDA
    // ============================================================

    let series_id =
        ctx.accounts.series.series_id;

    let series_bump =
        ctx.accounts.series.bump;

    let bump_seed = [series_bump];

    let series_signer_seeds: &[&[u8]] = &[
        b"series",
        series_id.as_ref(),
        &bump_seed,
    ];

    let signer_seeds = &[
        series_signer_seeds,
    ];

    // ============================================================
    // 4. MINTA EXATAMENTE UMA UNIDADE
    // ============================================================

    token_2022::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            MintTo {
                mint:
                    ctx.accounts
                        .mint
                        .to_account_info(),

                to:
                    ctx.accounts
                        .holder_token_account
                        .to_account_info(),

                authority:
                    ctx.accounts
                        .series
                        .to_account_info(),
            },
            signer_seeds,
        ),
        1,
    )?;

    // ============================================================
    // 5. REMOVE A MINT AUTHORITY
    // ============================================================
    //
    // Depois disso ninguém poderá aumentar o supply.
    //
    // Portanto este RWA fica estruturalmente:
    //
    // decimals = 0
    // supply   = 1
    //

    token_2022::set_authority(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            SetAuthority {
                current_authority:
                    ctx.accounts
                        .series
                        .to_account_info(),

                account_or_mint:
                    ctx.accounts
                        .mint
                        .to_account_info(),
            },
            signer_seeds,
        ),
        AuthorityType::MintTokens,
        None,
    )?;

    // ============================================================
    // 6. REMOVE A FREEZE AUTHORITY
    // ============================================================
    //
    // O emissor não poderá congelar arbitrariamente o RWA
    // após a emissão.
    //

    token_2022::set_authority(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            SetAuthority {
                current_authority:
                    ctx.accounts
                        .series
                        .to_account_info(),

                account_or_mint:
                    ctx.accounts
                        .mint
                        .to_account_info(),
            },
            signer_seeds,
        ),
        AuthorityType::FreezeAccount,
        None,
    )?;

    // ============================================================
    // 7. REGISTRA O VÍNCULO SERIES <-> MINT
    // ============================================================

    let mint_record =
        &mut ctx.accounts.mint_record;

    mint_record.series_id =
        series_id;

    mint_record.mint =
        ctx.accounts.mint.key();

    mint_record.initial_holder =
        ctx.accounts.holder.key();

    mint_record.minted_at =
        Clock::get()?.unix_timestamp;

    mint_record.bump =
        ctx.bumps.mint_record;

    // ============================================================
    // 8. EVENTO
    // ============================================================

    emit!(RwaMinted {
        series_id,
        mint: ctx.accounts.mint.key(),
        initial_holder:
            ctx.accounts.holder.key(),
        amount: 1,
        decimals: 0,
    });

    Ok(())
}

#[event]
pub struct RwaMinted {
    pub series_id: [u8; 32],

    pub mint: Pubkey,

    pub initial_holder: Pubkey,

    pub amount: u64,

    pub decimals: u8,
}

