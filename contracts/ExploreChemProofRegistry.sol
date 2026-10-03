// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title Minimal ERC-165 interface
interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

/// @title Chainlink CRE receiver interface
interface IReceiver is IERC165 {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

/// @title ExploreChem modular proof registry
/// @notice Anchors one immutable evidence commitment and independent calculation proofs
///         produced by separately authorized Chainlink CRE workflows.
/// @dev Matching and correlation remain private and off-chain. There is no MATCHED state.
///      Each workflow can publish only the proof type assigned to its authenticated workflow ID.
/// @notice Required ABI for the new E1 Lots deployment (not compatible with Lots v1).
interface IExploreChemLotsE1 {
    enum LotState { NONE, ACTIVE, IN_ESCROW, ENCUMBERED, CONSUMED }
    struct Lot {
        bytes32 commitment;
        bytes32 holder;
        bytes32 operationId;
        bytes32 proofId;
        bytes32 mufProofId;
        uint64 createdAt;
        LotState state;
    }
    struct OutputLot {
        bytes32 lotId;
        bytes32 commitment;
        bytes32 recipient;
    }
    struct OperationReport {
        uint8 kind; // 1 INITIAL; 2 TRANSFORM
        bytes32 operationId;
        bytes32 holder;
        bytes32[] inputLotIds;
        OutputLot[] outputs;
    }
    function registry() external view returns (address);
    function getLot(bytes32 lotId) external view returns (Lot memory);
    /// @dev Must accept only registry; reject replay, duplicate inputs, unusable
    /// ancestors, non-ACTIVE inputs and existing outputs; consume whole inputs.
    /// Proof references are explicit so Lots can implement cascading invalidation.
    function recordOperation(
        bytes32 evidenceId,
        bytes32 proofId,
        bytes32 mufProofId,
        OperationReport calldata op
    ) external;
}
import "./ExploreChemActorRegistry.sol";

contract ExploreChemProofRegistry is IReceiver {
    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    /// @notice Supported wire codes. Only codes 1 and 3 are accepted; all other codes are rejected.
    /// @dev Explicit uint8 codes preserve existing CRE report and event encoding.
    uint8 public constant PROOF_MUF = 1;
    uint8 public constant PROOF_ELEMENTAL = 3;

    enum CheckStatus {
        NONE,
        PENDING,
        CALCULATED,
        DIVERGENT,
        NOT_ATTESTED
    }

    /// @notice Immutable commitment to the original evidence submitted by an actor.
    struct Evidence {
        bytes32 evidenceId;
        bytes32 actorId;
        address submittedBy;
        bytes32 evidenceHash;
        uint64 createdAt;
    }

    /// @notice Latest supported hashes and statuses for direct frontend consumption.
    /// @dev ABI order: mufHash, elementalHash, mufStatus, elementalStatus.
    ///      Clients must use this reduced tuple on new deployments.
    /// @dev All statuses are initialized to PENDING when the evidence is submitted.
    struct CurrentProofState {
        bytes32 mufHash;
        bytes32 elementalHash;
        CheckStatus mufStatus;
        CheckStatus elementalStatus;
    }

    /// @notice Immutable historical revision produced by one specialized workflow.
    struct ProofRecord {
        bytes32 proofId;
        bytes32 evidenceId;
        bytes32 evidenceHash;
        uint8 proofType;
        bytes32 committedHash;
        bytes32 inputCommitmentHash;
        bytes32 methodologyHash;
        bytes32 previousProofId;
        CheckStatus status;
        uint32 revision;
        bytes32 workflowId;
        uint64 createdAt;
    }

    /// @notice Static report emitted by exactly one specialized CRE workflow.
    /// @dev `abi.encode(ProofReport)` contains ten ABI words.
    ///      `evidenceHash`, `committedHash`, `inputCommitmentHash`, and
    ///      `methodologyHash` are mandatory and cannot be zero.
    struct ProofReport {
        uint8 proofType;
        bytes32 evidenceId;
        bytes32 evidenceHash;
        bytes32 proofId;
        bytes32 committedHash;
        bytes32 inputCommitmentHash;
        bytes32 methodologyHash;
        bytes32 previousProofId;
        uint8 status;
        uint32 revision;
    }

    uint256 public constant REPORT_LENGTH = 10 * 32;
    uint8 public constant registryVersion = 3;

    // ---------------------------------------------------------------------
    // State
    // ---------------------------------------------------------------------

    address public owner;
    address public forwarder;

    ExploreChemActorRegistry public immutable actorRegistry;

    mapping(uint8 => bytes32) public expectedWorkflowId;



    mapping(bytes32 => Evidence) private evidences;
    mapping(bytes32 => CurrentProofState) private currentProofStates;

    mapping(bytes32 => ProofRecord) private proofRecords;
    mapping(bytes32 => mapping(uint8 => bytes32)) public latestProofId;
    mapping(bytes32 => bytes32) public nextProofId;

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error InvalidActorRegistry();
    error OnlyOwner();
    error ZeroAddress();
    error ZeroIdentifier();
    error InvalidHash();
    error InvalidProofType(uint8 proofType);
    error InvalidCheckStatus(uint8 status);
    error InvalidMetadataLength(uint256 received);
    error InvalidForwarder(address caller, address expected);
    error WorkflowNotConfigured(uint8 proofType);
    error InvalidWorkflowId(bytes32 received, bytes32 expected);

    error UnauthorizedWallet(bytes32 actorId, address wallet);

    error EvidenceAlreadyExists(bytes32 evidenceId);
    error EvidenceNotFound(bytes32 evidenceId);
    error EvidenceHashMismatch(bytes32 evidenceId, bytes32 expectedHash, bytes32 receivedHash);

    error ProofAlreadyExists(bytes32 proofId);
    error RootProofAlreadyExists(bytes32 evidenceId, uint8 proofType, bytes32 latestProofId);
    error PreviousProofNotFound(bytes32 previousProofId);
    error PreviousProofMismatch(bytes32 previousProofId);
    error PreviousProofAlreadySuperseded(bytes32 previousProofId);
    error InvalidRevision(uint32 received, uint32 expected);

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ForwarderUpdated(address indexed previousForwarder, address indexed newForwarder);
    event WorkflowConfigured(
        uint8 indexed proofType,
        bytes32 indexed previousWorkflowId,
        bytes32 indexed newWorkflowId
    );

    event EvidenceSubmitted(
        bytes32 indexed evidenceId,
        bytes32 indexed actorId,
        address indexed submittedBy,
        bytes32 evidenceHash,
        uint64 createdAt
    );

    event ProofAnchored(
        bytes32 indexed proofId,
        bytes32 indexed evidenceId,
        uint8 indexed proofType,
        bytes32 committedHash,
        CheckStatus status,
        uint32 revision,
        bytes32 previousProofId,
        bytes32 inputCommitmentHash,
        bytes32 methodologyHash,
        bytes32 workflowId,
        uint64 createdAt
    );

    // ---------------------------------------------------------------------
    // Modifiers and constructor
    // ---------------------------------------------------------------------

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    constructor(address initialForwarder, address actorRegistryAddress) {
        if (initialForwarder == address(0)) revert ZeroAddress();

        if (actorRegistryAddress.code.length == 0) revert InvalidActorRegistry();
        actorRegistry = ExploreChemActorRegistry(actorRegistryAddress);
        owner = msg.sender;
        forwarder = initialForwarder;

        emit OwnershipTransferred(address(0), msg.sender);
        emit ForwarderUpdated(address(0), initialForwarder);
    }

    // ---------------------------------------------------------------------
    // Administration
    // ---------------------------------------------------------------------

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        address previous = owner;
        owner = newOwner;
        emit OwnershipTransferred(previous, newOwner);
    }

    function setForwarder(address newForwarder) external onlyOwner {
        if (newForwarder == address(0)) revert ZeroAddress();
        address previous = forwarder;
        forwarder = newForwarder;
        emit ForwarderUpdated(previous, newForwarder);
    }

    /// @notice Assigns one authenticated workflow ID to one proof type.
    /// @dev Passing zero disables publication for that proof type.
    function setExpectedWorkflowId(uint8 proofType, bytes32 workflowId) external onlyOwner {
        _requireProofType(proofType);
        bytes32 previous = expectedWorkflowId[proofType];
        expectedWorkflowId[proofType] = workflowId;
        emit WorkflowConfigured(proofType, previous, workflowId);
    }

    // ---------------------------------------------------------------------
    // Actor identity and authorization
    // ---------------------------------------------------------------------

    // ---------------------------------------------------------------------
    // Evidence
    // ---------------------------------------------------------------------

    /// @notice Anchors the exact original evidence hash without publishing correlation data.
    function submitEvidence(
        bytes32 evidenceId,
        bytes32 actorId,
        bytes32 evidenceHash
    ) external {
        if (evidenceId == bytes32(0) || actorId == bytes32(0)) revert ZeroIdentifier();
        if (evidenceHash == bytes32(0)) revert InvalidHash();
        actorRegistry.requireActiveActor(actorId);
        if (!actorRegistry.authorizedWallets(actorId, msg.sender)) {
            revert UnauthorizedWallet(actorId, msg.sender);
        }
        if (evidences[evidenceId].submittedBy != address(0)) {
            revert EvidenceAlreadyExists(evidenceId);
        }

        uint64 timestamp = uint64(block.timestamp);
        evidences[evidenceId] = Evidence({
            evidenceId: evidenceId,
            actorId: actorId,
            submittedBy: msg.sender,
            evidenceHash: evidenceHash,
            createdAt: timestamp
        });

        CurrentProofState storage state = currentProofStates[evidenceId];
        state.mufStatus = CheckStatus.PENDING;
        state.elementalStatus = CheckStatus.PENDING;

        emit EvidenceSubmitted(evidenceId, actorId, msg.sender, evidenceHash, timestamp);
    }

    // ---------------------------------------------------------------------
    // CRE report reception
    // ---------------------------------------------------------------------

    /// @inheritdoc IReceiver
    /// @notice Static reports remain supported for MUF and unsuccessful ELEMENTAL.
    /// @dev Successful ELEMENTAL requires canonical abi.encode(ReportV3).
    /// No lot opening, mass, component identifier or salt belongs in this report.
    function onReport(bytes calldata metadata, bytes calldata report) external override nonReentrant {
        if (msg.sender != forwarder) revert InvalidForwarder(msg.sender, forwarder);
        ProofReport memory proof;
        IExploreChemLotsE1.OperationReport memory op;
        bool hasEnvelope;
        if (report.length == REPORT_LENGTH) {
            proof = abi.decode(report, (ProofReport));
            if (proof.proofType == PROOF_ELEMENTAL && proof.status == uint8(CheckStatus.CALCULATED)) {
                revert OperationReportRequired();
            }
        } else {
            ReportV3 memory envelope = abi.decode(report, (ReportV3));
            if (envelope.version != 3 || envelope.chainId != block.chainid || envelope.registry != address(this)) {
                revert InvalidReportDomain();
            }
            // Reject trailing payloads and noncanonical encodings. This is not
            // a secrecy guarantee: callers must never submit private openings.
            if (keccak256(report) != keccak256(abi.encode(envelope))) revert InvalidReportEncoding();
            proof = envelope.proof;
            op = envelope.op;
            hasEnvelope = true;
        }
        uint8 proofType = _decodeProofType(proof.proofType);
        CheckStatus status = _decodeFinalStatus(proof.status);
        bytes32 expected = expectedWorkflowId[proofType];
        if (expected == bytes32(0)) revert WorkflowNotConfigured(proofType);
        bytes32 workflowId = _readWorkflowId(metadata);
        if (workflowId != expected) revert InvalidWorkflowId(workflowId, expected);

        if (proofType == PROOF_ELEMENTAL && status == CheckStatus.CALCULATED) {
            bytes32 mufId = _currentMuf(proof.evidenceId);
            _validateOperation(proof.evidenceId, op);
            bytes32 calculated = _operationCommitment(proof.evidenceId, mufId, op);
            if (proof.inputCommitmentHash != calculated) {
                revert InputCommitmentMismatch(calculated, proof.inputCommitmentHash);
            }
            _anchorProof(proof, proofType, status, workflowId);
            usedOperations[op.operationId] = true;
            // A Lots revert rolls back both the proof and usedOperations.
            lotsContract.recordOperation(proof.evidenceId, proof.proofId, mufId, op);
        } else {
            if (hasEnvelope && !_emptyOperation(op)) revert InvalidOperation();
            _anchorProof(proof, proofType, status, workflowId);
        }
    }

    function _emptyOperation(IExploreChemLotsE1.OperationReport memory op) internal pure returns (bool) {
        return op.kind == 0 && op.operationId == bytes32(0) && op.holder == bytes32(0)
            && op.inputLotIds.length == 0 && op.outputs.length == 0;
    }

    function _currentMuf(bytes32 evidenceId) internal view returns (bytes32 mufId) {
        mufId = latestProofId[evidenceId][PROOF_MUF];
        if (mufId == bytes32(0) || currentProofStates[evidenceId].mufStatus != CheckStatus.CALCULATED) {
            revert CurrentMufRequired(evidenceId);
        }
    }

    function _validateOperation(bytes32 evidenceId, IExploreChemLotsE1.OperationReport memory op) internal view {
        if (address(lotsContract) == address(0)) revert LotsNotConfigured();
        if (op.operationId == bytes32(0) || op.holder == bytes32(0)) revert InvalidOperation();
        if (usedOperations[op.operationId]) revert OperationAlreadyUsed(op.operationId);
        if (op.outputs.length == 0 || op.outputs.length > MAX_OPERATION_ITEMS
            || op.inputLotIds.length > MAX_OPERATION_ITEMS) revert InvalidOperation();
        if (op.kind == 1) {
            if (op.inputLotIds.length != 0) revert InvalidOperation();
        } else if (op.kind == 2) {
            if (op.inputLotIds.length == 0) revert InvalidOperation();
        } else revert InvalidOperation();
        Evidence storage evidence = evidences[evidenceId];
        if (evidence.submittedBy == address(0)) revert EvidenceNotFound(evidenceId);
        if (evidence.actorId != op.holder) revert OperationHolderMismatch();
        actorRegistry.requireActiveActor(op.holder);
        _requireUniqueInputs(op.inputLotIds);
        for (uint256 i; i < op.inputLotIds.length; ++i) {
            IExploreChemLotsE1.Lot memory lot = lotsContract.getLot(op.inputLotIds[i]);
            if (lot.commitment == bytes32(0) || lot.state != IExploreChemLotsE1.LotState.ACTIVE
                || lot.holder != op.holder) revert InvalidInputLot(op.inputLotIds[i]);
        }
        for (uint256 i; i < op.outputs.length; ++i) {
            IExploreChemLotsE1.OutputLot memory output = op.outputs[i];
            if (output.lotId == bytes32(0) || output.commitment == bytes32(0)
                || output.recipient == bytes32(0)) revert InvalidOperation();
            actorRegistry.requireActiveActor(output.recipient);
            if (op.kind == 1 && output.recipient != op.holder) revert OperationHolderMismatch();
            for (uint256 j; j < i; ++j) {
                if (op.outputs[j].lotId == output.lotId) revert DuplicateLotId(output.lotId);
            }
            for (uint256 j; j < op.inputLotIds.length; ++j) {
                if (op.inputLotIds[j] == output.lotId) revert DuplicateLotId(output.lotId);
            }
            // Existing output IDs must also be rejected by Lots before any mutation.
        }
    }

    function _requireUniqueInputs(bytes32[] memory ids) internal pure {
        for (uint256 i; i < ids.length; ++i) {
            if (ids[i] == bytes32(0)) revert ZeroIdentifier();
            for (uint256 j; j < i; ++j) {
                if (ids[i] == ids[j]) revert DuplicateLotId(ids[i]);
            }
        }
    }

    /// @notice Exact hash the workflow must place in ProofReport.inputCommitmentHash.
    /// @dev Binds the full operation, ordered input commitments, domain and current MUF.
    /// Does not validate private arithmetic or prove knowledge of a lot opening.
    function computeInputCommitmentHash(bytes32 evidenceId, IExploreChemLotsE1.OperationReport calldata op)
        external view returns (bytes32)
    {
        if (address(lotsContract) == address(0)) revert LotsNotConfigured();
        if (op.inputLotIds.length > MAX_OPERATION_ITEMS || op.outputs.length > MAX_OPERATION_ITEMS) {
            revert InvalidOperation();
        }
        _requireUniqueInputs(op.inputLotIds);
        return _operationCommitment(evidenceId, _currentMuf(evidenceId), op);
    }

    function _operationCommitment(bytes32 evidenceId, bytes32 mufId, IExploreChemLotsE1.OperationReport memory op)
        internal view returns (bytes32)
    {
        bytes32[] memory commitments = new bytes32[](op.inputLotIds.length);
        for (uint256 i; i < op.inputLotIds.length; ++i) {
            commitments[i] = lotsContract.getLot(op.inputLotIds[i]).commitment;
            if (commitments[i] == bytes32(0)) revert InvalidInputLot(op.inputLotIds[i]);
        }
        return keccak256(abi.encode(
            OPERATION_DOMAIN_V1, block.chainid, address(this), address(lotsContract),
            evidenceId, mufId, op, commitments
        ));
    }

    function _anchorProof(
        ProofReport memory report,
        uint8 proofType,
        CheckStatus status,
        bytes32 workflowId
    ) internal {
        if (report.evidenceId == bytes32(0) || report.proofId == bytes32(0)) {
            revert ZeroIdentifier();
        }
        if (
            report.evidenceHash == bytes32(0) ||
            report.committedHash == bytes32(0) ||
            report.inputCommitmentHash == bytes32(0) ||
            report.methodologyHash == bytes32(0)
        ) {
            revert InvalidHash();
        }

        Evidence storage evidence = evidences[report.evidenceId];
        if (evidence.submittedBy == address(0)) revert EvidenceNotFound(report.evidenceId);
        if (evidence.evidenceHash != report.evidenceHash) {
            revert EvidenceHashMismatch(
                report.evidenceId,
                evidence.evidenceHash,
                report.evidenceHash
            );
        }
        if (proofRecords[report.proofId].proofId != bytes32(0)) {
            revert ProofAlreadyExists(report.proofId);
        }

        bytes32 currentLatest = latestProofId[report.evidenceId][proofType];
        if (report.previousProofId == bytes32(0)) {
            if (currentLatest != bytes32(0)) {
                revert RootProofAlreadyExists(report.evidenceId, report.proofType, currentLatest);
            }
            if (report.revision != 1) revert InvalidRevision(report.revision, 1);
        } else {
            ProofRecord storage previous = proofRecords[report.previousProofId];
            if (previous.proofId == bytes32(0)) {
                revert PreviousProofNotFound(report.previousProofId);
            }
            if (
                previous.evidenceId != report.evidenceId ||
                previous.proofType != proofType ||
                currentLatest != report.previousProofId
            ) {
                revert PreviousProofMismatch(report.previousProofId);
            }
            if (nextProofId[report.previousProofId] != bytes32(0)) {
                revert PreviousProofAlreadySuperseded(report.previousProofId);
            }

            uint32 expectedRevision = previous.revision + 1;
            if (report.revision != expectedRevision) {
                revert InvalidRevision(report.revision, expectedRevision);
            }
            nextProofId[report.previousProofId] = report.proofId;
        }

        uint64 timestamp = uint64(block.timestamp);
        proofRecords[report.proofId] = ProofRecord({
            proofId: report.proofId,
            evidenceId: report.evidenceId,
            evidenceHash: report.evidenceHash,
            proofType: proofType,
            committedHash: report.committedHash,
            inputCommitmentHash: report.inputCommitmentHash,
            methodologyHash: report.methodologyHash,
            previousProofId: report.previousProofId,
            status: status,
            revision: report.revision,
            workflowId: workflowId,
            createdAt: timestamp
        });

        latestProofId[report.evidenceId][proofType] = report.proofId;
        _updateCurrentProofState(
            currentProofStates[report.evidenceId],
            proofType,
            report.committedHash,
            status
        );

        emit ProofAnchored(
            report.proofId,
            report.evidenceId,
            proofType,
            report.committedHash,
            status,
            report.revision,
            report.previousProofId,
            report.inputCommitmentHash,
            report.methodologyHash,
            workflowId,
            timestamp
        );
    }

    // ---------------------------------------------------------------------
    // Read functions
    // ---------------------------------------------------------------------

    function getActor(bytes32 actorId) external view returns (ExploreChemActorRegistry.ActorIdentity memory) {
        return actorRegistry.getActor(actorId);
    }

    function getEvidence(bytes32 evidenceId) external view returns (Evidence memory) {
        Evidence storage evidence = evidences[evidenceId];
        if (evidence.submittedBy == address(0)) revert EvidenceNotFound(evidenceId);
        return evidence;
    }

    function getCurrentProofState(
        bytes32 evidenceId
    ) external view returns (CurrentProofState memory) {
        if (evidences[evidenceId].submittedBy == address(0)) revert EvidenceNotFound(evidenceId);
        return currentProofStates[evidenceId];
    }

    function getProof(bytes32 proofId) external view returns (ProofRecord memory) {
        return proofRecords[proofId];
    }

    function verifyEvidenceHash(
        bytes32 evidenceId,
        bytes32 candidateHash
    ) external view returns (bool) {
        Evidence storage evidence = evidences[evidenceId];
        if (evidence.submittedBy == address(0)) revert EvidenceNotFound(evidenceId);
        return evidence.evidenceHash == candidateHash;
    }

    function verifyCommittedHash(
        bytes32 proofId,
        bytes32 candidateHash
    ) external view returns (bool) {
        ProofRecord storage proof = proofRecords[proofId];
        if (proof.proofId == bytes32(0)) return false;
        return proof.committedHash == candidateHash;
    }

    function isWalletAuthorized(
        bytes32 actorId,
        address wallet
    ) external view returns (bool) {
        return actorRegistry.authorizedWallets(actorId, wallet);
    }

    // ---------------------------------------------------------------------
    // Internal helpers
    // ---------------------------------------------------------------------

    function _updateCurrentProofState(
        CurrentProofState storage state,
        uint8 proofType,
        bytes32 committedHash,
        CheckStatus status
    ) internal {
        if (proofType == PROOF_MUF) {
            state.mufHash = committedHash;
            state.mufStatus = status;
        } else if (proofType == PROOF_ELEMENTAL) {
            state.elementalHash = committedHash;
            state.elementalStatus = status;
        }
    }

    function _decodeProofType(uint8 value) internal pure returns (uint8 proofType) {
        if (value != PROOF_MUF && value != PROOF_ELEMENTAL) {
            revert InvalidProofType(value);
        }
        return value;
    }

    function _requireProofType(uint8 proofType) internal pure {
        uint8 value = uint8(proofType);
        if (value != PROOF_MUF && value != PROOF_ELEMENTAL) {
            revert InvalidProofType(value);
        }
    }

    /// @dev Workflows publish final verdicts. PENDING exists only before the first proof.
    function _decodeFinalStatus(uint8 value) internal pure returns (CheckStatus status) {
        if (
            value < uint8(CheckStatus.CALCULATED) ||
            value > uint8(CheckStatus.NOT_ATTESTED)
        ) {
            revert InvalidCheckStatus(value);
        }
        return CheckStatus(value);
    }

    function _readWorkflowId(
        bytes calldata metadata
    ) internal pure returns (bytes32 workflowId) {
        // The forwarder removes the first 45 bytes of the raw report header.
        // Receiver metadata starts with workflowId (32 bytes), followed by
        // workflowName (10), workflowOwner (20), and reportId (2).
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

    /// @notice Public context contains no physical quantities or element identifiers.
    struct ConsumptionContext {
        bytes32[] inputLotIds;
        bytes32[] inputCommitments;
        bytes32[] holders;
        IExploreChemLotsE1.LotState[] states;
    }
    function getConsumptionContext(bytes32[] calldata inputLotIds) external view returns (ConsumptionContext memory ctx) {
        if (address(lotsContract) == address(0)) revert LotsNotConfigured();
        if (inputLotIds.length == 0 || inputLotIds.length > MAX_OPERATION_ITEMS) revert InvalidOperation();
        _requireUniqueInputs(inputLotIds);
        ctx.inputLotIds = inputLotIds;
        ctx.inputCommitments = new bytes32[](inputLotIds.length);
        ctx.holders = new bytes32[](inputLotIds.length);
        ctx.states = new IExploreChemLotsE1.LotState[](inputLotIds.length);
        for (uint256 i; i < inputLotIds.length; ++i) {
            IExploreChemLotsE1.Lot memory lot = lotsContract.getLot(inputLotIds[i]);
            ctx.inputCommitments[i] = lot.commitment;
            ctx.holders[i] = lot.holder;
            ctx.states[i] = lot.state;
        }
    }
    IExploreChemLotsE1 public lotsContract;
    uint256 public constant MAX_OPERATION_ITEMS = 32;
    bytes32 public constant OPERATION_DOMAIN_V1 = keccak256("ExploreChem/OperationCommitment/v1");
    mapping(bytes32 => bool) public usedOperations;
    uint256 private entered;
    error ReentrantCall();
    error OperationReportRequired();
    error InvalidReportDomain();
    error InvalidReportEncoding();
    error InvalidOperation();
    error OperationHolderMismatch();
    error DuplicateLotId(bytes32 lotId);
    error InvalidInputLot(bytes32 lotId);
    error OperationAlreadyUsed(bytes32 operationId);
    error InputCommitmentMismatch(bytes32 expected, bytes32 received);
    error CurrentMufRequired(bytes32 evidenceId);
    error LotsNotConfigured();
    error LotsAlreadyConfigured();
    error InvalidLotsContract();
    event LotsConfigured(address indexed lots);
    struct ReportV3 {
        uint8 version;
        uint256 chainId;
        address registry;
        ProofReport proof;
        IExploreChemLotsE1.OperationReport op;
    }
    modifier nonReentrant() {
        if (entered != 0) revert ReentrantCall();
        entered = 1;
        _;
        entered = 0;
    }
    /// @notice One-time binding. A new Lots requires a new deployment, not silent replacement.
    function configureLots(address lots) external onlyOwner {
        if (address(lotsContract) != address(0)) revert LotsAlreadyConfigured();
        if (lots.code.length == 0) revert InvalidLotsContract();
        if (address(IExploreChemLotsE1(lots).registry()) != address(this)) revert InvalidLotsContract();
        lotsContract = IExploreChemLotsE1(lots);
        emit LotsConfigured(lots);
    }
    /// @notice Actor identity associated with evidence, independent of signing wallet.
    function evidenceActor(bytes32 evidenceId) external view returns (bytes32) {
        return evidences[evidenceId].actorId;
    }
    function actorActive(bytes32 actorId) external view returns (bool) {
        return actorRegistry.actorActive(actorId);
    }
    function authorizedWallets(bytes32 actorId, address wallet) external view returns (bool) {
        return actorRegistry.authorizedWallets(actorId, wallet);
    }
    function tokenHolder(bytes32 evidenceId) external view returns (address) {
        return evidences[evidenceId].submittedBy;
    }
    function tokenHolderEligible(bytes32 evidenceId) external view returns (bool) {
        Evidence storage e = evidences[evidenceId];
        // Eligibility belongs to the company and survives rotation of its signing wallet.
        return e.evidenceId != bytes32(0) && actorRegistry.actorActive(e.actorId);
    }
    function proofsCurrent(bytes32 evidenceId, bytes32 mufId, bytes32 elementalId) external view returns (bool) {
        CurrentProofState storage state = currentProofStates[evidenceId];
        return mufId != bytes32(0) && elementalId != bytes32(0)
            && state.mufStatus == CheckStatus.CALCULATED && state.elementalStatus == CheckStatus.CALCULATED
            && latestProofId[evidenceId][PROOF_MUF] == mufId
            && latestProofId[evidenceId][PROOF_ELEMENTAL] == elementalId;
    }

}