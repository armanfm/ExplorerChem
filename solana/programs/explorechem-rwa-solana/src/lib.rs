pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!(
    "A2sUfkL18Znfo6A3u9mPHbMm1avm1A9J7NDpvwSTqT79"
);

#[program]
pub mod explorechem_rwa_solana {
    use super::*;

    // ============================================================
    // INITIALIZE
    // ============================================================

    pub fn initialize(
        ctx: Context<InitializeConfig>,
        trusted_attestor: Pubkey,
        source_chain_id: u64,
        source_lots_contract: [u8; 20],
    ) -> Result<()> {
        crate::instructions::initialize::
            handle_initialize_config(
                ctx,
                trusted_attestor,
                source_chain_id,
                source_lots_contract,
            )
    }

    pub fn update_source_config(
        ctx: Context<UpdateSourceConfig>,
        source_chain_id: u64,
        source_lots_contract: [u8; 20],
    ) -> Result<()> {
        crate::instructions::initialize::handle_update_source_config(
            ctx, source_chain_id, source_lots_contract,
        )
    }

    // ============================================================
    // CREATE SERIES
    // ============================================================

    pub fn increment(
        ctx: Context<CreateSeries>,
        args: CreateSeriesArgs,
    ) -> Result<()> {
        crate::instructions::increment::
            handle_create_series(
                ctx,
                args,
            )
    }

    // ============================================================
    // MINT RWA
    // ============================================================

    pub fn mint_rwa(
        ctx: Context<MintRwa>,
    ) -> Result<()> {
        crate::instructions::mint_rwa::
            handle_mint_rwa(ctx)
    }

    // ============================================================
    // REQUEST REDEMPTION
    // ============================================================

    pub fn request_redemption(
        ctx: Context<RequestRedemption>,
        holder_actor_id: [u8; 32],
        redemption_lamports: u64,
    ) -> Result<()> {
        crate::instructions::request_redemption::
            handle_request_redemption(
                ctx,
                holder_actor_id,
                redemption_lamports,
            )
    }

    // ============================================================
    // SETTLEMENT + BURN
    // ============================================================

    pub fn settle_and_burn(
        ctx: Context<SettleAndBurn>,
        settlement_hash: [u8; 32],
        redemption_lamports: u64,
    ) -> Result<()> {
        crate::instructions::settle_and_burn::
            handle_settle_and_burn(
                ctx,
                settlement_hash,
                redemption_lamports,
            )
    }
    pub fn rotate_redemption_authority(ctx: Context<RotateRedemptionAuthority>) -> Result<()> {
        settle_and_burn::handle_rotate_redemption_authority(ctx)
    }
    pub fn update_redemption_quote(ctx: Context<UpdateRedemptionQuote>, lamports: u64) -> Result<()> {
        request_redemption::handle_update_redemption_quote(ctx, lamports)
    }
    pub fn initialize_lineage(ctx: Context<InitializeLineage>) -> Result<()> { lineage::initialize_registry(ctx) }
    pub fn register_lineage_lot(ctx: Context<ManageLineage>, lot_id: [u8;32], parents: Vec<[u8;32]>) -> Result<()> { lineage::register(ctx, lot_id, parents) }
    pub fn adopt_lineage_series(ctx: Context<AdoptLineage>, lot_id: [u8;32]) -> Result<()> { lineage::adopt(ctx, lot_id) }
    pub fn enable_lineage(ctx: Context<ManageLineage>, expected_reservations: u32) -> Result<()> { lineage::enable(ctx, expected_reservations) }
    pub fn list_rwa(ctx: Context<ListRwa>, price_lamports: u64) -> Result<()> { marketplace::list(ctx, price_lamports) }
    pub fn buy_rwa(ctx: Context<BuyRwa>, expected_price: u64) -> Result<()> { marketplace::buy(ctx, expected_price) }
    pub fn cancel_rwa(ctx: Context<CancelRwa>, history_hash: [u8;32]) -> Result<()> { cancel_rwa::handle_cancel_rwa(ctx, history_hash) }

    pub fn cancel_listing(ctx: Context<CancelListing>) -> Result<()> { marketplace::cancel(ctx) }

    pub fn initialize_usdt_payments(ctx: Context<InitializeUsdtPayments>) -> Result<()> { usdt::handle_initialize_usdt_payments(ctx) }
    pub fn initialize_demo_usdt(ctx: Context<InitializeDemoUsdt>) -> Result<()> { usdt::handle_initialize_demo_usdt(ctx) }
    pub fn list_rwa_usdt(ctx: Context<ListRwaUsdt>, price_units: u64) -> Result<()> { usdt::handle_list_usdt(ctx, price_units) }
    pub fn buy_rwa_usdt(ctx: Context<BuyRwaUsdt>, expected_price: u64) -> Result<()> { usdt::handle_buy_usdt(ctx, expected_price) }
    pub fn cancel_listing_usdt(ctx: Context<CancelListingUsdt>) -> Result<()> { usdt::handle_cancel_usdt(ctx) }
    pub fn request_redemption_usdt(ctx: Context<RequestRedemptionUsdt>, holder_actor_id: [u8;32], amount_units: u64) -> Result<()> { usdt::handle_request_redemption_usdt(ctx, holder_actor_id, amount_units) }
    pub fn update_redemption_quote_usdt(ctx: Context<UpdateRedemptionQuoteUsdt>, amount_units: u64) -> Result<()> { usdt::handle_update_redemption_quote_usdt(ctx, amount_units) }
    pub fn settle_and_burn_usdt(ctx: Context<SettleAndBurnUsdt>, settlement_hash: [u8;32], amount_units: u64) -> Result<()> { usdt::handle_settle_and_burn_usdt(ctx, settlement_hash, amount_units) }

}

