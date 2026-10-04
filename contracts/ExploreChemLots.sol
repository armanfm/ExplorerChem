// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { IExploreChemLotsE1 } from "./ExploreChemProofRegistry.sol";

interface IExploreChemRegistryE1 {
    function evidenceActor(bytes32 evidenceId) external view returns (bytes32);
    function actorActive(bytes32 actorId) external view returns (bool);
    function authorizedWallets(bytes32 actorId, address wallet) external view returns (bool);
    function proofsCurrent(bytes32 evidenceId, bytes32 mufId, bytes32 elementalId) external view returns (bool);
}

/// @notice E1: whole-lot commitments and public lineage, not material balances or ERC-1155.
/// @dev No openings, salts, masses or element identifiers are accepted or stored here.
contract ExploreChemLots is IExploreChemLotsE1 {
    address public immutable override registry;
    address public owner;
    address public pendingOwner;
    mapping(address => bool) public collateralAgents;
    uint256 public constant MAX_ITEMS = 32;
    uint256 public constant MAX_LINEAGE = 256;
    uint256 public constant CUSTODY_VERSION = 2;
    mapping(bytes32 => bytes32[]) private actorOrders;
    uint32 public constant MIN_WINDOW = 0;
    uint32 public constant MAX_WINDOW = 0;
    mapping(bytes32 => Lot) private lots;
    mapping(bytes32 => bytes32) public lotEvidence;
    mapping(bytes32 => bytes32[]) private parents;
    mapping(bytes32 => bytes32[]) private operationLots;
    mapping(bytes32 => bool) public usedOperations;
    mapping(bytes32 => bool) public evidenceTokenized;
    mapping(bytes32 => bytes32) public encumbrances;
    mapping(bytes32 => bytes32) public lockedOrder;
    mapping(bytes32 => bool) public usedEncumbranceRefs;
    uint256 private entered;

    enum OrderStatus { NONE, REQUESTED, ACCEPTED, LOCKED, RECEIVED, EXPIRED, CANCELLED, REJECTED }
    struct Order {
        bytes32 sender;
        bytes32 recipient;
        bytes32 lotId;
        bytes32 documentHash;
        uint32 receiptWindow;
        uint64 deadline;
        OrderStatus status;
    }
    mapping(bytes32 => Order) private orders;

    error RegistryOnly();
    error OnlyOwner();
    error OnlyPendingOwner();
    error OnlyCollateralAgent();
    error InvalidAddress();
    error InvalidIdentifier();
    error InvalidOperation();
    error DuplicateLotId(bytes32 id);
    error LotAlreadyExists(bytes32 id);
    error LotNotFound(bytes32 id);
    error WrongHolder(bytes32 id);
    error LotNotActive(bytes32 id);
    error LotNotUsable(bytes32 id);
    error LineageLimit();
    error ActorNotActive(bytes32 actor);
    error UnauthorizedWallet();
    error ProofNotCurrent();
    error OperationAlreadyUsed();
    error EvidenceAlreadyTokenized();
    error InvalidOrderState();
    error InvalidWindow();
    error OrderAlreadyExists();
    error DeadlineNotReached();
    error InvalidEncumbrance();
    error ReentrantCall();

    event LotCommitted(bytes32 indexed lotId, bytes32 indexed operationId, bytes32 commitment, bytes32 proofId);
    event LotConsumed(bytes32 indexed lotId, bytes32 indexed operationId);
    event LotDerived(bytes32 indexed childId, bytes32 indexed parentId, bytes32 indexed operationId);
    event LotStateChanged(bytes32 indexed lotId, LotState state, bytes32 ref);
    event LotHolderChanged(bytes32 indexed lotId, bytes32 indexed previousHolder, bytes32 indexed holder);
    event OrderCreated(bytes32 indexed orderId, bytes32 indexed sender, bytes32 indexed recipient, bytes32 lotId, bytes32 documentHash);
    event OrderUpdated(bytes32 indexed orderId, OrderStatus status, uint64 deadline);
    event CollateralAgentUpdated(address indexed agent, bool authorized);
    event OwnershipTransferStarted(address indexed owner, address indexed pendingOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event EncumbranceReleased(bytes32 indexed lotId, bytes32 encumbranceRef, bytes32 settlementRef);

    modifier onlyOwner() { if (msg.sender != owner) revert OnlyOwner(); _; }
    modifier nonReentrant() {
        if (entered != 0) revert ReentrantCall();
        entered = 1; _; entered = 0;
    }
    modifier onlyAgent() { if (!collateralAgents[msg.sender]) revert OnlyCollateralAgent(); _; }

    constructor(address registryAddress) {
        if (registryAddress.code.length == 0) revert InvalidAddress();
        registry = registryAddress;
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert OnlyPendingOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }
    /// @notice Owner can revoke/replace a lost collateral-agent key. No automatic cross-chain rollback.
    function setCollateralAgent(address agent, bool authorized) external onlyOwner {
        if (agent == address(0)) revert InvalidAddress();
        collateralAgents[agent] = authorized;
        emit CollateralAgentUpdated(agent, authorized);
    }
    function getLot(bytes32 id) external view override returns (Lot memory) { return _lot(id); }
    function holderOf(bytes32 id) external view returns (bytes32 holder, LotState state) {
        Lot storage lot = _lot(id); return (lot.holder, lot.state);
    }
    function getLotParents(bytes32 id) external view returns (bytes32[] memory) { _lot(id); return parents[id]; }
    function getOperationLots(bytes32 id) external view returns (bytes32[] memory) { return operationLots[id]; }
    function getOrder(bytes32 id) external view returns (Order memory) { return orders[id]; }
    function requireUsable(bytes32 id) external view { _usable(id); }

    function recordOperation(bytes32 evidenceId, bytes32 proofId, bytes32 mufProofId, OperationReport calldata op)
        external override nonReentrant
    {
        if (msg.sender != registry) revert RegistryOnly();
        IExploreChemRegistryE1 r = IExploreChemRegistryE1(registry);
        if (!r.proofsCurrent(evidenceId, mufProofId, proofId)) revert ProofNotCurrent();
        if (evidenceTokenized[evidenceId]) revert EvidenceAlreadyTokenized();
        if (op.operationId == bytes32(0)) revert InvalidIdentifier();
        if (usedOperations[op.operationId]) revert OperationAlreadyUsed();
        if (op.holder != r.evidenceActor(evidenceId)) revert WrongHolder(evidenceId);
        _activeActor(op.holder);
        if (op.outputs.length == 0 || op.outputs.length > MAX_ITEMS || op.inputLotIds.length > MAX_ITEMS) revert InvalidOperation();
        if (op.kind == 1) {
            if (op.inputLotIds.length != 0) revert InvalidOperation();
        } else if (op.kind == 2) {
            if (op.inputLotIds.length == 0) revert InvalidOperation();
        } else revert InvalidOperation();
        for (uint256 i; i < op.inputLotIds.length; ++i) {
            bytes32 id = op.inputLotIds[i];
            for (uint256 j; j < i; ++j) if (id == op.inputLotIds[j]) revert DuplicateLotId(id);
            _activeLot(id, op.holder);
            _usable(id);
        }
        for (uint256 i; i < op.outputs.length; ++i) {
            OutputLot calldata output = op.outputs[i];
            if (output.lotId == bytes32(0) || output.commitment == bytes32(0)) revert InvalidIdentifier();
            if (lots[output.lotId].state != LotState.NONE) revert LotAlreadyExists(output.lotId);
            for (uint256 j; j < i; ++j) if (output.lotId == op.outputs[j].lotId) revert DuplicateLotId(output.lotId);
            _activeActor(output.recipient);
            if (op.kind == 1 && output.recipient != op.holder) revert InvalidOperation();
        }
        usedOperations[op.operationId] = true;
        evidenceTokenized[evidenceId] = true;
        for (uint256 i; i < op.inputLotIds.length; ++i) {
            bytes32 id = op.inputLotIds[i];
            lots[id].state = LotState.CONSUMED;
            emit LotConsumed(id, op.operationId);
            emit LotStateChanged(id, LotState.CONSUMED, op.operationId);
        }
        for (uint256 i; i < op.outputs.length; ++i) {
            OutputLot calldata output = op.outputs[i];
            lots[output.lotId] = Lot(output.commitment, output.recipient, op.operationId, proofId, mufProofId, uint64(block.timestamp), LotState.ACTIVE);
            lotEvidence[output.lotId] = evidenceId;
            operationLots[op.operationId].push(output.lotId);
            for (uint256 j; j < op.inputLotIds.length; ++j) {
                parents[output.lotId].push(op.inputLotIds[j]);
                emit LotDerived(output.lotId, op.inputLotIds[j], op.operationId);
            }
            // Prevent creating an immediately unusable over-limit descendant.
            _usable(output.lotId);
            emit LotCommitted(output.lotId, op.operationId, output.commitment, proofId);
            emit LotHolderChanged(output.lotId, bytes32(0), output.recipient);
            emit LotStateChanged(output.lotId, LotState.ACTIVE, op.operationId);
        }
    }

    function encumber(bytes32 id, bytes32 encumbranceRef) external onlyAgent nonReentrant {
        Lot storage lot = _lot(id);
        _activeActor(lot.holder);
        if (lot.state != LotState.ACTIVE) revert LotNotActive(id);
        _usable(id);
        if (encumbranceRef == bytes32(0) || usedEncumbranceRefs[encumbranceRef]) revert InvalidEncumbrance();
        usedEncumbranceRefs[encumbranceRef] = true;
        encumbrances[id] = encumbranceRef;
        lot.state = LotState.ENCUMBERED;
        emit LotStateChanged(id, LotState.ENCUMBERED, encumbranceRef);
    }
    /// @dev Agent must verify settlement/cancelled issuance off-chain before releasing.
    /// A timeout is NOT evidence that a Solana RWA was never issued.
    function release(bytes32 id, bytes32 settlementRef) external onlyAgent nonReentrant {
        Lot storage lot = _lot(id);
        if (lot.state != LotState.ENCUMBERED || settlementRef == bytes32(0)) revert InvalidEncumbrance();
        bytes32 ref = encumbrances[id];
        delete encumbrances[id];
        lot.state = LotState.ACTIVE;
        emit EncumbranceReleased(id, ref, settlementRef);
        emit LotStateChanged(id, LotState.ACTIVE, settlementRef);
    }

    function orderIdFor(bytes32 sender, bytes32 requestId) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), sender, requestId));
    }
    function getActorOrderCount(bytes32 actor) external view returns (uint256) { return actorOrders[actor].length; }
    function getActorOrderId(bytes32 actor, uint256 index) external view returns (bytes32) { return actorOrders[actor][index]; }

    // The last argument is retained for ABI compatibility, but must be zero.
    // Sending reserves the entire lot. Acceptance atomically changes custody.
    function createOrder(bytes32 sender, bytes32 requestId, bytes32 recipient, bytes32 lotId, bytes32 documentHash, uint32 receiptWindow)
        external nonReentrant returns (bytes32 orderId)
    {
        _authorized(sender); _activeActor(recipient);
        if (sender == recipient || requestId == bytes32(0) || documentHash == bytes32(0)) revert InvalidIdentifier();
        if (receiptWindow != 0) revert InvalidWindow();
        _activeLot(lotId, sender); _usable(lotId);
        orderId = orderIdFor(sender, requestId);
        if (orders[orderId].status != OrderStatus.NONE) revert OrderAlreadyExists();
        orders[orderId] = Order(sender, recipient, lotId, documentHash, 0, 0, OrderStatus.REQUESTED);
        lots[lotId].state = LotState.IN_ESCROW;
        lockedOrder[lotId] = orderId;
        actorOrders[sender].push(orderId); actorOrders[recipient].push(orderId);
        emit OrderCreated(orderId, sender, recipient, lotId, documentHash);
        emit LotStateChanged(lotId, LotState.IN_ESCROW, orderId);
        _orderEvent(orderId);
    }
    function acceptOrder(bytes32 id) external nonReentrant { _receive(id); }
    function confirmReceipt(bytes32 id) external nonReentrant { _receive(id); }
    function _receive(bytes32 id) internal {
        Order storage o = orders[id];
        _requireEscrow(id, o); _authorized(o.recipient); _usable(o.lotId);
        Lot storage lot = lots[o.lotId];
        bytes32 previous = lot.holder;
        lot.holder = o.recipient; lot.state = LotState.ACTIVE;
        delete lockedOrder[o.lotId]; o.status = OrderStatus.RECEIVED;
        emit LotHolderChanged(o.lotId, previous, o.recipient);
        emit LotStateChanged(o.lotId, LotState.ACTIVE, id);
        _orderEvent(id);
    }
    // Kept as explicit reverts so old clients cannot silently run the old flow.
    function lockOrder(bytes32) external pure { revert InvalidOrderState(); }
    function finalizeOrder(bytes32) external pure { revert InvalidOrderState(); }
    function cancelOrder(bytes32 id) external nonReentrant {
        Order storage o = orders[id]; _authorized(o.sender);
        _returnLot(id, o, OrderStatus.CANCELLED);
    }
    function rejectOrder(bytes32 id) external nonReentrant {
        Order storage o = orders[id]; _authorized(o.recipient);
        _returnLot(id, o, OrderStatus.REJECTED);
    }
    function _returnLot(bytes32 id, Order storage o, OrderStatus status) internal {
        _requireEscrow(id, o);
        lots[o.lotId].state = LotState.ACTIVE; delete lockedOrder[o.lotId]; o.status = status;
        emit LotStateChanged(o.lotId, LotState.ACTIVE, id); _orderEvent(id);
    }
    function _requireEscrow(bytes32 id, Order storage o) internal view {
        if (o.status != OrderStatus.REQUESTED || lockedOrder[o.lotId] != id
            || lots[o.lotId].state != LotState.IN_ESCROW || lots[o.lotId].holder != o.sender) revert InvalidOrderState();
    }
    function _orderEvent(bytes32 id) internal { Order storage o = orders[id]; emit OrderUpdated(id, o.status, o.deadline); }
    function _lot(bytes32 id) internal view returns (Lot storage lot) {
        lot = lots[id]; if (lot.state == LotState.NONE) revert LotNotFound(id);
    }
    function _activeLot(bytes32 id, bytes32 holder) internal view {
        Lot storage lot = _lot(id);
        if (lot.state != LotState.ACTIVE) revert LotNotActive(id);
        if (lot.holder != holder) revert WrongHolder(id);
    }
    function _activeActor(bytes32 actor) internal view {
        if (actor == bytes32(0) || !IExploreChemRegistryE1(registry).actorActive(actor)) revert ActorNotActive(actor);
    }
    function _authorized(bytes32 actor) internal view {
        _activeActor(actor);
        if (!IExploreChemRegistryE1(registry).authorizedWallets(actor, msg.sender)) revert UnauthorizedWallet();
    }
    function _usable(bytes32 id) internal view {
        bytes32[] memory queue = new bytes32[](MAX_LINEAGE);
        queue[0] = id; uint256 count = 1;
        for (uint256 cursor; cursor < count; ++cursor) {
            bytes32 current = queue[cursor]; Lot storage lot = _lot(current);
            if (!IExploreChemRegistryE1(registry).proofsCurrent(lotEvidence[current], lot.mufProofId, lot.proofId)) revert LotNotUsable(current);
            bytes32[] storage ps = parents[current];
            for (uint256 j; j < ps.length; ++j) {
                bool found;
                for (uint256 k; k < count; ++k) if (queue[k] == ps[j]) { found = true; break; }
                if (!found) { if (count == MAX_LINEAGE) revert LineageLimit(); queue[count++] = ps[j]; }
            }
        }
    }
}
