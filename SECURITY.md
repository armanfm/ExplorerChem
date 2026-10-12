# Security

## Scope of the review

An internal, limited-scope security review of the Ethereum E1 contracts (`ExploreChemLots`, `ExploreChemProofRegistry`, `ExploreChemActorRegistry`), at commit `6ce6150`, deployed on Sepolia. The Ethereum contracts are unchanged between `6ce6150` and `af3a88d` (11 Oct). The Solana program (`explorechem-rwa-solana`) received a separate, shorter limited pass; its USDT payment path, added later, was only skimmed.

**This is not an external audit.** The Chainlink CRE workflows and the web UI were not reviewed. The Solana pass is described in `docs/security/solana-limited-pass.md`.

## What the system protects

- **Confidentiality of quantities and composition.** Only commitments (hashes) and status are written on-chain. Masses, compositions and salts stay off-chain.
  Evidence: `docs/security/evidence/t3-onchain.md` decodes real Sepolia transactions (`submitEvidence`, `ProofAnchored`) and shows only identifiers and 32-byte hashes.
- **Integrity of the proof chain.** Proofs form a revision chain per (evidence, proof type). A revision invalidates the lots derived from it.
- **Actor gating.** Operations require a registered, active actor.
- **Fixed supply of the Solana token.** After minting, the Solana program revokes both the mint authority and the freeze authority, so each RWA token has a supply of 1 and cannot be frozen by the issuer.

## Trust assumptions

- **Demo uses a mock forwarder.** Reports in the demo go through `MockKeystoneForwarder`, and the on-chain `workflowId` observed is the placeholder `0x11…11`. With a mock forwarder, report authenticity is not enforced. Production must use the real Chainlink forwarder. (Finding N-1)
- **Single admin wallet.** One EOA owns all three Ethereum contracts. No multisig, no timelock. (F-1)
- **Two single keys on Solana.** Series creation and minting depend on the trusted attestor, and configuration depends on the config authority. The Solana program cannot verify Ethereum state, so it trusts the attestor. The pause switch exists but cannot be activated. (S-1, S-2)
- **Demo payment token on Solana.** A default build of the Solana program accepts a worthless demo token as payment; production builds must disable it. (S-7)
- **RWA lock relies on an agent key.** An issued RWA locks its Ethereum lot (`ENCUMBERED`), but releasing the lot is decided by a collateral-agent key, not verified on-chain. (F-10)
- **Actor roles are not enforced in the demo.** Miner, purifier and manufacturer are not distinguished by the contracts; any registered actor can perform a transformation. This is a demo setting, to be changed. (F-9)
- **Off-chain database.** Salts are stored next to the data they protect, and the workflows use a Supabase service key. (Q-1)
- **Mass conservation is checked in the workflow, not in the contracts.**

## Known limitations

See `docs/security/findings.md` for the full list with IDs, severity and status, and `docs/security/solana-limited-pass.md` for the Solana program.

## Before production

- Use the real forwarder and validate workflow owner and name, not only `workflowId`.
- Move ownership and configuration keys (Ethereum and Solana) to a multisig with a timelock.
- Add an operable pause switch to the Solana program.
- Restore the actor role distinction on-chain.
- Verify contract source on Etherscan and pin the Solidity version (0.8.26).
- Enable row-level security in Supabase and rotate keys.
- Commission an external audit.

## Reporting a vulnerability

Please do not open a public issue. Contact the maintainers privately: c1pher2080@gmail.com.
