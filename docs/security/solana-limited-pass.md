# Solana program: limited pass

Program: `explorechem-rwa-solana` (Anchor, Token-2022), program id `A2sUfkL18Znfo6A3u9mPHbMm1avm1A9J7NDpvwSTqT79`, Rust under `solana/programs/explorechem-rwa-solana/src`. The detailed pass was done on `main` at `be37276` (about 2,100 lines). Between `be37276` and `af3a88d` (11 Oct) the program grew by about 1,170 lines (a USDT payment path, `cancel_rwa`, a marketplace-sale marker); these additions only got a skim, see S-7 and S-8.

**This is a limited pass, not a full review.** It focused on the account constraints, the authority model, and the mint, marketplace, redemption-quote and lineage paths. It is an internal review, not an external audit.

Not covered: the body of `settle_and_burn` (lamport and token movements), arithmetic and overflow handling, `state.rs` and `error.rs` in detail, the rest of the redemption request flow, the tests, dependency versions (`Cargo.lock`), and the state of the deployed program on Devnet (items marked "To confirm").

Severities are proposed and relative to a production deployment.

## Summary

| ID | Title | Severity | Status |
|---|---|---|---|
| S-1 | The pause switch cannot be activated | Medium | Open |
| S-2 | Mint and configuration depend on two single keys | Medium | Open |
| S-3 | Config initialization is first-come | Medium | To confirm |
| S-4 | Program upgrade authority not reviewed | Medium | To confirm |
| S-5 | Backup file and leftover template code in the repository | Low | Open |
| S-6 | Attestor check is a handler check, not an account constraint, in two instructions | Low | Open |
| S-7 | `demo-usdt` build feature is on by default | Medium | Open |
| S-8 | USDT payment path and `cancel_rwa` added after the detailed pass | Medium | Not reviewed in depth |

## Findings

### S-1: The pause switch cannot be activated (Medium)
- **Where:** `Config.paused` (`state.rs`), checked in `increment`, `mint_rwa`, `request_redemption`, `settle_and_burn`, `list_rwa` and `buy_rwa`.
- **Issue:** the only place that writes the flag is `initialize.rs`, which sets it to `false`. No instruction in `lib.rs` sets it to `true`.
- **Impact:** in an incident there is no way to stop issuance, redemption or trading except upgrading the program.
- **Recommendation:** add a `set_paused` instruction restricted to the config authority (ideally a multisig), or document that incident response is a program upgrade. Keep `cancel_listing` usable while paused, as it is today.

### S-2: Mint and configuration depend on two single keys (Medium)
- **Where:** `Config.trusted_attestor` and `Config.authority`.
- **Issue:** the attestor signs series creation, minting and lineage operations. The Solana program cannot verify Ethereum state, so what gets minted depends on the attestor stating the truth. The authority can change the source chain id and the source lots contract through `update_source_config` immediately, with no delay.
- **Impact:** compromise or misuse of the attestor key allows minting for lots that do not exist on the source chain; compromise of the authority key allows redirecting the source contract.
- **Recommendation:** multisig for both roles, a timelock for `update_source_config`, and an explicit statement of this trust assumption in the project documentation.

### S-3: Config initialization is first-come (Medium, to confirm)
- **Where:** `initialize` creates the config PDA (seeds `["config"]`) with the caller as authority and the attestor passed as an argument. The only validation seen is that the attestor is not the default key.
- **Issue:** whoever calls `initialize` first on a fresh deployment decides the authority and attestor.
- **To confirm:** on Devnet, that `Config.authority` and `Config.trusted_attestor` are the team's wallets. Config PDA: `GU1uFTCr11nzmX7obL8ghpc9m8EpZJDEsUXZm7jibhtK`.
- **Recommendation:** initialize in the same transaction as deployment, or restrict `initialize` to the program's upgrade authority.

### S-4: Program upgrade authority not reviewed (Medium, to confirm)
- **Issue:** whoever holds the upgrade authority can change every rule described here.
- **To confirm:** on the Devnet explorer page of the program, who holds the upgrade authority. **Recommendation:** a multisig, or revoke it once the program is final.

### S-5: Backup file and leftover template code (Low)
`lib.rs.bak` is committed. The instruction that creates a series is named `increment`, which looks like a leftover from the Anchor template. `verify_series.rs` has 2 lines. Recommendation: remove the backup, rename the instruction, and confirm that unused code is not exposed through the program.

### S-6: Attestor check is not an account constraint in two instructions (Low)
`lineage.rs` binds the attestor with `address = config.trusted_attestor` in the account struct. `CreateSeries` (`increment.rs`) and `MintRwa` (`mint_rwa.rs`) declare it as a bare `Signer` and compare the key inside the handler. The checks exist (`increment.rs` line 97, `mint_rwa.rs` lines 127-128), but a future edit that drops the comparison would silently allow any signer. Recommendation: use the same `address =` constraint everywhere.

### S-7: `demo-usdt` build feature is on by default (Medium)
- **Where:** `Cargo.toml` (`default = ["demo-usdt"]`), `instructions/usdt.rs`.
- **Issue:** a default build accepts a demo payment token (a mint derived from the program, with no real value) as the payment currency. The code and a comment say production builds must use `--no-default-features`. The demo mint can only be created by the config authority, and the payment configuration is also authority-only, which limits the exposure.
- **Impact:** if the deployed program is built with the default features and the payment config points to the demo mint, trades and redemptions settle in a worthless token.
- **Recommendation:** make the demo feature opt-in instead of default, and check on-chain which payment mint the `usdt-payments` config uses before presenting it as real USDT. Official USDT mint in the code: `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB`.

### S-8: USDT payment path and `cancel_rwa` added after the detailed pass (Medium, not reviewed in depth)
- **What changed:** eight `*_usdt` instructions (list, buy, cancel listing, redemption request, quote update, settle and burn, plus two initializers), and `cancel_rwa`, which lets the issuer burn an unsold token with the attestor's co-signature.
- **Seen in the skim:** payment mint is bound to the stored config, decimals are checked, initializers are restricted to the config authority, `buy` sets a sticky "sold" marker (`Series.reserved = 1`), and `cancel_rwa` requires that marker to be 0 and no listing or redemption to exist. The comment says the attestor certifies the unsold history; current ownership alone does not prove it.
- **Residual trust:** the "never sold" guarantee for direct SPL transfers rests on the attestor (see S-2). The settlement token movements of the USDT path were not traced line by line.
- **Recommendation:** review the USDT settlement path before any real-value use, and add tests for the sold-marker and `cancel_rwa` rules.

## What looks right

- Privileged lineage paths bind the attestor with an account constraint, and series creation and minting check it in the handler.
- After minting, the mint authority and the freeze authority are both revoked (`set_authority(..., None)`), so supply stays at 1 with 0 decimals and the issuer cannot freeze the token.
- Token movements use `transfer_checked`. The marketplace escrow is a PDA-owned token account.
- `buy_rwa` requires `expected_price == listing.price_lamports`, the buyer to differ from the seller, and the seller account to equal `listing.seller`. `cancel_listing` is restricted to the seller and does not depend on the pause flag.
- `settle_and_burn` requires the passed amount to equal the stored quote (`RedemptionAmountChanged`), so the holder cannot raise the price after the issuer reviewed it. The holder can adjust the quote only while the redemption is in `REQUESTED` status, which the code comments describe as intended.
- Changing the issuer wallet requires the signatures of both the current and the new wallet.
- Lineage registration is bounded: at most 64 lots in the registry, at most 32 parents per lot, no duplicate parents, and a lot cannot be its own parent.
- A keyword search of the program source found no use of Token-2022 extensions such as transfer hook, permanent delegate or transfer fee. This was not verified on the deployed mints.
