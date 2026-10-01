use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::{associated_token::AssociatedToken, token_2022::{self, Token2022, TransferChecked, CloseAccount}, token_interface::{Mint, TokenAccount}};
use crate::state::*;
use crate::error::ExploreChemRwaError as MarketError;
#[derive(Accounts)]
pub struct ListRwa<'info> {
    #[account(mut)] pub seller: Signer<'info>,
    #[account(seeds=[b"config"], bump=config.bump)]
    pub config: Account<'info, Config>,
    #[account(seeds=[b"series", series.series_id.as_ref()], bump=series.bump)]
    pub series: Account<'info, Series>,
    #[account(seeds=[b"rwa-mint", series.series_id.as_ref()], bump=mint_record.bump, constraint=mint_record.series_id==series.series_id, constraint=mint_record.mint==mint.key())]
    pub mint_record: Account<'info, RwaMintRecord>,
    #[account(address=mint_record.mint, constraint=mint.supply==1, constraint=mint.decimals==0)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint=mint, token::authority=seller, token::token_program=token_program, constraint=seller_token.amount==1)]
    pub seller_token: InterfaceAccount<'info, TokenAccount>,
    #[account(init, payer=seller, space=8+Listing::INIT_SPACE, seeds=[b"listing", series.series_id.as_ref()], bump)]
    pub listing: Account<'info, Listing>,
    #[account(mut, associated_token::mint=mint, associated_token::authority=listing, associated_token::token_program=token_program, constraint=escrow.amount==0)]
    pub escrow: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct BuyRwa<'info> {
    #[account(mut)] pub buyer: Signer<'info>,
    #[account(mut, address=listing.seller)] pub seller: SystemAccount<'info>,
    #[account(seeds=[b"config"], bump=config.bump)]
    pub config: Account<'info, Config>,
    #[account(seeds=[b"series", series.series_id.as_ref()], bump=series.bump)]
    pub series: Account<'info, Series>,
    #[account(seeds=[b"rwa-mint", series.series_id.as_ref()], bump=mint_record.bump, constraint=mint_record.series_id==series.series_id, constraint=mint_record.mint==mint.key())]
    pub mint_record: Account<'info, RwaMintRecord>,
    #[account(address=mint_record.mint, constraint=mint.supply==1, constraint=mint.decimals==0)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, close=seller, seeds=[b"listing", series.series_id.as_ref()], bump=listing.bump, constraint=listing.series_id==series.series_id, constraint=listing.mint==mint.key())]
    pub listing: Account<'info, Listing>,
    #[account(mut, associated_token::mint=mint, associated_token::authority=listing, associated_token::token_program=token_program, constraint=escrow.amount==1)]
    pub escrow: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, associated_token::mint=mint, associated_token::authority=buyer, associated_token::token_program=token_program)]
    pub buyer_token: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct CancelListing<'info> {
    #[account(mut, address=listing.seller)] pub seller: Signer<'info>,
    #[account(seeds=[b"config"], bump=config.bump)]
    pub config: Account<'info, Config>,
    #[account(seeds=[b"series", series.series_id.as_ref()], bump=series.bump)]
    pub series: Account<'info, Series>,
    #[account(seeds=[b"rwa-mint", series.series_id.as_ref()], bump=mint_record.bump, constraint=mint_record.series_id==series.series_id, constraint=mint_record.mint==mint.key())]
    pub mint_record: Account<'info, RwaMintRecord>,
    #[account(address=mint_record.mint, constraint=mint.supply==1, constraint=mint.decimals==0)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, close=seller, seeds=[b"listing", series.series_id.as_ref()], bump=listing.bump, constraint=listing.series_id==series.series_id, constraint=listing.mint==mint.key())]
    pub listing: Account<'info, Listing>,
    #[account(mut, associated_token::mint=mint, associated_token::authority=listing, associated_token::token_program=token_program, constraint=escrow.amount==1)]
    pub escrow: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, associated_token::mint=mint, associated_token::authority=seller, associated_token::token_program=token_program)]
    pub seller_token: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
pub fn list(ctx: Context<ListRwa>, price_lamports: u64) -> Result<()> {
 require!(!ctx.accounts.config.paused && ctx.accounts.series.economic_status==1, MarketError::Inactive);
 require!(price_lamports>0, MarketError::Price);
 token_2022::transfer_checked(CpiContext::new(ctx.accounts.token_program.key(), TransferChecked {from:ctx.accounts.seller_token.to_account_info(), mint:ctx.accounts.mint.to_account_info(), to:ctx.accounts.escrow.to_account_info(), authority:ctx.accounts.seller.to_account_info()}),1,0)?;
 let l=&mut ctx.accounts.listing;
 l.series_id=ctx.accounts.series.series_id; l.mint=ctx.accounts.mint.key(); l.seller=ctx.accounts.seller.key(); l.price_lamports=price_lamports; l.bump=ctx.bumps.listing;
 Ok(())
}
pub fn buy(ctx: Context<BuyRwa>, expected_price: u64) -> Result<()> {
 require!(!ctx.accounts.config.paused && ctx.accounts.series.economic_status==1, MarketError::Inactive);
 require!(expected_price>0 && ctx.accounts.listing.price_lamports==expected_price, MarketError::Price);
 require!(ctx.accounts.buyer.key()!=ctx.accounts.seller.key(), MarketError::SelfPurchase);
 system_program::transfer(CpiContext::new(ctx.accounts.system_program.key(), system_program::Transfer {from:ctx.accounts.buyer.to_account_info(),to:ctx.accounts.seller.to_account_info()}),expected_price)?;
 let sid=ctx.accounts.series.series_id; let bump=[ctx.accounts.listing.bump];
 let seeds: &[&[&[u8]]]=&[&[b"listing",sid.as_ref(),&bump]];
 token_2022::transfer_checked(CpiContext::new_with_signer(ctx.accounts.token_program.key(),TransferChecked {from:ctx.accounts.escrow.to_account_info(),mint:ctx.accounts.mint.to_account_info(),to:ctx.accounts.buyer_token.to_account_info(),authority:ctx.accounts.listing.to_account_info()},seeds),1,0)?;
 token_2022::close_account(CpiContext::new_with_signer(ctx.accounts.token_program.key(),CloseAccount {account:ctx.accounts.escrow.to_account_info(),destination:ctx.accounts.seller.to_account_info(),authority:ctx.accounts.listing.to_account_info()},seeds))?;
 Ok(())
}
pub fn cancel(ctx: Context<CancelListing>) -> Result<()> {
 let sid=ctx.accounts.series.series_id; let bump=[ctx.accounts.listing.bump];
 let seeds: &[&[&[u8]]]=&[&[b"listing",sid.as_ref(),&bump]];
 token_2022::transfer_checked(CpiContext::new_with_signer(ctx.accounts.token_program.key(),TransferChecked {from:ctx.accounts.escrow.to_account_info(),mint:ctx.accounts.mint.to_account_info(),to:ctx.accounts.seller_token.to_account_info(),authority:ctx.accounts.listing.to_account_info()},seeds),1,0)?;
 token_2022::close_account(CpiContext::new_with_signer(ctx.accounts.token_program.key(),CloseAccount {account:ctx.accounts.escrow.to_account_info(),destination:ctx.accounts.seller.to_account_info(),authority:ctx.accounts.listing.to_account_info()},seeds))?;
 Ok(())
}
