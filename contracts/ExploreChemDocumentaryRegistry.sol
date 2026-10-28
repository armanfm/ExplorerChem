// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IExploreChemDocumentaryActors {
    function actorActive(bytes32 actorId) external view returns (bool);
    function isWalletAuthorized(bytes32 actorId, address wallet) external view returns (bool);
}

interface IExploreChemDocumentaryLots {
    function registry() external view returns (address);
    function holderOf(bytes32 lotId) external view returns (bytes32 holder, uint8 state);
}

interface IExploreChemDocumentaryProofs {
    function actorRegistry() external view returns (address);
    function lotsContract() external view returns (address);
}

/// @title ExploreChem documentary records for existing lots
/// @notice Adds service requests and append-only documentary proofs without changing lots.
/// @dev This contract never calls lot transfer, operation, encumber or release functions.
/// Actor identities use the existing E1 registry; no new actor classification is required.
/// Request metadata, actors, hashes and events are public. Private files and access tokens
/// MUST remain off-chain. Storage must independently authenticate wallets/users and enforce
/// canReadPrivateRequest; this contract cannot make a file private by itself.
contract ExploreChemDocumentaryRegistry {
    enum ServiceKind { SAMPLING, LABORATORY, CUSTODY, AUDIT, CERTIFICATION }
    enum RequestState { NONE, PENDING, ACCEPTED, REJECTED, CANCELLED, COMPLETED }

    struct Request {
        bytes32 lotId;
        bytes32 requesterActorId;
        bytes32 providerActorId;
        bytes32 contextCommitment;
        bytes32 previousStageRecordId;
        uint64 createdAt;
        ServiceKind kind;
        RequestState state;
    }

    struct DocumentaryRecord {
        bytes32 requestId;
        bytes32 lotId;
        bytes32 actorId;
        // Private: salted commitment. Certificate: SHA-256 of the public file.
        bytes32 documentCommitment;
        bytes32 previousRecordId;
        address recordedBy;
        uint64 recordedAt;
        ServiceKind kind;
        bool publicDocument;
        bool revoked;
        string publicDocumentURI;
    }

    address public immutable proofRegistry;
    IExploreChemDocumentaryActors public immutable actorRegistry;
    IExploreChemDocumentaryLots public immutable lots;
    uint256 public recordCount;

    mapping(bytes32 => Request) private requests;
    mapping(bytes32 => DocumentaryRecord) private records;
    mapping(bytes32 => bytes32[]) private lotRequests;
    mapping(bytes32 => bytes32[]) private lotRecords;
    mapping(bytes32 => bytes32[]) private requestRecords;
    mapping(bytes32 => bytes32) public latestRecordForRequest;

    event ServiceRequested(bytes32 indexed requestId, bytes32 indexed lotId,
        bytes32 indexed providerActorId, bytes32 requesterActorId, ServiceKind kind,
        bytes32 contextCommitment, bytes32 previousStageRecordId);
    event RequestStateChanged(bytes32 indexed requestId, RequestState state);
    event DocumentaryRecordAdded(bytes32 indexed recordId, bytes32 indexed lotId,
        bytes32 indexed actorId, bytes32 requestId, ServiceKind kind,
        bytes32 documentCommitment, bytes32 previousRecordId, bool publicDocument);
    event PublicCertificatePublished(bytes32 indexed recordId, bytes32 indexed lotId,
        bytes32 fileSha256, string publicDocumentURI);
    event DocumentaryRecordRevoked(bytes32 indexed recordId, bytes32 indexed lotId,
        bytes32 indexed actorId, bytes32 reasonCommitment);

    error InvalidConfiguration();
    error InvalidIdentifier();
    error InvalidLot();
    error Unauthorized();
    error InactiveActor();
    error RequestAlreadyExists();
    error RequestNotFound();
    error InvalidState();
    error WrongServiceKind();
    error RecordNotFound();
    error InvalidRecordLink();
    error InvalidDocument();
    error AlreadyRevoked();

    /// @param existingProofRegistry The existing, already-linked ProofRegistry.
    /// Both read-only dependencies are discovered from it to avoid swapped arguments.
    constructor(address existingProofRegistry) {
        if (existingProofRegistry.code.length == 0) revert InvalidConfiguration();
        address actorsAddress = IExploreChemDocumentaryProofs(existingProofRegistry).actorRegistry();
        address lotsAddress = IExploreChemDocumentaryProofs(existingProofRegistry).lotsContract();
        if (actorsAddress.code.length == 0 || lotsAddress.code.length == 0) {
            revert InvalidConfiguration();
        }
        if (IExploreChemDocumentaryLots(lotsAddress).registry() != existingProofRegistry) {
            revert InvalidConfiguration();
        }
        // Validate the actor reader at deployment, including ABI return decoding.
        IExploreChemDocumentaryActors(actorsAddress).actorActive(bytes32(0));
        proofRegistry = existingProofRegistry;
        actorRegistry = IExploreChemDocumentaryActors(actorsAddress);
        lots = IExploreChemDocumentaryLots(lotsAddress);
    }

    /// @notice The current holder invites an existing actor to work on a lot.
    /// @dev ACTIVE, IN_ESCROW and ENCUMBERED lots may receive documents. No state
    /// is changed in Lots. A consumed lot keeps its history but gets no new request.
    /// previousStageRecordId optionally links this service to an earlier lot document.
    /// contextCommitment commits to private scope/materials; never submit their text.
    function requestService(bytes32 requestId, bytes32 lotId, bytes32 requesterActorId,
        bytes32 providerActorId, ServiceKind kind, bytes32 contextCommitment,
        bytes32 previousStageRecordId) external
    {
        if (requestId == bytes32(0) || lotId == bytes32(0) || contextCommitment == bytes32(0)) {
            revert InvalidIdentifier();
        }
        if (requests[requestId].state != RequestState.NONE) revert RequestAlreadyExists();
        _authorize(requesterActorId);
        if (providerActorId == bytes32(0) || !actorRegistry.actorActive(providerActorId)) {
            revert InactiveActor();
        }
        (bytes32 holder, uint8 state) = lots.holderOf(lotId);
        if (holder != requesterActorId || state == 0 || state > 3) revert InvalidLot();
        if (previousStageRecordId != bytes32(0)) {
            DocumentaryRecord storage previous = _record(previousStageRecordId);
            if (previous.lotId != lotId || previous.revoked) revert InvalidRecordLink();
        }
        requests[requestId] = Request({lotId: lotId, requesterActorId: requesterActorId,
            providerActorId: providerActorId, contextCommitment: contextCommitment,
            previousStageRecordId: previousStageRecordId, createdAt: uint64(block.timestamp),
            kind: kind, state: RequestState.PENDING});
        lotRequests[lotId].push(requestId);
        emit ServiceRequested(requestId, lotId, providerActorId, requesterActorId,
            kind, contextCommitment, previousStageRecordId);
    }

    function respond(bytes32 requestId, bool accept) external {
        Request storage request = _request(requestId);
        _authorize(request.providerActorId);
        if (request.state != RequestState.PENDING) revert InvalidState();
        request.state = accept ? RequestState.ACCEPTED : RequestState.REJECTED;
        emit RequestStateChanged(requestId, request.state);
    }

    function cancelPendingRequest(bytes32 requestId) external {
        Request storage request = _request(requestId);
        _authorize(request.requesterActorId);
        if (request.state != RequestState.PENDING) revert InvalidState();
        request.state = RequestState.CANCELLED;
        emit RequestStateChanged(requestId, request.state);
    }

    /// @notice Appends a private documentary proof, or a new immutable revision.
    /// @dev No private file URI, file hash opening or salt is submitted on-chain.
    /// previousRecordId must be the current latest record of THIS request (zero first).
    function recordPrivateEvidence(bytes32 requestId, bytes32 documentCommitment,
        bytes32 previousRecordId) external returns (bytes32 recordId)
    {
        Request storage request = _request(requestId);
        if (request.kind == ServiceKind.CERTIFICATION) revert WrongServiceKind();
        return _append(requestId, request, documentCommitment, previousRecordId, false, "");
    }

    /// @notice Publishes a certificate reference and the SHA-256 of its exact public file.
    /// @dev The issuer attests authorship, not regulatory accreditation. File hosting
    /// and public availability are handled off-chain. No effect on lot usability/RWA.
    function publishCertificate(bytes32 requestId, bytes32 fileSha256,
        string calldata publicDocumentURI, bytes32 previousRecordId)
        external returns (bytes32 recordId)
    {
        Request storage request = _request(requestId);
        if (request.kind != ServiceKind.CERTIFICATION) revert WrongServiceKind();
        uint256 length = bytes(publicDocumentURI).length;
        if (length == 0 || length > 2048) revert InvalidDocument();
        recordId = _append(requestId, request, fileSha256, previousRecordId, true, publicDocumentURI);
        emit PublicCertificatePublished(recordId, request.lotId, fileSha256, publicDocumentURI);
    }

    function _append(bytes32 requestId, Request storage request, bytes32 commitment,
        bytes32 previousRecordId, bool publicDocument, string memory uri)
        private returns (bytes32 recordId)
    {
        _authorize(request.providerActorId);
        if (request.state != RequestState.ACCEPTED && request.state != RequestState.COMPLETED) {
            revert InvalidState();
        }
        if (commitment == bytes32(0)) revert InvalidDocument();
        if (previousRecordId != latestRecordForRequest[requestId]) revert InvalidRecordLink();
        recordId = keccak256(abi.encode(block.chainid, address(this), requestId, ++recordCount));
        records[recordId] = DocumentaryRecord({requestId: requestId, lotId: request.lotId,
            actorId: request.providerActorId, documentCommitment: commitment,
            previousRecordId: previousRecordId, recordedBy: msg.sender,
            recordedAt: uint64(block.timestamp), kind: request.kind,
            publicDocument: publicDocument, revoked: false, publicDocumentURI: uri});
        latestRecordForRequest[requestId] = recordId;
        lotRecords[request.lotId].push(recordId);
        requestRecords[requestId].push(recordId);
        request.state = RequestState.COMPLETED;
        emit DocumentaryRecordAdded(recordId, request.lotId, request.providerActorId,
            requestId, request.kind, commitment, previousRecordId, publicDocument);
        emit RequestStateChanged(requestId, RequestState.COMPLETED);
    }

    /// @notice Marks an issuer's record revoked while preserving it and all revisions.
    function revokeRecord(bytes32 recordId, bytes32 reasonCommitment) external {
        DocumentaryRecord storage record = _record(recordId);
        _authorize(record.actorId);
        if (record.revoked) revert AlreadyRevoked();
        if (reasonCommitment == bytes32(0)) revert InvalidDocument();
        record.revoked = true;
        emit DocumentaryRecordRevoked(recordId, record.lotId, record.actorId, reasonCommitment);
    }

    /// @notice Authorization hint for a backend, not proof of wallet control.
    /// @dev The backend must verify a signed challenge/session before using wallet.
    /// Invitation participants can see the request materials even before acceptance;
    /// rejected/cancelled invitations lose private access. Existing public certificates
    /// remain public, including their revocation status and superseded revisions.
    function canReadPrivateRequest(bytes32 requestId, address wallet) external view returns (bool) {
        Request storage request = requests[requestId];
        if (request.state == RequestState.NONE || request.state == RequestState.REJECTED
            || request.state == RequestState.CANCELLED || wallet == address(0)) return false;
        return _authorizedWallet(request.requesterActorId, wallet)
            || _authorizedWallet(request.providerActorId, wallet);
    }

    function getRequest(bytes32 requestId) external view returns (Request memory) {
        return _request(requestId);
    }
    function getRecord(bytes32 recordId) external view returns (DocumentaryRecord memory) {
        return _record(recordId);
    }
    function lotRequestCount(bytes32 lotId) external view returns (uint256) { return lotRequests[lotId].length; }
    function lotRequestAt(bytes32 lotId, uint256 index) external view returns (bytes32) { return lotRequests[lotId][index]; }
    function lotRecordCount(bytes32 lotId) external view returns (uint256) { return lotRecords[lotId].length; }
    function lotRecordAt(bytes32 lotId, uint256 index) external view returns (bytes32) { return lotRecords[lotId][index]; }
    function requestRecordCount(bytes32 requestId) external view returns (uint256) { return requestRecords[requestId].length; }
    function requestRecordAt(bytes32 requestId, uint256 index) external view returns (bytes32) { return requestRecords[requestId][index]; }

    function _authorize(bytes32 actorId) private view {
        if (!_authorizedWallet(actorId, msg.sender)) revert Unauthorized();
    }
    function _authorizedWallet(bytes32 actorId, address wallet) private view returns (bool) {
        return actorId != bytes32(0) && actorRegistry.actorActive(actorId)
            && actorRegistry.isWalletAuthorized(actorId, wallet);
    }
    function _request(bytes32 requestId) private view returns (Request storage request) {
        request = requests[requestId];
        if (request.state == RequestState.NONE) revert RequestNotFound();
    }
    function _record(bytes32 recordId) private view returns (DocumentaryRecord storage record) {
        record = records[recordId];
        if (record.requestId == bytes32(0)) revert RecordNotFound();
    }
}
