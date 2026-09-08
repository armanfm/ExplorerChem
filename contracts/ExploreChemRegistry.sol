// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title Minimal ERC-165 interface
/// @notice Exposes ERC-165 interface detection used by the Chainlink CRE forwarder.
interface IERC165 {
    /// @notice Reports whether an interface is supported.
    /// @param interfaceId ERC-165 interface identifier.
    /// @return `true` if the interface is supported.
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

/// @title Chainlink CRE receiver interface
/// @notice Defines the callback invoked by the KeystoneForwarder.
/// @dev Implementations are expected to validate both the caller and report metadata.
interface IReceiver is IERC165 {
    /// @notice Receives an authenticated report from the Chainlink forwarder.
    /// @param metadata Forwarder metadata containing the workflow identifier.
    /// @param report ABI-encoded report payload.
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

/// @title ExploreChemRegistry
/// @notice Stores minimal on-chain identities, evidence commitments, audit verdicts,
///         and mass-balance result commitments for ExploreChem.
/// @dev The contract intentionally does not model the commercial relationship between
///      participants. It stores only the submitting identity, exact document hash,
///      evidence state, and minimal mass-balance commitments.
///
///      Sensitive or correlatable business data such as lot identifiers, origin,
///      destination, company identifiers, actor types, document references, masses,
///      concentrations, files, salts, manifests, and correlation fields remain off-chain.
///
///      Correlation, private-data validation, and mass-balance computation are performed
///      by authenticated Chainlink CRE/TEE workflows. This contract only validates the
///      authenticated delivery context and persists the resulting commitments or verdicts.
contract ExploreChemRegistry is IReceiver {
    // ---------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------

    /// @title Evidence lifecycle status
    /// @notice Represents the current on-chain state of an evidence record.
    /// @dev `NONE` is the storage zero value and distinguishes a missing record from `PENDING`.
    enum EvidenceStatus {
        NONE,
        PENDING,
        MATCHED,
        VERIFIED,
        DIVERGENT
    }

    /// @title Mass-balance attestation status
    /// @notice Represents the outcome committed for a mass-balance calculation.
    enum BalanceStatus {
        NONE,
        CONFORME,
        DIVERGENTE,
        NAO_ATESTADO
    }

    /// @title Actor identity
    /// @notice Minimal on-chain identity record for an ExploreChem participant.
    /// @param actorId Opaque actor identifier.
    /// @param controller Address with administrative control over the actor.
    /// @param createdAt Timestamp at which the identity was registered.
    struct ActorIdentity {
        bytes32 actorId;
        address controller;
        uint64 createdAt;
    }

    /// @title Evidence record
    /// @notice Stores the immutable document commitment and mutable verification state.
    /// @param evidenceId Opaque evidence identifier.
    /// @param actorId Actor identity that owns the evidence.
    /// @param submittedBy Wallet that submitted the evidence.
    /// @param evidenceHash Hash of the exact committed document bytes.
    /// @param status Current evidence lifecycle status.
    /// @param createdAt Submission timestamp.
    /// @param matchedAt Timestamp of the most recent successful CRE match.
    /// @param auditedAt Timestamp of the most recent auditor verdict.
    struct Evidence {
        bytes32 evidenceId;
        bytes32 actorId;
        address submittedBy;
        bytes32 evidenceHash;
        EvidenceStatus status;
        uint64 createdAt;
        uint64 matchedAt;
        uint64 auditedAt;
    }

    /// @title Mass-balance result commitment
    /// @notice Stores one immutable mass-balance result revision for an evidence.
    /// @param resultId Unique result identifier.
    /// @param evidenceId Evidence to which the result belongs.
    /// @param actorId Actor identity to which the result belongs.
    /// @param resultHash Commitment to the private result.
    /// @param previousResultId Previous result revision, or zero for a root revision.
    /// @param aggregateInputHash Commitment to the private canonical input manifest.
    /// @param status Mass-balance attestation status.
    /// @param calculationVersion Sequential revision number for this result chain.
    /// @param createdAt Timestamp at which the result was anchored.
    /// @dev One immutable result per partner and revision.
    ///      CRE/TEE computes resultHash and aggregateInputHash OFF-CHAIN,
    ///      with fresh cryptographically random private salts per partner
    ///      and revision, and distinct hash domains for the two commitments.
    ///      Store the same resulting hashes in Supabase and on-chain.
    ///      Never send salts, manifests, evidence lists or group IDs here.
    ///      The contract checks neither salt quality nor hidden membership:
    ///      those are responsibilities of the authenticated CRE/TEE workflow.
    struct BalanceResult {
        bytes32 resultId;
        bytes32 evidenceId;       // Evidence to which this result belongs
        bytes32 actorId;
        bytes32 resultHash;
        bytes32 previousResultId; // Previous revision for the same evidence
        bytes32 aggregateInputHash;
        BalanceStatus status;
        uint32 calculationVersion;
        uint64 createdAt;
    }

    /// @title CRE report payload
    /// @notice Static report structure delivered by the authenticated CRE forwarder.
    /// @param reportType Report discriminator: correlation, balance, or audit.
    /// @param evidenceId Evidence targeted by the report.
    /// @param resultId Result identifier for balance reports.
    /// @param actorId Actor identifier for balance reports.
    /// @param resultHash Private result commitment for balance reports.
    /// @param previousResultId Previous revision for balance reports.
    /// @param aggregateInputHash Commitment to the private canonical input manifest.
    /// @param balanceStatus Balance status, or evidence audit verdict for audit reports.
    /// @param calculationVersion Sequential balance-result revision.
    /// @dev `abi.encode(CREReport)` is a static tuple of nine ABI words.
    ///      Type 1 (correlation): reportType + evidenceId.
    ///      Type 2 (mass result): evidenceId + result/actor/hash/version fields.
    ///      Type 3 (audit): reportType + evidenceId + balanceStatus, where
    ///      balanceStatus carries uint8(EvidenceStatus.VERIFIED|DIVERGENT).
    ///      One evidence/result per invocation. No arrays.
    struct CREReport {
        uint8 reportType;
        bytes32 evidenceId;
        bytes32 resultId;
        bytes32 actorId;
        bytes32 resultHash;
        bytes32 previousResultId;
        bytes32 aggregateInputHash;
        uint8 balanceStatus;
        uint32 calculationVersion;
    }

    uint8 public constant REPORT_CORRELATION = 1;
    uint8 public constant REPORT_BALANCE = 2;
    uint8 public constant REPORT_AUDIT = 3;

    uint256 public constant REPORT_LENGTH = 9 * 32;

    /// @notice Maximum lifetime of a `PENDING` evidence before it can no longer be matched.
    /// @dev Expiration is derived from `createdAt`; no transaction mutates an evidence merely
    ///      because time has passed.
    uint64 public constant EVIDENCE_TTL = 365 days;

    // ---------------------------------------------------------------
    // State
    // ---------------------------------------------------------------

    /// @notice Address with administrative authority over the registry.
    address public owner;
    /// @notice Authorized Chainlink KeystoneForwarder address.
    address public forwarder;
    /// @notice Primary CRE workflow identifier accepted by the registry.
    bytes32 public expectedWorkflowId;
    /// @dev Zero means use expectedWorkflowId for balance reports too.
    bytes32 public expectedBalanceWorkflowId;
    /// @dev Zero means use expectedWorkflowId for audit reports too.
    bytes32 public expectedAuditWorkflowId;

    mapping(bytes32 => ActorIdentity) private actors;
    mapping(bytes32 => mapping(address => bool)) public authorizedWallets;

    mapping(bytes32 => Evidence) private evidences;
    // Minimal index used for status queries without scanning event logs.
    bytes32[] private evidenceIds;
    mapping(bytes32 => BalanceResult) private results;
    /// @notice Successor of a result, zero while it is the latest revision.
    mapping(bytes32 => bytes32) public nextResultId;
    /// @notice Latest mass result anchored for each evidence.
    mapping(bytes32 => bytes32) public latestResultIdByEvidence;

    // ---------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------

    /// @notice Reverts when a caller other than the owner invokes an owner-only function.
    error OnlyOwner();
    /// @notice Reverts when a required address is the zero address.
    error ZeroAddress();
    /// @notice Reverts when a required bytes32 identifier is zero.
    error ZeroIdentifier();
    /// @notice Reverts when a required commitment hash is zero or otherwise invalid.
    error InvalidHash();
    error ActorAlreadyExists(bytes32 actorId);
    error ActorNotFound(bytes32 actorId);
    error UnauthorizedWallet(bytes32 actorId, address wallet);
    error EvidenceAlreadyExists(bytes32 evidenceId);
    error EvidenceNotFound(bytes32 evidenceId);
    error EvidenceNotPending(bytes32 evidenceId);
    error EvidenceNotMatchable(bytes32 evidenceId, uint8 status);
    error EvidenceNotAuditable(bytes32 evidenceId, uint8 status);
    error EvidenceNotEligibleForBalance(bytes32 evidenceId, uint8 status);
    error EvidenceActorMismatch(bytes32 evidenceId, bytes32 expectedActorId, bytes32 receivedActorId);
    error EvidenceExpired(bytes32 evidenceId, uint64 createdAt, uint64 expiresAt);
    error ResultAlreadyExists(bytes32 resultId);
    error PreviousResultNotFound(bytes32 previousResultId);
    error PreviousResultActorMismatch(bytes32 previousResultId, bytes32 actorId);
    error PreviousResultEvidenceMismatch(bytes32 previousResultId, bytes32 evidenceId);
    error PreviousResultAlreadySuperseded(bytes32 previousResultId);
    error InvalidCalculationVersion(uint32 received, uint32 previous);
    error WorkflowNotConfigured();
    error InvalidReportLength(uint256 received);
    error UnexpectedReportFields();
    error InvalidForwarder(address caller, address expected);
    error InvalidWorkflowId(bytes32 received, bytes32 expected);
    error InvalidMetadataLength(uint256 received);
    error InvalidReportType(uint8 reportType);
    error InvalidBalanceStatus(uint8 balanceStatus);
    error InvalidEvidenceAuditStatus(uint8 status);

    // ---------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------

    /// @notice Emitted when registry ownership changes.
    /// @param previous Previous owner address.
    /// @param current New owner address.
    event OwnershipTransferred(address indexed previous, address indexed current);
    /// @notice Emitted when the authorized forwarder changes.
    /// @param previous Previous forwarder address.
    /// @param current New forwarder address.
    event ForwarderUpdated(address indexed previous, address indexed current);
    event ExpectedWorkflowIdUpdated(bytes32 indexed previous, bytes32 indexed current);
    event ExpectedBalanceWorkflowIdUpdated(bytes32 indexed previous, bytes32 indexed current);
    event ExpectedAuditWorkflowIdUpdated(bytes32 indexed previous, bytes32 indexed current);

    event ActorRegistered(
        bytes32 indexed actorId,
        address indexed controller,
        uint64 createdAt
    );

    event ActorControllerUpdated(
        bytes32 indexed actorId,
        address indexed previous,
        address indexed current
    );

    event WalletAuthorizationUpdated(
        bytes32 indexed actorId,
        address indexed wallet,
        bool authorized
    );

    /// @notice Emitted when a new evidence commitment is submitted.
    /// @dev This event is intended to trigger, or be indexed by, the CRE correlation workflow
    ///      because Solidity mappings are not iterable.
    event EvidenceSubmitted(
        bytes32 indexed evidenceId,
        bytes32 indexed actorId,
        address indexed submittedBy,
        bytes32 evidenceHash,
        uint64 createdAt
    );

    event EvidenceMatched(
        bytes32 indexed evidenceId,
        bytes32 indexed actorId,
        bytes32 workflowId,
        uint64 matchedAt
    );

    event EvidenceAudited(
        bytes32 indexed evidenceId,
        bytes32 indexed actorId,
        EvidenceStatus status,
        bytes32 workflowId,
        uint64 auditedAt
    );

    event BalanceResultAnchored(
        bytes32 indexed resultId,
        bytes32 indexed evidenceId,
        bytes32 indexed actorId,
        bytes32 previousResultId,
        bytes32 resultHash,
        BalanceStatus status,
        uint32 calculationVersion,
        uint64 createdAt
    );

    // ---------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    /// @notice Deploys the registry and configures the initial CRE forwarder.
    /// @param initialForwarder Address of the authorized KeystoneForwarder.
    constructor(address initialForwarder) {
        if (initialForwarder == address(0)) revert ZeroAddress();

        owner = msg.sender;
        forwarder = initialForwarder;

        emit OwnershipTransferred(address(0), msg.sender);
        emit ForwarderUpdated(address(0), initialForwarder);
    }

    // ---------------------------------------------------------------
    // Administration
    // ---------------------------------------------------------------

    /// @notice Transfers registry ownership to a new address.
    /// @param newOwner Address that will become the registry owner.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        address previous = owner;
        owner = newOwner;
        emit OwnershipTransferred(previous, newOwner);
    }

    /// @notice Updates the authorized Chainlink forwarder.
    /// @param newForwarder New KeystoneForwarder address.
    function setForwarder(address newForwarder) external onlyOwner {
        if (newForwarder == address(0)) revert ZeroAddress();
        address previous = forwarder;
        forwarder = newForwarder;
        emit ForwarderUpdated(previous, newForwarder);
    }

    /// @notice Configures the primary CRE workflow identifier accepted by the registry.
    /// @dev Fail-closed: a zero identifier is rejected and never disables workflow checks.
    /// @param newWorkflowId Workflow identifier expected in forwarder metadata.
    function setExpectedWorkflowId(bytes32 newWorkflowId) external onlyOwner {
        if (newWorkflowId == bytes32(0)) revert ZeroIdentifier();
        bytes32 previous = expectedWorkflowId;
        expectedWorkflowId = newWorkflowId;
        emit ExpectedWorkflowIdUpdated(previous, newWorkflowId);
    }

    /// @notice Configures an optional dedicated workflow identifier for balance reports.
    /// @dev A zero value makes balance reports fall back to `expectedWorkflowId`.
    /// @param newWorkflowId Dedicated balance workflow identifier, or zero to use the primary workflow.
    function setExpectedBalanceWorkflowId(bytes32 newWorkflowId) external onlyOwner {
        bytes32 previous = expectedBalanceWorkflowId;
        expectedBalanceWorkflowId = newWorkflowId;
        emit ExpectedBalanceWorkflowIdUpdated(previous, newWorkflowId);
    }

    /// @notice Configures an optional dedicated workflow identifier for audit reports.
    /// @dev A zero value makes audit reports fall back to `expectedWorkflowId`.
    /// @param newWorkflowId Dedicated audit workflow identifier, or zero to use the primary workflow.
    function setExpectedAuditWorkflowId(bytes32 newWorkflowId) external onlyOwner {
        bytes32 previous = expectedAuditWorkflowId;
        expectedAuditWorkflowId = newWorkflowId;
        emit ExpectedAuditWorkflowIdUpdated(previous, newWorkflowId);
    }

    // ---------------------------------------------------------------
    // Actor identity
    // ---------------------------------------------------------------

    /// @notice Registers a logical participant identity.
    /// @dev Business metadata remains off-chain. The chain stores only an opaque `actorId`,
    ///      its controller, and the creation timestamp.
    /// @param actorId Opaque identifier of the participant.
    /// @param controller Address that initially controls the participant identity.
    function registerActor(bytes32 actorId, address controller) external onlyOwner {
        if (actorId == bytes32(0)) revert ZeroIdentifier();
        if (controller == address(0)) revert ZeroAddress();
        if (actors[actorId].controller != address(0)) revert ActorAlreadyExists(actorId);

        uint64 timestamp = uint64(block.timestamp);

        actors[actorId] = ActorIdentity({
            actorId: actorId,
            controller: controller,
            createdAt: timestamp
        });

        authorizedWallets[actorId][controller] = true;

        emit ActorRegistered(actorId, controller, timestamp);
        emit WalletAuthorizationUpdated(actorId, controller, true);
    }

    /// @notice Changes the administrative controller of an actor without changing its `actorId`.
    /// @dev The previous controller is not automatically revoked from `authorizedWallets`.
    ///      Revoke it explicitly when operational access should end.
    /// @param actorId Identifier of the actor whose controller is being changed.
    /// @param newController Address of the new controller.
    function setActorController(bytes32 actorId, address newController) external {
        ActorIdentity storage actor = _requireActor(actorId);
        if (msg.sender != actor.controller && msg.sender != owner) {
            revert UnauthorizedWallet(actorId, msg.sender);
        }
        if (newController == address(0)) revert ZeroAddress();

        address previous = actor.controller;
        actor.controller = newController;
        authorizedWallets[actorId][newController] = true;

        emit ActorControllerUpdated(actorId, previous, newController);
        emit WalletAuthorizationUpdated(actorId, newController, true);
    }

    /// @notice Grants or revokes wallet authorization for an actor.
    /// @dev Multiple wallets may be authorized for the same `actorId`.
    /// @param actorId Identifier of the actor whose wallet authorization is being updated.
    /// @param wallet Wallet address to update.
    /// @param authorized `true` to authorize the wallet, `false` to revoke it.
    function setWalletAuthorization(
        bytes32 actorId,
        address wallet,
        bool authorized
    ) external {
        ActorIdentity storage actor = _requireActor(actorId);
        if (msg.sender != actor.controller && msg.sender != owner) {
            revert UnauthorizedWallet(actorId, msg.sender);
        }
        if (wallet == address(0)) revert ZeroAddress();

        authorizedWallets[actorId][wallet] = authorized;
        emit WalletAuthorizationUpdated(actorId, wallet, authorized);
    }

    // ---------------------------------------------------------------
    // Evidence
    // ---------------------------------------------------------------

    /// @notice Anchors an exact document hash and opens the evidence in `PENDING` state.
    /// @dev The document, business metadata, and lot information remain off-chain. Any field
    ///      later used for correlation must be re-extracted from the exact committed document.
    /// @param evidenceId Opaque evidence identifier with no business meaning embedded in it.
    /// @param actorId Actor identity to which the evidence belongs.
    /// @param evidenceHash Hash of the exact document bytes being committed.
    function submitEvidence(
        bytes32 evidenceId,
        bytes32 actorId,
        bytes32 evidenceHash
    ) external {
        if (evidenceId == bytes32(0) || actorId == bytes32(0)) revert ZeroIdentifier();
        if (evidenceHash == bytes32(0)) revert InvalidHash();

        _requireActor(actorId);

        if (!authorizedWallets[actorId][msg.sender]) {
            revert UnauthorizedWallet(actorId, msg.sender);
        }
        if (evidences[evidenceId].status != EvidenceStatus.NONE) {
            revert EvidenceAlreadyExists(evidenceId);
        }

        uint64 timestamp = uint64(block.timestamp);

        evidences[evidenceId] = Evidence({
            evidenceId: evidenceId,
            actorId: actorId,
            submittedBy: msg.sender,
            evidenceHash: evidenceHash,
            status: EvidenceStatus.PENDING,
            createdAt: timestamp,
            matchedAt: 0,
            auditedAt: 0
        });

        // Store only the identifier in the index; the mapping remains the source of truth.
        evidenceIds.push(evidenceId);

        emit EvidenceSubmitted(
            evidenceId,
            actorId,
            msg.sender,
            evidenceHash,
            timestamp
        );
    }

    // ---------------------------------------------------------------
    // CRE report reception
    // ---------------------------------------------------------------

    /// @inheritdoc IReceiver
    /// @dev Accepts exactly one ABI-encoded `CREReport`. The configured forwarder authenticates
    ///      report delivery; the selected CRE workflow authenticates documents, re-extracts fields,
    ///      performs private correlation, and computes private mass-balance results off-chain.
    function onReport(bytes calldata metadata, bytes calldata report) external override {
        if (msg.sender != forwarder) {
            revert InvalidForwarder(msg.sender, forwarder);
        }
        if (report.length != REPORT_LENGTH) revert InvalidReportLength(report.length);
        CREReport memory decoded = abi.decode(report, (CREReport));
        if (
            decoded.reportType != REPORT_CORRELATION &&
            decoded.reportType != REPORT_BALANCE &&
            decoded.reportType != REPORT_AUDIT
        ) {
            revert InvalidReportType(decoded.reportType);
        }

        bytes32 expected;
        if (decoded.reportType == REPORT_BALANCE && expectedBalanceWorkflowId != bytes32(0)) {
            expected = expectedBalanceWorkflowId;
        } else if (decoded.reportType == REPORT_AUDIT && expectedAuditWorkflowId != bytes32(0)) {
            expected = expectedAuditWorkflowId;
        } else {
            expected = expectedWorkflowId;
        }

        if (expected == bytes32(0)) revert WorkflowNotConfigured();
        bytes32 workflowId = _readWorkflowId(metadata);
        if (workflowId != expected) revert InvalidWorkflowId(workflowId, expected);

        if (decoded.reportType == REPORT_CORRELATION) {
            _applyEvidenceMatch(decoded, workflowId);
        } else if (decoded.reportType == REPORT_BALANCE) {
            _applyBalance(decoded);
        } else {
            _applyEvidenceAudit(decoded, workflowId);
        }
    }

    /// @dev Applies an off-chain verdict, NOT correlation logic.
    ///      Existing MATCHED evidence never returns to PENDING. A new document
    ///      gets a new evidenceId and is confirmed in its own transaction.
    function _applyEvidenceMatch(CREReport memory r, bytes32 workflowId) internal {
        if (
            r.resultId != bytes32(0) || r.actorId != bytes32(0) ||
            r.resultHash != bytes32(0) || r.previousResultId != bytes32(0) ||
            r.aggregateInputHash != bytes32(0) || r.balanceStatus != 0 ||
            r.calculationVersion != 0
        ) revert UnexpectedReportFields();
        if (r.evidenceId == bytes32(0)) revert ZeroIdentifier();

        Evidence storage e = evidences[r.evidenceId];
        if (e.status == EvidenceStatus.NONE) revert EvidenceNotFound(r.evidenceId);
        if (e.status != EvidenceStatus.PENDING && e.status != EvidenceStatus.VERIFIED) {
            revert EvidenceNotMatchable(r.evidenceId, uint8(e.status));
        }

        uint64 timestamp = uint64(block.timestamp);
        if (e.status == EvidenceStatus.PENDING) {
            uint64 deadline = e.createdAt + EVIDENCE_TTL;
            if (timestamp > deadline) revert EvidenceExpired(r.evidenceId, e.createdAt, deadline);
        }

        e.status = EvidenceStatus.MATCHED;
        e.matchedAt = timestamp;
        emit EvidenceMatched(r.evidenceId, e.actorId, workflowId, timestamp);
    }

    /// @dev Auditor verdict. Uses balanceStatus as the evidence-status byte to
    ///      preserve the existing static nine-word CREReport ABI.
    function _applyEvidenceAudit(CREReport memory r, bytes32 workflowId) internal {
        if (
            r.resultId != bytes32(0) || r.actorId != bytes32(0) ||
            r.resultHash != bytes32(0) || r.previousResultId != bytes32(0) ||
            r.aggregateInputHash != bytes32(0) || r.calculationVersion != 0
        ) revert UnexpectedReportFields();
        if (r.evidenceId == bytes32(0)) revert ZeroIdentifier();

        Evidence storage e = evidences[r.evidenceId];
        if (e.status == EvidenceStatus.NONE) revert EvidenceNotFound(r.evidenceId);
        if (e.status != EvidenceStatus.MATCHED) {
            revert EvidenceNotAuditable(r.evidenceId, uint8(e.status));
        }

        EvidenceStatus verdict = EvidenceStatus(r.balanceStatus);
        if (verdict != EvidenceStatus.VERIFIED && verdict != EvidenceStatus.DIVERGENT) {
            revert InvalidEvidenceAuditStatus(r.balanceStatus);
        }

        uint64 timestamp = uint64(block.timestamp);
        e.status = verdict;
        e.auditedAt = timestamp;

        emit EvidenceAudited(r.evidenceId, e.actorId, verdict, workflowId, timestamp);
    }

    /// @dev One partner result per call, with no evidence list.
    ///      aggregateInputHash commits to a private canonical input manifest;
    ///      it does NOT let this contract check which inputs were MATCHED.
    ///      The trusted workflow must verify input integrity, correlation,
    ///      eligibility and mass accounting before submitting the report.
    ///      All calldata/storage, actor IDs and block times remain public.
    function _applyBalance(CREReport memory r) internal {
        if (r.evidenceId == bytes32(0) || r.actorId == bytes32(0) || r.resultId == bytes32(0)) {
            revert ZeroIdentifier();
        }
        if (r.resultHash == bytes32(0) || r.aggregateInputHash == bytes32(0)) {
            revert InvalidHash();
        }
        if (
            r.balanceStatus < uint8(BalanceStatus.CONFORME) ||
            r.balanceStatus > uint8(BalanceStatus.NAO_ATESTADO)
        ) revert InvalidBalanceStatus(r.balanceStatus);

        Evidence storage evidence = evidences[r.evidenceId];
        if (evidence.status == EvidenceStatus.NONE) revert EvidenceNotFound(r.evidenceId);
        if (
            evidence.status != EvidenceStatus.MATCHED &&
            evidence.status != EvidenceStatus.VERIFIED
        ) {
            revert EvidenceNotEligibleForBalance(r.evidenceId, uint8(evidence.status));
        }
        if (evidence.actorId != r.actorId) {
            revert EvidenceActorMismatch(r.evidenceId, evidence.actorId, r.actorId);
        }

        _requireActor(r.actorId);
        if (results[r.resultId].resultId != bytes32(0)) {
            revert ResultAlreadyExists(r.resultId);
        }

        // calculationVersion is the result REVISION, not the algorithm version.
        // Algorithm/factor versions belong in the private committed manifest.
        // Different private balances of one actor may have independent roots.
        if (r.previousResultId == bytes32(0)) {
            if (r.calculationVersion != 1) {
                revert InvalidCalculationVersion(r.calculationVersion, 0);
            }
        } else {
            BalanceResult storage prev = results[r.previousResultId];
            if (prev.resultId == bytes32(0)) {
                revert PreviousResultNotFound(r.previousResultId);
            }
            if (prev.actorId != r.actorId) {
                revert PreviousResultActorMismatch(r.previousResultId, r.actorId);
            }
            if (prev.evidenceId != r.evidenceId) {
                revert PreviousResultEvidenceMismatch(r.previousResultId, r.evidenceId);
            }
            if (nextResultId[r.previousResultId] != bytes32(0)) {
                revert PreviousResultAlreadySuperseded(r.previousResultId);
            }
            if (uint256(r.calculationVersion) != uint256(prev.calculationVersion) + 1) {
                revert InvalidCalculationVersion(r.calculationVersion, prev.calculationVersion);
            }
            nextResultId[r.previousResultId] = r.resultId;
        }

        uint64 timestamp = uint64(block.timestamp);
        BalanceStatus status = BalanceStatus(r.balanceStatus);
        results[r.resultId] = BalanceResult({
            resultId: r.resultId,
            evidenceId: r.evidenceId,
            actorId: r.actorId,
            resultHash: r.resultHash,
            previousResultId: r.previousResultId,
            aggregateInputHash: r.aggregateInputHash,
            status: status,
            calculationVersion: r.calculationVersion,
            createdAt: timestamp
        });
        latestResultIdByEvidence[r.evidenceId] = r.resultId;

        emit BalanceResultAnchored(
            r.resultId, r.evidenceId, r.actorId, r.previousResultId,
            r.resultHash, status, r.calculationVersion, timestamp
        );
    }

    // ---------------------------------------------------------------
    // Read functions
    // ---------------------------------------------------------------

    /// @notice Returns the registered identity for an actor.
    /// @param actorId Actor identifier to query.
    /// @return The actor identity record.
    function getActor(bytes32 actorId) external view returns (ActorIdentity memory) {
        return _requireActor(actorId);
    }

    /// @notice Returns a stored evidence record.
    /// @param evidenceId Evidence identifier to query.
    /// @return The evidence record.
    function getEvidence(bytes32 evidenceId) external view returns (Evidence memory) {
        Evidence storage e = evidences[evidenceId];
        if (e.status == EvidenceStatus.NONE) revert EvidenceNotFound(evidenceId);
        return e;
    }

    /// @notice Returns the first evidence currently in `PENDING` state, or zero if none exists.
    /// @return The first matching evidence identifier, or `bytes32(0)` if none exists.
    function getNextPending() external view returns (bytes32) {
        return _getNextByStatus(EvidenceStatus.PENDING);
    }

    /// @notice Returns the first evidence currently in `MATCHED` state, or zero if none exists.
    /// @return The first matching evidence identifier, or `bytes32(0)` if none exists.
    function getNextMatched() external view returns (bytes32) {
        return _getNextByStatus(EvidenceStatus.MATCHED);
    }

    /// @notice Returns the first evidence currently in `VERIFIED` state, or zero if none exists.
    /// @return The first matching evidence identifier, or `bytes32(0)` if none exists.
    function getNextVerified() external view returns (bytes32) {
        return _getNextByStatus(EvidenceStatus.VERIFIED);
    }

    /// @notice Returns the first evidence currently in `DIVERGENT` state, or zero if none exists.
    /// @return The first matching evidence identifier, or `bytes32(0)` if none exists.
    function getNextDivergent() external view returns (bytes32) {
        return _getNextByStatus(EvidenceStatus.DIVERGENT);
    }

    /// @notice Returns a mass-balance result by identifier.
    /// @param resultId Result identifier to query.
    /// @return The stored result record. An unknown identifier returns the zero-value struct.
    function getResult(bytes32 resultId) external view returns (BalanceResult memory) {
        return results[resultId];
    }

    /// @notice Compares a candidate document hash with the hash committed for an evidence.
    /// @dev The caller recomputes the document hash off-chain and submits only the candidate hash.
    /// @param evidenceId Identifier of the evidence to verify.
    /// @param candidateHash Locally recomputed hash of the presented document.
    /// @return `true` if the candidate hash equals the committed evidence hash.
    function verifyEvidenceHash(
        bytes32 evidenceId,
        bytes32 candidateHash
    ) external view returns (bool) {
        Evidence storage e = evidences[evidenceId];
        if (e.status == EvidenceStatus.NONE) revert EvidenceNotFound(evidenceId);
        return e.evidenceHash == candidateHash;
    }

    /// @notice Returns whether a `PENDING` evidence is past its matching deadline.
    /// @dev The value is derived from `createdAt`. Evidence that is no longer `PENDING` is not
    ///      considered expired by this function.
    /// @param evidenceId Identifier of the evidence to inspect.
    /// @return `true` if the evidence is still `PENDING` and its deadline has passed.
    function isExpired(bytes32 evidenceId) external view returns (bool) {
        Evidence storage e = evidences[evidenceId];
        if (e.status == EvidenceStatus.NONE) revert EvidenceNotFound(evidenceId);
        if (e.status != EvidenceStatus.PENDING) return false;
        return block.timestamp > e.createdAt + EVIDENCE_TTL;
    }

    /// @notice Returns the matching deadline for an evidence.
    /// @param evidenceId Evidence identifier to query.
    /// @return Unix timestamp at which the evidence reaches its matching deadline.
    function expiresAt(bytes32 evidenceId) external view returns (uint64) {
        Evidence storage e = evidences[evidenceId];
        if (e.status == EvidenceStatus.NONE) revert EvidenceNotFound(evidenceId);
        return e.createdAt + EVIDENCE_TTL;
    }

    /// @notice Compares an anchored result commitment with a locally recomputed hash.
    /// @dev The authorized recipient recomputes the hash from the private canonical manifest and
    ///      private salt. Only the candidate hash is submitted on-chain.
    /// @param resultId Result identifier to verify.
    /// @param candidateHash Locally recomputed result commitment.
    /// @return `true` if the candidate hash equals the anchored `resultHash`.
    function verifyResultHash(
        bytes32 resultId,
        bytes32 candidateHash
    ) external view returns (bool) {
        BalanceResult storage r = results[resultId];
        if (r.resultId == bytes32(0)) return false;
        return r.resultHash == candidateHash;
    }

    /// @notice Returns whether a wallet is authorized for an actor.
    /// @param actorId Actor identifier to query.
    /// @param wallet Wallet address to query.
    /// @return `true` if the wallet is currently authorized for the actor.
    function isWalletAuthorized(
        bytes32 actorId,
        address wallet
    ) external view returns (bool) {
        return authorizedWallets[actorId][wallet];
    }

    // ---------------------------------------------------------------
    // Internal functions
    // ---------------------------------------------------------------

    /// @dev Performs a linear scan over the evidence identifier index and returns the first
    ///      record whose current status equals `wanted`.
    function _getNextByStatus(EvidenceStatus wanted) internal view returns (bytes32) {
        uint256 length = evidenceIds.length;
        for (uint256 i = 0; i < length; ++i) {
            bytes32 evidenceId = evidenceIds[i];
            if (evidences[evidenceId].status == wanted) {
                return evidenceId;
            }
        }
        return bytes32(0);
    }

    /// @dev Loads an actor from storage and reverts if the actor is not registered.
    function _requireActor(bytes32 actorId) internal view returns (ActorIdentity storage actor) {
        actor = actors[actorId];
        if (actor.controller == address(0)) revert ActorNotFound(actorId);
    }

    /// @dev Reads the first 32 bytes of forwarder metadata as the workflow identifier.
    ///      Longer metadata is accepted; metadata shorter than one ABI word is rejected.
    function _readWorkflowId(
        bytes calldata metadata
    ) internal pure returns (bytes32 workflowId) {
        // Accept the forwarder's longer metadata; only the first ABI word is required.
        // The allowlist comparison uses only the first 32-byte workflow identifier.
        if (metadata.length < 32) revert InvalidMetadataLength(metadata.length);
        assembly {
            workflowId := calldataload(metadata.offset)
        }
    }

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return
            interfaceId == type(IReceiver).interfaceId ||
            interfaceId == type(IERC165).interfaceId;
    }
}

