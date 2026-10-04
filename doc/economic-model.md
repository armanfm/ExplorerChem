# Economic rights, attestation and settlement

[Back to README](../README.md)

## Attestation between Ethereum and Solana

The attestor is the Solana signer stored in `Config.trusted_attestor`. Its signature authorizes lineage management, series creation and RWA minting. The issuing wallet also signs series creation. If these roles use the same wallet, one signature satisfies the matching signer requirements; if they use different wallets, the required signatures must all be collected.

The frontend prepares the Ethereum references; the Solana program checks the authorized signature and its own account constraints. Their responsibilities are distinct:

| Layer | Checks and actions |
|---|---|
| Frontend Ethereum lookup | Checks the selected Lots address; reads the selected lot in finalized and latest blocks; requires the selected actor to be its holder and its state to be ACTIVE, IN_ESCROW or ENCUMBERED; traverses parent references from the finalized snapshot; checks block hashes for changes during the lookup |
| Frontend commitment preparation | Binds the source chain, Lots contract, issuer actor, lot ID and lot commitment into the origin hash; forms the issuer-scoped credit ID and the economic-terms commitment |
| Attestor signature | Authorizes the submitted issuer/origin data and parent relationships for use on Solana; requires the authorized signer to check their correctness |
| Solana series creation | Checks the configured attestor, source chain and Lots address, attestation version and expiry, nonzero identifiers and commitments, uniqueness accounts, and an available lineage reservation |
| Solana mint | Requires the configured attestor, an active series and its registered reservation; issues one unit and removes further mint authority |

**Solana does not independently read Ethereum or verify Ethereum consensus.** Its trust boundary is the configured attestor's authorization of the submitted references. An authorized signature does not itself perform a laboratory analysis or prove that real-world measurements are true.

### Registering and preserving lineage

The frontend walks the selected lot's Ethereum parents and registers ancestors before their descendants on Solana. New descendants are added through `register_lineage_lot`, signed by the attestor. An existing node must retain the same registered ancestry; conflicting ancestry is rejected. Same-issuer overlap checks then use the registered ancestor relationships.

If the source lot is absent from the Solana registry, reservation fails. If a submitted parent is absent, its registration fails. If the frontend finds a disagreement between the registered Solana ancestry and the Ethereum snapshot, issuance stops.

If the attestor authorizes an incomplete relationship as though a descendant were an unrelated root, the Solana program cannot discover the missing Ethereum parent by itself. Correct and complete registration is therefore necessary for the subdivision protection. The frontend supplies the ancestor chain before issuing against a descendant.

The registry holds up to 64 lot nodes and 32 active reservations. Existing active series must be accounted for before enabling a migrated lineage registry; they are not silently discarded.

The attestor does **not** approve secondary purchases or redemption payments. A different wallet can fund redemption under the payment rules below.

## Economic lifecycle

Each series issues **one Token-2022 unit with decimals 0**. The unit represents the entire economic right for that series. A reference to a 1,000 kg lot does not create 1,000 tokens. The mint supply is 1 after issuance and 0 after a completed redemption and burn. Fractional ownership is not implemented.

The issuing company is the reference party for the economic obligation recorded for the series. A buyer acquires that economic right; a later buyer acquires the same right through resale. The original issuer remains the reference party even if the physical lot changes company, is sold or is transformed.

Redemption settles the economic right through a SOL payment. It does not deliver minerals or transfer physical custody. The secondary-market seller does not replace the original issuer.

### Prices, terms and payment acceptance

The system keeps three concepts separate:

| Value | Who sets it | What it controls |
|---|---|---|
| Sale price | The seller publishing an offer | The amount a buyer pays for that offer |
| Requested redemption amount | The current holder requesting redemption | The exact amount required to settle the pending request |
| Economic terms | The issuer supplies the terms associated with the series | A fixed-size commitment identifying the recorded terms |

The requested redemption amount is a proposal. **Submitting it does not debit the issuer's wallet or force a payment.** The payer accepts the current amount by signing the payment transaction with its own funds. There is no separate administrative approval transaction for payment.

The holder can request a higher or lower amount, including a negotiated adjustment for inflation, and can update it while the request remains pending. The program requires a positive amount expressed in integer lamports; it does not derive the amount from a sale price, automatically index it for inflation, or cap it at a previous purchase price. The payer cannot overwrite the holder's quote: settlement must match the current quote exactly.

For example, an RWA sold for 1 SOL may later trade for 2 SOL, while its holder requests redemption for 3 SOL. These are separate values. No payment or burn occurs until a payer signs and successfully pays the requested 3 SOL. If the holder changes the quote before settlement executes, a transaction using the old amount is rejected.

The economic-terms field contributes to a commitment; the program does not interpret its free-form text as executable payment rules. The on-chain payment follows the pending redemption quote.

### Lifecycle

| **Operation**                              | **Behavior**                                                                           |
| ------------------------------------------ | -------------------------------------------------------------------------------------- |
| Create series (`increment`)                | Bind issuer, source lot, origin/claim commitments and credit/lineage controls          |
| Mint (`mint_rwa`)                          | Issue the single Token-2022 unit; remove further mint authority                        |
| Transfer                                   | Move the economic token without moving the physical material                           |
| List (`list_rwa`)                          | Choose a positive asking price and move the token into sale escrow                     |
| Buy (`buy_rwa`)                            | Pay the seller in native SOL and deliver the escrowed token atomically                 |
| Cancel (`cancel_listing`)                  | Return the same token to the seller and close sale escrow/listing accounts             |
| Request (`request_redemption`)             | Set a positive requested SOL amount and move the holder's token into redemption escrow |
| Update request (`update_redemption_quote`) | Allow the requesting holder to change the amount while pending                         |
| Pay and burn (`settle_and_burn`)           | Pay the exact current requested amount to the registered holder and burn atomically    |

A seller may set a resale price above or below an earlier price. This price does **not** determine redemption value. To change an active asking price, cancel and relist. `expected_price` protects buyers against an unexpected price change, and the program rejects buying one's own offer.

Requesting redemption moves the token into redemption escrow and records the requesting holder as the payment recipient. **The request itself neither pays nor burns the token.** While pending, the token is unavailable for transfer or secondary sale.

If the issuer chooses not to pay, or a payer lacks sufficient funds, the request remains pending and the token remains in escrow. The holder can update the requested amount. The current program has no instruction for cancelling a redemption request or returning its token, and no automatic timeout refund.

**Cancelling a marketplace listing is a different operation:** `cancel_listing` returns the sale-escrow token to the seller. It does not cancel a redemption request. Rejecting a wallet signature before a transaction is broadcast does not create the proposed listing or request.

### Payment without a wallet allowlist

The issuing company can pay using a different wallet without registering it in a payment allowlist. **Any wallet other than the registered redemption holder** can fund the pending redemption with its own native SOL. A successful third-party payment settles the same series; it does not create a new issuer or transfer the economic right to the payer. The payer signs to authorize its own funds; no attestor signature, Config administrator signature or separate issuer-wallet approval is required for this payment.

The contract still checks the pending request, active series, exact current requested amount, registered recipient, mint and escrow. The payer receives neither the token nor ownership of the mineral. Self-payment is rejected so a transfer to oneself cannot count as economic settlement.

Payment to the registered holder, burn of the escrowed unit, redemption-escrow closure, finalization of the series and release of its active lineage reservation occur in one Solana transaction. Successful settlement leaves the mint supply at zero. If payment or any later instruction fails, the operation's transfers and state changes revert together; network fees may still apply. A settlement hash accompanies the operation, and the payment is executed in native SOL.

The per-series `RedemptionAuthority` remains an identity/configuration account. `rotate_redemption_authority` allows the current and new principal wallets to co-sign a rotation; it does not impose a payment allowlist. Payment from another wallet requires only that payer's signature and funds, subject to the redemption checks above.

The frontend includes an economic-terms field used to form the fixed-size claim commitment. Existing rights retain their recorded commitments.

### Duplicate issuance and subdivision

A stable issuer-scoped credit lock prevents reuse of the same credit identifier. A lineage reservation records the active economic coverage associated with a series. For the **same issuer**, an active reservation rejects another economic issue on the same lot or a related ancestor/descendant. Sibling lots are not automatically overlapping under this rule. These checks use the source lots and parent/child relationships registered in Solana through the attestation flow.

For example, if an issuer creates an RWA on lot A and then splits A into B and C, the original RWA remains active. Registering B and C as descendants of A preserves the overlap check: the same issuer cannot create another active economic issue on A, B or C while A's reservation remains active. The original token may still be resold; reselling it does not create a second series.

Physical subdivision, marketplace cancellation and physical transfer do not release the reservation. Successful paid redemption releases that series' active lineage reservation, while the permanent credit lock and history remain. Release does not reactivate a consumed physical lot or permit reuse of the same credit identifier.

A physical transfer to another company does not extinguish the original issuer's economic obligation, and payment does not require the physical lot to remain in that issuer's custody.

Different issuers are distinct reservation scopes. This permits the intended separate-obligation model; it is not a global guarantee against every company creating rights referencing the same material. Correct issuer identity, source registration and attestation remain essential.

The lineage registry supports up to **64 nodes and 32 reservations**. Its overlap checks operate on registered lot relationships and issuer identities; external obligations and unregistered lots are outside that registry.

## Recovering and verifying economic terms

The issuance form's text is wrapped in a JSON string with schema `ExploreChem/EconomicRight/E1/v2`. That string includes the issuer actor and wallet, source chain and contract, source lot and lot commitment, the entered terms, and the physical/economic separation flags.

After issuance, the frontend stores that exact `creditTerms` string with `creditId`, `termsCommitment`, `seriesId` and the mint in its local browser catalogue. Where those metadata are available, the marketplace presents them under **Condições de resgate**.

**The full terms are not stored in the Solana series account.** The account stores their `claim_commitment`. A wallet loading only on-chain series data, or a browser without the catalogue metadata, cannot recover the original text from the hash. The issuer must retain and provide the exact original terms to the buyer. The local catalogue is not a shared, durable terms repository.

The frontend also contains `rwaDownloadCreditTerms`, which prepares an `ExploreChem/CreditTermsReceipt/v1` JSON receipt. That helper is not wired to a visible download button in the current issuance flow; it must not be confused with an available user-facing export action.

To verify supplied terms:

1. Identify the series on Solana and read its `issuer_actor_id` and `claim_commitment`.
2. Read the series' credit-lock record and obtain its `credit_id`; check that it references that series and issuer.
3. Obtain the exact original `creditTerms` string from the issuer or retained catalogue metadata. Preserve its bytes: parsing and reformatting the JSON can change the hash.
4. Concatenate UTF-8 bytes of `ExploreChem/CreditTerms/v1`, the 32 raw bytes of the issuer actor ID, the 32 raw bytes of the credit ID, and UTF-8 bytes of the exact terms string, in that order, with no inserted separators.
5. Compute SHA-256 and compare it with the series' `claim_commitment`. The catalogue's `termsCommitment` is a convenience reference; the on-chain series is the comparison target.

This verifies integrity of the supplied text. The program does not execute the free-form terms as payment conditions: settlement follows the holder's current redemption quote.

## Commitment encoding

The frontend derives these identifiers using SHA-256 over the ordered raw byte concatenations below:

| Identifier | Ordered input |
|---|---|
| Origin commitment | UTF-8 `ExploreChem/RWAOrigin/E1/v2`, source chain ID as little-endian u64, 20 raw bytes of the Lots address, 32 raw bytes of issuer actor ID, 32 raw bytes of lot ID, 32 raw bytes of lot commitment |
| Credit ID | UTF-8 `ExploreChem/CreditId/v1`, then UTF-8 of the stable credit reference |
| Series ID | UTF-8 `ExploreChem/CreditSeries/v2`, 32 raw bytes of issuer actor ID, 32 raw bytes of credit ID |
| Terms commitment | UTF-8 `ExploreChem/CreditTerms/v1`, 32 raw bytes of issuer actor ID, 32 raw bytes of credit ID, then the exact UTF-8 terms string |

The stable credit reference joins `ExploreChem/IssuerLot/v1`, the decimal source chain ID, the lowercase Lots address, the lowercase issuer actor ID and lowercase lot ID using colons. Changing terms does not change this stable credit reference and does not bypass the existing issuer/lot credit lock.

## Transaction costs and optimizations

Issuance allocates multiple accounts: series, uniqueness records, mint records, issuer references, the Token-2022 mint and marketplace/token accounts. Their storage deposits are different from the network transaction fee. Public wallet estimates may combine these balance changes.

The frontend and optimized Rust implementation handle costs and RPC usage as follows:

- A compute limit based on simulated consumption, with a 20% margin plus 10,000 units and a 1,400,000-unit ceiling; the adjusted transaction is simulated again before signing.
- Batched catalogue reads, one RPC connection, serialized RPC requests, coalesced refreshes and a pause after HTTP 429.
- The optimized Rust implementation closes the empty source token account after listing or requesting redemption, once its unit has moved to escrow, and returns its storage deposit to the owner when the account has the default close authority.

Buy/cancel already close sale escrow and listing accounts. Settlement closes redemption escrow. Permanent origin, credit and lineage records are preserved; removing uniqueness records would undermine the controls.

Accounts with an explicit close authority are left open by the source-account optimization. Exact costs depend on the transaction, account sizes and wallet priority settings. Storage deposits refunded by account closure are distinct from network fees; Devnet SOL is test currency.
