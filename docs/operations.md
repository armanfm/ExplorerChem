# Configuration and operations

[Back to README](../README.md)

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

## Setup

### Frontend and Ethereum

Serve the HTML over localhost or HTTPS for Phantom integration. Configure Ethereum Sepolia, the contract set above, Solana Devnet and the required private-storage resources.

Do not include wallet secrets, service-role keys or private storage credentials in public HTML. Provision storage access policies separately.

For a simple local preview from the repository root:

```bash
python3 -m http.server 8000 --bind 127.0.0.1
```

Open `http://127.0.0.1:8000/` in a browser with the required wallets.

### CRE/TEE workflows

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

The MUF and Elemental workflows are configured for confidential processing in a Trusted Execution Environment (TEE), using Chainlink CRE’s `handlerInTee`. The commands above run these workflows in the CRE simulator, whose logs are intended for debugging. Respect the chain-read limits configured for the target environment.

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

## Source configuration

Verify `ProofRegistry.lotsContract()` and the reverse `Lots.registry()` link. Solana's `Config` records the permitted source chain and Lots address. `update_source_config` requires the Config administrator and updates references for new series while preserving existing series and the configured attestor.

The frontend provides **Update E1 origin through Phantom**. Program upgrades, IDL publication and Config changes are separate operations. The upgrade authority and Config administrator can use different wallets.

Serve the application over localhost or HTTPS for wallet integration. The economic interface uses Solana Devnet; the physical interface uses Ethereum Sepolia.
