# ExploreChem

**Verifiable mineral provenance connected to transferable economic rights.**

ExploreChem is a multichain MVP for critical-mineral supply chains, initially focused on rare earths. It combines company identity, private industrial evidence, Chainlink CRE calculations, physical lot traceability on Ethereum Sepolia, and transferable economic rights represented by Solana Token-2022 on Devnet.

The physical lot and the economic right have separate lifecycles. Buying an RWA does not transfer the mineral or its custody. Selling or transforming the physical material does not automatically extinguish the issuer's existing economic obligation.

[Live application](https://armanfm.github.io/ExplorerChem/) · [Source repository](https://github.com/armanfm/ExplorerChem)

> Testnet MVP. Demonstration companies, documents and quantities are synthetic. Demonstration tokens do not create real commercial payment obligations. Mainnet use requires commercial, operational and security validation.

## Architecture

| Component | Responsibility |
|---|---|
| `ExploreChemActorRegistry` | Company identity, registration approval, controllers, authorized wallets and actor status |
| `ExploreChemProofRegistry` | Evidence commitments, independent MUF and Elemental states, authorized reports, proof history and coordination with Lots |
| `ExploreChemLots` | Opaque lot identifiers, salted commitments, holder/state records, custody and parent/child relationships |
| MUF workflow | Original-document integrity verification and deterministic total-mass accounting |
| Elemental workflow | MUF-result integrity verification, elemental calculations and proof-linked physical lot operations |
| Solana RWA program | Economic series, one-unit Token-2022 issuance, duplicate-issuance controls, marketplace escrow and paid redemption/burn |
| Supabase | Controlled evidence/result storage, lookup and application metadata |
| Frontend | Submission, private lot inspection, physical receiving and wallet-based economic operations |

### Why two chains?

Ethereum records the physical provenance layer. Solana records the economic instrument, its current token holder, offers and redemption lifecycle.

The Solana program does not run an Ethereum light client or independently read Ethereum state. Origin and lineage references are provided through the configured attestation flow. The attestor remains involved in issuance; it is not required to pay a redemption.

The design is not a token bridge. Using two networks does not itself provide atomic cross-chain execution, legal enforceability or market liquidity.

## Deployment references

References used in the October 4, 2026 demonstration:

| Network | Component | Address |
|---|---|---|
| Ethereum Sepolia, chain ID `11155111` | ActorRegistry | `0x2fb8a06A929299fEFCAfef63fCf663C0b07016F8` |
| Ethereum Sepolia | ProofRegistry E1 | `0x1934305d8FC0a426a0eF5D475E941341d8c9fC1e` |
| Ethereum Sepolia | Lots E1 | `0x92eFE5Cf48d9e18d2B66F1547D3E6D445b1774a3` |
| Solana Devnet | RWA program | `A2sUfkL18Znfo6A3u9mPHbMm1avm1A9J7NDpvwSTqT79` |

Verify `ProofRegistry.lotsContract()` and the reverse `Lots.registry()` link. Old lot-contract addresses must not be used for new E1 issuance.

Solana's `Config` records the permitted source chain and Lots address. Upgrading the program does **not** rewrite that account. `update_source_config` updates these references with the signature of the administrator stored in `Config`; it preserves the attestor and the source references of existing series. The frontend provides **Update E1 origin through Phantom** for this operation.

The program upgrade authority and the application Config administrator are separate roles. Deployment success and IDL publication do not prove that every frontend or repository file matches the deployed revision.

## Repository map

The following paths follow the project layout documented for this MVP:

| Path | Contents |
|---|---|
| `contracts/ExploreChemActorRegistry.sol` | Company identity contract |
| `contracts/ExploreChemProofRegistry.sol` | Evidence/proof registry |
| `contracts/ExploreChemLots.sol` | Commitment-based physical lots |
| `workflows/muf/muf-worflow/` | MUF workflow |
| `workflows/elemental/elemental-worflow/` | Elemental workflow |
| `solana/programs/explorechem-rwa-solana/src/` | Rust/Anchor RWA program |
| `solana/tests/` | TypeScript test sources |
| `solana/Anchor.toml` | Anchor configuration |
| `index.html` | Main application |

The spelling `worflow` follows the existing paths. Each CRE project has its own `project.yaml` in its parent directory. Newly prepared source packages must be synchronized with the repository and deployed before their behavior is treated as live.

## Evidence, MUF and Elemental

A company submits an original private JSON document. Its hash is anchored with the actor and submitter. Workflows retrieve the document and compare its hash with the on-chain commitment before using its contents.

MUF and Elemental are separate proofs for the same evidence:

| Proof | Code | Purpose |
|---|---:|---|
| MUF | `1` | Total-mass accounting |
| Elemental | `3` | Elemental accounting and associated lot operations |

| State | Code | Meaning |
|---|---:|---|
| NONE | `0` | No recorded state |
| PENDING | `1` | Awaiting the corresponding proof |
| CALCULATED | `2` | Supported calculation/checks succeeded |
| DIVERGENT | `3` | A supported divergence was detected |
| NOT_ATTESTED | `4` | Available inputs do not support the attestation |

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

Elemental checks the original evidence and committed private MUF result, reconciles the supported streams, and calculates elemental quantities from the declared assays and supported compound conversions. Demonstrations include Nd, Pr and Dy; the presence of a conversion in the implementation is not experimental validation of every process.

For transformations, the workflow resolves the referenced input lots and verifies their private openings against their public commitments. It rejects represented outputs exceeding input material or any tracked elemental quantity. Differences remain part of private accounting and do not become independently tradable lots unless represented by valid outputs.

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

| State | Meaning |
|---|---|
| NONE | Identifier not registered |
| ACTIVE | Available for supported operations, subject to current proofs |
| IN_ESCROW | Locked in a physical custody order |
| ENCUMBERED | Locked through the contract's collateral-agent mechanism |
| CONSUMED | Used by a transformation; unavailable for reuse |

Physical receipt requires the relevant recipient's acceptance/confirmation under the custody flow. The receiving interface exposes authorized private quantities so the recipient can inspect the lot. Expiry does not itself prove receipt or resolve a dispute.

The physical contract's encumbrance mechanism is distinct from the current RWA policy. **Issuing an economic right does not automatically require freezing the physical lot.** Selling, receiving or transforming the material can continue under the physical contract's own rules. An explicitly encumbered lot remains subject to that contract's restrictions.

### Integrity controls

| Control | Protection |
|---|---|
| Salted, domain-separated commitments | Detect modified openings and bind their source domain |
| Bound operation hashes | Link evidence, proofs, contract/network, operation, inputs and outputs |
| Duplicate-input rejection | Prevent the same input appearing twice in one operation |
| Used-operation/evidence tracking | Prevent replay and reuse for another issuance operation |
| Unique output IDs | Prevent replacing an existing lot |
| Whole-lot consumption | Prevent consumed inputs being used again |
| Current ancestry proofs | Require applicable current proofs throughout usable ancestry |
| Ethereum atomic execution | Anchor the Elemental proof and its physical operation together, or revert both |
| Integer arithmetic | Avoid floating-point mass accumulation |

Authorized workflows perform the private arithmetic. The contract does not recompute secret mass accounting. Commitments are not zero-knowledge proofs or evidence that a laboratory measurement is true.

The E1 report uses canonical encoding and chain/registry binding; the workflows expect registry version `3`. Documented prototype bounds are 32 inputs/outputs and 256 visited ancestry nodes. Source admission and physical verification remain necessary to detect material falsely introduced under unrelated initial identifiers.

## Privacy and access

| Information | Visibility |
|---|---|
| Actor IDs, controllers and authorized Ethereum wallets | Public |
| Evidence/proof hashes, states and events | Public |
| Lot IDs, commitments, holders and lineage | Public |
| Masses, elemental quantities, purity, inventory and detailed calculations | Restricted off-chain |
| Private openings, salts and original documents | Restricted off-chain |
| Solana mints, token balances, transfers, offers and SOL payments | Public |

The intended public elemental display is a **presence indicator**, such as “contains Nd, Pr and Dy”, without mass, percentage or purity. The numerical composition chart belongs in the authorized private company/physical receiving view, not the public RWA catalogue. Availability of public indicators must follow the implemented verified data source.

Public metadata can still reveal timing and business relationships. Previously published data cannot be made private retroactively. A hidden tab or an “access private” label is not authorization: storage policies and API responses must enforce the permitted scope. Do not publish openings or salts.

## RWA: economic rights, not delivery rights

Each series has a Token-2022 mint with **supply 1 and decimals 0**. The current holder owns the token-based economic right. A reference to a 1,000 kg lot does not create 1,000 tokens. Fractional ownership is not implemented.

The issuer remains the economic reference party after resale. The token does not transfer physical custody, does not grant mineral delivery through redemption, and does not make the secondary-market seller a replacement issuer.

### Lifecycle

| Operation | Behavior |
|---|---|
| Create series (`increment`) | Bind issuer, source lot, origin/claim commitments and credit/lineage controls |
| Mint (`mint_rwa`) | Issue the single Token-2022 unit; remove further mint authority |
| Transfer | Move the economic token without moving the physical material |
| List (`list_rwa`) | Choose a positive asking price and move the token into sale escrow |
| Buy (`buy_rwa`) | Pay the seller in native SOL and deliver the escrowed token atomically |
| Cancel (`cancel_listing`) | Return the same token to the seller and close sale escrow/listing accounts |
| Request (`request_redemption`) | Set a positive requested SOL amount and move the holder's token into redemption escrow |
| Update request (`update_redemption_quote`) | Allow the requesting holder to change the amount while pending |
| Pay and burn (`settle_and_burn`) | Pay the exact current requested amount to the registered holder and burn atomically |

A seller may set a resale price above or below an earlier price. This price does **not** determine redemption value. To change an active asking price, cancel and relist. `expected_price` protects buyers against an unexpected price change, and the program rejects buying one's own offer.

Requesting redemption does not immediately pay or burn. The token remains in escrow until a successful payment. There is no implemented automatic interest/inflation adjustment or automatic timeout refund.

### Payment without a wallet allowlist

The current payment design lets **any wallet other than the registered redemption holder** fund the pending redemption with its own native SOL. The payer signs to authorize its funds; no prior issuer-wallet permission or attestor signature is required for payment.

The contract still checks the pending request, active series, exact current requested amount, registered recipient, mint and escrow. The payer receives neither the token nor ownership of the mineral. Self-payment is rejected so a transfer to oneself cannot count as economic settlement.

Payment, token burn, escrow closure and finalization occur in one Solana transaction. Failure reverts the operation's state changes and transfers; network fees may still apply. A settlement hash accompanies the operation, but payment is executed in SOL rather than merely asserted as an off-chain payment.

The per-series `RedemptionAuthority` remains an identity/configuration account. `rotate_redemption_authority` allows the current and new principal wallets to co-sign a rotation; it does not impose a payment allowlist. Multiple-wallet delegation is not part of the current delivered flow.

The manually entered economic-terms field remains in the current frontend and contributes to a fixed-size claim commitment. Removing that field in favor of versioned standard terms is a discussed simplification, not an already completed change. Older rights retain their original commitments.

### Duplicate issuance and subdivision

A stable issuer-scoped credit lock and lineage reservations protect against duplicate issuance. For the **same issuer**, an active reservation rejects another economic issue on the same lot or a related ancestor/descendant. Sibling lots are not automatically overlapping under this rule.

Physical subdivision does not release the original economic reservation. The original RWA may continue to trade in the secondary market. A physical transfer to another company does not extinguish the original issuer's obligation.

Different issuers are distinct reservation scopes. This permits the intended separate-obligation model; it is not a global guarantee against every company creating rights referencing the same material. Correct issuer identity, source registration and attestation remain essential.

The prototype registry supports up to **64 lineage nodes and 32 reservations**. It does not discover unrelated Ethereum lots or off-platform obligations independently. Increasing capacity requires implementation work.

## Transaction costs and optimizations

Issuance allocates multiple accounts: series, uniqueness records, mint records, issuer references, the Token-2022 mint and marketplace/token accounts. Their storage deposits are different from the network transaction fee. Public wallet estimates may combine these balance changes.

Prepared optimizations include:

- A compute limit based on simulated consumption, with a 20% margin plus 10,000 units and a 1,400,000-unit ceiling; the adjusted transaction is simulated again before signing.
- Batched catalogue reads, one RPC connection, serialized RPC requests, coalesced refreshes and a pause after HTTP 429.
- In the optimized Rust package, closing the source token account after listing or requesting redemption, once its unit has moved to escrow, and returning the deposit to its owner when the account has the default close authority.

Buy/cancel already close sale escrow and listing accounts. Settlement closes redemption escrow. Permanent origin, credit and lineage records are preserved; removing uniqueness records would undermine the controls.

Publishing the HTML does not deploy the Rust optimizations. Confirm the relevant program build/upgrade before claiming reduced deposits. Accounts with an explicit close authority are left open by the source-account optimization. Exact costs depend on the actual transaction, account sizes and wallet priority settings; Devnet SOL is test currency.

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

The workflows use `handlerInTee`; simulation logs are visible and simulation is not production enclave execution. Respect production-equivalent chain-read limits rather than treating disabled simulator limits as a deployment fix.

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

`--arch v0` matches the binary architecture successfully used in the demonstrated toolchain. Review `Anchor.toml`; localnet defaults do not select the published Devnet program automatically.

Program upgrades, IDL updates and Config-origin updates are separate operations. The CLI wallet used for an upgrade may differ from the Phantom administrator of Config. Never commit keypair files.

The current account interfaces differ from the older redemption implementation. Legacy series without the required issuer-reference account, and pending legacy requests without a quote account, require an explicit migration before the current flow can use them. Publishing a new IDL does not create those missing accounts.

## Validation status

The demonstrated work includes the private physical workflow, lot transformation/receipt views, and creation/listing of an E1-linked RWA in the current UI. Local frontend checks cover instruction encoding, exact lamport parsing, third-party payment construction, signature collection and RPC throttling. These checks use mocks and are not on-chain end-to-end payment tests.

Before marking the economic cycle fully demonstrated, complete and record:

- Purchase from a different wallet.
- Secondary resale and purchase by another holder.
- Redemption request and requested-amount update.
- Full payment from a different payer, recipient balance verification and mint supply becoming zero.
- Failed/insufficient payment preserving the pending request and token.
- Duplicate same-issuer issuance and ancestor/descendant attempts being rejected.
- Physical subdivision/transfer preserving the existing economic reservation.
- Optimized program deployment and actual storage-deposit refunds.

Historical test counts must not be presented as validation of a later revision. Rust changes prepared during this update require compilation and Devnet verification with the project's real dependencies. An MVP demonstration is distinct from production readiness or an independent security audit.

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

