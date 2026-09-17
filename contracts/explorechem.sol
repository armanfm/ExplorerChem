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

/// @title Minimal ERC-721 interface used by the company identity token
interface IERC721 is IERC165 {
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    function balanceOf(address account) external view returns (uint256);
    function ownerOf(uint256 tokenId) external view returns (address);
    function safeTransferFrom(address from, address to, uint256 tokenId, bytes calldata data) external;
    function safeTransferFrom(address from, address to, uint256 tokenId) external;
    function transferFrom(address from, address to, uint256 tokenId) external;
    function approve(address approved, uint256 tokenId) external;
    function setApprovalForAll(address operator, bool approved) external;
    function getApproved(uint256 tokenId) external view returns (address);
    function isApprovedForAll(address account, address operator) external view returns (bool);
}

/// @title ERC-5192 minimal soulbound-token interface
interface IERC5192 is IERC165 {
    event Locked(uint256 tokenId);
    event Unlocked(uint256 tokenId);

    function locked(uint256 tokenId) external view returns (bool);
}

/// @title ExploreChem modular proof registry
/// @notice Anchors one immutable evidence commitment and independent calculation proofs
///         produced by separately authorized Chainlink CRE/TEE workflows.
/// @dev Matching and correlation remain private and off-chain. There is no MATCHED state.
///      Each workflow can publish only the proof type assigned to its authenticated workflow ID.
contract ExploreChemProofRegistry is IReceiver, IERC721, IERC5192 {
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

    enum ActorStatus {
        NONE,
        PENDING,
        ACTIVE,
        SUSPENDED,
        REJECTED
    }

    struct ActorIdentity {
        bytes32 actorId;
        address controller;
        uint256 tokenId;
        bytes32 registrationHash;
        ActorStatus status;
        uint64 createdAt;
        uint64 statusUpdatedAt;
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

    /// @notice Delegated operational administrators selected by the owner.
    mapping(address => bool) public admins;

    string public constant name = "ExploreChem Company Identity";
    string public constant symbol = "EXPCID";

    mapping(uint256 => address) private tokenOwners;
    mapping(address => uint256) private tokenBalances;

    mapping(uint8 => bytes32) public expectedWorkflowId;

    mapping(bytes32 => ActorIdentity) private actors;
    mapping(bytes32 => mapping(address => bool)) public authorizedWallets;

    mapping(bytes32 => Evidence) private evidences;
    mapping(bytes32 => CurrentProofState) private currentProofStates;

    mapping(bytes32 => ProofRecord) private proofRecords;
    mapping(bytes32 => mapping(uint8 => bytes32)) public latestProofId;
    mapping(bytes32 => bytes32) public nextProofId;

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error OnlyOwner();
    error OnlyAdmin();
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

    error ActorAlreadyExists(bytes32 actorId);
    error ActorNotFound(bytes32 actorId);
    error ActorNotPending(bytes32 actorId, uint8 status);
    error ActorNotApproved(bytes32 actorId, uint8 status);
    error ActorSuspended(bytes32 actorId);
    error InvalidActorStatus(uint8 status);
    error ActorStatusUnchanged(bytes32 actorId, uint8 status);
    error ControllerUnchanged(bytes32 actorId, address controller);
    error UnauthorizedWallet(bytes32 actorId, address wallet);

    error NonexistentToken(uint256 tokenId);
    error SoulboundToken();

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
    event AdminUpdated(address indexed admin, bool authorized, address indexed updatedBy);
    event ForwarderUpdated(address indexed previousForwarder, address indexed newForwarder);
    event WorkflowConfigured(
        uint8 indexed proofType,
        bytes32 indexed previousWorkflowId,
        bytes32 indexed newWorkflowId
    );

    event ActorRegistrationRequested(
        bytes32 indexed actorId,
        address indexed controller,
        bytes32 indexed registrationHash,
        uint64 requestedAt
    );
    event ActorRegistrationApproved(
        bytes32 indexed actorId,
        uint256 indexed tokenId,
        address indexed controller,
        bytes32 registrationHash,
        bytes32 decisionHash,
        address approvedBy,
        uint64 approvedAt
    );
    event ActorRegistrationRejected(
        bytes32 indexed actorId,
        address indexed controller,
        bytes32 indexed registrationHash,
        bytes32 decisionHash,
        address rejectedBy,
        uint64 rejectedAt
    );
    event ActorControllerUpdated(
        bytes32 indexed actorId,
        address indexed previousController,
        address indexed newController,
        bytes32 actionHash
    );
    event ActorStatusUpdated(
        bytes32 indexed actorId,
        ActorStatus previousStatus,
        ActorStatus newStatus,
        bytes32 indexed decisionHash,
        address updatedBy,
        uint64 updatedAt
    );
    event WalletAuthorizationUpdated(
        bytes32 indexed actorId,
        address indexed wallet,
        bool authorized
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

    modifier onlyAdmin() {
        if (msg.sender != owner && !admins[msg.sender]) revert OnlyAdmin();
        _;
    }

    constructor(address initialForwarder) {
        if (initialForwarder == address(0)) revert ZeroAddress();

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

    /// @notice Grants or revokes delegated operational administration.
    /// @dev The owner is always an administrator and is not stored in this mapping.
    function setAdmin(address account, bool authorized) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        admins[account] = authorized;
        emit AdminUpdated(account, authorized, msg.sender);
    }

    function isAdmin(address account) public view returns (bool) {
        return account == owner || admins[account];
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

    /// @notice Requests company registration from the caller's own wallet.
    /// @dev `registrationHash` commits to the private registration data stored off-chain.
    ///      No identity token is minted until an administrator approves the request.
    function requestActorRegistration(
        bytes32 actorId,
        bytes32 registrationHash
    ) external {
        if (actorId == bytes32(0)) revert ZeroIdentifier();
        if (registrationHash == bytes32(0)) revert InvalidHash();
        if (actors[actorId].controller != address(0)) revert ActorAlreadyExists(actorId);

        uint64 timestamp = uint64(block.timestamp);
        uint256 tokenId = uint256(actorId);
        actors[actorId] = ActorIdentity({
            actorId: actorId,
            controller: msg.sender,
            tokenId: tokenId,
            registrationHash: registrationHash,
            status: ActorStatus.PENDING,
            createdAt: timestamp,
            statusUpdatedAt: timestamp
        });

        emit ActorRegistrationRequested(actorId, msg.sender, registrationHash, timestamp);
    }

    /// @notice Approves a pending request and permanently mints its locked identity token.
    function approveActorRegistration(
        bytes32 actorId,
        bytes32 decisionHash
    ) external onlyAdmin {
        if (decisionHash == bytes32(0)) revert InvalidHash();
        ActorIdentity storage actor = _requireActor(actorId);
        if (actor.status != ActorStatus.PENDING) {
            revert ActorNotPending(actorId, uint8(actor.status));
        }

        uint64 timestamp = uint64(block.timestamp);
        actor.status = ActorStatus.ACTIVE;
        actor.statusUpdatedAt = timestamp;
        authorizedWallets[actorId][actor.controller] = true;
        tokenOwners[actor.tokenId] = actor.controller;
        tokenBalances[actor.controller] += 1;

        emit ActorRegistrationApproved(
            actorId,
            actor.tokenId,
            actor.controller,
            actor.registrationHash,
            decisionHash,
            msg.sender,
            timestamp
        );
        emit WalletAuthorizationUpdated(actorId, actor.controller, true);
        emit Transfer(address(0), actor.controller, actor.tokenId);
        emit Locked(actor.tokenId);
    }

    /// @notice Rejects a pending request without minting an identity token.
    /// @dev The rejected request remains queryable and the actorId cannot be reused.
    function rejectActorRegistration(
        bytes32 actorId,
        bytes32 decisionHash
    ) external onlyAdmin {
        if (decisionHash == bytes32(0)) revert InvalidHash();
        ActorIdentity storage actor = _requireActor(actorId);
        if (actor.status != ActorStatus.PENDING) {
            revert ActorNotPending(actorId, uint8(actor.status));
        }

        uint64 timestamp = uint64(block.timestamp);
        actor.status = ActorStatus.REJECTED;
        actor.statusUpdatedAt = timestamp;

        emit ActorRegistrationRejected(
            actorId,
            actor.controller,
            actor.registrationHash,
            decisionHash,
            msg.sender,
            timestamp
        );
    }

    /// @notice Administrative recovery for a changed or lost company controller wallet.
    /// @dev Holders cannot transfer the token. This recovery preserves the same actorId,
    ///      tokenId, evidence, and proof history while moving control to a replacement wallet.
    function updateActorController(
        bytes32 actorId,
        address newController,
        bytes32 actionHash
    ) external onlyAdmin {
        if (newController == address(0)) revert ZeroAddress();
        if (actionHash == bytes32(0)) revert InvalidHash();
        ActorIdentity storage actor = _requireApprovedActor(actorId);

        address previous = actor.controller;
        if (previous == newController) revert ControllerUnchanged(actorId, newController);
        actor.controller = newController;
        authorizedWallets[actorId][previous] = false;
        authorizedWallets[actorId][newController] = true;
        tokenOwners[actor.tokenId] = newController;
        tokenBalances[previous] -= 1;
        tokenBalances[newController] += 1;

        emit ActorControllerUpdated(actorId, previous, newController, actionHash);
        emit WalletAuthorizationUpdated(actorId, previous, false);
        emit WalletAuthorizationUpdated(actorId, newController, true);
        emit Transfer(previous, newController, actor.tokenId);
    }

    /// @notice Suspends or reactivates a company without deleting its identity or history.
    function setActorStatus(
        bytes32 actorId,
        ActorStatus newStatus,
        bytes32 decisionHash
    ) external onlyAdmin {
        if (newStatus != ActorStatus.ACTIVE && newStatus != ActorStatus.SUSPENDED) {
            revert InvalidActorStatus(uint8(newStatus));
        }
        if (decisionHash == bytes32(0)) revert InvalidHash();

        ActorIdentity storage actor = _requireApprovedActor(actorId);
        ActorStatus previous = actor.status;
        if (previous == newStatus) revert ActorStatusUnchanged(actorId, uint8(newStatus));

        uint64 timestamp = uint64(block.timestamp);
        actor.status = newStatus;
        actor.statusUpdatedAt = timestamp;

        emit ActorStatusUpdated(
            actorId,
            previous,
            newStatus,
            decisionHash,
            msg.sender,
            timestamp
        );
    }

    function setWalletAuthorization(
        bytes32 actorId,
        address wallet,
        bool authorized
    ) external {
        if (wallet == address(0)) revert ZeroAddress();
        ActorIdentity storage actor = _requireActiveActor(actorId);
        if (msg.sender != actor.controller) {
            revert UnauthorizedWallet(actorId, msg.sender);
        }

        authorizedWallets[actorId][wallet] = authorized;
        emit WalletAuthorizationUpdated(actorId, wallet, authorized);
    }

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
        _requireActiveActor(actorId);
        if (!authorizedWallets[actorId][msg.sender]) {
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
    function onReport(bytes calldata metadata, bytes calldata report) external override {
        if (msg.sender != forwarder) revert InvalidForwarder(msg.sender, forwarder);
        if (report.length != REPORT_LENGTH) revert InvalidReportLength(report.length);

        ProofReport memory decoded = abi.decode(report, (ProofReport));
        uint8 proofType = _decodeProofType(decoded.proofType);
        CheckStatus status = _decodeFinalStatus(decoded.status);

        bytes32 configuredWorkflowId = expectedWorkflowId[proofType];
        if (configuredWorkflowId == bytes32(0)) {
            revert WorkflowNotConfigured(decoded.proofType);
        }

        bytes32 workflowId = _readWorkflowId(metadata);
        if (workflowId != configuredWorkflowId) {
            revert InvalidWorkflowId(workflowId, configuredWorkflowId);
        }

        _anchorProof(decoded, proofType, status, workflowId);
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

    function getActor(bytes32 actorId) external view returns (ActorIdentity memory) {
        return _requireActor(actorId);
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
        return authorizedWallets[actorId][wallet];
    }

    // ---------------------------------------------------------------------
    // Soulbound company identity (ERC-721 + ERC-5192)
    // ---------------------------------------------------------------------

    function balanceOf(address account) external view override returns (uint256) {
        if (account == address(0)) revert ZeroAddress();
        return tokenBalances[account];
    }

    function ownerOf(uint256 tokenId) public view override returns (address) {
        address tokenOwner = tokenOwners[tokenId];
        if (tokenOwner == address(0)) revert NonexistentToken(tokenId);
        return tokenOwner;
    }

    function locked(uint256 tokenId) external view override returns (bool) {
        ownerOf(tokenId);
        return true;
    }

    function tokenIdForActor(bytes32 actorId) external view returns (uint256) {
        ActorIdentity storage actor = _requireActor(actorId);
        return actor.tokenId;
    }

    function actorIdForToken(uint256 tokenId) external view returns (bytes32) {
        ownerOf(tokenId);
        return bytes32(tokenId);
    }

    function approve(address, uint256) external pure override {
        revert SoulboundToken();
    }

    function setApprovalForAll(address, bool) external pure override {
        revert SoulboundToken();
    }

    function getApproved(uint256 tokenId) external view override returns (address) {
        ownerOf(tokenId);
        return address(0);
    }

    function isApprovedForAll(address, address) external pure override returns (bool) {
        return false;
    }

    function transferFrom(address, address, uint256) external pure override {
        revert SoulboundToken();
    }

    function safeTransferFrom(address, address, uint256) external pure override {
        revert SoulboundToken();
    }

    function safeTransferFrom(address, address, uint256, bytes calldata) external pure override {
        revert SoulboundToken();
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

    function _requireActor(
        bytes32 actorId
    ) internal view returns (ActorIdentity storage actor) {
        actor = actors[actorId];
        if (actor.controller == address(0)) revert ActorNotFound(actorId);
    }

    function _requireApprovedActor(
        bytes32 actorId
    ) internal view returns (ActorIdentity storage actor) {
        actor = _requireActor(actorId);
        if (actor.status != ActorStatus.ACTIVE && actor.status != ActorStatus.SUSPENDED) {
            revert ActorNotApproved(actorId, uint8(actor.status));
        }
    }

    function _requireActiveActor(
        bytes32 actorId
    ) internal view returns (ActorIdentity storage actor) {
        actor = _requireApprovedActor(actorId);
        if (actor.status == ActorStatus.SUSPENDED) revert ActorSuspended(actorId);
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
            interfaceId == type(IERC721).interfaceId ||
            interfaceId == type(IERC5192).interfaceId ||
            interfaceId == type(IERC165).interfaceId;
    }
}
