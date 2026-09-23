// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title ExploreChem company identities and wallet governance
contract ExploreChemActorRegistry {
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
        bytes32 registrationHash;
        ActorStatus status;
        uint64 createdAt;
        uint64 statusUpdatedAt;
    }

    address public owner;
    mapping(address => bool) public admins;
    mapping(bytes32 => ActorIdentity) private actors;
    mapping(bytes32 => mapping(address => bool)) public authorizedWallets;
    error OnlyOwner();
    error OnlyAdmin();
    error ZeroAddress();
    error ZeroIdentifier();
    error InvalidHash();
    error ActorAlreadyExists(bytes32 actorId);
    error ActorNotFound(bytes32 actorId);
    error ActorNotPending(bytes32 actorId, uint8 status);
    error ActorNotApproved(bytes32 actorId, uint8 status);
    error ActorSuspended(bytes32 actorId);
    error InvalidActorStatus(uint8 status);
    error ActorStatusUnchanged(bytes32 actorId, uint8 status);
    error ControllerUnchanged(bytes32 actorId, address controller);
    error UnauthorizedWallet(bytes32 actorId, address wallet);


    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event AdminUpdated(address indexed admin, bool authorized, address indexed updatedBy);
    event ActorRegistrationRequested(
        bytes32 indexed actorId,
        address indexed controller,
        bytes32 indexed registrationHash,
        uint64 requestedAt
    );
    event ActorRegistrationApproved(
        bytes32 indexed actorId,

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

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    modifier onlyAdmin() {
        if (msg.sender != owner && !admins[msg.sender]) revert OnlyAdmin();
        _;
    }

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }
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

    /// @notice Requests company registration from the caller's own wallet.
    /// @dev `registrationHash` commits to the private registration data stored off-chain.
    ///      Registration becomes active after administrative approval; no identity token is issued.
    function requestActorRegistration(
        bytes32 actorId,
        bytes32 registrationHash
    ) external {
        if (actorId == bytes32(0)) revert ZeroIdentifier();
        if (registrationHash == bytes32(0)) revert InvalidHash();
        if (actors[actorId].controller != address(0)) revert ActorAlreadyExists(actorId);

        uint64 timestamp = uint64(block.timestamp);
        actors[actorId] = ActorIdentity({
            actorId: actorId,
            controller: msg.sender,
            registrationHash: registrationHash,
            status: ActorStatus.PENDING,
            createdAt: timestamp,
            statusUpdatedAt: timestamp
        });

        emit ActorRegistrationRequested(actorId, msg.sender, registrationHash, timestamp);
    }

    /// @notice Approves actor registration and authorizes its controller.
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

        emit ActorRegistrationApproved(
            actorId,
            actor.controller,
            actor.registrationHash,
            decisionHash,
            msg.sender,
            timestamp
        );
        emit WalletAuthorizationUpdated(actorId, actor.controller, true);
    }

    /// @notice Rejects a pending registration.
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
    /// @dev Preserves actorId and evidence history. Does not transfer material balances.
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

        emit ActorControllerUpdated(actorId, previous, newController, actionHash);
        emit WalletAuthorizationUpdated(actorId, previous, false);
        emit WalletAuthorizationUpdated(actorId, newController, true);
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

    function getActor(bytes32 actorId) external view returns (ActorIdentity memory) {
        return _requireActor(actorId);
    }
    function isWalletAuthorized(bytes32 actorId, address wallet) external view returns (bool) {
        return authorizedWallets[actorId][wallet];
    }
    function actorActive(bytes32 actorId) external view returns (bool) {
        return actors[actorId].status == ActorStatus.ACTIVE;
    }
    function requireActiveActor(bytes32 actorId) external view {
        _requireActiveActor(actorId);
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

}
