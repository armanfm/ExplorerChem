# ExploreChem

**Private quantities, public encumbrance and settlement: verifiable rare-earth provenance as collateral for export financing.**

ExploreChem lets a rare-earth producer prove where a lot came from and how its mass was accounted for, without revealing volumes, grades or capacity to competitors, and then use that verified lot as collateral for export financing. Private industrial evidence is processed by Chainlink CRE (Chainlink Runtime Environment) workflows; Ethereum Sepolia records lot commitments, custody states and lineage; Solana Devnet records an issuer-linked economic right (RWA, Real World Asset) that a financier funds and the issuer settles.

**Buying an RWA does not transfer the mineral or its custody.** The physical lot and the economic right have separate lifecycles. In the application flow, issuing an RWA also encumbers the source lot on Ethereum (`ENCUMBERED`, set through the collateral-agent role): while encumbered, the lot cannot be sold, sent to another company or transformed. The lot returns to `ACTIVE` only after the series is settled or the issuance is cancelled. On the Solana side, the economic series stays bound to its original issuer regardless of later physical transfers.

Here, an **economic obligation** means the issuer identity and origin/terms commitments recorded for a series, together with the token holder's ability to request a SOL settlement. In the intended use, the holder is the financier and the settlement is the issuer's repayment. The program executes settlement when a payer signs and funds it. It does not automatically debit the issuer or enforce free-form commercial terms.

[Pitch video](https://youtu.be/HURDA09KyJc) · [Technical demo](https://youtu.be/gpj7f8joUoE) · [Live application](https://armanfm.github.io/ExplorerChem/) · [Source repository](https://github.com/armanfm/ExplorerChem)

> Testnet MVP. Companies, documents and quantities used in examples are synthetic. Demonstration tokens do not create real commercial payment obligations and are not offered to the public. Any real commercial enforceability depends on agreements and validation outside the protocol.

**ExploreChem** is the product name. **ExplorerChem** is the existing GitHub repository and GitHub Pages path; the links above retain those actual paths.

## Problem and who pays

Traceability in critical-mineral chains is held back by cost, limited interoperability and commercial confidentiality, a diagnosis set out in the IEA/OECD (International Energy Agency / Organisation for Economic Co-operation and Development) April 2026 report on traceability in critical mineral supply chains. The problem is sharpest in the midstream, where lots are mixed and aggregated: competitors must prove mass conservation to each other without disclosing volumes, prices or installed capacity.

In the EU, the Critical Raw Materials Act (Regulation (EU) 2024/1252, Articles 28–30) sets labelling, recycled-content and environmental-footprint requirements for permanent magnets; their detailed rules depend on implementing and delegated acts. The ESPR (Ecodesign for Sustainable Products Regulation, Regulation (EU) 2024/1781) provides the Digital Product Passport infrastructure.

Traceability today pays through market access and risk management, not through a price premium. ExploreChem turns verified provenance into a financing input:

- **The financier pays:** a verified, encumbered lot reduces due-diligence cost and double-pledging risk.
- **The producer gains:** faster, cheaper export credit without depending on a price premium.
- **Initial focus: Brazil.** Brazil holds the world's second-largest rare-earth reserves but supplies under 1% of global output; ionic-clay mining has been in operation since 2024.

## Demonstration flow

The technical demo follows these steps on Ethereum Sepolia and Solana Devnet. It uses an issuer (producer) wallet, a financier wallet and a third wallet that exercises transfer mechanics, plus the configured attestor when it is a different signer.

| Step | Action | System behavior |
|---|---|---|
| 1. Evidence | The producer submits a private industrial JSON document | Anchor its hash and actor reference on Ethereum |
| 2. Accounting | Run MUF, then Elemental | Check document/result integrity, calculate balances and create proof-linked lot commitments |
| 3. Inspect | Select the lot in the authorized company view | Inspect private quantities and composition; public records contain only commitments, holders, states and lineage |
| 4. Issue | The producer selects the source lot, enters financing terms and a 1 SOL amount, and signs | Register ancestry, reserve issuer-scoped coverage so the same lot cannot back another issue, issue one Token-2022 unit and place it in escrow |
| 5. Fund | The financier wallet takes the offer | Pay 1 SOL to the producer and receive the economic right atomically; physical custody remains separate |
| 6. Transfer (testnet mechanics) | The right is offered at 2 SOL and taken by a third wallet | Show that the right moves while the original issuer stays bound to the series; see the transfer-restriction note below |
| 7. Request settlement | The current holder requests 3 SOL | Lock the token in redemption escrow and record the requested amount; no payment or burn occurs yet |
| 8. Settle | The producer, or another eligible payer, funds the 3 SOL request | Pay the holder, burn the unit, close escrow, finalize the series and release the coverage reservation atomically |

The 1, 2 and 3 SOL values illustrate separate funding, transfer and settlement amounts. Transfer prices do not determine settlement value.

**Transfer restriction (roadmap).** The current Devnet program allows any wallet to take a listed offer, so step 6 demonstrates transfer mechanics only. The target design is not an open marketplace: transfers are restricted to enabled financing parties, with price and terms kept off-chain and only their hash on-chain.

**Before requesting redemption:** the token is removed from circulation while the request is pending. The current program has no redemption-cancellation instruction or automatic timeout return. If nobody pays, the token remains in escrow for an indefinite period; the holder can update the requested amount but cannot resell the locked unit. Cancelling a marketplace offer is a separate operation that returns its sale-escrow token.

## Architecture

| Component | Responsibility |
|---|---|
| ActorRegistry on Ethereum | Company identity, approved registration, controllers and authorized Ethereum wallets |
| ProofRegistry on Ethereum | Evidence commitments, MUF/Elemental states, authorized reports and proof history |
| Lots on Ethereum | Lot commitments, holders, custody states and declared parent/child lineage |
| Chainlink CRE workflows | Integrity checks, total-mass accounting and elemental calculations using private evidence |
| Solana RWA program | Issuer-linked economic series, Token-2022 issuance, coverage-reservation (anti-double-pledge) controls, transfer escrow and paid settlement/burn |
| Private storage and frontend | Controlled evidence/results, authorized lot inspection and wallet-based operations |

Ethereum records **commitments, custody states and declared physical lineage**. Solana records the economic instrument, token transfers, offers and SOL settlements. The design uses separate physical and economic state machines; it is not a token bridge.

MUF calculates the material balance. Elemental calculates tracked elemental quantities and checks transformations against referenced inputs. E1 is the current physical-lot model: public commitments bind private quantities and salts. Detailed calculations and commitment rules are in [Physical model](docs/physical-model.md).

## Attestation: what crosses the chain boundary

The authorized signer is the wallet stored in `Config.trusted_attestor`. It authorizes lineage registration, series creation and minting. The issuing wallet also signs series creation. The attestor is not required for marketplace purchases or redemption payments.

The frontend queries the selected lot and its ancestors on Ethereum. It checks the source contract, holder and permitted state against finalized/latest snapshots, prepares origin and terms commitments, and registers ancestors before descendants on Solana. The Solana program checks the configured attestor's signature, allowed source, version/expiry, uniqueness accounts and registered lineage reservations.

**Solana does not independently query Ethereum.** Correct source and lineage registration depend on the authorized attestor. A missing source node or submitted parent is rejected; ancestry conflicting with the existing registration is rejected. An Ethereum parent relationship omitted from an attestor-authorized registration cannot be discovered by the Solana program itself.

See [Attestation responsibilities and lineage rules](docs/economic-model.md#attestation-between-ethereum-and-solana) for the exact checks and registration flow.

## Economic rules

- Each series issues one indivisible Token-2022 unit with decimals 0. Supply is 1 after mint and 0 after paid redemption and burn.
- A buyer receives the economic right. The original issuer remains associated with it after secondary resale or physical transfer.
- A seller sets the sale price. The current holder proposes the redemption amount and can edit it while pending. The payer accepts it by signing a transaction paying exactly the current quote.
- Settlement uses the payer's own native SOL. Any wallet other than the registered redemption holder can fund it without a payment allowlist or attestor signature. The payer receives no token or mineral ownership. The program also exposes an experimental USDT purchase instruction (`buy_rwa_usdt`) that is not part of the demonstration flow.
- Payment, burn, escrow closure, final status and release of the active lineage reservation occur atomically. A failed payment preserves the pending request and escrowed unit; transaction fees may still apply.
- For the same issuer, an active reservation blocks another issue on the same lot or a registered ancestor/descendant. Subdivision preserves that reservation. Reselling the existing RWA remains allowed while it is outside redemption escrow.
- Two independent controls prevent double use of a lot: the Solana coverage reservation (no second issue on the same lot or its lineage) and the Ethereum encumbrance (no sale, custody transfer or transformation while the RWA is outstanding).
- Different issuers have separate reservation scopes. Once a lot is released, selling it to another company does not settle the original issuer's series.
- Redemption settles the economic series rather than delivering the mineral. After settlement, the collateral agent releases the Ethereum lot back to `ACTIVE`.
- The release decision relies on the collateral-agent key; the Ethereum contract cannot verify Solana settlement by itself (see [SECURITY.md](SECURITY.md), finding F-10).


The requesting holder's quote is separate from the entered terms text and from past sale prices. There is no automatic inflation index or automatic debit. A request alone does not burn the token.

### Economic terms and verification

The issuer enters terms at issuance. The frontend records the exact terms JSON string in its local browser catalogue; where available, it appears under **Condições de resgate**. Solana stores the terms commitment rather than the full text.

To verify supplied terms, SHA-256 is recomputed from the domain `ExploreChem/CreditTerms/v1`, issuer actor bytes, credit ID bytes and the exact UTF-8 terms string, then compared with the on-chain series' `claim_commitment`. Reformatting the original JSON can change the hash.

The issuer must retain and provide the original content. On-chain discovery alone cannot recover it, and the local browser catalogue is not a shared terms repository. The program does not parse free-form terms into executable payment conditions. [Recovery and exact verification procedure](docs/economic-model.md#recovering-and-verifying-economic-terms).

## Networks and contracts

| Network | Component | Address |
|---|---|---|
| Ethereum Sepolia, chain ID `11155111` | ActorRegistry | `0x2fb8a06A929299fEFCAfef63fCf663C0b07016F8` |
| Ethereum Sepolia | ProofRegistry E1 | `0x1934305d8FC0a426a0eF5D475E941341d8c9fC1e` |
| Ethereum Sepolia | Lots E1 | `0x92eFE5Cf48d9e18d2B66F1547D3E6D445b1774a3` |
| Solana Devnet | RWA program | `A2sUfkL18Znfo6A3u9mPHbMm1avm1A9J7NDpvwSTqT79` |

Solana `Config` specifies the permitted source chain and Lots address. The Config administrator can update that origin through the frontend's Phantom operation. Program upgrades, IDL publication and Config changes are separate operations; existing series retain their original source references.

## Quick start

From the repository root, serve the frontend locally:

```bash
python3 -m http.server 8000 --bind 127.0.0.1
```

Open `http://127.0.0.1:8000/` with the required wallets. Use Ethereum Sepolia for physical operations and Phantom on Solana Devnet for economic operations. Private evidence resources and contract authorizations must be configured for document processing.

Run the workflows from the repository root:

```bash
(cd workflows/muf && cre workflow simulate ./muf-worflow --target staging-settings)
(cd workflows/elemental && cre workflow simulate ./elemental-worflow --target staging-settings)
```

Run MUF before Elemental. Add `--broadcast` to submit reports to the configured testnet. MUF and Elemental integrate with Chainlink CRE through `handlerInTee` for confidential processing (this submission runs them in the CRE simulator); these commands invoke the simulator, whose logs are for debugging.

See [Configuration and operations](docs/operations.md) for dependencies, contract wiring, source updates and the Solana build flow.
Synthetic industrial JSON examples for use with the MUF and Elemental workflows are available in [exemples/](exemples/).

## Privacy, costs and operating boundaries

- Masses, elemental quantities, purity, detailed results, openings and salts remain in controlled off-chain storage. Authorized private views expose composition; the public catalogue does not expose numerical composition. Public presence indicators, when displayed, identify elements without quantities.
- Public actor IDs, commitments, lineage, wallet activity and SOL payments can reveal timing and relationships. Storage/API authorization determines access to private content.
- Issuance creates accounts with storage deposits in addition to transaction fees. Closing eligible empty accounts refunds their deposits. The frontend adjusts compute limits from simulation and batches catalogue reads; [cost and RPC behavior](docs/economic-model.md#transaction-costs-and-optimizations) describes the details.
- Lineage protection covers registered relationships and issuer identities. The registry holds up to 64 nodes and 32 reservations. Ethereum lot operations have their own state and proof requirements.
- Measurements depend on their producers, and origin transfer depends on attestation. Commitments bind data; they do not independently certify laboratory measurements or provide zero-knowledge proofs.

## Documentation

| Document | Contents |
|---|---|
| [Physical model](docs/physical-model.md) | Terminology, evidence/proof states, balances, private openings, lot states and integrity controls |
| [Economic model](docs/economic-model.md) | Attestation, lineage, prices, escrow, payment/burn, terms recovery and commitment encoding |
| [Operations](docs/operations.md) | Repository paths, dependencies, CRE configuration, E1 wiring, Solana builds and migration considerations |

## Use of AI tools

AI-assisted tools, including ChatGPT, Claude and Manus, supported implementation, debugging, research, interface work, documentation and synthetic inputs. Armando Freire led architecture, technical decisions, integration, deployment and validation.

## Team

- **Armando Freire — Technical Lead:** architecture, Solidity contracts, Rust/Anchor program, Chainlink CRE workflows, integration, testing and technical documentation.
- **Jéssica Chagas — Product Lead:** product direction, requirements, refinement, documentation, positioning and presentation.
- **Adriana Tourinho — Security & Privacy Lead:** threat model, Solidity review, internal security review and Solidity development.

## License

The repository includes an Apache-2.0 license. Some source files and package manifests carry different license identifiers; consult and reconcile those notices before a formal release.
