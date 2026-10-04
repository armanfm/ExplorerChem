# ExploreChem

**Verifiable mineral provenance connected to transferable economic rights.**

ExploreChem is a multichain MVP for critical-mineral supply chains, initially focused on rare earths. It combines company identity, private industrial evidence, Chainlink CRE calculations, physical lot traceability on Ethereum Sepolia, and transferable economic rights represented by Solana Token-2022 on Devnet.

The physical lot and the economic right have separate lifecycles. Buying an RWA does not transfer the mineral or its custody. Selling or transforming the physical material does not automatically extinguish the issuer's existing economic obligation.

[Live application](https://armanfm.github.io/ExplorerChem/) · [Source repository](https://github.com/armanfm/ExplorerChem)

> Testnet MVP. Demonstration companies, documents and quantities are synthetic. Demonstration tokens do not create real commercial payment obligations. Mainnet use requires commercial, operational and security validation.

## Architecture

| **Component**              | **Responsibility**                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `ExploreChemActorRegistry` | Company identity, registration approval, controllers, authorized wallets and actor status                                |
| `ExploreChemProofRegistry` | Evidence commitments, independent MUF and Elemental states, authorized reports, proof history and coordination with Lots |
| `ExploreChemLots`          | Opaque lot identifiers, salted commitments, holder/state records, custody and parent/child relationships                 |
| MUF workflow               | Original-document integrity verification and deterministic total-mass accounting                                         |
| Elemental workflow         | MUF-result integrity verification, elemental calculations and proof-linked physical lot operations                       |
| Solana RWA program         | Economic series, one-unit Token-2022 issuance, duplicate-issuance controls, marketplace escrow and paid redemption/burn  |
| Supabase                   | Controlled evidence/result storage, lookup and application metadata                                                      |
| Frontend                   | Submission, private lot inspection, physical receiving and wallet-based economic operations                              |

### Why two chains?

Ethereum records the physical provenance layer. Solana records the economic instrument, its current token holder, offers and redemption lifecycle.

The Solana program does not run an Ethereum light client or independently read Ethereum state. Origin and lineage references are provided through the configured attestation flow. The attestor remains involved in issuance; it is not required to pay a redemption.

The design is not a token bridge. Using two networks does not itself provide atomic cross-chain execution, legal enforceability or market liquidity.

## Deployment references

Network configuration: Ethereum Sepolia for physical provenance and Solana Devnet for economic rights.

| **Network**                           | **Component**    | **Address**                                    |
| ------------------------------------- | ---------------- | ---------------------------------------------- |
| Ethereum Sepolia, chain ID `11155111` | ActorRegistry    | `0x2fb8a06A929299fEFCAfef63fCf663C0b07016F8`   |
| Ethereum Sepolia                      | ProofRegistry E1 | `0x1934305d8FC0a426a0eF5D475E941341d8c9fC1e`   |
| Ethereum Sepolia                      | Lots E1          | `0x92eFE5Cf48d9e18d2B66F1547D3E6D445b1774a3`   |
| Solana Devnet                         | RWA program      | `A2sUfkL18Znfo6A3u9mPHbMm1avm1A9J7NDpvwSTqT79` |

Verify `ProofRegistry.lotsContract()` and the reverse `Lots.registry()` link. Old lot-contract addresses must not be used for new E1 issuance.

Solana's `Config` records the permitted source chain and Lots address. Upgrading the program does **not** rewrite that account. `update_source_config` updates these references with the signature of the administrator stored in `Config`; it preserves the attestor and the source references of existing series. The frontend provides **Update E1 origin through Phantom** for this operation.

The program upgrade authority manages program upgrades. The administrator stored in `Config` manages application configuration. These roles may use different wallets.

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

## Transaction costs and optimizations

Issuance allocates multiple accounts: series, uniqueness records, mint records, issuer references, the Token-2022 mint and marketplace/token accounts. Their storage deposits are different from the network transaction fee. Public wallet estimates may combine these balance changes.

The frontend and optimized Rust implementation handle costs and RPC usage as follows:

- A compute limit based on simulated consumption, with a 20% margin plus 10,000 units and a 1,400,000-unit ceiling; the adjusted transaction is simulated again before signing.
- Batched catalogue reads, one RPC connection, serialized RPC requests, coalesced refreshes and a pause after HTTP 429.
- The optimized Rust implementation closes the empty source token account after listing or requesting redemption, once its unit has moved to escrow, and returns its storage deposit to the owner when the account has the default close authority.

Buy/cancel already close sale escrow and listing accounts. Settlement closes redemption escrow. Permanent origin, credit and lineage records are preserved; removing uniqueness records would undermine the controls.

Accounts with an explicit close authority are left open by the source-account optimization. Exact costs depend on the transaction, account sizes and wallet priority settings. Storage deposits refunded by account closure are distinct from network fees; Devnet SOL is test currency.

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
bun install
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

## Trust boundaries

- Industrial measurements and declarations depend on the companies and laboratories producing them.
- Authorized workflows, Config administration and issuance attestation are distinct roles.
- The current physical/economic linkage relies on correct attestation and lineage registration, not trustless cross-chain verification.
- Public metadata can reveal commercial relationships despite private quantities.
- Access control, key recovery, prototype capacity and real commercial terms need production validation.

## Use of AI tools

AI-assisted tools, including ChatGPT, Claude and Manus, supported implementation, debugging, tests, research, interface work, documentation and synthetic demonstration inputs. Armando Freire led architecture, technical decisions, integration, deployment and validation. AI-generated output is not an independent audit.

## Team

- **Armando Freire — Technical Lead:** architecture, Solidity contracts, Rust/Anchor program, Chainlink CRE workflows, integration, testing and technical documentation.
- **Jéssica — Product Lead:** product direction, requirements, refinement, documentation, positioning and presentation.
- **Adriana Tourinho — Technical & Business Mentor:** technical/business guidance, hands-on support, Solidity development, internal code review and Scrum coordination support.

## License

The repository includes an Apache-2.0 license. Some source files and package manifests carry different license identifiers; consult and reconcile those notices before a formal release.

