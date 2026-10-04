use anchor_lang::prelude::*;

#[error_code]
pub enum ExploreChemRwaError {
    #[msg("Trusted attestor invalido")]
    InvalidAttestor,

    #[msg("Configuracao de origem invalida")]
    InvalidSource,

    #[msg("Programa pausado")]
    ProgramPaused,

    #[msg("Attestor nao autorizado")]
    UnauthorizedAttestor,

    #[msg("Versao de attestation nao suportada")]
    UnsupportedAttestationVersion,

    #[msg("Attestation expirada")]
    AttestationExpired,

    #[msg("Source chain incorreta")]
    WrongSourceChain,

    #[msg("Contrato ExploreChemLots incorreto")]
    WrongSourceContract,

    #[msg("Series ID nao pode ser zero")]
    ZeroSeriesId,

    #[msg("Issuer Actor ID nao pode ser zero")]
    ZeroIssuerActorId,

    #[msg("Origin commitment nao pode ser zero")]
    ZeroOriginCommitment,

    #[msg("Claim commitment nao pode ser zero")]
    ZeroClaimCommitment,

    // Mantém a numeração dos erros existentes; não usado.
    #[msg("Codigo reservado por compatibilidade")]
    ReservedLegacyCode,

    #[msg("Series nao esta economicamente ativa")]
    SeriesNotActive,

    #[msg("Holder Actor ID nao pode ser zero")]
    ZeroHolderActorId,

    #[msg("Settlement hash nao pode ser zero")]
    ZeroSettlementHash,

    #[msg("Status de redemption invalido")]
    InvalidRedemptionStatus,

    #[msg("Saldo do RWA deve ser exatamente 1")]
    InvalidTokenBalance,

    #[msg("Mint nao pertence a esta Series")]
    WrongMint,

    #[msg("Redemption nao pertence a esta Series")]
    WrongRedemptionSeries,

    #[msg("Holder informado nao corresponde ao pedido de redemption")]
    WrongRedemptionHolder,

    #[msg("Attestor nao autorizado")] Unauthorized,
    #[msg("Linhagem nao inicializada/migrada")] NotReady,
    #[msg("Lote invalido, pais ausentes ou linhagem inconsistente")] Invalid,
    #[msg("Limite de 64 lotes ou 32 reservas ativas atingido; emissao bloqueada")] Capacity,
    #[msg("Emissor ja possui RWA ativo neste lote, ancestral ou descendente")] Overlap,
    #[msg("Serie sem reserva de cobertura")] Unreserved,
    #[msg("Mercado pausado ou serie inativa")] Inactive,
    #[msg("Preco invalido ou alterado")] Price,
    #[msg("Comprador nao pode ser vendedor")] SelfPurchase,
    #[msg("Valor de resgate deve ser maior que zero")]
    InvalidRedemptionAmount,
    #[msg("Carteira pagadora nao pode ser a carteira beneficiaria")]
    SelfRedemptionPayment,
    #[msg("Somente a carteira registrada da emissora pode aceitar o resgate")]
    UnauthorizedRedemptionIssuer,
    #[msg("Valor proposto mudou; revise antes de aceitar")]
    RedemptionAmountChanged,
    #[msg("Nova carteira deve ser diferente da carteira atual")]
    SameRedemptionWallet,
}
