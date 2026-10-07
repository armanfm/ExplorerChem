# Security

## Scope of the review

An internal, limited-scope security review was performed by a dedicated team member on the Ethereum E1 contracts (`ExploreChemLots`, `ExploreChemProofRegistry`, `ExploreChemActorRegistry`), at commit `6ce6150`, deployed on Sepolia.

**This is not an external audit.** The Chainlink CRE workflows, the Solana Token-2022 program and the web UI were not reviewed.

## What the system protects

- **Confidentiality of quantities and composition.** Only commitments (hashes) and status are written on-chain. Masses, compositions and salts stay off-chain.
  Evidence: `docs/security/evidence/t3-onchain.md` decodes real Sepolia transactions (`submitEvidence`, `ProofAnchored`) and shows only identifiers and 32-byte hashes.
- **Integrity of the proof chain.** Proofs form a revision chain per (evidence, proof type). A revision invalidates the lots derived from it.
- **Actor gating.** Operations require a registered, active actor.

## Trust assumptions 

- **Demo uses a mock forwarder.** Reports in the demo go through `MockKeystoneForwarder`, and the on-chain `workflowId` observed is the placeholder `0x11…11`. With a mock forwarder, report authenticity is not enforced. Production must use the real Chainlink forwarder. (Finding N-1)
- **Single admin wallet.** One EOA owns all three contracts. No multisig, no timelock. (F-1)
- **Off-chain database.** Salts are stored next to the data they protect, and the workflows use a Supabase service key. (Q-1)
- **Mass conservation is checked in the workflow, not in the contracts.**

## Known limitations

See `docs/security/findings.md` for the full list with IDs, severity and status.

## Before production

- Use the real forwarder and validate workflow owner and name, not only `workflowId`.
- Move ownership to a multisig with a timelock.
- Verify contract source on Etherscan and pin the Solidity version (0.8.26).
- Enable row-level security in Supabase and rotate keys.
- Commission an external audit.

## Reporting a vulnerability

Please do not open a public issue. Contact the maintainers privately: c1pher2080@gmail.com.
