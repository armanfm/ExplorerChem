# Physical evidence, calculations and private lots

[Back to README](../README.md)

## Key terms

- **E1:** the current physical-lot model, which stores public commitments and lineage while keeping quantities and commitment openings private.
- **MUF (Material Unaccounted For):** the difference between accounted material inputs and outputs, including inventory changes.
- **Opening:** the private quantities and salt needed to verify a lot against its public commitment.
- **Lineage:** the parent/child relationships between lots created by physical transformations.
- **Lineage reservation:** an issuer-scoped record that prevents overlapping active economic issuance on a lot and its ancestors or descendants.
- **Series:** the economic instrument associated with an issuer and a source lot, represented by a single indivisible RWA token.

## Evidence, MUF and Elemental

A company submits an original private JSON document. Its hash is anchored with the actor and submitter. Workflows retrieve the document and compare its hash with the on-chain commitment before using its contents.

MUF and Elemental are separate proofs for the same evidence:

| **Proof** | **Code** | **Purpose**                                        |
| --------- | -------- | -------------------------------------------------- |
| MUF       | `1`      | Total-mass accounting                              |
| Elemental | `3`      | Elemental accounting and associated lot operations |

| **State**    | **Code** | **Meaning**                                     |
| ------------ | -------- | ----------------------------------------------- |
| NONE         | `0`      | No recorded state                               |
| PENDING      | `1`      | Awaiting the corresponding proof                |
| CALCULATED   | `2`      | Supported calculation/checks succeeded          |
| DIVERGENT    | `3`      | A supported divergence was detected             |
| NOT_ATTESTED | `4`      | Available inputs do not support the attestation |

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

Elemental checks the original evidence and committed private MUF result, reconciles the supported streams, and calculates elemental quantities from the declared assays and supported compound conversions. The supported elemental calculations include Nd, Pr and Dy, according to the declared assays and conversion rules used by the workflow.

For transformations, the workflow resolves the specific input lot references supplied by the document and verifies their private openings against their public commitments. Each lot is accounted for through its own identifier and opening; other lots are not added to the operation unless explicitly referenced. It rejects represented outputs exceeding input material or any tracked elemental quantity. Differences remain part of private accounting and do not become independently tradable lots unless represented by valid outputs.

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

| **State**  | **Meaning**                                                   |
| ---------- | ------------------------------------------------------------- |
| NONE       | Identifier not registered                                     |
| ACTIVE     | Available for supported operations, subject to current proofs |
| IN_ESCROW  | Locked in a physical custody order                            |
| ENCUMBERED | Locked through the contract's collateral-agent mechanism      |
| CONSUMED   | Used by a transformation; unavailable for reuse               |

Physical receipt requires the relevant recipient's acceptance/confirmation under the custody flow. The receiving interface exposes authorized private quantities so the recipient can inspect the lot. Expiry does not itself prove receipt or resolve a dispute.

The physical contract's encumbrance mechanism is distinct from the current RWA policy. **Issuing an economic right does not automatically require freezing the physical lot.** Selling, receiving or transforming the material can continue under the physical contract's own rules. An explicitly encumbered lot remains subject to that contract's restrictions.

### Integrity controls

| **Control**                          | **Protection**                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------ |
| Salted, domain-separated commitments | Detect modified openings and bind their source domain                          |
| Bound operation hashes               | Link evidence, proofs, contract/network, operation, inputs and outputs         |
| Duplicate-input rejection            | Prevent the same input appearing twice in one operation                        |
| Used-operation/evidence tracking     | Prevent replay and reuse of evidence for another physical lot operation                        |
| Unique output IDs                    | Prevent replacing an existing lot                                              |
| Whole-lot consumption                | Prevent consumed inputs being used again                                       |
| Current ancestry proofs              | Require applicable current proofs throughout usable ancestry                   |
| Ethereum atomic execution            | Anchor the Elemental proof and its physical operation together, or revert both |
| Integer arithmetic                   | Avoid floating-point mass accumulation                                         |

Authorized workflows perform the private arithmetic. The contract does not recompute secret mass accounting. Commitments are not zero-knowledge proofs or evidence that a laboratory measurement is true.

The E1 report uses canonical encoding and chain/registry binding; the workflows expect registry version `3`. Documented prototype bounds are 32 inputs/outputs and 256 visited ancestry nodes. Source admission and physical verification remain necessary to detect material falsely introduced under unrelated initial identifiers.

## Privacy and access

| **Information**                                                           | **Visibility**       |
| ------------------------------------------------------------------------- | -------------------- |
| Actor IDs, controllers and authorized Ethereum wallets                    | Public               |
| Evidence/proof hashes, states and events                                  | Public               |
| Lot IDs, commitments, holders and lineage                                 | Public               |
| Masses, elemental quantities, purity, inventory and detailed calculations | Restricted off-chain |
| Private openings, salts and original documents                            | Restricted off-chain |
| Solana mints, token balances, transfers, offers and SOL payments          | Public               |

Detailed quantities and the composition chart are available in the authorized private company/physical receiving view. The public RWA catalogue does not expose those numerical results. An elemental presence indicator, when displayed, identifies elements such as Nd, Pr and Dy without publishing mass, percentage or purity.

Public metadata can still reveal timing and business relationships. Previously published data cannot be made private retroactively. A hidden tab or an “access private” label is not authorization: storage policies and API responses must enforce the permitted scope. Do not publish openings or salts.
