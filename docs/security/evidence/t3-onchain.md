# T3: On-chain privacy evidence (Sepolia)

**Question:** what does an observer of the chain actually see when evidence is submitted and proofs are anchored?

**Answer (for the transactions below):** only identifiers, 32-byte hashes, small enums (proof type, status, revision) and timestamps. No masses, compositions, substance names or salts appear in the calldata, in the decoded report or in the event logs.

Reviewed commit: `6ce6150`. Network: Sepolia (chainId 11155111). RPC used: `https://ethereum-sepolia-rpc.publicnode.com`.

## Transactions analysed

| # | Type | Tx hash | Block | To |
|---|---|---|---|---|
| A | `submitEvidence` | [`0x247430d1…12d4`](https://sepolia.etherscan.io/tx/0x247430d1844c59e613e063e5e31e7285d181576cba0f4ebfd8dc7a9288ce12d4) | 11840121 | ProofRegistry |
| B | `submitEvidence` | [`0x4d4f8a1c…c813`](https://sepolia.etherscan.io/tx/0x4d4f8a1c323c97bfb3d3bf50b3cb9a5e3c1767d14019790501e08551f74cc813) | 11840134 | ProofRegistry |
| C | `report(...)` → `onReport`, proof type 1 | [`0x079a09b5…15c0`](https://sepolia.etherscan.io/tx/0x079a09b5851fa1f2fa1aec2f29e122d8f54216eafaea47fdfde908f81fad15c0) | 11840081 | MockKeystoneForwarder `0x15fC…9F88` |
| D | `report(...)` → `onReport`, proof type 3 | [`0xfa924a93…3942`](https://sepolia.etherscan.io/tx/0xfa924a93b4fc4952df2b2e3dce5353f43f876886ac8e89ea6e5fe18860373942) | 11840085 | MockKeystoneForwarder `0x15fC…9F88` |
| E | `EvidenceSubmitted` emitted via `redeemDelegations` | [`0xbcf11d3f…973e`](https://sepolia.etherscan.io/tx/0xbcf11d3f452fabc01ba822bc21450c334169868a7d17ca8b53096aa9889b973e) | 11840076 | delegation manager (`0xcef6d209`) |

Reproduce:

```bash
RPC=https://ethereum-sepolia-rpc.publicnode.com
cast tx <HASH> --rpc-url $RPC
cast receipt <HASH> --rpc-url $RPC
```

## A and B: `submitEvidence` (selector `0x804bc994`)

Calldata is the selector followed by exactly three 32-byte words.

| Word | Meaning | Tx A | Tx B |
|---|---|---|---|
| 1 | evidenceId | `0x07edd412…f08bfa5` | `0x614116d7…759a7469` |
| 2 | actorId | `0x2fd9c782…e064f7c` | `0x2fd9c782…e064f7c` |
| 3 | evidenceHash | `0xbcd1583b…ff79566` | `0xf0027756…4b4e4b7` |

The `EvidenceSubmitted` log repeats these values and adds `submittedBy` (`0xAD9e…401c`) and `createdAt` (2026-10-04 04:49:24 UTC for A, 04:52:48 UTC for B). Gas used: 172,166 for both.

Observation: both evidences belong to the same `actorId`. Activity of one actor is linkable on-chain even though the content is not readable.

## C and D: reports delivered through the forwarder (selector `0x11289565`)

The transaction goes to the forwarder, which calls `onReport` on the ProofRegistry. The `rawReport` inside the calldata decodes as follows.

**Header (identical in C and D)**

| Field | Value |
|---|---|
| version | `01` |
| workflowExecutionId | `0xec7ae6a4…1555cb` (same execution produced both reports) |
| timestamp | `0x64` (100) |
| donId / configVersion | 1 / 1 |
| workflowId | `0x1111…1111` (32 bytes of `0x11`) |
| workflowName | `ebb203df73` |
| workflowOwner | `0xaaaa…aaaa` (20 bytes of `0xaa`) |
| reportId | `0x0001` |

These values are simulator placeholders, not a real workflow identity (see Observations).

**Body, tx C (proof type 1, 10 words):** type `1`; evidenceId `0x800e9a5b…ba4b2`; one unlabeled 32-byte hash `0xc39f5c98…c58983`; proofId `0xfc7fc077…492be8`; committedHash `0xd12554a0…4379ea`; inputCommitmentHash `0x19bcca18…64e55a`; methodologyHash `0xd0ede3ca…ae43ea`; previousProofId `0`; status `2` (CALCULATED); revision `1`.

**Body, tx D (proof type 3, 25 words):** the same proof fields (proofId `0x2a38b8ab…4a0874`, committedHash `0x725c0c2e…49444d`, inputCommitmentHash `0xd1415947…2f7c16`, methodologyHash `0x314c9a7b…80b38a`, status `2`, revision `1`), plus the chainId (`11155111`), the ProofRegistry address and a lot output: array length 1, an operation hash `0xfde0705e…9a27`, the actorId, an empty input list and one output entry (lot id `0xa2825a02…89427`, lot commitment `0x27d8c018…c77639`, actorId).

Every non-hash value in both bodies is a small enum or counter: 1, 2, 3, 0, array lengths, offsets and the chainId. **There is no field that carries a mass, quantity or composition.**

**Logs of tx D:** `ProofAnchored` (ProofRegistry); three events from the Lots contract `0x92eF…74a3` (topics are lot id, operation hash, actor id; data are hashes and a count); and the forwarder's processed-report event with success `1`.

**`ProofAnchored` fields (both transactions):** proofId, evidenceId, proofType, committedHash, status, revision, previousProofId, inputCommitmentHash, methodologyHash, workflowId, createdAt. All are hashes, enums or timestamps.

## Conclusion

On-chain, only commitments and identifiers are public. Quantities, compositions and salts are not present in any of the four transactions. What an observer can still learn: how many proofs exist for an evidence, their status (here CALCULATED), the proof types that ran, the actor behind an evidence, and timing.

## Observations for the findings list

1. **Simulation identity (supports N-1).** `workflowId = 0x11…11`, `workflowOwner = 0xaa…aa`, `workflowName = ebb203df73`, timestamp 100. The reports were delivered by the mock forwarder with simulator metadata. The contract only reads `workflowId` from the metadata (confirmed in code review), so owner and name are not validated. Whether the mock forwarder accepts any caller was not tested here.
2. **Same sender.** All four transactions were sent by the owner EOA `0xAD9e…401c`, which also owns the three contracts (F-1).
3. **Cross-chain replay hint.** The proof-type-3 report embeds chainId and the registry address; the proof-type-1 report does not (not analysed further).
4. **Evidence submitted through a delegation.** The evidence `0x800e9a5b…` used in C and D was registered by an `EvidenceSubmitted` event (block 11840076, `createdAt` 1791088752 = 2026-10-04 04:39:12 UTC, tx [`0xbcf11d3f…973e`](https://sepolia.etherscan.io/tx/0xbcf11d3f452fabc01ba822bc21450c334169868a7d17ca8b53096aa9889b973e)) emitted inside a call to `redeemDelegations` (selector `0xcef6d209`), not by a direct call to the ProofRegistry. That is why it does not appear in the ProofRegistry's transaction list. Its `evidenceHash` is `0xc39f5c98…c58983`, which confirms that the extra hash in the C and D report bodies is the evidence hash. The delegation setup (who is the delegate, which restrictions apply) is outside the reviewed contracts and is to be confirmed with the tech lead.

## Limits of this evidence

Five transactions on one testnet deployment; not an exhaustive review of every possible report. Field labels in the report body are inferred from the `ProofAnchored` event and from the code (the evidence-hash label is confirmed by tx E); the exact field names should be checked against the `ReportV3` struct.
