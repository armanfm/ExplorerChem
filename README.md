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

MUF calculates the material balance. Elemental calculates tracked elemental quantities and checks transformations against referenced inputs. E1 is the current physical-lot model: public commitments bind private quantities and salts. Detailed calculations and commitment rules are described below in Evidence, MUF and Elemental and E1: private physical accounting.

## Networks and contracts

| Network | Component | Address |
|---|---|---|
| Ethereum Sepolia, chain ID `11155111` | ActorRegistry | `0x2fb8a06A929299fEFCAfef63fCf663C0b07016F8` |
| Ethereum Sepolia | ProofRegistry E1 | `0x1934305d8FC0a426a0eF5D475E941341d8c9fC1e` |
| Ethereum Sepolia | Lots E1 | `0x92eFE5Cf48d9e18d2B66F1547D3E6D445b1774a3` |
| Solana Devnet | RWA program | `A2sUfkL18Znfo6A3u9mPHbMm1avm1A9J7NDpvwSTqT79` |

Solana `Config` specifies the permitted source chain and Lots address. The Config administrator can update that origin through the frontend's Phantom operation. Program upgrades, IDL publication and Config changes are separate operations; existing series retain their original source references.

## Key terms

- **E1:** the current physical-lot model, which stores public commitments and lineage while keeping quantities and commitment openings private.
- **MUF (Material Unaccounted For):** the difference between accounted material inputs and outputs, including inventory changes.
- **Opening:** the private quantities and salt needed to verify a lot against its public commitment.
- **Lineage:** the parent/child relationships between lots created by physical transformations.
- **Lineage reservation:** an issuer-scoped record that prevents overlapping active economic issuance on a lot and its ancestors or descendants.
- **Series:** the economic instrument associated with an issuer and a source lot, represented by a single indivisible RWA token.

## Evidence, MUF and Elemental

A company submits an original private JSON document. Its hash is anchored with the actor and submitter. Workflows retrieve the document and compare its hash with the on-chain commitment before using its contents.

MUF and Elemental are separate proofs for the same evidence:

| **Proof** | **Code** | **Purpose**                                        |
| --------- | -------- | -------------------------------------------------- |
| MUF       | `1`      | Total-mass accounting                              |
| Elemental | `3`      | Elemental accounting and associated lot operations |

| **State**    | **Code** | **Meaning**                                     |
| ------------ | -------- | ----------------------------------------------- |
| NONE         | `0`      | No recorded state                               |
| PENDING      | `1`      | Awaiting the corresponding proof                |
| CALCULATED   | `2`      | Supported calculation/checks succeeded          |
| DIVERGENT    | `3`      | A supported divergence was detected             |
| NOT_ATTESTED | `4`      | Available inputs do not support the attestation |

Interpret each status together with its proof type, methodology and reason codes. `CALCULATED` is not a universal certification of a measurement or company.

### Total-mass accounting

For supported non-carrier documents:

```text
MUF = input + opening inventory
    - product - scrap - other outputs - closing inventory
```

For supported carrier documents:

```text
difference = collected mass - delivered mass
```

Decimal kilogram inputs are converted to integer milligrams. Results include operands, signed/absolute differences and relative differences when calculable. A valid calculation does not by itself establish an industrial tolerance or explain the physical cause of a difference.

### Elemental accounting

Elemental checks the original evidence and committed private MUF result, reconciles the supported streams, and calculates elemental quantities from the declared assays and supported compound conversions. The supported elemental calculations include Nd, Pr and Dy, according to the declared assays and conversion rules used by the workflow.

For transformations, the workflow resolves the specific input lot references supplied by the document and verifies their private openings against their public commitments. Each lot is accounted for through its own identifier and opening; other lots are not added to the operation unless explicitly referenced. It rejects represented outputs exceeding input material or any tracked elemental quantity. Differences remain part of private accounting and do not become independently tradable lots unless represented by valid outputs.

Detailed results remain in controlled storage:

```text
muf-results/{evidenceId-without-0x}/{proofId-without-0x}.json
elemental-results/{evidenceId-without-0x}/{proofId-without-0x}.json
```

Those braces describe storage-key structure; they are not deployment commands.

## E1: private physical accounting

E1 lots use opaque `bytes32` identifiers. Ethereum records commitments, actor holders, proof/operation references, timestamps, states and lineage. Physical masses, elemental quantities and commitment openings are not public kilogram balances.

Private operations carry input/output openings and secret salts. An opening binds the lot identifier, material mass in integer milligrams, sorted elemental basis hashes/quantities and salt.

- **INITIAL:** creates initial outputs from supported validated streams, assigned to the evidence actor.
- **TRANSFORM:** verifies existing input openings, holders and usable states, consumes complete inputs and creates new product, residue or retained-material lots.

Example: a private calculation can represent `100 kg → 60 kg product + 39 kg residue + 1 kg difference`. The chain records resulting commitments and lineage, not those figures. Evidence is needed to establish whether a difference represents processing loss, measurement error or another cause.

### Physical states

| **State**  | **Meaning**                                                   |
| ---------- | ------------------------------------------------------------- |
| NONE       | Identifier not registered                                     |
| ACTIVE     | Available for supported operations, subject to current proofs |
| IN_ESCROW  | Locked in a physical custody order                            |
| ENCUMBERED | Locked through the contract's collateral-agent mechanism      |
| CONSUMED   | Used by a transformation; unavailable for reuse               |

Physical receipt requires the relevant recipient's acceptance/confirmation under the custody flow. The receiving interface exposes authorized private quantities so the recipient can inspect the lot. Expiry does not itself prove receipt or resolve a dispute.

The physical contract's encumbrance mechanism is distinct from the current RWA policy. **Issuing an economic right does not automatically require freezing the physical lot.** Selling, receiving or transforming the material can continue under the physical contract's own rules. An explicitly encumbered lot remains subject to that contract's restrictions.

### Integrity controls

| **Control**                          | **Protection**                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------ |
| Salted, domain-separated commitments | Detect modified openings and bind their source domain                          |
| Bound operation hashes               | Link evidence, proofs, contract/network, operation, inputs and outputs         |
| Duplicate-input rejection            | Prevent the same input appearing twice in one operation                        |
| Used-operation/evidence tracking     | Prevent replay and reuse of evidence for another physical lot operation                        |
| Unique output IDs                    | Prevent replacing an existing lot                                              |
| Whole-lot consumption                | Prevent consumed inputs being used again                                       |
| Current ancestry proofs              | Require applicable current proofs throughout usable ancestry                   |
| Ethereum atomic execution            | Anchor the Elemental proof and its physical operation together, or revert both |
| Integer arithmetic                   | Avoid floating-point mass accumulation                                         |

Authorized workflows perform the private arithmetic. The contract does not recompute secret mass accounting. Commitments are not zero-knowledge proofs or evidence that a laboratory measurement is true.

The E1 report uses canonical encoding and chain/registry binding; the workflows expect registry version `3`. Documented prototype bounds are 32 inputs/outputs and 256 visited ancestry nodes. Source admission and physical verification remain necessary to detect material falsely introduced under unrelated initial identifiers.

## Privacy and access

| **Information**                                                           | **Visibility**       |
| ------------------------------------------------------------------------- | -------------------- |
| Actor IDs, controllers and authorized Ethereum wallets                    | Public               |
| Evidence/proof hashes, states and events                                  | Public               |
| Lot IDs, commitments, holders and lineage                                 | Public               |
| Masses, elemental quantities, purity, inventory and detailed calculations | Restricted off-chain |
| Private openings, salts and original documents                            | Restricted off-chain |
| Solana mints, token balances, transfers, offers and SOL payments          | Public               |

Detailed quantities and the composition chart are available in the authorized private company/physical receiving view. The public RWA catalogue does not expose those numerical results. An elemental presence indicator, when displayed, identifies elements such as Nd, Pr and Dy without publishing mass, percentage or purity.

Public metadata can still reveal timing and business relationships. Previously published data cannot be made private retroactively. A hidden tab or an “access private” label is not authorization: storage policies and API responses must enforce the permitted scope. Do not publish openings or salts.

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

## RWA: economic rights, not delivery rights

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

## Toolchain and dependencies

Repository configuration was checked against commit [`dfcb1d9e863ab3a7d1bfb7b14ae093fdb4b199bc`](https://github.com/armanfm/ExplorerChem/commit/dfcb1d9e863ab3a7d1bfb7b14ae093fdb4b199bc). This is the reference for the manifests and licensing inventory below; it is not a statement that a deployment was built from that commit.

| Tool or dependency | Version or declared requirement | Source |
|---|---|---|
| Anchor CLI | `1.2.0` | `solana/Anchor.toml` and local CLI output |
| Rust | `1.89.0`, edition `2021` | `solana/rust-toolchain.toml` and workspace manifest |
| Solana/Agave CLI | `3.1.10` | Local CLI output used during Devnet deployment |
| CRE CLI | `1.29.0` | Captured workflow simulation output |
| `anchor-lang` / `anchor-spl` | `1.2.0` | Solana program manifest |
| `@anchor-lang/core` | `1.2.0` | Solana JavaScript manifest |
| `@solana/web3.js` | `1.99.0` | Solana JavaScript manifest |
| `@solana/spl-token` | `0.4.15` | Solana JavaScript manifest |
| TypeScript, workflows | `5.9.3` | Both workflow manifests |
| TypeScript, Solana tests | `6.0.3` | Solana JavaScript manifest |
| CRE SDK | `^1.18.0` | Both workflow manifests; resolved dependencies follow `bun.lock` |
| `viem` | `^2.56.3` | Both workflow manifests; resolved dependencies follow `bun.lock` |
| Bun | Used for workflow dependencies; no exact CLI version is pinned | Workflow `bun.lock` files |
| Yarn | Selected for the Anchor project; no exact CLI version is pinned | `solana/Anchor.toml` and `solana/yarn.lock` |

Do not replace reported or manifest versions with guessed versions. Record the installed tools before reproducing a run:

```bash
node --version
bun --version
yarn --version
rustc --version
cargo --version
anchor --version
solana --version
cre --version
```

Install workflow dependencies in each workflow directory using `bun install --frozen-lockfile`. Install the Solana project's JavaScript dependencies from `solana/` using its `yarn.lock`. The Solana build uses `anchor build --arch v0`.

## Minimum configuration

The two `config.staging.json` files use the following required non-secret settings for the existing testnet environment:

```json
{
  "supabaseUrl": "https://mnmflnqmohgsxgavwenn.supabase.co",
  "secretNamespace": "main",
  "chainSelectorName": "ethereum-testnet-sepolia",
  "contractAddress": "0x1934305d8FC0a426a0eF5D475E941341d8c9fC1e",
  "gasLimit": "3000000"
}
```

These are actual public configuration references, not access credentials. Access to private evidence still requires the project's authorized setup. The Supabase URL does not grant another reader access to the project.

| Requirement | Configuration |
|---|---|
| Ethereum RPC | `https://ethereum-sepolia-rpc.publicnode.com` under `ethereum-testnet-sepolia` in each CRE `project.yaml` |
| CRE target | `staging-settings`, with `workflow-path: ./main.ts`, `config-path: ./config.staging.json` and `secrets-path: ../secrets.yaml` |
| Workflow secret | Provision `SUPABASE_SERVICE_ROLE_KEY` through CRE's local secret configuration in namespace `main`; keep the value outside public files and HTML |
| Company lookup | `explorerchem_actors` records linking the UUID, on-chain `actor_id` and `actor_type` |
| Evidence lookup | `explorerchem_evidences` records linking evidence ID, actor UUID, hash/algorithm, bucket/path and MIME type |
| Private storage | `explorechem-evidence`, with authorized access to original documents and MUF/Elemental result paths |
| Contract binding | `ProofRegistry.lotsContract()` must point to the listed E1 Lots contract, whose `registry()` points back |
| Workflow authorization | Configure the expected MUF/Elemental workflow IDs and report forwarders on the registry |
| Solana | Use `https://api.devnet.solana.com` and program `A2sUfkL18Znfo6A3u9mPHbMm1avm1A9J7NDpvwSTqT79` |
| Solana source | Config source chain `11155111` and Lots `0x92eFE5Cf48d9e18d2B66F1547D3E6D445b1774a3`, plus the configured attestor |

The workflow can optionally restrict the block interval through `onchainFromBlock` and `onchainToBlock`, and the candidate offset through `onchainCandidateOffset`. Elemental can restrict operation type through `tokenActionMode`. Omit that field when the same workflow should accept the JSON's supported INITIAL or TRANSFORM mode.

The checked `Anchor.toml` defaults to **localnet** with a local wallet path. That configuration runs local development; it does not switch to Devnet merely because the program ID is the same. Select Devnet explicitly for deployment and economic operations.

## Synthetic E1 evidence example

This complete fixture defines an independent initial lot of **150 kg dry material containing 12 kg Nd, 4.5 kg Pr and 3 kg Dy**. The elemental masses are contained within the 150 kg; they are not additional material mass. The total-mass balance is zero, and the remaining 130.5 kg has no specified elemental composition in this example.

The actor ID is the Serra Clara demonstration actor already used by the application. The INITIAL output is tied to the input stream because INITIAL represents admitted material; the PRODUCT stream provides the matching accounting output. No existing physical lot is consumed.

```json
{
  "schema": "ExploreChem/PrivateEvidence/E1/demo",
  "lotReference": "README-E1-INITIAL-150KG-ND-PR-DY",
  "actorId": "0x2fd9c7823fedcace0fc3060ad815182bde855c9cf88c4cb832c82af37e064f7c",
  "description": "Synthetic documentation fixture: 150 kg dry material, Nd 8%, Pr 3%, Dy 2%. Independent initial lot; no real material or previous lot is consumed.",
  "massBalance": {
    "inputMassKg": "150",
    "openingInventoryMassKg": "0",
    "outputMassKg": "150",
    "scrapMassKg": "0",
    "otherOutputMassKg": "0",
    "closingInventoryMassKg": "0"
  },
  "calculationContext": {
    "trackedElements": [
      "Nd",
      "Pr",
      "Dy"
    ]
  },
  "streams": [
    {
      "streamId": "ENTRADA-ND-PR-DY-001",
      "streamType": "INPUT",
      "measuredMassKg": "150",
      "massBasis": "DRY",
      "assays": [
        {
          "element": "Nd",
          "basis": "ELEMENT_PCT",
          "value": "8"
        },
        {
          "element": "Pr",
          "basis": "ELEMENT_PCT",
          "value": "3"
        },
        {
          "element": "Dy",
          "basis": "ELEMENT_PCT",
          "value": "2"
        }
      ]
    },
    {
      "streamId": "CONFERENCIA-ND-PR-DY-001",
      "streamType": "PRODUCT",
      "measuredMassKg": "150",
      "massBasis": "DRY",
      "assays": [
        {
          "element": "Nd",
          "basis": "ELEMENT_PCT",
          "value": "8"
        },
        {
          "element": "Pr",
          "basis": "ELEMENT_PCT",
          "value": "3"
        },
        {
          "element": "Dy",
          "basis": "ELEMENT_PCT",
          "value": "2"
        }
      ]
    }
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
            {
              "basisHash": "0x26840443a8398c0f3b91d87605ba114623f577fdb3e8e66f3537348e4766e742",
              "massMg": "4500000"
            },
            {
              "basisHash": "0x8fe013d1a12762e66efaf560989b1fa4d67febb24546576a60f445fc83016dbc",
              "massMg": "12000000"
            },
            {
              "basisHash": "0xe29a0102a484995a40c96a4555e78b37cf211bbe179f49bd32dcb805a09bd02b",
              "massMg": "3000000"
            }
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

Submit the example through the private evidence flow for that actor, then run MUF followed by Elemental. The node and operation IDs must be unused. This is one fixed synthetic fixture: reusing it after successful processing is not a way to create a second lot. For a fresh live submission, generate new operation/output IDs and salts; never regenerate openings for already committed input lots.

The salts above are deliberately public synthetic data. Do not use them for private real-world evidence.

## Verification commands and recorded results

This section records commands, checks and execution evidence. It is separate from the functional description above.

### Reproduce the E1 example and conservation checks

From the repository root, with this README installed as `README.md`:

```bash
cd workflows/elemental/elemental-worflow
bun install --frozen-lockfile
node <<'JS'
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const ts = require('typescript');
const { keccak256, toHex } = require('viem');
const readme = fs.readFileSync('../../../README.md', 'utf8');
const example = readme.match(/## Synthetic E1 evidence example[\s\S]*?```json\n([\s\S]*?)\n```/);
assert(example, 'Synthetic JSON block missing');
const doc = JSON.parse(example[1]);
const filename = path.resolve('e1.ts');
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;
const loaded = new Module(filename, module);
loaded.filename = filename;
loaded.paths = Module._nodeModulePaths(process.cwd());
loaded._compile(compiled, filename);
const { buildOperation, lotCommitment } = loaded.exports;
const chainId = 11155111n;
const lots = '0x92eFE5Cf48d9e18d2B66F1547D3E6D445b1774a3';
const holder = doc.actorId;
const hex = () => '0x' + crypto.randomBytes(32).toString('hex');
const elementAmounts = new Map([['Nd', 12000000n], ['Pr', 4500000n], ['Dy', 3000000n]].map(
  ([symbol, amount]) => [keccak256(toHex(`ExploreChem/Element/${symbol}/dry/mg/v1`)), amount]
));
const opening = doc.e1.outputs[0].opening;
const elements = opening.elements.map(e => ({ basisHash: e.basisHash, massMg: BigInt(e.massMg) }));
for (const e of elements) assert.equal(e.massMg, elementAmounts.get(e.basisHash));
const initial = buildOperation({ spec: doc.e1, holder, chainId, lots, context: null,
  available: [{ streamId: doc.e1.outputs[0].streamId, materialMassMg: 150000000n, elements }],
  accounted: [] });
assert.equal(initial.op.kind, 1);
assert.equal(initial.op.outputs.length, 1);
assert.equal(initial.difference, null);
console.log('PASS initial: 150 kg; Nd 12 kg; Pr 4.5 kg; Dy 3 kg');
const child = (streamId, massMg) => ({ streamId, recipient: holder, opening: {
  lotId: hex(), salt: hex(), materialMassMg: String(massMg),
  elements: elements.map(e => ({ basisHash: e.basisHash, massMg: String(e.massMg * massMg / 150000000n) }))
}});
const spec = { mode: 'TRANSFORM', operationId: hex(), proofSalt: hex(), inputs: [opening],
  outputs: [child('PRODUCT-90KG', 90000000n), child('RESIDUE-59KG', 59000000n)] };
const parsedOpening = { ...opening, materialMassMg: BigInt(opening.materialMassMg), elements };
const context = { inputLotIds: [opening.lotId], inputCommitments: [lotCommitment(chainId, lots, parsedOpening)],
  holders: [holder], states: [1] };
const available = [{ streamId: 'INPUT-150KG', sourceLotId: opening.lotId, materialMassMg: 150000000n, elements }];
const accounted = spec.outputs.map(o => ({ streamId: o.streamId,
  materialMassMg: BigInt(o.opening.materialMassMg),
  elements: o.opening.elements.map(e => ({ basisHash: e.basisHash, massMg: BigInt(e.massMg) })) }));
const args = { spec, holder, chainId, lots, context, available, accounted };
const result = buildOperation(args);
assert.equal(result.difference.materialMassMg, '1000000');
for (const e of result.difference.elements) assert.equal(BigInt(e.massMg), elementAmounts.get(e.basisHash) / 150n);
console.log('PASS transform: 150 kg -> 90 kg + 59 kg + 1 kg difference');
const wrongContext = { ...context, inputCommitments: [hex()] };
assert.throws(() => buildOperation({ ...args, context: wrongContext }), /COMMITMENT_MISMATCH/);
console.log('PASS modified input commitment rejected');
const tooMuch = { ...spec, outputs: [child('EXCESS', 151000000n)] };
const tooMuchStreams = tooMuch.outputs.map(o => ({ streamId: o.streamId,
  materialMassMg: BigInt(o.opening.materialMassMg),
  elements: o.opening.elements.map(e => ({ basisHash: e.basisHash, massMg: BigInt(e.massMg) })) }));
assert.throws(() => buildOperation({ ...args, spec: tooMuch, accounted: tooMuchStreams }), /SUPPLY_EXCEEDED/);
console.log('PASS outputs above available material rejected');
JS
```

The command reads the fixture directly from this README, compiles the existing `e1.ts` helper in memory and calls it without submitting transactions. It checks a valid initial lot, a valid transformation with a 1 kg difference, a tampered input commitment and an output exceeding the input.

Recorded output from this verification:

```text
PASS initial: 150 kg; Nd 12 kg; Pr 4.5 kg; Dy 3 kg
PASS transform: 150 kg -> 90 kg + 59 kg + 1 kg difference
PASS modified input commitment rejected
PASS outputs above available material rejected
```

Exit code: `0`. Execution environment: Node `v24.19.0`, TypeScript `5.9.3` and `viem` `2.56.3`, using the referenced repository's E1 helper. These are local accounting/integrity checks; no live chain or private-storage credentials are used.

### Workflow and Solana checks

From the repository root, workflow typechecking is invoked with:

```bash
(cd workflows/muf/muf-worflow && bun run typecheck)
(cd workflows/elemental/elemental-worflow && bun run typecheck)
```

The checked repository contains `main.test.ts` files copied from the original greeting template. Those files expect `Hello world!` and the old trigger exports; they are not the current MUF/Elemental accounting checks and must not be reported as passing coverage of those workflows. Their references also need to match the current exports for a whole-project typecheck to pass. The executable E1 check above uses the current helper directly.

The Rust library check and the configured Anchor test command are:

```bash
cd solana
cargo test -p explorechem-rwa-solana --lib
anchor test
```

`anchor test` uses the localnet configuration and the `tests/test_stage3.ts` command in `Anchor.toml`. The checked Stage 3 suite contains the previous Lots address and redemption interface, so it should not be treated as coverage of the updated E1/payment interface without aligning those fixtures. The Rust library command checks its own test target; it is not equivalent to the full wallet-to-wallet economic cycle.

### Captured execution evidence

| Operation | Recorded result | Reference |
|---|---|---|
| MUF simulation with broadcast | `CALCULATED`, matching document hashes and `confirmedMufStatus: 2` | Evidence `0x800e9a5b369ebb91fad6f22a44fe00c6827d4b30787c38ff13519bf3054ba4b2`; [Sepolia transaction](https://sepolia.etherscan.io/tx/0x079a09b5851fa1f2fa1aec2f29e122d8f54216eafaea47fdfde908f81fad15c0) |
| Solana program upgrade | CLI returned the program ID and transaction signature | [Devnet transaction](https://explorer.solana.com/tx/RQ68xEits1jkFwyp2qgiCBeY2ZtbqCJoUtAUZVsScRfVZhQTd9okT2Tc8trtEFCXLnxwq71jpo8cdjzzVxrwRUc?cluster=devnet) |
| IDL upgrade | `Operation executed successfully` and `IDL upgraded` | Metadata account `75LkLS8ZqLAb2wsZHQcjzqG96g64FtUXExnwdwiZZVyM` |
| Issuance/listing simulation | RegisterLineageLot, Increment, MintRwa and ListRwa instructions returned success | Wallet signature was rejected in the captured run; simulation success does not mean that run was broadcast |

The transaction references above come from the captured command outputs. A program upgrade receipt identifies that upgrade; it does not identify every later source edit or prove a later full redemption cycle.

## Setup

### Frontend and Ethereum

Serve the HTML over localhost or HTTPS for Phantom integration. Configure Ethereum Sepolia, the contract set above, Solana Devnet and the required private-storage resources.

Do not include wallet secrets, service-role keys or private storage credentials in public HTML. Provision storage access policies separately.

For a simple local preview from the repository root:

```bash
python3 -m http.server 8000 --bind 127.0.0.1
```

Open `http://127.0.0.1:8000/` in a browser with the required wallets.

### CRE workflows

```bash
cd workflows/muf/muf-worflow
bun install --frozen-lockfile
bun run typecheck
```

Perform the equivalent dependency installation and typecheck in `workflows/elemental/elemental-worflow/`. Provision local secrets and mappings; the workflows request `SUPABASE_SERVICE_ROLE_KEY`. Do not commit `.env` or `secrets.yaml`.

From the repository root:

```bash
(cd workflows/muf && cre workflow simulate ./muf-worflow --target staging-settings)
(cd workflows/elemental && cre workflow simulate ./elemental-worflow --target staging-settings)
```

Add `--broadcast` to submit reports to the configured testnet after checking configuration. Run MUF before Elemental. Workflow IDs, forwarders and configured project names must match their on-chain authorizations.

The MUF and Elemental workflows integrate with Chainlink CRE through `handlerInTee` for confidential processing. The commands above run the workflows in the CRE simulator; logs shown by the simulator are for debugging. Respect the chain-read limits configured for the target environment.

### E1 contract wiring

1. Retain the existing ActorRegistry when deploying the ProofRegistry.
2. Deploy Lots with the correct ProofRegistry reference.
3. Configure the one-time ProofRegistry-to-Lots binding and verify the reverse link.
4. Configure MUF/Elemental forwarders and expected workflow IDs.
5. Point both workflows to the current ProofRegistry and check version `3`.
6. Submit fresh E1 evidence with complete private openings; run MUF, then Elemental.
7. Update Solana Config's source references with its administrator where necessary.

Do not regenerate an existing committed input opening during transformation.

### Solana

Keep the existing project dependency/toolchain versions that compile together. From the repository's Anchor project:

```bash
cd solana
yarn install
anchor build --arch v0
```

`--arch v0` selects the binary architecture used by this project's deployment toolchain. Review `Anchor.toml`; localnet defaults do not select the published Devnet program automatically.

Program upgrades, IDL updates and Config-origin updates are separate operations. The CLI wallet used for an upgrade may differ from the Phantom administrator of Config. Never commit keypair files.

The current account interfaces differ from the older redemption implementation. Legacy series without the required issuer-reference account, and pending legacy requests without a quote account, require an explicit migration before the current flow can use them. Publishing a new IDL does not create those missing accounts.

## Repository map

Project layout:

| **Path**                                      | **Contents**                   |
| --------------------------------------------- | ------------------------------ |
| `contracts/ExploreChemActorRegistry.sol`      | Company identity contract      |
| `contracts/ExploreChemProofRegistry.sol`      | Evidence/proof registry        |
| `contracts/ExploreChemLots.sol`               | Commitment-based physical lots |
| `workflows/muf/muf-worflow/`                  | MUF workflow                   |
| `workflows/elemental/elemental-worflow/`      | Elemental workflow             |
| `solana/programs/explorechem-rwa-solana/src/` | Rust/Anchor RWA program        |
| `solana/tests/`                               | TypeScript test sources        |
| `solana/Anchor.toml`                          | Anchor configuration           |
| `index.html`                                  | Main application               |

The spelling `worflow` follows the existing paths. Each CRE project has its own `project.yaml` in its parent directory.

## Trust boundaries

- Industrial measurements and declarations depend on the companies and laboratories producing them.
- Authorized workflows, Config administration and issuance attestation are distinct roles.
- The current physical/economic linkage relies on correct attestation and lineage registration, not trustless cross-chain verification.
- Public metadata can reveal commercial relationships despite private quantities.
- Access control, key recovery, prototype capacity and real commercial terms need production validation.

## Use of AI tools

AI-assisted tools, including ChatGPT, Claude and Manus, supported implementation, debugging, research, interface work, documentation and synthetic inputs. Armando Freire led architecture, technical decisions, integration, deployment and validation.

## Team

- **Armando Freire — Technical Lead:** architecture, Solidity contracts, Rust/Anchor program, Chainlink CRE workflows, integration, testing and technical documentation.
- **Jéssica — Product Lead:** product direction, requirements, refinement, documentation, positioning and presentation.
- **Adriana Tourinho — Technical & Business Mentor:** technical/business guidance, hands-on support, Solidity development, internal code review and Scrum coordination support.

## License

ExploreChem is licensed under **Apache License 2.0**. See the repository's [LICENSE](https://github.com/armanfm/ExplorerChem/blob/main/LICENSE) for the full terms. Third-party dependencies retain their own licenses and attribution notices.

### Align source and package identifiers

The project's Apache-2.0 license is the intended license for its own source. Some checked files retain earlier template/source declarations: MIT in the three Solidity headers and UNLICENSED in the two CRE package manifests. The Rust workspace/program manifests lack an explicit license field.

The following command aligns those first-party metadata with the existing Apache-2.0 license. Run it from the repository root. It checks all affected files before writing and does not alter executable logic, dependencies or third-party notices.

```bash
python3 <<'PYLICENSE'
import json
from pathlib import Path

root = Path.cwd()
license_text = (root / 'LICENSE').read_text()
assert 'Apache License' in license_text and 'Version 2.0' in license_text
changes = {}
contracts = [
    'contracts/ExploreChemActorRegistry.sol',
    'contracts/ExploreChemProofRegistry.sol',
    'contracts/ExploreChemLots.sol',
]
for name in contracts:
    path = root / name
    content = path.read_text()
    old = '// SPDX-License-Identifier: MIT'
    new = '// SPDX-License-Identifier: Apache-2.0'
    assert content.startswith(old) or content.startswith(new), name
    changes[path] = content.replace(old, new, 1)

for name in [
    'workflows/muf/muf-worflow/package.json',
    'workflows/elemental/elemental-worflow/package.json',
]:
    path = root / name
    package = json.loads(path.read_text())
    assert package.get('license') in ['UNLICENSED', 'Apache-2.0'], name
    package['license'] = 'Apache-2.0'
    changes[path] = json.dumps(package, indent=2) + '\n'

workspace = root / 'solana/Cargo.toml'
content = workspace.read_text()
if 'license = "Apache-2.0"' not in content:
    marker = 'rust-version = "1.89.0"'
    assert content.count(marker) == 1
    content = content.replace(marker, marker + '\nlicense = "Apache-2.0"', 1)
changes[workspace] = content

program = root / 'solana/programs/explorechem-rwa-solana/Cargo.toml'
content = program.read_text()
if 'license.workspace = true' not in content:
    marker = 'rust-version.workspace = true'
    assert content.count(marker) == 1
    content = content.replace(marker, marker + '\nlicense.workspace = true', 1)
changes[program] = content

for path, content in changes.items():
    path.write_text(content)
    print('Apache-2.0:', path.relative_to(root))
PYLICENSE
```

These metadata changes take effect in the repository when the command is applied and committed. Changing source-license metadata does not require redeploying the program or changing application state.

