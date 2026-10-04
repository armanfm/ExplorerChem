# ExploreChem

**Verifiable mineral provenance connected to transferable economic rights.**

ExploreChem connects private industrial evidence, Chainlink CRE calculations, physical lot traceability on Ethereum Sepolia and transferable economic rights on Solana Devnet. It focuses initially on rare earths and supports company identity, mass and elemental accounting, lot transformation, physical receipt, RWA issuance, trading and paid redemption.

**Buying an RWA does not transfer the mineral or its custody.** The physical lot and the economic right have separate lifecycles: selling or transforming the material does not close the issuer's existing economic series.

Here, an **economic obligation** means the issuer identity and origin/terms commitments recorded for a series, together with the token holder's ability to request a SOL settlement. The program executes settlement when a payer signs and funds it. It does not automatically debit the issuer or enforce free-form commercial terms.

[Live application](https://armanfm.github.io/ExplorerChem/) · [Source repository](https://github.com/armanfm/ExplorerChem)

> Testnet MVP. Companies, documents and quantities used in examples are synthetic. Demonstration tokens do not create real commercial payment obligations. Any real commercial enforceability depends on agreements and validation outside the protocol.

**ExploreChem** is the product name. **ExplorerChem** is the existing GitHub repository and GitHub Pages path; the links above retain those actual paths.

## A short product walkthrough

Use Ethereum Sepolia and Solana Devnet. The economic example uses one issuer wallet and two buyer wallets with Devnet SOL, plus the configured attestor when it is a different signer.

| Step | Action | System behavior |
|---|---|---|
| 1. Evidence | Select the company and submit a private industrial JSON document | Anchor its hash and actor reference on Ethereum |
| 2. Accounting | Run MUF, then Elemental | Check document/result integrity, calculate balances and create proof-linked lot commitments |
| 3. Inspect | Select the lot in the authorized company view | Inspect private quantities and composition; public records contain commitments, holders, states and lineage |
| 4. Issue and list | Select company and source lot, enter terms and a 1 SOL asking price, and sign the required transactions | Register its ancestry, reserve issuer-scoped coverage, issue one Token-2022 unit and place it in sale escrow |
| 5. Buy | Connect a different wallet and buy the offer | Pay 1 SOL to the seller and receive the economic token atomically; physical custody remains separate |
| 6. Resell | Publish a 2 SOL offer and buy it from the third wallet | Transfer the same economic right; the original issuer stays associated with the series |
| 7. Request | The current holder requests 3 SOL redemption | Lock the token in redemption escrow and record the requested amount; no payment or burn occurs yet |
| 8. Settle | The issuer, or another eligible payer, signs and funds the current 3 SOL request | Pay the recorded holder, burn the unit, close redemption escrow and finalize the series atomically |

The 1, 2 and 3 SOL values illustrate separate sale, resale and requested redemption amounts. Secondary prices do not determine redemption value.

**Before requesting redemption:** the token is removed from circulation while the request is pending. The current program has no redemption-cancellation instruction or automatic timeout return. If nobody pays, the token remains in escrow for an indefinite period; the holder can update the requested amount but cannot resell the locked unit. Cancelling a marketplace offer is a separate operation that returns its sale-escrow token.

## Architecture

| Component | Responsibility |
|---|---|
| ActorRegistry on Ethereum | Company identity, approved registration, controllers and authorized Ethereum wallets |
| ProofRegistry on Ethereum | Evidence commitments, MUF/Elemental states, authorized reports and proof history |
| Lots on Ethereum | Lot commitments, holders, custody states and declared parent/child lineage |
| Chainlink CRE workflows | Integrity checks, total-mass accounting and elemental calculations using private evidence |
| Solana RWA program | Issuer-linked economic series, Token-2022 issuance, overlap controls, marketplace escrow and paid redemption/burn |
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

- Payment uses the payer's own native SOL. Any wallet other than the registered redemption holder can fund it without a payment allowlist or attestor signature. The payer receives no token or mineral ownership.

- Payment, burn, escrow closure, final status and release of the active lineage reservation occur atomically. A failed payment preserves the pending request and escrowed unit; transaction fees may still apply.

- For the same issuer, an active reservation blocks another issue on the same lot or a registered ancestor/descendant. Subdivision preserves that reservation. Reselling the existing RWA remains allowed while it is outside redemption escrow.

- Different issuers have separate reservation scopes. Selling the physical lot to another company does not settle the original issuer's series.

- Redemption does not require the physical lot to remain in the issuer's custody. It settles the economic series rather than delivering the mineral.

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

## Example evidence JSON

This synthetic INITIAL example admits **150 kg dry material containing 12 kg Nd, 4.5 kg Pr and 3 kg Dy**. The elemental quantities are part of the 150 kg. Accounted input and output are equal, so MUF is zero; no previous lot is consumed.

Send it through the private evidence submission flow for the Serra Clara demonstration actor, then run MUF followed by Elemental. To repeat with a new lot, use new operation/output IDs and fresh salts. Existing committed input openings must remain unchanged for TRANSFORM operations.

<details>
<summary>View the complete 150 kg evidence JSON</summary>

```json
{
  "schema": "ExploreChem/PrivateEvidence/E1/demo",
  "lotReference": "README-E1-INITIAL-150KG-ND-PR-DY",
  "actorId": "0x2fd9c7823fedcace0fc3060ad815182bde855c9cf88c4cb832c82af37e064f7c",
  "description": "Synthetic documentation fixture: 150 kg dry material, Nd 8%, Pr 3%, Dy 2%. Independent initial lot; no real material or previous lot is consumed.",
  "massBalance": {"inputMassKg": "150", "openingInventoryMassKg": "0", "outputMassKg": "150", "scrapMassKg": "0", "otherOutputMassKg": "0", "closingInventoryMassKg": "0"},
  "calculationContext": {"trackedElements": ["Nd", "Pr", "Dy"]},
  "streams": [
    {"streamId": "ENTRADA-ND-PR-DY-001", "streamType": "INPUT", "measuredMassKg": "150", "massBasis": "DRY", "assays": [{"element": "Nd", "basis": "ELEMENT_PCT", "value": "8"}, {"element": "Pr", "basis": "ELEMENT_PCT", "value": "3"}, {"element": "Dy", "basis": "ELEMENT_PCT", "value": "2"}]},
    {"streamId": "CONFERENCIA-ND-PR-DY-001", "streamType": "PRODUCT", "measuredMassKg": "150", "massBasis": "DRY", "assays": [{"element": "Nd", "basis": "ELEMENT_PCT", "value": "8"}, {"element": "Pr", "basis": "ELEMENT_PCT", "value": "3"}, {"element": "Dy", "basis": "ELEMENT_PCT", "value": "2"}]}
  ],
  "e1": {
    "mode": "INITIAL",
    "operationId": "0xef260bb53c4560ec25c569f6905208b1759a182060747eda7495f88a6485cf5d",
    "proofSalt": "0xc11be24279c35b339130aeef301af19dcea15b9bb22ce98b9ccb879ebb771451",
    "inputs": [],
    "outputs": [
      {
        "streamId": "ENTRADA-ND-PR-DY-001",
        "recipient": "0x2fd9c7823fedcace0fc3060ad815182bde855c9cf88c4cb832c82af37e064f7c",
        "opening": {
          "lotId": "0x9eeb9827922aee547e0065180d3f496a321ce0e9e964def95fb7b3d12cf66a27",
          "materialMassMg": "150000000",
          "elements": [
            {"basisHash": "0x26840443a8398c0f3b91d87605ba114623f577fdb3e8e66f3537348e4766e742", "massMg": "4500000"},
            {"basisHash": "0x8fe013d1a12762e66efaf560989b1fa4d67febb24546576a60f445fc83016dbc", "massMg": "12000000"},
            {"basisHash": "0xe29a0102a484995a40c96a4555e78b37cf211bbe179f49bd32dcb805a09bd02b", "massMg": "3000000"}
          ],
          "salt": "0xc56d143b9bcd52cb5bd3954390db2660aedb2d9c766a31cb0624537b70c4428a"
        }
      }
    ]
  },
  "evidenceType": "OWN_STOCK",
  "actorType": "OTHER"
}
```

</details>

`massBalance` gives total quantities in kilograms. `streams` and `assays` describe the measured material and elemental percentages. The `e1` section supplies the operation, recipient and private lot opening; its mass quantities use integer milligrams as strings. In INITIAL, the created lot references the admitted input stream; the PRODUCT stream completes the matching output accounting.

The remaining 130.5 kg has no specified elemental composition in this fixture. The displayed salts are public synthetic examples; use fresh private salts for confidential evidence.

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

Run MUF before Elemental. Add `--broadcast` to submit reports to the configured testnet. MUF and Elemental integrate with Chainlink CRE through `handlerInTee` for confidential processing; these commands invoke the simulator, whose logs are for debugging.

See [Configuration and operations](docs/operations.md) for dependencies, contract wiring, source updates and the Solana build flow.

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

- **Jéssica — Product Lead:** product direction, requirements, refinement, documentation, positioning and presentation.

- **Adriana Tourinho — Technical & Business Mentor:** technical/business guidance, hands-on support, Solidity development, internal code review and Scrum coordination support.

## License

ExploreChem is licensed under **Apache License 2.0**. See the repository's [LICENSE](https://github.com/armanfm/ExplorerChem/blob/main/LICENSE) for the full terms. Third-party dependencies retain their own licenses and attribution notices.


