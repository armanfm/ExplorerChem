ExploreChem CRE/TEE — Pairwise Mass Correlation Workflow

Confidential Chainlink CRE workflow for discovering physical handoffs between private supply-chain evidence, checking document integrity, calculating pairwise mass differences, and anchoring deterministic results on Ethereum Sepolia.

This directory contains the implemented workflow responsible for moving one new evidence from PENDING to MATCHED and anchoring its mass result. Final evidence audit is intentionally assigned to a separate Auditor workflow, currently being prepared for its own repository.

What this workflow does

For each execution, the workflow:

Reads the next PENDING evidence directly from ExploreChemRegistry.

Locates only the corresponding Supabase row.

Downloads the original private JSON inside the TEE execution.

Recalculates the document hash and compares it with the hash anchored on-chain.

Confirms that the evidence belongs to the same actorId recorded on-chain.

Extracts the committed lotId, origin, destination, actor type, and applicable mass fields.

Uses the Supabase lot_reference column only as a candidate-discovery index.

Reopens and verifies every candidate document before accepting it.

Reconstructs the connected lot component with strict bidirectional origin/destination rules.

Selects only the physical handoff that leaves the current focus evidence.

Compares the outgoing mass declared by the origin with the incoming mass declared by the recipient.

Produces deterministic pairId, aggregateInputHash, resultHash, and resultId values.

Stores the detailed private result in Supabase Storage.

Sends one correlation report and one balance report through the CRE forwarder.

Mirrors MATCHED in Supabase only after both blockchain writes succeed.

Architecture

flowchart TD
    A["ExploreChemRegistry: getNextPending"] --> B["TEE: open and verify focus JSON"]
    B --> C["Supabase index: candidates from same lot"]
    C --> D["TEE: verify candidate JSON files"]
    D --> E["Strict origin/destination correlation"]
    E --> F["Pairwise mass verification"]
    F --> G["Private canonical result"]
    G --> H["CRE reports: MATCH + BALANCE"]
    H --> I["Ethereum Sepolia"]
    H --> J["Supabase MATCHED mirror"]

The blockchain is the authority for identity, document hashes, evidence status, and anchored balance results. Supabase is used for private-file storage, actor lookup, candidate indexing, and UI mirroring.

Core design decisions

Blockchain-first discovery

The workflow always starts with:

getNextPending()

Supabase does not choose the authoritative evidence. A candidate can become the focus only when getEvidence(evidenceId) confirms EvidenceStatus.PENDING on-chain.

The result belongs to the origin document

The correlated component may contain several actors, but one execution creates a result only for the physical handoff leaving the focus evidence.

For a miner-to-carrier handoff:

focus = miner evidence
comparison = miner outgoing mass versus carrier received mass
result owner = miner actorId and miner evidenceId

When the carrier later becomes the origin of another handoff, its evidence becomes the focus of a different execution and produces a different result hash. Hashes are not expected to be equal because the owner, focus evidence, counterpart, and calculation content change.

Strict physical correlation

A PHYSICAL_HANDOFF is accepted only when all three conditions are true:

from.lotId == to.lotId
from.destinationActorId == to.ownerActorId
to.originActorId == from.ownerActorId

There is no fallback to approximate actor names, equal masses, nearby timestamps, or self-referential origin/destination values.

Mass does not discover a relationship. Mass is evaluated only after the relationship has been established.

Supabase is an index, not proof

The lot_reference database column narrows candidate discovery to one lot. It does not prove that a candidate belongs to that lot.

For every returned row, the workflow still:

reads the corresponding evidence on-chain;

downloads the original JSON;

recalculates the declared hash algorithm;

checks the document hash against the blockchain;

confirms the owner actorId;

extracts the real lotId from the committed document;

rejects any divergence between the index and the document.

Bidirectional BFS reconstruction

The workflow expands the same-lot component in both directions. Every newly verified document can reveal the next valid relationship.

This graph reconstruction is used to understand the private lot chain. It does not cause a global mass sum. The committed result remains limited to the outgoing physical edge of the current focus.

Laboratory evidence is not a physical handoff

Laboratory evidence may be connected as LAB_ANALYSIS when it belongs to the same lot and points to the relevant destination actor.

It does not create a physical mass edge and does not generate a PairMassResult. Sample mass is analytical evidence, not custody-flow mass.

Document integrity checks

The workflow accepts private JSON evidence using either:

SHA-256 / SHA256;

KECCAK-256 / KECCAK256.

An evidence is rejected before correlation when any of these checks fails:

Check

Authoritative comparison

Evidence identifier

Supabase evidence_id against on-chain evidenceId

Indexed hash

Supabase evidence_hash against on-chain evidenceHash

Original document

Recalculated file hash against on-chain evidenceHash

Evidence owner

Supabase actor lookup against on-chain actorId

Actor type

JSON actorType, when present, against the registered actor type

Lot index

Supabase lot_reference against the committed JSON lotId

The JSON actor identifier is not authoritative for ownership. Ownership is resolved through:

explorerchem_evidences.actor_db_id
→ explorerchem_actors.actor_id
→ ExploreChemRegistry Evidence.actorId

Mass-field selection

All accepted decimal kilogram values are converted to integer milligrams. Conversion uses deterministic half-up rounding when more than six decimal places are supplied.

Outgoing side

Origin actor type

Preferred field

MINER

outputMassKg, otherwise massBalance.grossMassKg

CARRIER

custody.massDeliveredKg, otherwise outputMassKg

PROCESSOR / REFINER

transformation.outputMassKg

MANUFACTURER to RECYCLER

transformation.scrapMassKg

Other MANUFACTURER handoff

outputMassKg, otherwise transformation.scrapMassKg

RECYCLER

recovery.recoveredProductMassKg, otherwise outputMassKg

Incoming side

Recipient actor type

Preferred field

CARRIER

custody.massCollectedKg, then inputMassKg, then massBalance.grossMassKg

PROCESSOR / REFINER / MANUFACTURER / RECYCLER

transformation.inputMassKg, then massBalance.grossMassKg, then custody.massCollectedKg

Other physical recipient

inputMassKg, then custody.massCollectedKg, then massBalance.grossMassKg

LABORATORY

no physical mass

Pairwise calculation

For each outgoing physical edge of the focus:

deltaMg = leftMassMg - rightMassMg

The result is classified as:

Condition

Status

deltaMg == 0

CONFORME

deltaMg != 0

DIVERGENTE

Either mass is absent

NAO_ATESTADO

The current version uses exact equality. It does not apply a tolerance band, uncertainty propagation, moisture normalization, oxide conversion, or periodic elemental MUF calculation.

Deterministic commitments

No random salt or timestamp participates in the current commitment. Identical canonical inputs reproduce identical hashes.

The workflow uses explicit domain separation:

Commitment

Domain

Pair identity

ExploreChem/PairwiseMassPair/v1

Relationship fingerprint

ExploreChem/PairwiseMassRelation/v1

Input commitment

ExploreChem/PairwiseMassInput/v1

Canonical result

ExploreChem/PairwiseMass/v1

Result identifier

ExploreChem/PairwiseMassResultId/v1

The canonical result includes:

calculationVersion
actorId
focusEvidenceId
lotReference
evidenceIds
correlationEdges
massPairs
status

canonicalResultHash is also used as the contract-facing resultHash.

Private and public data boundaries

Kept private

original JSON documents;

lot identifier;

origin and destination references;

company names and sites;

individual mass values;

selected mass-field names;

correlation edges;

complete pairwise calculation;

private canonical result manifest.

Anchored on-chain

focus evidenceId;

result owner actorId;

deterministic resultId;

deterministic resultHash;

aggregateInputHash;

balance status;

calculation version;

transaction and block history emitted by the contract.

Detailed private results are written to:

mass-results/{focusEvidenceId-without-0x}/{resultId-without-0x}.json

CRE report format

The workflow sends a static nine-word ABI report compatible with ExploreChemRegistry.CREReport:

Position

Field

Type

1

reportType

uint8

2

evidenceId

bytes32

3

resultId

bytes32

4

actorId

bytes32

5

resultHash

bytes32

6

previousResultId

bytes32

7

aggregateInputHash

bytes32

8

balanceStatus

uint8

9

calculationVersion

uint32

Encoded length:

9 × 32 bytes = 288 bytes

This workflow emits:

reportType = 1 for evidence correlation;

reportType = 2 for the pairwise mass result.

It does not emit reportType = 3. Final audit belongs to the separate Auditor workflow.

Evidence lifecycle

Within this workflow:

PENDING
  → strict correlation and integrity verification
MATCHED
  → pairwise result already anchored, awaiting independent audit

The workflow deliberately ends at MATCHED. A separate Auditor workflow is being prepared to consume getNextMatched() and finalize the evidence as VERIFIED or DIVERGENT.

Each new shipment or order creates a new evidenceId. A historical evidence is never reused as the identity of a new transaction.

Supabase dependencies

explorerchem_actors

The workflow reads:

id
actor_id
display_name
actor_type
active
created_at

explorerchem_evidences

The workflow reads:

evidence_id
actor_db_id
state
evidence_hash
hash_algorithm
storage_bucket
storage_path
mime_type
lot_reference
chain_created_at

After successful blockchain writes, it updates:

state = MATCHED
matched_at
match_tx_hash

Private Storage

The original document must be available at the authenticated object path represented by storage_bucket and storage_path.

The service-role key is never stored in the repository. It is requested inside the TEE from the configured secret namespace under:

SUPABASE_SERVICE_ROLE_KEY

Configuration

The workflow validates these configuration fields at startup:

Field

Required

Purpose

supabaseUrl

yes

Supabase project URL

secretNamespace

yes

Namespace containing the service-role secret

chainSelectorName

yes

CRE EVM network selector name

contractAddress

yes

Deployed ExploreChemRegistry address

gasLimit

yes

Gas limit used by writeReport

correlationSchedule

no

Cron schedule override

Default schedule:

0 0 0 * * 0

The production trigger requests AWS Nitro in us-west-2 through handlerInTee. The local simulator is not a real TEE and must not be used with production confidential data.

Installation and simulation

Install dependencies inside the workflow directory:

cd explorerchem-workflow
bun install

Compile and simulate with blockchain writes enabled:

cre workflow simulate . --broadcast

Alternatively, from the repository root, target the workflow directory directly:

cre workflow simulate explorerchem-workflow --broadcast

--broadcast is required to persist the correlation and balance reports on Sepolia. Without it, the simulator can execute the logic but does not create the authoritative on-chain state transition.

Before broadcasting, the contract must trust the workflow ID delivered in the forwarder metadata. expectedWorkflowId protects correlation reports. Balance reports use expectedBalanceWorkflowId when it is nonzero; otherwise they fall back to expectedWorkflowId.

Simulation progression fallback

Some simulation executions can return the same on-chain pending evidence when simulated writes do not advance state between runs.

The workflow contains a controlled fallback:

getNextPending() is still called first.

If that evidence is already MATCHED in the Supabase simulation mirror, the workflow loads a limited set of other Supabase rows still marked PENDING.

Every fallback candidate must independently return on-chain status PENDING before selection.

This mechanism exists only to advance simulation. It does not make Supabase authoritative.

The output identifies the selection path as either:

CHAIN_GET_NEXT_PENDING
SIMULATION_PROGRESS_FALLBACK

Failure behavior

The workflow does not anchor a result when:

no on-chain PENDING evidence exists;

the focus evidence cannot be resolved in Supabase;

the original file is missing or is not JSON;

the indexed hash diverges from the blockchain;

the recalculated document hash diverges from the blockchain;

the document owner diverges from the on-chain actor;

lotId is absent;

the lot_reference index diverges from the committed document;

origin and destination are both absent;

no strict outgoing physical handoff exists for the focus;

the focus leaves PENDING before the final write gate;

the CRE report transaction fails;

the receiver contract reverts.

Candidate-specific failures are isolated in candidateErrors, allowing other valid same-lot candidates to continue through correlation.

What this workflow does not claim

This implementation does not claim to:

prove that a physical delivery happened in the real world without independently submitted recipient evidence;

perform periodic plant-wide mass reconciliation;

calculate elemental mass for Nd, Pr, Dy, or Tb;

normalize wet, dry, calcined, or liquid mass bases;

calculate inventory-adjusted MUF;

apply uncertainty bands or statistical thresholds;

preserve molecular identity after material transformation;

replace sampling, laboratory accreditation, or commercial arbitration;

finalize evidence as VERIFIED or DIVERGENT without the separate Auditor workflow.

Current scope and next workflow

The implemented scope closes one responsibility:

Given private evidence anchored by hash, discover the next strict physical handoff, compare the origin's outgoing mass with the recipient's incoming mass, and anchor a deterministic result owned by the origin evidence.

The next repository will contain the independent Auditor workflow. It will consume evidence already left as MATCHED by this workflow and will issue the final VERIFIED or DIVERGENT evidence verdict after checking the anchored private result.

Author

Armando Freire — technical design, smart contracts, Chainlink CRE/TEE workflow, Supabase integration, and blockchain anchoring.

ExploreChem is being developed for ETHOnline 2026. Demonstration company names, lot identifiers, document references, quantities, and results are fictional.
