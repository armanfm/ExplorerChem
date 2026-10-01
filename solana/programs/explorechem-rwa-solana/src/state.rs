use anchor_lang::prelude::*;

#[derive(
    AnchorSerialize,
    AnchorDeserialize,
    Clone,
    Debug
)]
pub struct CreateSeriesArgs {
    pub version: u8,
    pub series_id: [u8; 32],
    pub issuer_actor_id: [u8; 32],
    pub origin_commitment: [u8; 32],
    pub claim_commitment: [u8; 32],
    pub source_chain_id: u64,
    pub source_lots_contract: [u8; 20],
    pub nonce: u64,
    pub expires_at: i64,
    pub source_lot_id: [u8; 32],
    pub credit_id: [u8; 32],
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub authority: Pubkey,
    pub trusted_attestor: Pubkey,
    pub source_chain_id: u64,
    pub source_lots_contract: [u8; 20],
    pub paused: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Series {
    pub series_id: [u8; 32],

    pub issuer_actor_id: [u8; 32],

    pub origin_commitment: [u8; 32],

    pub claim_commitment: [u8; 32],

    pub source_chain_id: u64,

    pub source_lots_contract: [u8; 20],

    pub nonce: u64,

    pub created_at: i64,

    pub economic_status: u8,

    // Byte legado ignorado. Preserva tamanho e posição do bump nas contas existentes.
    pub reserved: u8,

    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct OriginLock {
    pub origin_commitment: [u8; 32],

    pub series_id: [u8; 32],

    pub created_at: i64,

    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct NonceRecord {
    pub nonce: u64,

    pub series_id: [u8; 32],

    pub used_at: i64,

    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct RwaMintRecord {
    pub series_id: [u8; 32],

    pub mint: Pubkey,

    pub initial_holder: Pubkey,

    pub minted_at: i64,

    pub bump: u8,
}

// ================================================================
// REDEMPTION
// ================================================================
//
// holder_wallet:
// carteira que possuía o token quando pediu o resgate.
//
// holder_actor_id:
// identidade econômica/pseudônima usada pelo backend para
// localizar os dados privados de pagamento.
//
// settlement_hash:
// commitment/prova do settlement.
// NÃO contém PIX, conta bancária ou outros dados privados.
//
#[account]
#[derive(InitSpace)]
pub struct Redemption {
    pub series_id: [u8; 32],

    pub mint: Pubkey,

    pub holder_wallet: Pubkey,

    pub holder_actor_id: [u8; 32],

    pub status: u8,

    pub requested_at: i64,

    pub settled_at: i64,

    pub settlement_hash: [u8; 32],

    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Listing {
 pub series_id: [u8;32],
 pub mint: Pubkey,
 pub seller: Pubkey,
 pub price_lamports: u64,
 pub bump: u8,
}

// Permanent uniqueness per issuer and business credit identifier, including after settlement.
#[account]
#[derive(InitSpace)]
pub struct CreditLock {
    pub issuer: [u8;32],
    pub credit_id: [u8;32],
    pub terms_commitment: [u8;32],
    pub series_id: [u8;32],
    pub source_lot_id: [u8;32],
    pub bump: u8,
}
