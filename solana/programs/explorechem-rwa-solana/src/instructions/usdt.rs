//! Pagamentos SPL USDT separados do RWA Token-2022 e do fluxo legado SOL.
use crate::constants::*;
use crate::error::ExploreChemRwaError as MarketError;
use crate::error::ExploreChemRwaError;
use crate::instructions::lineage::LineageRegistry;
use crate::instructions::request_redemption::RedemptionRequested;
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token,
    token_2022::{self, Burn, CloseAccount, Token2022, TransferChecked},
    token_interface::{Mint, TokenAccount},
};

pub const USDT_DECIMALS: u8 = 6;
pub const OFFICIAL_USDT_MINT: Pubkey = pubkey!("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");

pub fn demo_usdt_mint() -> Pubkey {
    Pubkey::find_program_address(&[b"demo-usdt"], &crate::ID).0
}

pub fn check_usdt_config(config: &UsdtPaymentConfig) -> Result<()> {
    require!(
        config.decimals == USDT_DECIMALS,
        ExploreChemRwaError::InvalidPaymentToken
    );
    if config.demo {
        require!(
            cfg!(feature = "demo-usdt"),
            ExploreChemRwaError::DemoPaymentDisabled
        );
        require_keys_eq!(
            config.payment_mint,
            demo_usdt_mint(),
            ExploreChemRwaError::WrongPaymentMint
        );
    } else {
        require_keys_eq!(
            config.payment_mint,
            OFFICIAL_USDT_MINT,
            ExploreChemRwaError::WrongPaymentMint
        );
    }
    Ok(())
}

// Configuracao imutavel: atualizar o programa nao altera a moeda de ofertas existentes.
#[derive(Accounts)]
pub struct InitializeUsdtPayments<'info> {
    #[account(mut, address=config.authority @ ExploreChemRwaError::UnauthorizedPaymentAdmin)]
    pub authority: Signer<'info>,
    #[account(seeds=[b"config"], bump=config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(init, payer=authority, space=8+UsdtPaymentConfig::INIT_SPACE, seeds=[b"usdt-payments"], bump)]
    pub payment_config: Box<Account<'info, UsdtPaymentConfig>>,
    #[account(constraint=payment_mint.decimals==USDT_DECIMALS @ ExploreChemRwaError::InvalidPaymentToken)]
    pub payment_mint: Box<Account<'info, token::Mint>>,
    pub payment_token_program: Program<'info, token::Token>,
    pub system_program: Program<'info, System>,
}
pub fn handle_initialize_usdt_payments(ctx: Context<InitializeUsdtPayments>) -> Result<()> {
    require!(
        !ctx.accounts.config.paused,
        ExploreChemRwaError::ProgramPaused
    );
    let p = &mut ctx.accounts.payment_config;
    p.payment_mint = ctx.accounts.payment_mint.key();
    p.decimals = USDT_DECIMALS;
    p.demo = p.payment_mint == demo_usdt_mint();
    p.bump = ctx.bumps.payment_config;
    check_usdt_config(p)
}

// Apenas demonstracao. O mint PDA nao e emitido pela Tether e nao tem valor real.
// Em producao compile com --no-default-features: este handler e rejeitado.
#[derive(Accounts)]
pub struct InitializeDemoUsdt<'info> {
    #[account(mut, address=config.authority @ ExploreChemRwaError::UnauthorizedPaymentAdmin)]
    pub authority: Signer<'info>,
    #[account(seeds=[b"config"], bump=config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(init, payer=authority, seeds=[b"demo-usdt"], bump,
        mint::decimals=USDT_DECIMALS, mint::authority=authority,
        mint::token_program=payment_token_program)]
    pub payment_mint: Box<Account<'info, token::Mint>>,
    pub payment_token_program: Program<'info, token::Token>,
    pub system_program: Program<'info, System>,
}
pub fn handle_initialize_demo_usdt(ctx: Context<InitializeDemoUsdt>) -> Result<()> {
    require!(
        cfg!(feature = "demo-usdt"),
        ExploreChemRwaError::DemoPaymentDisabled
    );
    require!(
        !ctx.accounts.config.paused,
        ExploreChemRwaError::ProgramPaused
    );
    Ok(())
}

#[derive(Accounts)]
pub struct ListRwaUsdt<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    #[account(seeds=[b"config"], bump=config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds=[b"series", series.series_id.as_ref()], bump=series.bump)]
    pub series: Box<Account<'info, Series>>,
    #[account(seeds=[b"rwa-mint", series.series_id.as_ref()], bump=mint_record.bump, constraint=mint_record.series_id==series.series_id, constraint=mint_record.mint==mint.key())]
    pub mint_record: Box<Account<'info, RwaMintRecord>>,
    #[account(address=mint_record.mint, constraint=mint.supply==1, constraint=mint.decimals==0)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint=mint, token::authority=seller, token::token_program=token_program, constraint=seller_token.amount==1)]
    pub seller_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(init, payer=seller, space=8+UsdtListing::INIT_SPACE, seeds=[b"listing", series.series_id.as_ref()], bump)]
    pub listing: Box<Account<'info, UsdtListing>>,
    #[account(mut, associated_token::mint=mint, associated_token::authority=listing, associated_token::token_program=token_program, constraint=escrow.amount==0)]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,

    #[account(seeds=[b"usdt-payments"], bump=payment_config.bump)]
    pub payment_config: Box<Account<'info, UsdtPaymentConfig>>,
    #[account(address=payment_config.payment_mint @ ExploreChemRwaError::WrongPaymentMint,
        constraint=payment_mint.decimals==USDT_DECIMALS @ ExploreChemRwaError::InvalidPaymentToken)]
    pub payment_mint: Box<Account<'info, token::Mint>>,
    pub payment_token_program: Program<'info, token::Token>,
}
#[derive(Accounts)]
pub struct BuyRwaUsdt<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(mut, address=listing.seller)]
    pub seller: SystemAccount<'info>,
    #[account(seeds=[b"config"], bump=config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds=[b"series", series.series_id.as_ref()], bump=series.bump)]
    pub series: Box<Account<'info, Series>>,
    #[account(seeds=[b"rwa-mint", series.series_id.as_ref()], bump=mint_record.bump, constraint=mint_record.series_id==series.series_id, constraint=mint_record.mint==mint.key())]
    pub mint_record: Box<Account<'info, RwaMintRecord>>,
    #[account(address=mint_record.mint, constraint=mint.supply==1, constraint=mint.decimals==0)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, close=seller, seeds=[b"listing", series.series_id.as_ref()], bump=listing.bump, constraint=listing.series_id==series.series_id, constraint=listing.mint==mint.key())]
    pub listing: Box<Account<'info, UsdtListing>>,
    #[account(mut, associated_token::mint=mint, associated_token::authority=listing, associated_token::token_program=token_program, constraint=escrow.amount==1)]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, associated_token::mint=mint, associated_token::authority=buyer, associated_token::token_program=token_program)]
    pub buyer_token: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,

    #[account(seeds=[b"usdt-payments"], bump=payment_config.bump)]
    pub payment_config: Box<Account<'info, UsdtPaymentConfig>>,
    #[account(address=payment_config.payment_mint @ ExploreChemRwaError::WrongPaymentMint,
        constraint=payment_mint.decimals==USDT_DECIMALS @ ExploreChemRwaError::InvalidPaymentToken)]
    pub payment_mint: Box<Account<'info, token::Mint>>,

    #[account(mut, token::mint=payment_mint, token::authority=buyer, token::token_program=payment_token_program)]
    pub buyer_payment: Box<Account<'info, token::TokenAccount>>,
    #[account(mut, token::mint=payment_mint, token::authority=seller, token::token_program=payment_token_program)]
    pub seller_payment: Box<Account<'info, token::TokenAccount>>,
    pub payment_token_program: Program<'info, token::Token>,
}
#[derive(Accounts)]
pub struct CancelListingUsdt<'info> {
    #[account(mut, address=listing.seller)]
    pub seller: Signer<'info>,
    #[account(seeds=[b"config"], bump=config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds=[b"series", series.series_id.as_ref()], bump=series.bump)]
    pub series: Box<Account<'info, Series>>,
    #[account(seeds=[b"rwa-mint", series.series_id.as_ref()], bump=mint_record.bump, constraint=mint_record.series_id==series.series_id, constraint=mint_record.mint==mint.key())]
    pub mint_record: Box<Account<'info, RwaMintRecord>>,
    #[account(address=mint_record.mint, constraint=mint.supply==1, constraint=mint.decimals==0)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, close=seller, seeds=[b"listing", series.series_id.as_ref()], bump=listing.bump, constraint=listing.series_id==series.series_id, constraint=listing.mint==mint.key())]
    pub listing: Box<Account<'info, UsdtListing>>,
    #[account(mut, associated_token::mint=mint, associated_token::authority=listing, associated_token::token_program=token_program, constraint=escrow.amount==1)]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, associated_token::mint=mint, associated_token::authority=seller, associated_token::token_program=token_program)]
    pub seller_token: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
pub fn handle_list_usdt(ctx: Context<ListRwaUsdt>, price_units: u64) -> Result<()> {
    require!(
        !ctx.accounts.config.paused && ctx.accounts.series.economic_status == 1,
        MarketError::Inactive
    );
    check_usdt_config(&ctx.accounts.payment_config)?;
    require!(price_units > 0, MarketError::Price);
    token_2022::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.seller_token.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.escrow.to_account_info(),
                authority: ctx.accounts.seller.to_account_info(),
            },
        ),
        1,
        0,
    )?;
    let l = &mut ctx.accounts.listing;
    l.series_id = ctx.accounts.series.series_id;
    l.mint = ctx.accounts.mint.key();
    l.seller = ctx.accounts.seller.key();
    l.price_units = price_units;
    l.payment_mint = ctx.accounts.payment_mint.key();
    l.bump = ctx.bumps.listing;
    Ok(())
}
pub fn handle_buy_usdt(ctx: Context<BuyRwaUsdt>, expected_price: u64) -> Result<()> {
    // Sticky marker: a buy and its marker commit or revert together.
    ctx.accounts.series.reserved = 1;
    require!(
        !ctx.accounts.config.paused && ctx.accounts.series.economic_status == 1,
        MarketError::Inactive
    );
    check_usdt_config(&ctx.accounts.payment_config)?;
    require_keys_eq!(
        ctx.accounts.listing.payment_mint,
        ctx.accounts.payment_mint.key(),
        MarketError::WrongPaymentMint
    );
    require!(
        expected_price > 0 && ctx.accounts.listing.price_units == expected_price,
        MarketError::Price
    );
    require!(
        ctx.accounts.buyer.key() != ctx.accounts.seller.key(),
        MarketError::SelfPurchase
    );
    token::transfer_checked(
        CpiContext::new(
            ctx.accounts.payment_token_program.key(),
            token::TransferChecked {
                from: ctx.accounts.buyer_payment.to_account_info(),
                mint: ctx.accounts.payment_mint.to_account_info(),
                to: ctx.accounts.seller_payment.to_account_info(),
                authority: ctx.accounts.buyer.to_account_info(),
            },
        ),
        expected_price,
        USDT_DECIMALS,
    )?;
    let sid = ctx.accounts.series.series_id;
    let bump = [ctx.accounts.listing.bump];
    let seeds: &[&[&[u8]]] = &[&[b"listing", sid.as_ref(), &bump]];
    token_2022::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.escrow.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.buyer_token.to_account_info(),
                authority: ctx.accounts.listing.to_account_info(),
            },
            seeds,
        ),
        1,
        0,
    )?;
    token_2022::close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.key(),
        CloseAccount {
            account: ctx.accounts.escrow.to_account_info(),
            destination: ctx.accounts.seller.to_account_info(),
            authority: ctx.accounts.listing.to_account_info(),
        },
        seeds,
    ))?;
    Ok(())
}
pub fn handle_cancel_usdt(ctx: Context<CancelListingUsdt>) -> Result<()> {
    let sid = ctx.accounts.series.series_id;
    let bump = [ctx.accounts.listing.bump];
    let seeds: &[&[&[u8]]] = &[&[b"listing", sid.as_ref(), &bump]];
    token_2022::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.escrow.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.seller_token.to_account_info(),
                authority: ctx.accounts.listing.to_account_info(),
            },
            seeds,
        ),
        1,
        0,
    )?;
    token_2022::close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.key(),
        CloseAccount {
            account: ctx.accounts.escrow.to_account_info(),
            destination: ctx.accounts.seller.to_account_info(),
            authority: ctx.accounts.listing.to_account_info(),
        },
        seeds,
    ))?;
    Ok(())
}

#[derive(Accounts)]
pub struct RequestRedemptionUsdt<'info> {
    // ============================================================
    // HOLDER ATUAL
    // ============================================================
    //
    // Quem possui o RWA é quem pode solicitar o redemption.
    //
    #[account(mut)]
    pub holder: Signer<'info>,
    #[account(init, payer=holder, space=8+UsdtRedemptionQuote::INIT_SPACE,
        seeds=[b"redemption-quote", series.series_id.as_ref()], bump)]
    pub redemption_quote: Box<Account<'info, UsdtRedemptionQuote>>,

    // ============================================================
    // CONFIG
    // ============================================================
    #[account(
        seeds = [b"config"],
        bump = config.bump
    )]
    pub config: Box<Account<'info, Config>>,

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
    pub series: Box<Account<'info, Series>>,

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
    pub mint_record: Box<Account<'info, RwaMintRecord>>,

    // ============================================================
    // TOKEN-2022 MINT
    // ============================================================
    #[account(
        address = mint_record.mint,

        constraint =
            mint.supply == 1
            @ ExploreChemRwaError::InvalidTokenBalance
    )]
    pub mint: Box<InterfaceAccount<'info, Mint>>,

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
    pub holder_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

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
    pub redemption: Box<Account<'info, Redemption>>,

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
    pub escrow_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Program<'info, Token2022>,

    pub associated_token_program: Program<'info, AssociatedToken>,

    pub system_program: Program<'info, System>,

    #[account(seeds=[b"usdt-payments"], bump=payment_config.bump)]
    pub payment_config: Box<Account<'info, UsdtPaymentConfig>>,
    #[account(address=payment_config.payment_mint @ ExploreChemRwaError::WrongPaymentMint,
        constraint=payment_mint.decimals==USDT_DECIMALS @ ExploreChemRwaError::InvalidPaymentToken)]
    pub payment_mint: Box<Account<'info, token::Mint>>,
    pub payment_token_program: Program<'info, token::Token>,
}

pub fn handle_request_redemption_usdt(
    ctx: Context<RequestRedemptionUsdt>,
    holder_actor_id: [u8; 32],
    amount_units: u64,
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
        ctx.accounts.series.economic_status == ECONOMIC_STATUS_ACTIVE,
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

    require!(
        amount_units > 0,
        ExploreChemRwaError::InvalidRedemptionAmount
    );
    ctx.accounts.redemption_quote.series_id = ctx.accounts.series.series_id;
    ctx.accounts.redemption_quote.amount_units = amount_units;
    check_usdt_config(&ctx.accounts.payment_config)?;
    ctx.accounts.redemption_quote.payment_mint = ctx.accounts.payment_mint.key();
    ctx.accounts.redemption_quote.bump = ctx.bumps.redemption_quote;

    token_2022::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.holder_token_account.to_account_info(),

                mint: ctx.accounts.mint.to_account_info(),

                to: ctx.accounts.escrow_token_account.to_account_info(),

                authority: ctx.accounts.holder.to_account_info(),
            },
        ),
        1,
        0,
    )?;

    // ============================================================
    // REGISTRA PEDIDO
    // ============================================================

    let now = Clock::get()?.unix_timestamp;

    let redemption = &mut ctx.accounts.redemption;

    redemption.series_id = ctx.accounts.series.series_id;

    redemption.mint = ctx.accounts.mint.key();

    redemption.holder_wallet = ctx.accounts.holder.key();

    redemption.holder_actor_id = holder_actor_id;

    redemption.status = REDEMPTION_STATUS_REQUESTED;

    redemption.requested_at = now;

    redemption.settled_at = 0;

    redemption.settlement_hash = [0u8; 32];

    redemption.bump = ctx.bumps.redemption;

    emit!(UsdtRedemptionRequested {
        series_id: ctx.accounts.series.series_id,
        payment_mint: ctx.accounts.payment_mint.key(),
        amount_units,
    });
    emit!(RedemptionRequested {
        series_id: redemption.series_id,

        mint: redemption.mint,

        holder_wallet: redemption.holder_wallet,

        holder_actor_id,

        requested_at: now,
    });

    Ok(())
}

// O titular pode ajustar a proposta enquanto aguarda aceite da emissora.
#[derive(Accounts)]
pub struct UpdateRedemptionQuoteUsdt<'info> {
    pub holder: Signer<'info>,
    #[account(seeds=[b"redemption", redemption.series_id.as_ref()], bump=redemption.bump,
        constraint=redemption.holder_wallet == holder.key() @ ExploreChemRwaError::WrongRedemptionHolder,
        constraint=redemption.status == REDEMPTION_STATUS_REQUESTED @ ExploreChemRwaError::InvalidRedemptionStatus)]
    pub redemption: Box<Account<'info, Redemption>>,
    #[account(mut, seeds=[b"redemption-quote", redemption.series_id.as_ref()], bump=redemption_quote.bump,
        constraint=redemption_quote.series_id == redemption.series_id @ ExploreChemRwaError::WrongRedemptionSeries)]
    pub redemption_quote: Box<Account<'info, UsdtRedemptionQuote>>,
}

pub fn handle_update_redemption_quote_usdt(
    ctx: Context<UpdateRedemptionQuoteUsdt>,
    amount_units: u64,
) -> Result<()> {
    require!(
        amount_units > 0,
        ExploreChemRwaError::InvalidRedemptionAmount
    );
    ctx.accounts.redemption_quote.amount_units = amount_units;
    Ok(())
}

#[derive(Accounts)]
pub struct SettleAndBurnUsdt<'info> {
    // ============================================================
    // CONFIG
    // ============================================================
    #[account(
        seeds = [b"config"],
        bump = config.bump
    )]
    pub config: Box<Account<'info, Config>>,

    // Qualquer carteira pode financiar o pagamento integral solicitado.
    // O titular recebe USDT; o pagador não recebe o token nem o direito.
    #[account(mut)]
    pub issuer_payer: Signer<'info>,

    #[account(seeds=[b"redemption-authority", series.series_id.as_ref()], bump=redemption_authority.bump,
        constraint=redemption_authority.series_id == series.series_id @ ExploreChemRwaError::WrongRedemptionSeries)]
    pub redemption_authority: Box<Account<'info, RedemptionAuthority>>,

    #[account(seeds=[b"redemption-quote", series.series_id.as_ref()], bump=redemption_quote.bump,
        constraint=redemption_quote.series_id == series.series_id @ ExploreChemRwaError::WrongRedemptionSeries)]
    pub redemption_quote: Box<Account<'info, UsdtRedemptionQuote>>,

    pub system_program: Program<'info, System>,

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
    pub series: Box<Account<'info, Series>>,

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
    pub mint_record: Box<Account<'info, RwaMintRecord>>,

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
    pub mint: Box<InterfaceAccount<'info, Mint>>,

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
    pub redemption: Box<Account<'info, Redemption>>,

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
    pub escrow_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Program<'info, Token2022>,
    #[account(mut, seeds=[b"credit-lineage-v2"], bump=lineage.bump)]
    pub lineage: Box<Account<'info, LineageRegistry>>,

    #[account(seeds=[b"usdt-payments"], bump=payment_config.bump)]
    pub payment_config: Box<Account<'info, UsdtPaymentConfig>>,
    #[account(address=payment_config.payment_mint @ ExploreChemRwaError::WrongPaymentMint,
        constraint=payment_mint.decimals==USDT_DECIMALS @ ExploreChemRwaError::InvalidPaymentToken)]
    pub payment_mint: Box<Account<'info, token::Mint>>,

    #[account(mut, token::mint=payment_mint, token::authority=issuer_payer, token::token_program=payment_token_program)]
    pub payer_payment: Box<Account<'info, token::TokenAccount>>,
    #[account(mut, token::mint=payment_mint, token::authority=holder, token::token_program=payment_token_program)]
    pub holder_payment: Box<Account<'info, token::TokenAccount>>,
    pub payment_token_program: Program<'info, token::Token>,
}

pub fn handle_settle_and_burn_usdt(
    ctx: Context<SettleAndBurnUsdt>,
    settlement_hash: [u8; 32],
    amount_units: u64,
) -> Result<()> {
    // ============================================================
    // CONFIG
    // ============================================================

    require!(
        !ctx.accounts.config.paused,
        ExploreChemRwaError::ProgramPaused
    );

    // ============================================================
    // SERIES AINDA PRECISA ESTAR ACTIVE
    // ============================================================

    require!(
        ctx.accounts.series.economic_status == ECONOMIC_STATUS_ACTIVE,
        ExploreChemRwaError::SeriesNotActive
    );

    // ============================================================
    // SETTLEMENT HASH
    // ============================================================

    require!(
        settlement_hash != [0u8; 32],
        ExploreChemRwaError::ZeroSettlementHash
    );

    require!(
        amount_units == ctx.accounts.redemption_quote.amount_units,
        ExploreChemRwaError::RedemptionAmountChanged
    );
    require!(
        amount_units > 0,
        ExploreChemRwaError::InvalidRedemptionAmount
    );
    require_keys_neq!(
        ctx.accounts.issuer_payer.key(),
        ctx.accounts.holder.key(),
        ExploreChemRwaError::SelfRedemptionPayment
    );

    check_usdt_config(&ctx.accounts.payment_config)?;
    require_keys_eq!(
        ctx.accounts.redemption_quote.payment_mint,
        ctx.accounts.payment_mint.key(),
        ExploreChemRwaError::WrongPaymentMint
    );
    // Pagamento, burn e liberacao de reserva sao atomicos.
    token::transfer_checked(
        CpiContext::new(
            ctx.accounts.payment_token_program.key(),
            token::TransferChecked {
                from: ctx.accounts.payer_payment.to_account_info(),
                mint: ctx.accounts.payment_mint.to_account_info(),
                to: ctx.accounts.holder_payment.to_account_info(),
                authority: ctx.accounts.issuer_payer.to_account_info(),
            },
        ),
        amount_units,
        USDT_DECIMALS,
    )?;

    // ============================================================
    // PDA SIGNER DO ESCROW
    // ============================================================

    let series_id = ctx.accounts.series.series_id;

    let redemption_bump = ctx.accounts.redemption.bump;

    let bump_seed = [redemption_bump];

    let redemption_signer_seeds: &[&[u8]] = &[b"redemption", series_id.as_ref(), &bump_seed];

    let signer_seeds = &[redemption_signer_seeds];

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
                mint: ctx.accounts.mint.to_account_info(),

                from: ctx.accounts.escrow_token_account.to_account_info(),

                authority: ctx.accounts.redemption.to_account_info(),
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

    token_2022::close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.key(),
        CloseAccount {
            account: ctx.accounts.escrow_token_account.to_account_info(),

            destination: ctx.accounts.holder.to_account_info(),

            authority: ctx.accounts.redemption.to_account_info(),
        },
        signer_seeds,
    ))?;

    // ============================================================
    // FINALIZA REDEMPTION
    // ============================================================

    let now = Clock::get()?.unix_timestamp;

    let redemption = &mut ctx.accounts.redemption;

    redemption.status = REDEMPTION_STATUS_SETTLED;

    redemption.settlement_hash = settlement_hash;

    redemption.settled_at = now;

    // ============================================================
    // FINALIZA DIREITO ECONÔMICO
    // ============================================================

    ctx.accounts.series.economic_status = ECONOMIC_STATUS_REDEEMED;

    ctx.accounts.lineage.release(series_id);

    emit!(UsdtRedemptionSettled {
        series_id,
        issuer_payer: ctx.accounts.issuer_payer.key(),
        payment_mint: ctx.accounts.payment_mint.key(),
        amount_units,

        mint: ctx.accounts.mint.key(),

        holder_wallet: redemption.holder_wallet,

        holder_actor_id: redemption.holder_actor_id,

        settlement_hash,

        settled_at: now,
    });

    Ok(())
}

#[event]
pub struct UsdtRedemptionSettled {
    pub issuer_payer: Pubkey,
    pub payment_mint: Pubkey,
    pub amount_units: u64,
    pub series_id: [u8; 32],

    pub mint: Pubkey,

    pub holder_wallet: Pubkey,

    pub holder_actor_id: [u8; 32],

    pub settlement_hash: [u8; 32],

    pub settled_at: i64,
}

#[event]
pub struct UsdtRedemptionRequested {
    pub series_id: [u8; 32],
    pub payment_mint: Pubkey,
    pub amount_units: u64,
}

#[cfg(test)]
mod payment_tests {
    use super::*;
    #[test]
    fn official_usdt_is_accepted_and_arbitrary_mints_are_rejected() {
        let good = UsdtPaymentConfig {
            payment_mint: OFFICIAL_USDT_MINT,
            decimals: 6,
            demo: false,
            bump: 0,
        };
        assert!(check_usdt_config(&good).is_ok());
        let fake = UsdtPaymentConfig {
            payment_mint: Pubkey::new_unique(),
            ..good
        };
        assert!(check_usdt_config(&fake).is_err());
    }
    #[test]
    fn decimals_and_demo_identity_are_enforced() {
        let wrong = UsdtPaymentConfig {
            payment_mint: OFFICIAL_USDT_MINT,
            decimals: 9,
            demo: false,
            bump: 0,
        };
        assert!(check_usdt_config(&wrong).is_err());
        let fake_demo = UsdtPaymentConfig {
            payment_mint: Pubkey::new_unique(),
            decimals: 6,
            demo: true,
            bump: 0,
        };
        assert!(check_usdt_config(&fake_demo).is_err());
    }
    #[test]
    fn demo_build_flag_is_enforced() {
        let demo = UsdtPaymentConfig {
            payment_mint: demo_usdt_mint(),
            decimals: 6,
            demo: true,
            bump: 0,
        };
        assert_eq!(
            check_usdt_config(&demo).is_ok(),
            cfg!(feature = "demo-usdt")
        );
    }
}
