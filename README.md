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

| Component | Responsibility |
| --- | --- |
| ExploreChemActorRegistry | Company identity, registration approval, controllers, authorized wallets and actor status |
| ExploreChemProofRegistry | Evidence commitments, authorized workflow reports, independent MUF and Elemental proof states, proof history and coordination with the lot contract |
| ExploreChemLots | Actor-scoped material balances, component quantities, lot creation, validated transformations, parent/child links, processing differences and transfer orders |
| MUF workflow | Evidence integrity verification and deterministic total-mass accounting |
| Elemental workflow | Verification of the MUF result, stream and assay calculations, and preparation of proof-linked lot operations |
| Solana RWA program | Series creation, Token-2022 issuance, credit/lineage reservations, marketplace escrow, redemption and settlement/burn |
| Supabase | Evidence lookup, controlled document/result storage and application metadata |
| Frontend | Evidence submission, actor navigation, lot/history views and wallet-based RWA operations |

### Why Ethereum and Solana are separate

Ethereum records the physical provenance and accounting layer. Solana records the economic instrument and its holder, listings and redemption lifecycle. This makes the separation between physical material and economic rights explicit in the system design.

The link uses source-chain and contract identifiers, lot references, cryptographic commitments and authorized attestation. It is not a token bridge or a trustless Ethereum light client on Solana. Correct identity, origin and lineage attestation remain part of the trust model.

Separate chains do not, by themselves, establish legal separation, regulatory compliance or liquidity. The economic right must be defined by its terms and responsible issuer.

## Deployment references

These are the current deployment references supplied for the demonstration. Ethereum has **three contracts**, in addition to the separate Solana program.

| Network | Component | Address |
| --- | --- | --- |
| Ethereum Sepolia | ExploreChemActorRegistry | [`0x2fb8a06A929299fEFCAfef63fCf663C0b07016F8`](https://sepolia.etherscan.io/address/0x2fb8a06A929299fEFCAfef63fCf663C0b07016F8) |
| Ethereum Sepolia | ExploreChemProofRegistry | [`0x692234073Aa3581B7A6F63C56D8ad56C8eFCE8Df`](https://sepolia.etherscan.io/address/0x692234073Aa3581B7A6F63C56D8ad56C8eFCE8Df) |
| Ethereum Sepolia | ExploreChemLots | [`0x191F35b0E823319B167E7E0ffEb7BB442f9b396F`](https://sepolia.etherscan.io/address/0x191F35b0E823319B167E7E0ffEb7BB442f9b396F) |
| Solana Devnet | explorechem_rwa_solana | [`A2sUfkL18Znfo6A3u9mPHbMm1avm1A9J7NDpvwSTqT79`](https://explorer.solana.com/address/A2sUfkL18Znfo6A3u9mPHbMm1avm1A9J7NDpvwSTqT79?cluster=devnet) |

Source publication is separate from deployment. Before interacting, check the frontend configuration, RPC network, program/contract addresses and deployed version. A GitHub commit alone does not prove that identical bytecode is deployed.

## Repository map

| Path | Contents |
| --- | --- |
| `contracts/ExploreChemActorRegistry.sol` | Ethereum company identity contract |
| `contracts/ExploreChemProofRegistry.sol` | Ethereum evidence and proof registry |
| `contracts/ExploreChemLots.sol` | Ethereum physical lot accounting |
| `workflows/muf/muf-worflow/` | Current MUF workflow, configuration and test file |
| `workflows/elemental/elemental-worflow/` | Current Elemental workflow, configuration and test file |
| `solana/programs/explorechem-rwa-solana/src/` | Rust/Anchor RWA program |
| `solana/tests/` | TypeScript test sources |
| `solana/Anchor.toml` | Anchor project and cluster configuration |
| `index.html` | Main web application entry point |

The directory spelling `worflow` is intentional here because it matches the committed paths. Each CRE project has its own `project.yaml` in its parent directory.

## Companies, evidence and proofs

Companies have stable actor identifiers, controllers and authorized wallets. The actor registry separates administrative registration decisions from operational evidence submission and supports actor suspension.

Evidence submission binds an actor and submitter to the hash of the original document. The source JSON is stored off-chain. Workflows retrieve that document and verify its hash against the on-chain commitment before relying on its contents.

The proof registry records separate results for the same evidence:

| Proof type | Wire code | Purpose |
| --- | --- | --- |
| MUF | `1` | Total-mass calculation |
| Elemental | `3` | Elemental calculation and associated lot-operation flow |

The proof registry accepts these two proof types and tracks their states independently.

| Check status | Code | Interpretation |
| --- | --- | --- |
| `NONE` | `0` | No state |
| `PENDING` | `1` | Awaiting the corresponding proof |
| `COMPLIANT` | `2` | The workflow's implemented checks/calculation succeeded |
| `DIVERGENT` | `3` | A supported divergence, such as an integrity mismatch, was detected |
| `NOT_ATTESTED` | `4` | The available inputs do not support the required attestation |

Interpret a status together with its proof type, methodology and reason codes. It is not a universal certification of a mineral, a measurement or a business.

Proof records include result, input and methodology commitments, revision information and transaction evidence. Detailed results stay in controlled storage; the chain provides the commitment and authoritative proof state.

## MUF: total-mass accounting

For supported non-carrier documents:

```text
MUF = (input + opening inventory)
    - (product + scrap + other outputs + closing inventory)
```

For supported carrier documents:

```text
difference = collected mass - delivered mass
```

Decimal kilogram inputs are converted to integer milligrams for deterministic calculation. The result records the operands, accounted output, signed and absolute difference, and relative difference when calculable.

**MUF `COMPLIANT` means a valid supported calculation, not that the difference is within an industrial or regulatory tolerance.** The published MUF implementation separates tolerance evaluation from this calculation.

The detailed result is stored under:

```text
muf-results/{evidenceId-without-0x}/{proofId-without-0x}.json
```

## Elemental: streams, composition and lot operations

The Elemental workflow retrieves the committed document and private MUF result and verifies both against their anchored hashes. It checks that the counted streams agree with the MUF accounting and calculates supported elemental quantities from the declared stream/assay data.

The source supports the rare-earth element set and supported compound conversions. Demonstration logs include Pr, Nd and Dy. Support in the code is not a claim that every element, compound and industrial process has been validated experimentally.

Missing or inconsistent assay/stream data can produce `NOT_ATTESTED`; an integrity mismatch can produce `DIVERGENT`. A successful result can carry a lot action, combining proof anchoring and the associated Ethereum lot operation atomically.

The detailed result is stored under:

```text
elemental-results/{evidenceId-without-0x}/{proofId-without-0x}.json
```

## Physical lots, transformations and differences

`ExploreChemLots` records material quantities and component balances by actor and lot. It exposes lot composition, parent relationships, operation outputs and transfer-order state.

Validated transformations consume material and component balances and create output lots. The contract rejects production above the consumed total mass and rejects output component quantities above the corresponding consumed component quantities. It records remaining differences through `ProcessingDifference` events.

A product and a residue can both be represented by output lots. A processing difference is recorded separately; it is not automatically another tradable lot.

The demonstration includes:

```text
100 kg input → 60 kg product + 39 kg residue + 1 kg difference
```

The demonstration logs report MUF and Elemental `COMPLIANT` and creation of lots `5` and `6`. Negative test logs also show Elemental rejecting inconsistent stream accounting.

A difference can represent a declared loss or an unexplained accounting remainder. Its physical cause requires evidence; the arithmetic alone does not establish it.

Subdivision is routed through validated processing and output proofs. The standalone `splitLot` entry point in the published contract reverts. Transfer orders use their own authorization and whole-lot rules; subdivision is not an unrestricted administrative balance edit.

The physical contract uses a custom actor-based lot ledger. Its balance interface should not be advertised as standard ERC-1155 wallet compatibility without a separate compatibility assessment.

## Public and private information

**Documents and detailed calculations remain in controlled off-chain storage; lot masses and elemental quantities recorded on-chain are public and identifiable.**

| Data | Visibility |
| --- | --- |
| Actor IDs, controller/authorized wallets, registration state | Public on Ethereum |
| Evidence hashes, proof commitments, proof states and events | Public on Ethereum |
| Lot quantities, component basis identifiers, component quantities and lineage | Public on Ethereum |
| Processing-difference events | Public on Ethereum |
| Solana mints, token balances/transfers, listings, prices and lifecycle accounts | Public on Solana |
| Original evidence documents and detailed workflow results | Off-chain, subject to configured access permissions |
| Internal process information absent from public records | Can remain restricted in off-chain documents |

Removing element names from a screen does not make the underlying records private. Deterministic element identifiers can be mapped back to element names, and public quantities can disclose proportions and processing differences. Hash commitments are not zero-knowledge proofs and do not conceal every guessable input.

Issuers must decide which commercial product attributes and quantities they authorize for publication. The remaining documents and process details can be restricted, subject to access controls and information inferable from the public data.

## Solana economic-rights lifecycle

Each current RWA mint represents **one indivisible unit**, with supply `1` and decimals `0`. The physical quantity referenced by a right is not the mint supply: a right linked to a 60 kg lot is not automatically 60 Solana tokens. Fractional economic ownership is not implemented by this one-unit design.

| Operation | Behavior |
| --- | --- |
| Create series | Records issuer, source references and origin/claim commitments; applies configured credit and lineage reservations |
| Mint | Issues the Token-2022 unit for the series |
| Transfer | Moves the token to another holder without moving the physical lot |
| List | Sets an asking price and transfers the unit into marketplace escrow |
| Buy | Transfers SOL to the seller and the escrowed unit to the buyer in the same Solana transaction |
| Cancel listing | Returns the escrowed unit to the seller |
| Request redemption | Locks the holder's unit in redemption escrow and starts the redemption lifecycle |
| Settle and burn | Requires the configured authority, records a settlement commitment and burns the escrowed token |

Series creation is exposed through the Anchor instruction `increment`. Marketplace instructions are `list_rwa`, `buy_rwa` and `cancel_listing`.

**Requesting redemption does not itself burn the token or pay a refund.** Settlement/burn records an authorized settlement hash; it is not independent proof of off-chain payment. In the demonstration, the claim explicitly carries no real payment obligation.

The current holder can initiate the supported holder actions. An earlier holder does not retain those token-holder permissions after transferring the unit. While a unit is in escrow, the corresponding program state governs its release or burn.

Resale does not automatically replace the issuer with the secondary-market seller. The responsible economic party must be established in the claim terms. The trusted attestor is a configured signing authority and is not automatically the issuer's company wallet.

### Credit and lineage controls

The program includes issuer-scoped credit locks and lineage reservations. For the same issuer, the reservation logic rejects overlaps on the same lot or its ancestors/descendants. The registry is bounded in this prototype: up to 64 lineage nodes and 32 reservations.

These are application rules in the ExploreChem program, not an automatic Token-2022 feature. Correct source-lot registration, issuer identity and attestation are required. A different issuer is a different reservation scope; that does not by itself prove an economically independent or valid new obligation.

The lineage registry must be configured with the relevant source relationships and series reservations. The program does not independently discover all Ethereum lineage or off-platform obligations.

## Demonstration and validation status

| Area | Current evidence/status |
| --- | --- |
| Company identity, evidence and Ethereum lot operations | Demonstrated/reported in the prototype; corresponding contract sources are published |
| MUF and Elemental | Published workflow source and supplied simulation/broadcast logs, including positive and negative examples |
| RWA issuance, transfer, listing and cancellation | Demonstrated/reported on Solana Devnet; corresponding source is published |
| Purchase, redemption, settlement and burn | Implemented in the published program; complete integrated buyer-wallet purchase → redemption → authorized settlement/burn remains to be documented |
| Automated tests | Test sources are included; their presence is not a claim that all suites pass against this exact revision |
| Production confidential execution | Not established by local CRE simulation |
| External users and paying customers | Pre-pilot; none reported |

The next integrated demonstration should record separate seller/buyer wallets, transaction links and before/after states, including rejection of an old holder's redemption and an unauthorized settlement attempt.

## Local setup

### Frontend and Ethereum

The live demonstration is the easiest way to inspect the UI. For development, serve the frontend over HTTP and configure Ethereum Sepolia, the three contract addresses, Solana Devnet and the required Supabase resources.

Public frontend configuration must never contain service-role keys, wallet private keys or private storage credentials. Supabase access policies remain responsible for protecting off-chain data.

### CRE workflows

Install the workflow dependencies using Bun in each workflow folder:

```bash
cd workflows/muf/muf-worflow
bun install
bun run typecheck
```

Run the equivalent installation/typecheck from `workflows/elemental/elemental-worflow` for Elemental.

Configure local credentials and secret mappings in each CRE project. The code requests `SUPABASE_SERVICE_ROLE_KEY` from the configured secret namespace. `.env` and `secrets.yaml` are intentionally excluded from publication and must be provisioned locally. The repository does not supply access to private demonstration storage.

From the repository root, run each project in its own subshell:

```bash
(cd workflows/muf && cre workflow simulate ./muf-worflow --target staging-settings)
(cd workflows/elemental && cre workflow simulate ./elemental-worflow --target staging-settings)
```

To submit the generated reports to the configured chain, add `--broadcast` after reviewing the network, contract, workflow authorization and signing configuration. Broadcasting changes testnet state.

The workflow code uses `handlerInTee`. **The CRE simulator is not a real TEE:** debug logs are visible. A successful simulation or broadcast does not attest production enclave execution.

The committed workflow configuration uses `massa-worflow-*` names. Ensure the configured names and on-chain workflow IDs match before deployment. A `production-settings` label is not evidence of a production deployment.

### Solana

The Anchor project is in `solana/`. Review its toolchain configuration and install its JavaScript dependencies before building:

```bash
cd solana
yarn install
anchor build
```

`Anchor.toml` currently defaults to `localnet`. Use explicit Devnet settings when interacting with the published demonstration program. Do not deploy automatically as part of README setup, and never commit wallet or program keypairs.

Test files in `solana/tests/` must be checked against the current program accounts and instruction arguments before reporting results. Initialization, the configured attestor and lineage setup are prerequisites for the economic flow.

## Trust boundaries and remaining work

- Source measurements and business declarations still depend on the companies, laboratories and authorities producing them. Blockchain integrity does not establish physical truth.
- Administrators, authorized workflows and the Solana attestor have distinct trusted roles.
- Public quantities and lineage are not confidential industrial data storage.
- Cross-chain consistency depends on correct attestation and synchronization; it is not provided solely by using two networks.
- Prototype capacities, permissions, key management, storage policies and recovery procedures require production review.
- Further work includes closing the integrated multi-wallet lifecycle, documenting reproducible test results, validating commercial terms with prospective users and obtaining independent security review.

## Use of AI tools

AI-assisted tools, including ChatGPT, Claude and Manus, supported implementation, debugging, tests, research, interface work, documentation and synthetic demonstration inputs. Armando Freire led the architecture, technical decisions, integration, deployment and validation. AI-generated output is not an independent audit or proof of correctness.

## Team

- **Armando Freire — Technical Lead:** architecture, Solidity contracts, Rust/Anchor program, Chainlink CRE workflows, integration, testing and technical documentation.
- **Jéssica — Product Lead:** product direction, requirements, refinement, documentation, positioning and presentation.
- **Adriana Tourinho — Technical & Business Mentor:** technical and business guidance, hands-on support across the project, Solidity smart contract development, internal code auditing and support for team coordination using Scrum practices.

## License

The repository includes an [Apache-2.0 LICENSE](LICENSE). Some individual source files and package manifests carry different license identifiers; consult those notices and reconcile them before a formal release.

