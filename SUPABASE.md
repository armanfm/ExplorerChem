# ExploreChem — Supabase Architecture and Setup

This package creates the ExploreChem MVP database without sample or fictional
data. It is designed to work with the `ExploreChemRegistry` contract, the
private ExploreChem backend, and the Chainlink CRE/TEE workflows.

## What is implemented

### Product-facing layer

The tables in the `public` schema are protected by Row Level Security:

| Area | Tables |
|---|---|
| Users and organizations | `explorerchem_user_profiles`, `explorerchem_actors`, `explorerchem_actor_private_details`, `explorerchem_actor_memberships`, `explorerchem_actor_wallets` |
| Lots and chain of custody | `explorerchem_lots`, `explorerchem_lot_participants`, `explorerchem_transfers` |
| Evidence | `explorerchem_evidences`, `explorerchem_evidence_access`, `explorerchem_transfer_evidences` |
| Results and clients | `explorerchem_balance_results`, `explorerchem_result_access`, `explorerchem_client_invitations`, `explorerchem_report_files` |

### Private CRE/TEE layer

The `explorerchem_private` schema is not accessible to either `anon` or
`authenticated`. It contains:

- the history of document extractions and re-extractions;
- append-only comparisons between anchored and recomputed hashes;
- the deterministic pending-evidence queue;
- private correlation groups;
- graph edges and the verification performed in each execution;
- workflow execution records;
- physical flows protected against double counting;
- element-level mass balances;
- private manifests committed by `resultHash`;
- database-side operational audit records.

The `correlation_group_id` is only a discovery index. Trust comes from the
verification rows recorded in `edge_verifications` for each `workflow_run_id`.

## Applying the migration

1. Create the Supabase project.
2. Open the SQL Editor.
3. Run `supabase/migrations/202609050001_explorerchem_core.sql` in full.
4. Run `supabase/tests/verify_explorerchem_schema.sql`.
5. Create the first user in Authentication.
6. In `explorerchem_user_profiles`, grant platform-administrator status only
   to the correct user. Perform this elevation through the Supabase dashboard
   or the backend using the `service_role`; never perform it in the browser.

The migration also creates two private buckets:

- `explorerchem-evidence`: PDF, PNG, or JPEG files up to 20 MiB;
- `explorerchem-reports`: PDF or JSON files up to 20 MiB.

## Identity and authorization

Supabase Auth identifies the application user. Organization membership is
stored in `explorerchem_actor_memberships`, while authorized wallets are stored
in `explorerchem_actor_wallets`.

The `explorerchem_actors` directory contains only the operational identity that
a direct counterparty may need. Legal name, tax identifier, registered address,
and responsible contacts are stored in `explorerchem_actor_private_details` and
are visible only to the organization itself and the ExploreChem platform
administration.

| Profile | Effective access |
|---|---|
| ExploreChem administrator | Public operational entities; private data only through the backend |
| Actor administrator | Organization, members, wallets, lots, and permissions under its control |
| Operator or submitter | Evidence submission for its own actor |
| Viewer | Authorized read access without submission privileges |
| Carrier | Assigned transfers and the controlled delivery RPC only |
| Invited client | Explicitly shared results and report files only |
| CRE/TEE | Required data through the private ExploreChem API |

The prototype's URL `role` parameter is not an authorization mechanism.
Authorization is determined by the authenticated session, memberships, explicit
grants, and RLS policies.

## Evidence submission flow

1. The browser reads the original file bytes.
2. It calculates a 32-byte hash using the same algorithm adopted by the
   contract and the TEE.
3. It calls `explorerchem_create_evidence_draft`.
4. The function automatically creates the `evidence_id`, display code, and
   immutable Storage path.
5. The browser uploads the file to the returned path in the
   `explorerchem-evidence` bucket.
6. The authorized wallet calls `submitEvidence` on the contract.
7. The backend verifies the transaction receipt and the `EvidenceSubmitted`
   event.
8. Only after that verification does the backend call
   `explorerchem_private.record_chain_submission`.
9. The evidence becomes `PENDING` and enters the deterministic queue.

The file is never placed on-chain. The contract receives only `evidenceId`,
`actorId`, the submitting wallet, `evidenceHash`, state, and timestamps.

The lot selected in the interface is stored as `declared_lot_db_id` only to
guide submission. Manual input does not make it trusted data. After rereading
the anchored document, the CRE/TEE records the confirmed association in
`verified_lot_db_id` and in the extracted private metadata.

## CRE/TEE flow

The workflow does not receive the Supabase secret key or direct unrestricted
database access. The expected design is:

1. `EvidenceSubmitted` triggers the backend or indexer.
2. The backend creates a correlation `workflow_run`.
3. `explorerchem_private.claim_pending_evidence` consumes the queue using FIFO
   ordering and `FOR UPDATE SKIP LOCKED`.
4. The TEE calls the private ExploreChem API.
5. The API uses `explorerchem_private.get_evidence_bundle` to retrieve the
   document, the latest extraction, and the required context.
6. The TEE recomputes `evidenceHash` from the original file bytes.
7. Metadata is extracted again, a new append-only row is written to
   `evidence_extractions`, and the relationships are verified.
8. The candidate group accelerates discovery, but every graph edge is
   revalidated.
9. After the correlation report is confirmed on-chain, the backend calls
   `explorerchem_private.record_correlation_match`.
10. The evidence moves from `PENDING` to `MATCHED`.

If there is not enough evidence to establish a counterpart, the evidence
remains `PENDING`. The queue supports retries and scheduled recovery scans; no
evidence depends on random selection.

## Transport and double-counting protection

The carrier updates only the fields permitted by
`explorerchem_record_transport_delivery`. It cannot change the origin,
destination, lot, or assigned carrier.

Transport documents enter `explorerchem_transfer_evidences` with one of these
roles:

- `CUSTODY_ONLY`;
- `COMMERCIAL_ONLY`;
- `COMPOSITION_ONLY`.

These roles corroborate the physical stream and do not add the same mass a
second time. In `physical_flows`, the unique `canonical_flow_key` constraint
prevents the same stream from being registered twice in one calculation.

## Results and history

Each public result belongs to one actor and has its own `resultHash`. Different
partners do not share the same public hash.

The implemented protections are:

- `explorerchem_balance_results` is append-only;
- an actor's first result may start at the lot's current version;
- each later version must reference the latest version for the same actor and
  lot;
- a result enters the public table only after its blockchain anchor is
  confirmed;
- the complete manifest remains in
  `explorerchem_private.result_manifests`;
- `private_nonce_ciphertext` stores only the encrypted nonce;
- there is no public `aggregateInputHash`;
- no list of correlated evidence is included in a transaction.

## Credentials

The front end uses only the project's publishable key together with the
Supabase Auth session. The secret key associated with the `service_role` exists
only in the ExploreChem backend.

The CRE/TEE authenticates to the private API using a secret held in the
appropriate vault. The API verifies the workflow identity and performs only the
required internal operations. The workflow must not connect directly to the
database with unrestricted administrative access.

## Next integration step

After the migration is applied, the prototype must replace its local arrays
with:

- a real Supabase Auth session;
- queries filtered by RLS;
- the RPC call that creates the evidence draft;
- upload to private Storage;
- wallet signing and transaction submission;
- authorized result and report retrieval.

No URL, key, wallet, contract address, or company data is invented in this
package. Those values must come from the real Supabase project and contract
deployment.
