# Findings: ExploreChem E1 (internal review)

Scope: Ethereum E1 contracts (`ExploreChemLots`, `ExploreChemProofRegistry`, `ExploreChemActorRegistry`) at commit `6ce6150`, Sepolia. Internal, limited-scope review by a team member; **not an external audit**. Workflows, the Solana program and the UI were not reviewed, except where noted.

Severities are proposed and relative to a production deployment, not to the hackathon demo. Status: **Open** = no fix yet; **To confirm** = needs input from the tech lead.

## Summary

| ID | Title | Severity | Status |
|---|---|---|---|
| N-1 | Mock forwarder and weak workflow identity check | High (production) | Open |
| F-1 | Single EOA owns all three contracts | High | Open |
| F-5 | Admin can change an actor's controller without consent or delay | Medium | Open |
| Q-1 | Salt stored next to the data it protects; entropy not validated | Medium | Open |
| F-6 | Wallet recovery does not revoke other authorized wallets | Medium | Open |
| F-7 | Actor IDs are first-come (registration front-running) | Low | Open |
| F-8 | `registrationHash` has no secret salt | Low | Open |
| F-3 | TRANSFORM to another actor restricted only in the UI | Medium | To confirm |
| N-3 | Gas limits of large lineage operations not tested | Medium | To confirm |
| O-3 | Contract source not verified on Etherscan | Low | Open |

Other IDs from the internal inventory are not repeated here.

## High

### N-1: Mock forwarder and weak workflow identity check
- **Where:** `ExploreChemProofRegistry.onReport`, `_readWorkflowId`.
- **Evidence:** `docs/security/evidence/t3-onchain.md`. The reports on Sepolia were delivered by `MockKeystoneForwarder` (`0x15fC…9F88`) with simulator metadata: `workflowId = 0x11…11`, `workflowOwner = 0xaa…aa`, `workflowName = ebb203df73`.
- **Issue:** the registry reads only the first 32 bytes of the metadata (`workflowId`). Owner and name are not validated. With a mock forwarder, report authenticity is not enforced, and the accepted `workflowId` is public.
- **Impact (plausible, not tested):** a third party could publish a revision for an existing proof using the public `workflowId`, which could mark a proof DIVERGENT and invalidate derived lots through the `_usable` cascade.
- **Recommendation:** use the real Chainlink forwarder in any non-demo deployment; validate workflow owner and name in addition to `workflowId` (confirm whether the real `workflowId` already binds the owner); test the scenario on a local fork before publishing any claim.

### F-1: Single EOA owns all three contracts
- **Where:** owner `0xAD9eA3D28df2E1D76aB2236aC8C7c86915e4401c` on ProofRegistry, Lots and ActorRegistry. The same EOA also sent every transaction analysed in the T3 evidence.
- **Impact:** compromise of one key gives control of configuration, forwarder and workflow settings.
- **Recommendation:** multisig plus timelock for owner functions before production; separate the deployer/operator key from the owner key. `OwnershipTransferred` is declared in ProofRegistry; confirm that a transfer function exists.

## Medium

### F-5: Admin can change an actor's controller without consent or delay
- **Where:** `ExploreChemActorRegistry.updateActorController`.
- **Impact:** an admin can take over an actor's identity instantly.
- **Recommendation:** two-step change with the current controller's consent or a timelock; emit an event with the old and new controller.

### Q-1: Salt stored next to the data it protects; entropy not validated
- **Where:** off-chain (Supabase). Workflows use `SUPABASE_SERVICE_ROLE_KEY`, which bypasses row-level security. The UI (`teste.html`) has a `Math.random` fallback for salt generation (to be confirmed in the code).
- **Impact:** a database leak exposes both data and salt, which defeats the commitment's hiding property; a weak salt makes low-entropy values (masses) brute-forceable from the on-chain hash.
- **Recommendation:** generate salts with a cryptographically secure source; validate length and entropy; store salts separately from the data; enable row-level security and rotate the service key.

### F-6: Wallet recovery does not revoke other authorized wallets
- **Where:** `ExploreChemActorRegistry` recovery flow.
- **Impact:** after a recovery caused by a compromised wallet, other previously authorized wallets stay valid.
- **Recommendation:** revoke all other authorized wallets on recovery, or require explicit re-authorization.

### F-3: TRANSFORM to another actor is restricted only in the UI
- **Where:** `ExploreChemLots` transform path.
- **Issue:** intentional in the earlier model; the restriction now exists only in the interface.
- **Recommendation:** decide whether the contract should enforce it; if not, document it as intended behavior. To confirm with the tech lead.

### N-3: Gas limits of large lineage operations not tested
- **Where:** operations with up to 32 inputs and 256 lots (the 256 limit includes the lot itself).
- **Issue:** no gas test was reported.
- **Recommendation:** Foundry test at the maximum sizes; record results in a gas-test evidence file (planned). Reference: `submitEvidence` costs 172,166 gas; a proof-type-3 report with one lot output cost 683,699 gas.

## Low

### F-7: Actor IDs are first-come
Anyone can call `requestActorRegistration` and claim an ID before the intended party. Recommendation: bind IDs to the requesting wallet or add admin pre-approval.

### F-8: `registrationHash` has no secret salt
A hash of low-entropy registration data can be guessed offline. Recommendation: include a secret salt that is never published in the registration JSON.

### O-3: Contract source not verified on Etherscan
Third parties cannot read the deployed source. Recommendation: verify all three contracts.

## Observations (no severity)

- Floating pragma `^0.8.26`; pin to `0.8.26`.
- `tokenHolder` returns the original submitting wallet and goes stale after a wallet rotation; `tokenHolderEligible` checks company status. Confirm which one consumers rely on.
- `isWalletAuthorized` does not check that the actor is active.
- Order flow: `ACCEPTED`, `LOCKED` and `EXPIRED` states are declared but never assigned, and there is no order expiry. Consumed input lots are never restored.
- `configureLots` is one-time and `Lots.registry` is immutable, so redeploying Lots requires redeploying ProofRegistry.
- Evidence can be submitted through a delegation (`redeemDelegations`); the delegation setup is outside the reviewed contracts (see T3 evidence, tx E).
- `teste.html` loads scripts from CDNs without Subresource Integrity and uses an unpinned `supabase-js@2`. Its Supabase publishable key is public by design.

## What was verified

- Privacy on-chain: see `docs/security/evidence/t3-onchain.md`.
- Reviewed commit unchanged up to `origin/main`: see `docs/security/evidence/commit-scope.md`.

