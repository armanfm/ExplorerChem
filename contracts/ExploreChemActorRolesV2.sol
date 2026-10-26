// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IExploreChemE1ActorReader {
    function actorActive(bytes32 actorId) external view returns (bool);
    function isWalletAuthorized(bytes32 actorId, address wallet) external view returns (bool);
}

/// @notice Commercial activity permissions for identities already registered in E1.
/// @dev This contract never creates or replaces actor identities. Passive service roles
///      are maintained by ExploreChemDocumentaryRegistryV2.
contract ExploreChemActorRolesV2 {
    uint256 public constant MINER = 1 << 0;
    uint256 public constant TRANSPORTER = 1 << 1;
    uint256 public constant PROCESSOR = 1 << 5;
    uint256 public constant REFINER = 1 << 6;
    uint256 public constant RECYCLER = 1 << 7;
    uint256 public constant MANUFACTURER = 1 << 8;
    uint256 public constant EXPORTER = 1 << 9;
    uint256 public constant BUYER = 1 << 10;
    uint256 public constant SUPPORTED_COMMERCIAL_MASK = MINER | TRANSPORTER | PROCESSOR
        | REFINER | RECYCLER | MANUFACTURER | EXPORTER | BUYER;

    IExploreChemE1ActorReader public immutable e1Actors;
    address public owner;
    mapping(bytes32 actorId => uint256 mask) public actorActivities;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ActorActivitiesChanged(bytes32 indexed actorId, uint256 oldMask, uint256 newMask,
        bytes32 indexed policyRef);

    error InvalidAddress();
    error OnlyOwner();
    error InvalidActor(bytes32 actorId);
    error InvalidMask(uint256 mask);
    error InvalidPolicyRef();

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    constructor(address e1ActorRegistry, address initialAdmin) {
        if (e1ActorRegistry.code.length == 0 || initialAdmin == address(0)) revert InvalidAddress();
        e1Actors = IExploreChemE1ActorReader(e1ActorRegistry);
        owner = initialAdmin;
        emit OwnershipTransferred(address(0), initialAdmin);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setActorActivities(bytes32 actorId, uint256 mask, bytes32 policyRef) external onlyOwner {
        if (actorId == bytes32(0) || !e1Actors.actorActive(actorId)) revert InvalidActor(actorId);
        if ((mask & ~SUPPORTED_COMMERCIAL_MASK) != 0) revert InvalidMask(mask);
        if (policyRef == bytes32(0)) revert InvalidPolicyRef();
        uint256 previous = actorActivities[actorId];
        actorActivities[actorId] = mask;
        emit ActorActivitiesChanged(actorId, previous, mask, policyRef);
    }

    function actorHasActivity(bytes32 actorId, uint256 requiredMask) external view returns (bool) {
        return requiredMask != 0 && (requiredMask & ~SUPPORTED_COMMERCIAL_MASK) == 0
            && e1Actors.actorActive(actorId)
            && (actorActivities[actorId] & requiredMask) == requiredMask;
    }

    /// @notice True when an E1 actor has at least one commercial activity.
    /// @dev Used to distinguish commercial lot holders from passive service providers.
    function actorHasCommercialActivity(bytes32 actorId) external view returns (bool) {
        return e1Actors.actorActive(actorId)
            && (actorActivities[actorId] & SUPPORTED_COMMERCIAL_MASK) != 0;
    }

    function authorizedForActivity(bytes32 actorId, address wallet, uint256 requiredMask)
        external view returns (bool)
    {
        return requiredMask != 0 && (requiredMask & ~SUPPORTED_COMMERCIAL_MASK) == 0
            && e1Actors.actorActive(actorId) && e1Actors.isWalletAuthorized(actorId, wallet)
            && (actorActivities[actorId] & requiredMask) == requiredMask;
    }
}
