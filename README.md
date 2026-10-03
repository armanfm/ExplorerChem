# ExploreChem

**Verifiable mineral provenance connected to transferable economic rights.**

ExploreChem is a multichain prototype for critical-mineral supply chains, with an initial focus on rare earths. It combines company identity, private evidence, Chainlink CRE calculations, physical lot traceability on Ethereum Sepolia, and an economic-rights layer built with Solana Token-2022 on Devnet.

Physical material and economic rights have separate records and lifecycles. A transfer of a physical lot does not automatically transfer the Solana RWA, and a transfer of the RWA does not transfer ownership or custody of the physical mineral.

> Prototype / pre-pilot. Demonstration companies, documents and quantities are synthetic. Demo rights do not create a real payment obligation. Production adoption requires validated commercial terms, source-data controls, security review and operational validation.

- [Live demonstration](https://armanfm.github.io/ExplorerChem/)
- [Source repository](https://github.com/armanfm/ExplorerChem)
- Physical layer: Ethereum Sepolia, chain ID `11155111`
- Economic layer: Solana Devnet

## Architecture

| **Component**            | **Responsibility**                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ExploreChemActorRegistry | Company identity, registration approval, controllers, authorized wallets and actor status                                                                     |
| ExploreChemProofRegistry | Evidence commitments, authorized workflow reports, independent MUF and Elemental proof states, proof history and coordination with the lot contract           |
| ExploreChemLots          | Salted lot commitments, whole-lot state transitions, parent/child links, custody orders and collateral locks |
| MUF workflow             | Evidence integrity verification and deterministic total-mass accounting                                                                                       |
| Elemental workflow       | Verification of the MUF result, stream and assay calculations, and preparation of proof-linked lot operations                                                 |
| Solana RWA program       | Series creation, Token-2022 issuance, credit/lineage reservations, marketplace escrow, redemption and settlement/burn                                         |
| Supabase                 | Evidence lookup, controlled document/result storage and application metadata                                                                                  |
| Frontend                 | Evidence submission, actor navigation, lot/history views and wallet-based RWA operations                                                                      |

### Why Ethereum and Solana are separate

Ethereum records the physical provenance and accounting layer. Solana records the economic instrument and its holder, listings and redemption lifecycle. This makes the separation between physical material and economic rights explicit in the system design.

The E1 design links private industrial evidence to public lot commitments. Solana records the economic right through source references, commitments and authorized attestation. E1 defines collateral coordination through the Ethereum lot state and a unique backing reference. The design is not a token bridge or a trustless Ethereum light client on Solana. Correct identity, origin and lineage attestation remain part of the trust model.

Separate chains do not, by themselves, establish legal separation, regulatory compliance or liquidity. The economic right must be defined by its terms and responsible issuer.

## Deployment references

These are the deployment references supplied by the project team on October 3, 2026. Ethereum has **three contracts**, in addition to the separate Solana program. ActorRegistry is retained; the two E1 addresses below are the new ProofRegistry and Lots. Use the network and address references below when configuring the application.

| **Network**      | **Component**            | **Address**                                                                                                                                       |
| ---------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ethereum Sepolia | ExploreChemActorRegistry | [`0x2fb8a06A929299fEFCAfef63fCf663C0b07016F8`](https://sepolia.etherscan.io/address/0x2fb8a06A929299fEFCAfef63fCf663C0b07016F8)                   |
| Ethereum Sepolia | ExploreChemProofRegistry | [`0x76Fc76C7d38B44B10f7a6bdC08A7d37CA1a468dB`](https://sepolia.etherscan.io/address/0x76Fc76C7d38B44B10f7a6bdC08A7d37CA1a468dB)                   |
| Ethereum Sepolia | ExploreChemLots          | [`0xF319d67496302Dd28394874B3c3FBfA5DA6a02Dd`](https://sepolia.etherscan.io/address/0xF319d67496302Dd28394874B3c3FBfA5DA6a02Dd)                   |
| Solana Devnet    | explorechem_rwa_solana   | [`A2sUfkL18Znfo6A3u9mPHbMm1avm1A9J7NDpvwSTqT79`](https://explorer.solana.com/address/A2sUfkL18Znfo6A3u9mPHbMm1avm1A9J7NDpvwSTqT79?cluster=devnet) |

Source publication is separate from deployment. Before interacting, check the frontend configuration, RPC network, program/contract addresses and deployed version. A GitHub commit alone does not prove that identical bytecode is deployed.

## Repository map

| **Path**                                      | **Contents**                                            |
| --------------------------------------------- | ------------------------------------------------------- |
| `contracts/ExploreChemActorRegistry.sol`      | Ethereum company identity contract                      |
| `contracts/ExploreChemProofRegistry.sol`      | Ethereum evidence and proof registry                    |
| `contracts/ExploreChemLots.sol`               | Ethereum commitment-based lot registry                        |
| `workflows/muf/muf-worflow/`                  | Current MUF workflow, configuration and test file       |
| `workflows/elemental/elemental-worflow/`      | Current Elemental workflow, configuration and test file |
| `solana/programs/explorechem-rwa-solana/src/` | Rust/Anchor RWA program                                 |
| `solana/tests/`                               | TypeScript test sources                                 |
| `solana/Anchor.toml`                          | Anchor project and cluster configuration                |
| `index.html`                                  | Main web application entry point                        |

The directory spelling `worflow` is intentional here because it matches the committed paths. Each CRE project has its own `project.yaml` in its parent directory.

## Companies, evidence and proofs

Companies have stable actor identifiers, controllers and authorized wallets. The actor registry separates administrative registration decisions from operational evidence submission and supports actor suspension.

Evidence submission binds an actor and submitter to the hash of the original document. The source JSON is stored off-chain. Workflows retrieve that document and verify its hash against the on-chain commitment before relying on its contents.

The proof registry records separate results for the same evidence:

| **Proof type** | **Wire code** | **Purpose**                                             |
| -------------- | ------------- | ------------------------------------------------------- |
| MUF            | `1`           | Total-mass calculation                                  |
| Elemental      | `3`           | Elemental calculation and associated lot-operation flow |

The proof registry accepts these two proof types and tracks their states independently.

| **Check status** | **Code** | **Interpretation**                                                  |
| ---------------- | -------- | ------------------------------------------------------------------- |
| `NONE`           | `0`      | No state                                                            |
| `PENDING`        | `1`      | Awaiting the corresponding proof                                    |
| `CALCULATED`      | `2`      | The workflow's implemented checks/calculation succeeded             |
| `DIVERGENT`      | `3`      | A supported divergence, such as an integrity mismatch, was detected |
| `NOT_ATTESTED`   | `4`      | The available inputs do not support the required attestation        |

Interpret a status together with its proof type, methodology and reason codes. It is not a universal certification of a mineral, a measurement or a business.

Proof records include result, input and methodology commitments, revision information and transaction evidence. Detailed results stay in controlled storage; the chain provides the commitment and authoritative proof state.

## MUF: total-mass accounting

For supported non-carrier documents:

```
MUF = (input + opening inventory)
    - (product + scrap + other outputs + closing inventory)

```

For supported carrier documents:

```
difference = collected mass - delivered mass

```

Decimal kilogram inputs are converted to integer milligrams for deterministic calculation. The result records the operands, accounted output, signed and absolute difference, and relative difference when calculable.

**MUF `CALCULATED` means a valid supported calculation, not that the difference is within an industrial or regulatory tolerance.** The published MUF implementation separates tolerance evaluation from this calculation.

The detailed result is stored under:

```
muf-results/{evidenceId-without-0x}/{proofId-without-0x}.json

```

## Elemental: streams, composition and lot operations

The Elemental workflow retrieves the committed document and private MUF result and verifies both against their anchored hashes. It checks that the counted streams agree with the MUF accounting and calculates supported elemental quantities from the declared stream/assay data.

The source supports the rare-earth element set and supported compound conversions. Demonstration logs include Pr, Nd and Dy. Support in the code is not a claim that every element, compound and industrial process has been validated experimentally.

Missing or inconsistent assay/stream data can produce `NOT_ATTESTED`; an integrity mismatch can produce `DIVERGENT`. A successful result can carry a lot action, combining proof anchoring and the associated Ethereum lot operation atomically.

The detailed result is stored under:

```
elemental-results/{evidenceId-without-0x}/{proofId-without-0x}.json

```

## E1 physical lots and private accounting

`ExploreChemLots` stores opaque `bytes32` lot IDs, salted commitments, holder actor IDs, operation/proof references, creation time, states and parent links. It does **not** store physical masses, elemental quantities or the private openings of those commitments. It is a custom lot registry, not an ERC-20 or ERC-1155 balance of kilograms.

The private evidence contains an `e1` operation with its mode, operation ID, proof salt, input openings and output openings/recipients. Each lot opening contains the lot ID, material mass in integer milligrams, sorted elemental basis hashes and quantities, and a secret salt. Openings and salts must remain in restricted storage.

- **INITIAL:** creates the initial lot records from the validated available streams. It has no existing lot inputs and assigns the outputs to the evidence actor.
- **TRANSFORM:** verifies existing input openings against their on-chain commitments, checks the holder and active state, and validates output masses and elements against the private calculations. The workflow rejects outputs exceeding inputs in total mass or in any tracked element.
- Inputs are consumed **in full**. Products, residues and retained material that must remain usable are represented by new output lots.
- A private processing difference is the input minus represented outputs; it is not automatically a physical loss or a tradable lot.

For example, a synthetic scenario can account for `100 kg → 60 kg product + 39 kg residue + 1 kg difference`. These figures belong to the private calculation. Ethereum records the resulting commitments and lineage, not those quantities. The physical cause of the difference requires evidence.

### Lot states and custody

| State | Meaning |
| --- | --- |
| `NONE` | No lot recorded under that identifier |
| `ACTIVE` | Available for authorized operations, subject to valid proofs |
| `IN_ESCROW` | Locked in a custody order |
| `ENCUMBERED` | Locked by an authorized collateral agent |
| `CONSUMED` | Used by a transformation and unavailable for reuse |

Custody follows request, recipient acceptance, sender locking and recipient receipt confirmation. Expiry does not automatically transfer the lot or unlock escrow. Recipient rejection can restore the sender's active lot under the supported state rules. There is no automatic arbitration for an unresponsive recipient.

`encumber` requires an authorized collateral agent, an active usable lot and a fresh encumbrance reference. While encumbered, the lot cannot be transferred or consumed. `release` requires an authorized agent and a nonzero settlement reference. The agent must verify settlement or cancelled issuance off-chain before releasing it.

## E1 integrity and duplicate-use controls

These controls have different purposes:

| Control | Protection and scope |
| --- | --- |
| Salted lot commitment | Detects changes to a lot opening; includes chain and Lots address domain separation |
| Bound operation hash | Binds evidence, current MUF proof, chain, Registry, Lots, kind, operation ID, holder, inputs, input commitments, outputs and recipients |
| Duplicate input rejection | Prevents counting the same registered input lot twice in one operation; checked in workflow and contract |
| Used operation and evidence tracking | Rejects replay of an operation or reuse of the same evidence for another lot issuance |
| Unique output identifiers | Rejects creation over an existing lot identifier |
| Whole-lot consumption | Prevents a consumed input from funding another transformation |
| Current ancestry proofs | Blocks operations requiring usability when a lot or ancestor no longer has the required current proofs |
| Ethereum atomic execution | Anchors the successful Elemental proof and records its lot operation together, or reverts both |
| BigInt arithmetic | Keeps integer mass accumulation precise in the workflow |

The Registry accepts authorized forwarder reports and checks the expected workflow ID for each proof type. Successful Elemental operations use ReportV3, with canonical encoding and chain/registry binding. `registryVersion()` returns `3`; E1 workflows reject an incompatible registry version.

The on-chain contract does not recompute private arithmetic. Conservation is checked by the authorized workflow, and the report binds the resulting operation. Hashes are not zero-knowledge proofs or independent proof that a measurement is true.

Duplicate-use protection applies to **registered identifiers and their validated lineage**. It cannot by itself detect the same physical material falsely introduced under a new initial evidence record. Source identity, admission controls and physical verification remain necessary.

The implementation bounds operations to 32 inputs/outputs and ancestry traversal to 256 visited nodes. Exceeding supported bounds fails closed and requires an explicit operational policy.

## Public and private information

**E1 keeps new lot masses, composition and detailed calculations off-chain. Public commitments and states make those records verifiable without publishing their openings.**

| Data | Visibility |
| --- | --- |
| Actor IDs, controllers, authorized wallets and registration state | Public on Ethereum |
| Evidence hashes, proof commitments, proof states and events | Public on Ethereum |
| E1 lot IDs, commitments, holder actor IDs, lineage and state changes | Public on Ethereum |
| Masses, elemental quantities, inventories and calculation details | Restricted off-chain, subject to access configuration |
| Private lot openings and salts | Restricted off-chain; do not publish real openings |
| Solana mints, balances, transfers, listings and prices in the existing marketplace | Public on Solana |
| Original evidence documents and detailed workflow results | Restricted off-chain, subject to access configuration |

E1 does not guarantee anonymous companies or unobservable commercial relationships. Public actor records, holders, lineage, timing and transaction metadata can permit correlation. Data already published on a public blockchain cannot be made private retroactively.

Use unpredictable salts and protect the complete private evidence, including access through API responses, logs, signed URLs and the frontend. Removing data from a screen is not an access-control mechanism. Salting reduces guessability but does not remove public metadata or protect a leaked opening.

## Solana economic-rights lifecycle

Each current RWA mint represents **one indivisible unit**, with supply `1` and decimals `0`. The physical quantity referenced by a right is not the mint supply: a right linked to a 60 kg lot is not automatically 60 Solana tokens. Fractional economic ownership is not implemented by this one-unit design.

| **Operation**      | **Behavior**                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Create series      | Records issuer, source references and origin/claim commitments; applies configured credit and lineage reservations |
| Mint               | Issues the Token-2022 unit for the series                                                                          |
| Transfer           | Moves the token to another holder without moving the physical lot                                                  |
| List               | Sets an asking price and transfers the unit into marketplace escrow                                                |
| Buy                | Transfers SOL to the seller and the escrowed unit to the buyer in the same Solana transaction                      |
| Cancel listing     | Returns the escrowed unit to the seller                                                                            |
| Request redemption | Locks the holder's unit in redemption escrow and starts the redemption lifecycle                                   |
| Settle and burn    | Requires the configured authority, records a settlement commitment and burns the escrowed token                    |

**Offer pricing:** the seller chooses a positive price in lamports when listing. To change it, the seller cancels the active listing and lists the same token again at the new price. There is no dedicated direct price-update instruction in the reviewed marketplace code. The buyer supplies `expected_price`, and the program rejects a purchase if it differs from the stored listing price. Changing an asking price does not change the lot commitment or the underlying claim terms.

Series creation is exposed through the Anchor instruction `increment`. Marketplace instructions are `list_rwa`, `buy_rwa` and `cancel_listing`.

**Requesting redemption does not itself burn the token or pay a refund.** Settlement/burn records an authorized settlement hash; it is not independent proof of off-chain payment. In the demonstration, the claim explicitly carries no real payment obligation.

The current holder can initiate the supported holder actions. An earlier holder does not retain those token-holder permissions after transferring the unit. While a unit is in escrow, the corresponding program state governs its release or burn.

Resale does not automatically replace the issuer with the secondary-market seller. The responsible economic party must be established in the claim terms. The trusted attestor is a configured signing authority and is not automatically the issuer's company wallet.

### Credit and lineage controls

The program includes issuer-scoped credit locks and lineage reservations. For the same issuer, the reservation logic rejects overlaps on the same lot or its ancestors/descendants. The registry is bounded in this prototype: up to 64 lineage nodes and 32 reservations.

These are application rules in the ExploreChem program, not an automatic Token-2022 feature. Correct source-lot registration, issuer identity and attestation are required. A different issuer is a different reservation scope; that does not by itself prove an economically independent or valid new obligation.

The lineage registry is configured with the relevant source relationships and series reservations. The program does not independently discover all Ethereum lineage or off-platform obligations.

## Cross-chain security

### Cross-chain collateral coordination

Linking an RWA to a lot is not sufficient to prevent duplicate economic issuance. The E1 issuance policy requires a confirmed Ethereum collateral lock and a stable, non-reusable backing identifier in Solana. Changing an issuer, wallet or issuance ID must not bypass the selected backing policy.

Ethereum and Solana do not execute one atomic transaction. A failed or uncertain Solana issuance after Ethereum locking requires reconciliation before release. Timeout alone does not prove that no RWA was issued. Recovery must also prevent a delayed or replayed issuance after release.

The Lots owner can revoke and replace collateral agents. This provides key replacement, not an automatic cross-chain rollback. Owners, agents and attestors remain trusted roles. The current release reference is not independently verified as Solana settlement or payment by the Ethereum contract.

Validation must include failed issuance, replacement of an agent, safe release, duplicate issuance attempts, and old-holder/unauthorized settlement rejection. The existing redemption flow requires the configured settlement authority; this README does not claim an automatic redemption timeout or refund mechanism.

## Local setup

### Frontend and Ethereum

The live demonstration is the easiest way to inspect the UI. For development, serve the frontend over HTTP and configure Ethereum Sepolia, the three contract addresses, Solana Devnet and the required Supabase resources.

Public frontend configuration must never contain service-role keys, wallet private keys or private storage credentials. Supabase access policies remain responsible for protecting off-chain data.

### CRE workflows

Install the workflow dependencies using Bun in each workflow folder:

```
cd workflows/muf/muf-worflow
bun install
bun run typecheck
```

Run the equivalent installation/typecheck from `workflows/elemental/elemental-worflow` for Elemental.

Configure local credentials and secret mappings in each CRE project. The code requests `SUPABASE_SERVICE_ROLE_KEY` from the configured secret namespace. `.env` and `secrets.yaml` are intentionally excluded from publication and must be provisioned locally. The repository does not supply access to private demonstration storage.

From the repository root, run each project in its own subshell:

```
(cd workflows/muf && cre workflow simulate ./muf-worflow --target staging-settings)
(cd workflows/elemental && cre workflow simulate ./elemental-worflow --target staging-settings)
```

To submit the generated reports to the configured chain, add `--broadcast` after reviewing the network, contract, workflow authorization and signing configuration. Broadcasting changes testnet state.

The workflow code uses `handlerInTee`. **The CRE simulator is not a real TEE:** debug logs are visible. A successful simulation or broadcast does not attest production enclave execution.

The committed workflow configuration uses `massa-worflow-*` names. Ensure the configured names and on-chain workflow IDs match before deployment. A `production-settings` label is not evidence of a production deployment.

### E1 deployment wiring

1. Use the retained ActorRegistry when deploying ProofRegistry.
2. Deploy Lots with the new ProofRegistry address.
3. From the ProofRegistry owner, call `configureLots` with the new Lots address. This binding is one-time; `Lots.registry()` must point back to that ProofRegistry.
4. Configure the appropriate forwarder and expected workflow IDs for MUF (`1`) and Elemental (`3`). Simulation identifiers are not production authorizations.
5. Set both workflow configurations to the new ProofRegistry and verify registry version `3`. Check the reverse Lots link before submitting evidence.
6. Register fresh E1 evidence with complete private openings. Run MUF before Elemental. Existing actor registration remains valid; the new proof and lot registries begin without the old records.

The Elemental package includes `e1.ts` plus local helpers for preparing private identifiers/salts and checking deployment configuration. If `tokenActionMode` is explicitly configured, it must match the private evidence operation (`INITIAL` or `TRANSFORM`). Never regenerate a committed input opening when preparing a transformation.

### Solana

The Anchor project is in `solana/`. Review its toolchain configuration and install its JavaScript dependencies before building:

```
cd solana
yarn install
anchor build
```

`Anchor.toml` currently defaults to `localnet`. Use explicit Devnet settings when interacting with the published demonstration program. Do not deploy automatically as part of README setup, and never commit wallet or program keypairs.

Test files in `solana/tests/` must be checked against the current program accounts and instruction arguments before reporting results. Initialization, the configured attestor and lineage setup are prerequisites for the economic flow.

## Trust boundaries

- Source measurements and business declarations still depend on the companies, laboratories and authorities producing them. Blockchain integrity does not establish physical truth.
- Administrators, authorized workflows and the Solana attestor have distinct trusted roles.
- Public lineage, actor links and transaction metadata can reveal relationships even when quantities remain private.
- Cross-chain consistency depends on correct attestation and synchronization; it is not provided solely by using two networks.
- Prototype capacities, permissions, key management, storage policies and recovery procedures require production review.
- Validation claims must identify the tested revision and environment; local checks are not an independent security audit or proof of production readiness.

## Use of AI tools

AI-assisted tools, including ChatGPT, Claude and Manus, supported implementation, debugging, tests, research, interface work, documentation and synthetic demonstration inputs. Armando Freire led the architecture, technical decisions, integration, deployment and validation. AI-generated output is not an independent audit or proof of correctness.

## Team

- **Armando Freire — Technical Lead:** architecture, Solidity contracts, Rust/Anchor program, Chainlink CRE workflows, integration, testing and technical documentation.
- **Jéssica — Product Lead:** product direction, requirements, refinement, documentation, positioning and presentation.
- **Adriana Tourinho — Technical & Business Mentor:** technical and business guidance, hands-on support across the project, Solidity smart contract development, internal code auditing and support for team coordination using Scrum practices.

## License

The repository includes an [Apache-2.0 LICENSE](https://github.com/armanfm/ExplorerChem/blob/main/LICENSE). Some individual source files and package manifests carry different license identifiers; consult those notices and reconcile them before a formal release.

