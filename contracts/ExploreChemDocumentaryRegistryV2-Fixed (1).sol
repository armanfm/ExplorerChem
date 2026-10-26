// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IE2ActorReader {
    function actorActive(bytes32 actorId) external view returns (bool);
    function isWalletAuthorized(bytes32 actorId, address wallet) external view returns (bool);
}

interface IE2LotsDocumentary {
    function holderOf(bytes32 lotId) external view returns (bytes32 holder, uint8 state);
    function heldLotCount(bytes32 actorId) external view returns (uint256);
}

/**
 * @title ExploreChemDocumentaryRegistryV2
 * @notice On-chain service assignment, stage proofs, and public certificates linked to lots.
 * @dev Public ABI includes the functions expected by ECDOC_ABI in the supplied HTML.
 *      The frontend must also call assignRequest/respond/cancelPendingOrRejected before work.
 */
contract ExploreChemDocumentaryRegistryV2 {
    enum Kind { SAMPLING, CUSTODY, LAB_REPORT, AUDIT_REPORT, CERTIFICATION }
    enum RequestState { NONE, PENDING, ACCEPTED, REJECTED, CANCELLED, COMPLETED }
    enum Decision { NONE, CERTIFIED, REJECTED }
    enum CertificateState { NOT_CERTIFIED, CERTIFIED, REJECTED, EXPIRED, REVOKED, STALE }

    struct Request {
        bytes32 lotId;
        bytes32 requesterActorId;
        bytes32 providerActorId;
        bytes32 previousRequestId;
        Kind kind;
        RequestState state;
        uint64 requestedAt;
    }
    struct Work {
        bytes32 requestId;
        bytes32 lotId;
        bytes32 actorId;
        bytes32 commitment;
        uint8 kind;
        uint64 recordedAt;
    }
    struct Certification {
        bytes32 requestId;
        bytes32 issuerActorId;
        bytes32 certificateSha256;
        string publicDocumentPath;
        uint8 decision;
        uint64 issuedAt;
        uint64 validUntil;
        bool revoked;
    }

    uint8 private constant CERTIFIED = 1;
    uint8 private constant REJECTED = 2;
    uint8 private constant SERVICE_CERTIFICATION = 1 << 4;
    uint8 public constant SUPPORTED_SERVICE_MASK = (1 << 5) - 1;

    IE2ActorReader public immutable e1Actors;
    IE2LotsDocumentary public immutable lots;
    address public owner;
    mapping(bytes32 actorId => uint8 serviceMask) private passiveServiceMasks;
    mapping(bytes32 actorId => bytes32 groupId) public passiveConflictGroups;
    mapping(bytes32 requestId => Request request) private requests;
    mapping(bytes32 requestId => Work work) private workProofs;
    mapping(bytes32 lotId => bytes32[]) private requestHistory;
    mapping(bytes32 lotId => mapping(uint8 kind => bytes32 requestId)) public latestCompletedRequest;
    mapping(bytes32 lotId => Certification cert) private latestCertifications;
    mapping(bytes32 lotId => bytes32[]) private certificationHistory;
    mapping(bytes32 requestId => bytes32 replacingRequestId) public replacedBy;
    mapping(bytes32 lotId => uint256 revision) public documentaryRevision;
    mapping(bytes32 lotId => uint256 revision) private certifiedRevision;

    event RequestAssigned(bytes32 indexed requestId, bytes32 indexed lotId, bytes32 indexed providerActorId,
        bytes32 requesterActorId, Kind kind, bytes32 previousRequestId);
    event RequestStatusChanged(bytes32 indexed requestId, RequestState oldState, RequestState newState);
    event WorkCompleted(bytes32 indexed requestId, bytes32 indexed lotId, bytes32 indexed actorId,
        uint8 kind, bytes32 commitment, uint64 recordedAt);
    event DocumentaryBindingUpdated(bytes32 indexed lotId, Kind indexed kind, bytes32 indexed requestId,
        bytes32 previousRequestId);
    event CertificationDecision(bytes32 indexed lotId, bytes32 indexed requestId, bytes32 indexed issuerActorId,
        uint8 decision, bytes32 certificateSha256, string publicDocumentPath, uint64 validUntil);
    event CertificationRevoked(bytes32 indexed lotId, bytes32 indexed requestId,
        bytes32 indexed issuerActorId, bytes32 reasonCommitment);
    event PassiveServicesUpdated(bytes32 indexed actorId, uint8 oldMask, uint8 newMask);
    event PassiveConflictGroupUpdated(bytes32 indexed actorId, bytes32 oldGroup, bytes32 newGroup);

    error InvalidAddress();
    error InvalidInput();
    error Unauthorized();
    error UnauthorizedService();
    error InvalidLot();
    error InvalidTransition();
    error DuplicateRequest();
    error ConflictOfInterest();
    error PrerequisiteMissing();
    error OnlyOwner();
    error InvalidPassiveRole();

    modifier onlyOwner() { if (msg.sender != owner) revert OnlyOwner(); _; }

    constructor() {
        address e1ActorRegistry = 0xB9d81FEc13BcC00eC70C7bD2F877A1d5B5DA51D2;
        address e2Lots = 0xA065Baa4F873c1b4E213162FA13EB04995554849;
        (bool validLots, bytes memory countData) = e2Lots.staticcall(abi.encodeWithSelector(IE2LotsDocumentary.heldLotCount.selector, bytes32(0)));
        if (!validLots || countData.length != 32) revert InvalidAddress();
        if (e1ActorRegistry.code.length == 0 || e2Lots.code.length == 0) revert InvalidAddress();
        e1Actors = IE2ActorReader(e1ActorRegistry);
        lots = IE2LotsDocumentary(e2Lots);
        owner = msg.sender;
    }

    /// @notice Compatibility view consumed by the attached HTML.
    function actorServiceMask(bytes32 actorId) external view returns (uint8) {
        return e1Actors.actorActive(actorId) ? passiveServiceMasks[actorId] : 0;
    }

    function setPassiveServiceMask(bytes32 actorId, uint8 mask) external onlyOwner {
        if (actorId == bytes32(0) || (mask & ~SUPPORTED_SERVICE_MASK) != 0
            || (mask != 0 && !e1Actors.actorActive(actorId))) revert InvalidPassiveRole();
        if (mask != 0 && lots.heldLotCount(actorId) != 0) revert InvalidPassiveRole();
        uint8 oldMask = passiveServiceMasks[actorId];
        passiveServiceMasks[actorId] = mask;
        emit PassiveServicesUpdated(actorId, oldMask, mask);
    }

    function setPassiveConflictGroup(bytes32 actorId, bytes32 groupId) external onlyOwner {
        if (actorId == bytes32(0) || (groupId != bytes32(0) && !e1Actors.actorActive(actorId))) {
            revert InvalidPassiveRole();
        }
        bytes32 oldGroup = passiveConflictGroups[actorId];
        passiveConflictGroups[actorId] = groupId;
        emit PassiveConflictGroupUpdated(actorId, oldGroup, groupId);
    }

    function requiredActivity(Kind kind) public pure returns (uint256) {
        return uint256(1) << uint8(kind);
    }

    function _authorized(bytes32 actorId) private view {
        if (!e1Actors.actorActive(actorId) || !e1Actors.isWalletAuthorized(actorId, msg.sender)) revert Unauthorized();
    }

    function _holderState(bytes32 lotId, bytes32 requesterActorId) private view {
        if (lotId == bytes32(0) || requesterActorId == bytes32(0)) revert InvalidInput();
        (bytes32 holder, uint8 state) = lots.holderOf(lotId);
        if (holder != requesterActorId || (state != 1 && state != 3)) revert InvalidLot();
    }

    function _checkProvider(bytes32 lotId, bytes32 requesterActorId, bytes32 providerActorId, Kind kind) private view {
        if (providerActorId == bytes32(0) || !e1Actors.actorActive(providerActorId)
            || _actorsConflict(providerActorId, requesterActorId)) revert Unauthorized();
        if ((passiveServiceMasks[providerActorId] & uint8(1 << uint8(kind))) == 0) revert UnauthorizedService();
        if (kind == Kind.AUDIT_REPORT) {
            bytes32 lab = _latestActor(lotId, Kind.LAB_REPORT);
            if (lab != bytes32(0) && _actorsConflict(providerActorId, lab)) revert ConflictOfInterest();
        }
        if (kind == Kind.CERTIFICATION) {
            bytes32 lab = _latestActor(lotId, Kind.LAB_REPORT);
            bytes32 auditor = _latestActor(lotId, Kind.AUDIT_REPORT);
            if ((lab != bytes32(0) && _actorsConflict(providerActorId, lab))
                || (auditor != bytes32(0) && _actorsConflict(providerActorId, auditor))) {
                revert ConflictOfInterest();
            }
        }
    }

    function _actorsConflict(bytes32 first, bytes32 second) private view returns (bool) {
        if (first == second) return true;
        bytes32 group = passiveConflictGroups[first];
        return group != bytes32(0) && group == passiveConflictGroups[second];
    }

    function _latestActor(bytes32 lotId, Kind kind) private view returns (bytes32) {
        bytes32 id = latestCompletedRequest[lotId][uint8(kind)];
        return id == bytes32(0) ? bytes32(0) : workProofs[id].actorId;
    }

    function assignRequest(bytes32 requestId, bytes32 lotId, bytes32 requesterActorId,
        bytes32 providerActorId, Kind kind, bytes32 previousRequestId) external
    {
        if (requestId == bytes32(0) || requests[requestId].state != RequestState.NONE) revert DuplicateRequest();
        _authorized(requesterActorId);
        _holderState(lotId, requesterActorId);
        _checkProvider(lotId, requesterActorId, providerActorId, kind);
        if (previousRequestId != bytes32(0)) {
            Request storage previous = requests[previousRequestId];
            if (replacedBy[previousRequestId] != bytes32(0) || previous.lotId != lotId
                || previous.kind != kind || previous.requesterActorId != requesterActorId
                || (previous.state != RequestState.PENDING && previous.state != RequestState.REJECTED
                    && previous.state != RequestState.CANCELLED) || previous.providerActorId == providerActorId) {
                revert InvalidTransition();
            }
            replacedBy[previousRequestId] = requestId;
            if (previous.state != RequestState.CANCELLED) {
                RequestState oldState = previous.state;
                previous.state = RequestState.CANCELLED;
                emit RequestStatusChanged(previousRequestId, oldState, RequestState.CANCELLED);
            }
        }
        requests[requestId] = Request(lotId, requesterActorId, providerActorId,
            previousRequestId, kind, RequestState.PENDING, uint64(block.timestamp));
        requestHistory[lotId].push(requestId);
        emit RequestAssigned(requestId, lotId, providerActorId, requesterActorId, kind, previousRequestId);
    }

    function respond(bytes32 requestId, bool accept) external {
        Request storage request = requests[requestId];
        if (request.state != RequestState.PENDING) revert InvalidTransition();
        _authorized(request.providerActorId);
        _checkProvider(request.lotId, request.requesterActorId, request.providerActorId, request.kind);
        RequestState next = accept ? RequestState.ACCEPTED : RequestState.REJECTED;
        request.state = next;
        emit RequestStatusChanged(requestId, RequestState.PENDING, next);
    }

    function cancelPendingOrRejected(bytes32 requestId) external {
        Request storage request = requests[requestId];
        if (request.state != RequestState.PENDING && request.state != RequestState.REJECTED) revert InvalidTransition();
        _authorized(request.requesterActorId);
        _holderState(request.lotId, request.requesterActorId);
        RequestState oldState = request.state;
        request.state = RequestState.CANCELLED;
        emit RequestStatusChanged(requestId, oldState, RequestState.CANCELLED);
    }

    /// @notice ABI-compatible with the attached HTML's `recordWork` call.
    function recordWork(bytes32 requestId, bytes32 lotId, bytes32 actorId, uint8 kind, bytes32 commitment) external {
        if (kind > uint8(Kind.AUDIT_REPORT) || commitment == bytes32(0)) revert InvalidInput();
        Request memory request = _acceptedRequest(requestId, lotId, actorId, Kind(kind));
        _record(requestId, request, commitment);
    }

    /// @notice ABI-compatible with the attached HTML's 8-argument certification call.
    function decideCertification(bytes32 requestId, bytes32 lotId, bytes32 issuerActorId,
        bytes32 commitment, uint8 decision, bytes32 certificateSha256, string calldata publicDocumentPath,
        uint64 validUntil) external
    {
        if (commitment == bytes32(0) || (decision != 1 && decision != 2)) revert InvalidInput();
        Request memory request = _acceptedRequest(requestId, lotId, issuerActorId, Kind.CERTIFICATION);
        if (latestCompletedRequest[lotId][uint8(Kind.SAMPLING)] == bytes32(0)
            || latestCompletedRequest[lotId][uint8(Kind.CUSTODY)] == bytes32(0)
            || latestCompletedRequest[lotId][uint8(Kind.LAB_REPORT)] == bytes32(0)
            || latestCompletedRequest[lotId][uint8(Kind.AUDIT_REPORT)] == bytes32(0)) revert PrerequisiteMissing();

        if (decision == 1) {
            uint256 pathLength = bytes(publicDocumentPath).length;
            if (certificateSha256 == bytes32(0) || pathLength < 6 || pathLength > 220
                || keccak256(bytes(publicDocumentPath))
                    != keccak256(bytes(string.concat(_hex32(requestId), "/certificate.pdf")))
                || (validUntil != 0 && validUntil <= block.timestamp)) revert InvalidInput();
        } else if (certificateSha256 != bytes32(0) || bytes(publicDocumentPath).length != 0 || validUntil != 0) {
            revert InvalidInput();
        }
        _checkProvider(lotId, request.requesterActorId, issuerActorId, Kind.CERTIFICATION);
        _record(requestId, request, commitment);
        latestCertifications[lotId] = Certification(requestId, issuerActorId, certificateSha256,
            publicDocumentPath, decision, uint64(block.timestamp), validUntil, false);
        certifiedRevision[lotId] = documentaryRevision[lotId];
        certificationHistory[lotId].push(requestId);
        emit CertificationDecision(lotId, requestId, issuerActorId, decision,
            certificateSha256, publicDocumentPath, validUntil);
    }

    function _acceptedRequest(bytes32 requestId, bytes32 lotId, bytes32 actorId, Kind kind)
        private view returns (Request memory request)
    {
        request = requests[requestId];
        if (request.state != RequestState.ACCEPTED || request.lotId != lotId
            || request.providerActorId != actorId || request.kind != kind) revert InvalidTransition();
        _authorized(actorId);
        _checkProvider(lotId, request.requesterActorId, actorId, kind);
    }

    function _record(bytes32 requestId, Request memory request, bytes32 commitment) private {
        if (commitment == bytes32(0)) revert InvalidInput();
        requests[requestId].state = RequestState.COMPLETED;
        workProofs[requestId] = Work(requestId, request.lotId, request.providerActorId,
            commitment, uint8(request.kind), uint64(block.timestamp));
        bytes32 previousRequestId = latestCompletedRequest[request.lotId][uint8(request.kind)];
        latestCompletedRequest[request.lotId][uint8(request.kind)] = requestId;
        documentaryRevision[request.lotId] += 1;
        emit RequestStatusChanged(requestId, RequestState.ACCEPTED, RequestState.COMPLETED);
        emit WorkCompleted(requestId, request.lotId, request.providerActorId,
            uint8(request.kind), commitment, uint64(block.timestamp));
        emit DocumentaryBindingUpdated(request.lotId, request.kind, requestId, previousRequestId);
    }

    function revokeCertification(bytes32 lotId, bytes32 reasonCommitment) external {
        Certification storage cert = latestCertifications[lotId];
        if (cert.requestId == bytes32(0) || cert.revoked || reasonCommitment == bytes32(0)) revert InvalidInput();
        _authorized(cert.issuerActorId);
        if ((passiveServiceMasks[cert.issuerActorId] & SERVICE_CERTIFICATION) == 0) revert UnauthorizedService();
        cert.revoked = true;
        emit CertificationRevoked(lotId, cert.requestId, cert.issuerActorId, reasonCommitment);
    }

    function getRequest(bytes32 requestId) external view returns (Request memory) { return requests[requestId]; }
    function getWork(bytes32 requestId) external view returns (Work memory) { return workProofs[requestId]; }
    function requestCount(bytes32 lotId) external view returns (uint256) { return requestHistory[lotId].length; }
    function requestIdAt(bytes32 lotId, uint256 index) external view returns (bytes32) { return requestHistory[lotId][index]; }
    function latestCertification(bytes32 lotId) external view returns (Certification memory) { return latestCertifications[lotId]; }
    function certificationCount(bytes32 lotId) external view returns (uint256) { return certificationHistory[lotId].length; }
    function certificationIdAt(bytes32 lotId, uint256 index) external view returns (bytes32) {
        return certificationHistory[lotId][index];
    }
    function _hex32(bytes32 value) private pure returns (string memory) {
        bytes16 alphabet = "0123456789abcdef";
        bytes memory result = new bytes(66);
        result[0] = "0";
        result[1] = "x";
        for (uint256 i; i < 32; ++i) {
            uint8 current = uint8(value[i]);
            result[2 + i * 2] = alphabet[current >> 4];
            result[3 + i * 2] = alphabet[current & 0x0f];
        }
        return string(result);
    }
    function certificationState(bytes32 lotId) external view returns (uint8) {
        Certification storage cert = latestCertifications[lotId];
        if (cert.requestId == bytes32(0)) return uint8(CertificateState.NOT_CERTIFIED);
        if (cert.revoked) return uint8(CertificateState.REVOKED);
        if (cert.decision == REJECTED) return uint8(CertificateState.REJECTED);
        if (certifiedRevision[lotId] != documentaryRevision[lotId]) return uint8(CertificateState.STALE);
        if (cert.validUntil != 0 && cert.validUntil <= block.timestamp) return uint8(CertificateState.EXPIRED);
        return uint8(CertificateState.CERTIFIED);
    }
}
