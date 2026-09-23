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
///         produced by separately authorized Chainlink CRE/TEE workflows.
/// @dev Matching and correlation remain private and off-chain. There is no MATCHED state.
///      Each workflow can publish only the proof type assigned to its authenticated workflow ID.
import "./ExploreChemLots.sol";
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
        COMPLIANT,
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

    /// @notice Static report emitted by exactly one specialized CRE/TEE workflow.
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
    error InvalidReportLength(uint256 received);
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
    /// @notice Legacy 320-byte reports: MUF or non-COMPLIANT ELEMENTAL only.
    /// @dev ELEMENTAL COMPLIANT uses abi.encode(ReportV2), including its token action.
    function onReport(bytes calldata metadata, bytes calldata report) external override nonReentrant {
        if (msg.sender != forwarder) revert InvalidForwarder(msg.sender, forwarder);
        ProofReport memory proof;
        ExploreChemLots.TokenAction memory action;
        if (report.length == REPORT_LENGTH) {
            proof = abi.decode(report, (ProofReport));
            if (proof.proofType == PROOF_ELEMENTAL && proof.status == uint8(CheckStatus.COMPLIANT)) {
                revert TokenReportRequired();
            }
        } else {
            ReportV2 memory envelope = abi.decode(report, (ReportV2));
            if (envelope.version != 2 || envelope.chainId != block.chainid || envelope.registry != address(this)) {
                revert InvalidReportDomain();
            }
            proof = envelope.proof;
            action = envelope.action;
        }
        uint8 proofType = _decodeProofType(proof.proofType);
        CheckStatus status = _decodeFinalStatus(proof.status);
        bytes32 expected = expectedWorkflowId[proofType];
        if (expected == bytes32(0)) revert WorkflowNotConfigured(proofType);
        bytes32 workflowId = _readWorkflowId(metadata);
        if (workflowId != expected) revert InvalidWorkflowId(workflowId, expected);
        _anchorProof(proof, proofType, status, workflowId);
        if (proofType == PROOF_ELEMENTAL && status == CheckStatus.COMPLIANT) {
            if (address(lotsContract) == address(0)) revert LotsNotConfigured();
            lotsContract.processTokenAction(proof.evidenceId, proof.proofId, action);
        } else if (action.kind != ExploreChemLots.ActionKind.NONE || action.inputs.length != 0 || action.outputs.length != 0 || action.consumedComponents.length != 0) {
            revert InvalidTokenAction();
        }
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
            value < uint8(CheckStatus.COMPLIANT) ||
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

    struct ConsumptionContext {
        ExploreChemLots.LotInput[] inputs;
        bytes32[] inputBases;
        ExploreChemLots.Component[][] inputComponents;
        uint256[] inputIssued;
        uint256[] inputBalances;
    }
    function getConsumptionContext(bytes32 actorId, ExploreChemLots.LotInput[] calldata inputs) external view returns (ConsumptionContext memory ctx) {
        if (inputs.length == 0 || inputs.length > 32) revert InvalidTokenAction();
        ctx.inputs = inputs;
        ctx.inputBases = new bytes32[](inputs.length);
        ctx.inputComponents = new ExploreChemLots.Component[][](inputs.length);
        ctx.inputIssued = new uint256[](inputs.length);
        ctx.inputBalances = new uint256[](inputs.length);
        for (uint256 i; i < inputs.length; ++i) {
            ExploreChemLots.Lot memory lot = lotsContract.getLot(inputs[i].lotId);
            ctx.inputBases[i] = lot.basisHash;
            ctx.inputIssued[i] = lot.supply;
            ctx.inputBalances[i] = lotsContract.balanceOf(actorId, inputs[i].lotId);
            ctx.inputComponents[i] = lotsContract.getActorComposition(actorId, inputs[i].lotId);
        }
    }
    ExploreChemLots public lotsContract;
    uint256 private entered;
    error ReentrantCall();
    error TokenReportRequired();
    error InvalidReportDomain();
    error InvalidTokenAction();
    error LotsNotConfigured();
    error LotsAlreadyConfigured();
    error InvalidLotsContract();
    event LotsConfigured(address indexed lots);
    struct ReportV2 {
        uint8 version;
        uint256 chainId;
        address registry;
        ProofReport proof;
        ExploreChemLots.TokenAction action;
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
        if (address(ExploreChemLots(lots).registry()) != address(this)) revert InvalidLotsContract();
        lotsContract = ExploreChemLots(lots);
        emit LotsConfigured(lots);
    }
    /// @notice Identity owning registration balances, independent of signing wallet.
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
        // Eligibility belongs to the company; rotating its signing wallet does not erase its balances.
        return e.evidenceId != bytes32(0) && actorRegistry.actorActive(e.actorId);
    }
    function proofsCurrent(bytes32 evidenceId, bytes32 mufId, bytes32 elementalId) external view returns (bool) {
        CurrentProofState storage state = currentProofStates[evidenceId];
        return mufId != bytes32(0) && elementalId != bytes32(0)
            && state.mufStatus == CheckStatus.COMPLIANT && state.elementalStatus == CheckStatus.COMPLIANT
            && latestProofId[evidenceId][PROOF_MUF] == mufId
            && latestProofId[evidenceId][PROOF_ELEMENTAL] == elementalId;
    }

}
