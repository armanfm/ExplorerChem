# Findings: ExploreChem E1 (internal review)

Scope: Ethereum E1 contracts (`ExploreChemLots`, `ExploreChemProofRegistry`, `ExploreChemActorRegistry`) at commit `6ce6150`, Sepolia. Internal, limited-scope review; **not an external audit**. Workflows and the UI were not reviewed, except where noted. The Solana program received a separate limited pass: see `solana-limited-pass.md`.

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
| F-3 | TRANSFORM to another actor restricted only in the UI | Medium | Intended, to document |
| F-9 | Actor roles are not enforced by the contracts | Medium | Confirmed (demo setting) |
| F-10 | RWA lock (`encumber`/`release`) depends on a collateral-agent key | Medium | Open |
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
- **Recommendation:** multisig plus timelock for owner functions before production; separate the deployer/operator key from the owner key. All three contracts have `transferOwnership` (confirmed in code), so ownership can move to a multisig without redeploying. ActorRegistry transfers in one step with no acceptance by the new owner; Lots also has `acceptOwnership` (two-step).

## Medium

### F-5: Admin can change an actor's controller without consent or delay
- **Where:** `ExploreChemActorRegistry.updateActorController`.
- **Impact:** an admin can take over an actor's identity instantly.
- **Recommendation:** two-step change with the current controller's consent or a timelock; emit an event with the old and new controller.

### Q-1: Salt stored next to the data it protects; entropy not validated
- **Where:** off-chain (Supabase). Workflows use `SUPABASE_SERVICE_ROLE_KEY`, which bypasses row-level security. Salt generation was not found in the UI code. The only `Math.random` in `index.html` is a fallback for actor IDs when `crypto.getRandomValues` is unavailable (low risk). Where the salts are generated (workflows) was not checked.
- **Impact:** a database leak exposes both data and salt, which defeats the commitment's hiding property; a weak salt makes low-entropy values (masses) brute-forceable from the on-chain hash.
- **Recommendation:** generate salts with a cryptographically secure source; validate length and entropy; store salts separately from the data; enable row-level security and rotate the service key.

### F-6: Wallet recovery does not revoke other authorized wallets
- **Where:** `ExploreChemActorRegistry` recovery flow.
- **Impact:** after a recovery caused by a compromised wallet, other previously authorized wallets stay valid.
- **Recommendation:** revoke all other authorized wallets on recovery, or require explicit re-authorization.

### F-3: TRANSFORM to another actor is restricted only in the UI
- **Where:** `ExploreChemLots` transform path.
- **Issue:** the restriction exists only in the interface. The tech lead confirmed that transformation by different kinds of actors (for example a purifier, then a manufacturer) is allowed and intended.
- **Recommendation:** document it as intended behavior, since the supply chain depends on passing lots between actors.

### F-9: Actor roles are not enforced by the contracts (demo setting)
- **Where:** `ExploreChemActorRegistry` and the `ExploreChemLots` transform path.
- **Issue:** the product describes distinct stages (miner, purifier, manufacturer). Confirmed by the tech lead: actor types existed but were removed to simplify the demo, so any registered actor can perform a transformation. The stage a lot goes through is a convention, not a rule. The team plans to restore the role distinction after the demo.
- **Impact:** a registered actor could submit a transformation for a stage it does not play, for example a miner presenting a purification. The remaining controls are the actor registration process and the mass checks in the workflow.
- **Recommendation:** model roles on-chain (a role per actor, checked in the transform path), or document that stage separation is enforced off-chain, and decide before production.

### F-10: RWA lock depends on a collateral-agent key
- **Where:** `ExploreChemLots.encumber`, `release`, `setCollateralAgent`.
- **What works:** once an RWA is issued, an authorized collateral agent calls `encumber`, which sets the lot to `ENCUMBERED`. The lot can then no longer be sold or handed to another actor through orders (`createOrder` requires an `ACTIVE` lot), and each `encumbranceRef` can be used only once. This matches the tech lead's description.
- **Issue:** `release` returns the lot to `ACTIVE` on the agent's word alone. The code comment says the agent must verify settlement or a cancelled issuance off-chain first; the contract cannot check Solana. The owner (one EOA, F-1) can add or replace agents.
- **Impact:** a compromised or mistaken agent key could release a lot while its Solana RWA still exists, so the same lot could be traded on Ethereum and held as a token on Solana.
- **Recommendation:** multisig or timelock for agents and releases; publish the agent address; emit and monitor `EncumbranceReleased`. Confirmed in code: the transform path (`_activeLot`) and `createOrder` both reject lots that are not `ACTIVE`, so an `ENCUMBERED` lot cannot be transformed or sold.

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
- The UI page (`index.html`, formerly `teste.html`) loads scripts from CDNs without Subresource Integrity and uses an unpinned `supabase-js@2`. Its Supabase publishable key is public by design.

## What was verified

- Privacy on-chain: see `docs/security/evidence/t3-onchain.md`.
- Ethereum contracts unchanged between `6ce6150` and `origin/main` (`af3a88d`, 11 Oct): see `docs/security/evidence/commit-scope.md`.
- Solana program: limited pass, see `docs/security/solana-limited-pass.md`.
