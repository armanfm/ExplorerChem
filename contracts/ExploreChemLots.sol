// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IExploreChemRegistry {
    function evidenceActor(bytes32 evidenceId) external view returns (bytes32);
    function actorActive(bytes32 actorId) external view returns (bool);
    function authorizedWallets(bytes32 actorId, address wallet) external view returns (bool);
    function tokenHolderEligible(bytes32 evidenceId) external view returns (bool);
    function proofsCurrent(bytes32 evidenceId, bytes32 mufId, bytes32 elementalId) external view returns (bool);
}
/// @notice Registration balances only; does not certify physical custody or legal rights.
contract ExploreChemLots {
    IExploreChemRegistry public immutable registry;
    error RegistryOnly();
    error ZeroAddress();
    error ZeroIdentifier();
    error InvalidHash();
    constructor(address registryAddress) {
        if (registryAddress.code.length == 0) revert ZeroAddress();
        registry = IExploreChemRegistry(registryAddress);
    }
    // ---------------------------------------------------------------------
    // Registration lots: Actor-scoped balances (not ERC-1155), atomic issuance and orders
    // ---------------------------------------------------------------------
    bytes32 public constant ESCROW_ACTOR = keccak256("ExploreChem/OrderEscrow/v2");
    uint256 public constant MAX_ITEMS = 32;
    uint256 public constant RECEIPT_WINDOW = 1 days;
    enum ActionKind { NONE, INITIAL, TRANSFORM }
    enum OrderStatus { NONE, REQUESTED, ACCEPTED, LOCKED, RECEIVED, TIMED_OUT, CANCELLED, REJECTED }
    struct LotInput { uint256 lotId; uint256 quantity; }
    /// @dev basisHash identifies ONE stable accounting basis (material/element and unit).
    ///      quantity is an integer in that basis, not a universal kg/mg conversion.
    struct Component { bytes32 basisHash; uint256 quantity; }
    // One spendable lot is dry material mass; components are contained amounts, never independent balances.
    bytes32 public constant MATERIAL_BASIS = keccak256("ExploreChem/MaterialMass/dry/mg/v1");
    uint256 public constant MAX_MASS = type(uint96).max;
    struct LotOutput { bytes32 streamId; bytes32 basisHash; bytes32 metadataHash; uint256 quantity; Component[] components; bytes32 recipientActorId; }
    mapping(uint256 => Component[]) private lotComponents;
    mapping(uint256 => mapping(bytes32 => mapping(bytes32 => uint256))) private componentBalances;
    mapping(uint256 => bytes32) public compositionProof;
    event ComponentConsumed(bytes32 indexed operationId, uint256 indexed lotId, bytes32 indexed basisHash, uint256 quantity, bytes32 proofId);
    error InvalidComposition();

    event ProcessingDifference(bytes32 indexed operationId, bytes32 indexed basisHash, uint256 consumed, uint256 represented, uint256 unrepresented);
    function getLotComposition(uint256 id) external view returns (Component[] memory) { _lot(id); return lotComponents[id]; }
    /// @notice Registered contained amount, including material reserved but not yet assayed/consumed.
    function componentBalance(bytes32 actorId, uint256 id, bytes32 basis) external view returns(uint256) {
        _lot(id); return componentBalances[id][actorId][basis];
    }
    function getActorComposition(bytes32 actorId,uint256 id) external view returns(Component[] memory cs) {
        _lot(id); cs=new Component[](lotComponents[id].length);
        for(uint256 i; i<cs.length; ++i) {
            bytes32 basis=lotComponents[id][i].basisHash;
            cs[i]=Component(basis,componentBalances[id][actorId][basis]);
        }
    }
    function _validateOutput(LotOutput calldata output) internal pure {
        if(output.basisHash != MATERIAL_BASIS || output.quantity == 0 || output.quantity > MAX_MASS || output.components.length > 17) revert InvalidComposition();
        uint256 sum;
        for(uint256 i; i < output.components.length; ++i) {
            Component calldata c=output.components[i];
            if(c.basisHash==bytes32(0) || c.basisHash==MATERIAL_BASIS || c.quantity==0 || c.quantity>output.quantity) revert InvalidComposition();
            for(uint256 j; j<i; ++j) if(output.components[j].basisHash==c.basisHash) revert InvalidComposition();
            sum+=c.quantity;
        }
        if(sum>output.quantity) revert InvalidComposition();
    }
    struct TokenAction {
        ActionKind kind;
        bytes32 operationId;
        bytes32 mufProofId;
        LotInput[] inputs;
        LotOutput[] outputs;
        Component[][] consumedComponents;
    }
    struct Lot {
        bytes32 evidenceId;
        bytes32 elementalProofId;
        bytes32 mufProofId;
        bytes32 basisHash;
        bytes32 metadataHash;
        bytes32 streamId;
        bytes32 operationId;
        uint256 issued;
        uint256 supply;
    }
    struct Order {
        bytes32 sender;
        bytes32 recipient;
        uint256 sourceLotId;
        uint256 parcelLotId;
        uint256 quantity;
        bytes32 documentHash;
        uint64 deadline;
        OrderStatus status;
    }
    uint256 public lotCount;
    mapping(uint256 => Lot) private lots;
    mapping(uint256 => mapping(bytes32 => uint256)) private lotBalances;
    mapping(bytes32 => bool) public usedOperations;
    mapping(bytes32 => bool) public evidenceTokenized;
    mapping(bytes32 => uint256[]) private operationLots;
    mapping(uint256 => uint256[]) private lotParents;
    mapping(bytes32 => Order) private orders;
    uint256 private entered;

    error WholeLotRequired();
    error ReentrantCall();
    error InvalidOperator();
    error NotTokenHolder();
    error InvalidTokenAction();
    error TokenReportRequired();
    error InvalidReportDomain();
    error InvalidQuantity();
    error TooManyItems();
    error LotNotFound(uint256 lotId);
    error InsufficientLotBalance(uint256 lotId);
    error OperationAlreadyUsed(bytes32 operationId);
    error EvidenceAlreadyTokenized(bytes32 evidenceId);
    error MufNotCompliant();
    error ProofNotCurrent();
    error LotNotUsable(uint256 lotId);
    error LineageLimit();
    error BasisMismatch();
    error SupplyExceeded();
    error TransformationNotApproved();
    error UnsafeRecipient();
    error InvalidOrderState();
    error WrongOrderParty();
    error DeadlineNotReached();
    error OrderAlreadyExists();
    error EscrowOnlyViaOrder();

    event ActorBalanceChanged(address indexed operator, bytes32 indexed from, bytes32 indexed to, uint256 id, uint256 value);
    event LotCreated(uint256 indexed lotId, bytes32 indexed evidenceId, bytes32 indexed operationId, bytes32 basisHash, bytes32 metadataHash, bytes32 streamId, uint256 quantity);
    event LotDerived(uint256 indexed childId, uint256 indexed parentId, bytes32 indexed operationId);
    event TokenOperation(bytes32 indexed operationId, bytes32 indexed evidenceId, ActionKind kind, bytes32 holder);
    event TransformationAuthorized(bytes32 indexed evidenceId, bytes32 indexed holder, bytes32 actionHash);
    event OrderCreated(bytes32 indexed orderId, bytes32 indexed sender, bytes32 indexed recipient, uint256 sourceLotId, uint256 quantity, bytes32 documentHash);
    event OrderUpdated(bytes32 indexed orderId, OrderStatus status, uint256 parcelLotId, uint64 deadline);

    modifier nonReentrant() {
        if (entered != 0) revert ReentrantCall();
        entered = 1;
        _;
        entered = 0;
    }

    function getLot(uint256 id) external view returns (Lot memory) { return _lot(id); }
    function getLotParents(uint256 id) external view returns (uint256[] memory) { _lot(id); return lotParents[id]; }
    function getOperationLots(bytes32 id) external view returns (uint256[] memory) { return operationLots[id]; }
    function getOrder(bytes32 id) external view returns (Order memory) { return orders[id]; }
    function totalSupply(uint256 id) external view returns (uint256) { return lots[id].supply; }

    /// @notice Available registration balance for one company and lot; escrow is separate.
    function balanceOf(bytes32 account, uint256 id) public view returns (uint256) {
        if (account == bytes32(0)) revert ZeroAddress();
        return lotBalances[id][account];
    }
    function balanceOfBatch(bytes32[] calldata accounts, uint256[] calldata ids) external view returns (uint256[] memory balances) {
        if (accounts.length != ids.length) revert InvalidQuantity();
        balances = new uint256[](ids.length);
        for (uint256 i; i < ids.length; ++i) balances[i] = balanceOf(accounts[i], ids[i]);
    }
    function processTokenAction(bytes32 evidenceId, bytes32 elementalProofId, TokenAction calldata action) external nonReentrant {
        if (msg.sender != address(registry)) revert RegistryOnly();
        _processTokenAction(evidenceId, elementalProofId, action);
    }
    function _processTokenAction(bytes32 evidenceId, bytes32 elementalProofId, TokenAction calldata action) internal {
        if (!registry.proofsCurrent(evidenceId, action.mufProofId, elementalProofId)) revert ProofNotCurrent();
        // Revisions may update a proof but cannot issue again. NONE is mandatory after issue.
        if (evidenceTokenized[evidenceId]) {
            if (action.kind != ActionKind.NONE || action.inputs.length != 0 || action.outputs.length != 0 || action.operationId != bytes32(0) || action.consumedComponents.length != 0) revert EvidenceAlreadyTokenized(evidenceId);
            return;
        }
        if (action.kind == ActionKind.NONE) revert InvalidTokenAction();
        _useOperation(action.operationId);
        bytes32 holder = registry.evidenceActor(evidenceId);
        _requireActive(holder);
        if (!registry.tokenHolderEligible(evidenceId)) revert NotTokenHolder();
        _checkCount(action.outputs.length);
        if (action.inputs.length > MAX_ITEMS) revert TooManyItems();
        for (uint256 i; i < action.inputs.length; ++i)
            for (uint256 j; j < i; ++j)
                if (action.inputs[i].lotId == action.inputs[j].lotId) revert InvalidTokenAction();
        for(uint256 i; i<action.outputs.length; ++i) _validateOutput(action.outputs[i]);
        if (action.kind == ActionKind.INITIAL) {
            if (action.inputs.length != 0 || action.consumedComponents.length != 0) revert InvalidTokenAction();
        } else {
            _checkCount(action.inputs.length);
            _validateTransformBalances(action,holder);
            // The authorized evidence commits the inputs and recipients validated by the workflow.
            for (uint256 i; i < action.inputs.length; ++i) {
                LotInput memory input = action.inputs[i];
                _usable(input.lotId);
                if (input.quantity == 0) revert InvalidQuantity();
                // Sequential burns also protect repeated ids in the same report.
                _debit(holder,input.lotId,input.quantity);
                lots[input.lotId].supply-=input.quantity;
                for(uint256 k; k<action.consumedComponents[i].length; ++k) {
                    Component calldata c=action.consumedComponents[i][k];
                    componentBalances[input.lotId][holder][c.basisHash]-=c.quantity;
                    emit ComponentConsumed(action.operationId,input.lotId,c.basisHash,c.quantity,elementalProofId);
                }
                compositionProof[input.lotId]=elementalProofId;
                emit ActorBalanceChanged(msg.sender,holder,bytes32(0),input.lotId,input.quantity);
            }
        }
        evidenceTokenized[evidenceId] = true;
        for (uint256 i; i < action.outputs.length; ++i) {
            LotOutput memory output = action.outputs[i];
            bytes32 recipient = output.recipientActorId;
            _requireActive(recipient);
            if (action.kind == ActionKind.INITIAL && recipient != holder) revert InvalidTokenAction();
            if (output.streamId == bytes32(0) || output.basisHash == bytes32(0) || output.metadataHash == bytes32(0)) revert InvalidHash();
            if (output.quantity == 0) revert InvalidQuantity();
            for (uint256 j; j < i; ++j) if (action.outputs[j].streamId == output.streamId) revert InvalidTokenAction();
            uint256 id = ++lotCount;
            lots[id] = Lot(evidenceId, elementalProofId, action.mufProofId, output.basisHash, output.metadataHash, output.streamId, action.operationId, output.quantity, output.quantity);
            for(uint256 k; k<output.components.length; ++k) {
                lotComponents[id].push(output.components[k]);
                componentBalances[id][recipient][output.components[k].basisHash]=output.components[k].quantity;
            }
            compositionProof[id]=elementalProofId;
            operationLots[action.operationId].push(id);
            for (uint256 j; j < action.inputs.length; ++j) {
                lotParents[id].push(action.inputs[j].lotId);
                emit LotDerived(id, action.inputs[j].lotId, action.operationId);
            }
            emit LotCreated(id, evidenceId, action.operationId, output.basisHash, output.metadataHash, output.streamId, output.quantity);
            lotBalances[id][recipient] = output.quantity;
            emit ActorBalanceChanged(msg.sender, bytes32(0), recipient, id, output.quantity);
        }
        emit TokenOperation(action.operationId, evidenceId, action.kind, holder);
    }

    /// @dev Material and each committed elemental basis are conserved separately.
    ///      Unrepresented differences are recorded, not labelled as physically measured losses.
    function _validateTransformBalances(TokenAction calldata action,bytes32 holder) internal {
        if(action.consumedComponents.length!=action.inputs.length) revert InvalidComposition();
        uint256 consumed; uint256 produced;
        for(uint256 i; i<action.inputs.length; ++i) {
            _validateConsumption(action.inputs[i],action.consumedComponents[i],holder);
            consumed+=action.inputs[i].quantity;
        }
        for(uint256 i; i<action.outputs.length; ++i) produced+=action.outputs[i].quantity;
        if(produced>consumed) revert SupplyExceeded();
        emit ProcessingDifference(action.operationId,MATERIAL_BASIS,consumed,produced,consumed-produced);
        // Check every output basis, including attempted creation of a previously absent element.
        for(uint256 i; i<action.outputs.length; ++i) for(uint256 j; j<action.outputs[i].components.length; ++j) {
            bytes32 basis=action.outputs[i].components[j].basisHash;
            if(_producedComponent(action,basis)>_consumedComponent(action,basis)) revert SupplyExceeded();
        }
        // Record each input basis once, including elements absent from all outputs.
        bytes32[] memory seen=new bytes32[](MAX_ITEMS*17); uint256 n;
        for(uint256 i; i<action.inputs.length; ++i) {
            Component[] storage cs=lotComponents[action.inputs[i].lotId];
            for(uint256 j; j<cs.length; ++j) {
                bool found; for(uint256 k; k<n; ++k) if(seen[k]==cs[j].basisHash) {found=true;break;}
                if(found) continue; seen[n++]=cs[j].basisHash;
                uint256 a=_consumedComponent(action,cs[j].basisHash); uint256 b=_producedComponent(action,cs[j].basisHash);
                if(b>a) revert SupplyExceeded();
                emit ProcessingDifference(action.operationId,cs[j].basisHash,a,b,a-b);
            }
        }
    }
    function _validateConsumption(LotInput calldata input,Component[] calldata measured,bytes32 holder) internal view {
        Lot storage lot=_lot(input.lotId);
        if(input.quantity==0 || input.quantity>lot.supply || measured.length>17) revert InvalidComposition();
        uint256 removed; uint256 remaining;
        for(uint256 i; i<measured.length; ++i) {
            Component calldata c=measured[i];
            if(c.quantity==0 || c.quantity>componentBalances[input.lotId][holder][c.basisHash]) revert SupplyExceeded();
            for(uint256 j; j<i; ++j) if(measured[j].basisHash==c.basisHash) revert InvalidComposition();
            removed+=c.quantity;
        }
        if(removed>input.quantity) revert InvalidComposition();
        Component[] storage cs=lotComponents[input.lotId];
        for(uint256 i; i<cs.length; ++i) remaining+=componentBalances[input.lotId][holder][cs[i].basisHash];
        // Remaining content is an accounting remainder, not an assay of the remaining material.
        if(remaining-removed>lot.supply-input.quantity) revert InvalidComposition();
    }
    function _consumedComponent(TokenAction calldata action,bytes32 basis) internal pure returns(uint256 sum) {
        for(uint256 i; i<action.consumedComponents.length; ++i)
            for(uint256 j; j<action.consumedComponents[i].length; ++j)
                if(action.consumedComponents[i][j].basisHash==basis) sum+=action.consumedComponents[i][j].quantity;
    }
    function _producedComponent(TokenAction calldata action,bytes32 basis) internal pure returns(uint256 sum) {
        for(uint256 i; i<action.outputs.length; ++i) for(uint256 j; j<action.outputs[i].components.length; ++j)
            if(action.outputs[i].components[j].basisHash==basis) sum+=action.outputs[i].components[j].quantity;
    }

    /// @notice Split without changing the accounting basis or issuing additional stock.
    /// @dev The remaining quantity stays in the parent id; all children stay with the caller.
    /// @notice Physical subdivision requires a processing request and validated output proofs.
    function splitLot(bytes32, bytes32, uint256, uint256[] calldata, bytes32) external pure returns (uint256[] memory) {
        revert WholeLotRequired();
    }
    function _requireWholeLot(bytes32 actorId, uint256 lotId, uint256 quantity) internal view {
        if (quantity == 0 || quantity != lotBalances[lotId][actorId]) revert WholeLotRequired();
    }

    /// @notice Creates a traceability request; tokens are only committed after the first acceptance.
    function orderIdFor(bytes32 sender, bytes32 requestId) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), sender, requestId));
    }
    function createOrder(bytes32 sender, bytes32 requestId, bytes32 recipient, uint256 sourceLotId, uint256 quantity, bytes32 documentHash) external returns (bytes32 orderId) {
        if (requestId == bytes32(0) || documentHash == bytes32(0)) revert InvalidHash();
        _requireHolder(sender);
        _requireActive(recipient);
        if (sender == recipient) revert WrongOrderParty();
        orderId = orderIdFor(sender, requestId);
        if (orders[orderId].status != OrderStatus.NONE) revert OrderAlreadyExists();
        if (recipient == bytes32(0) || recipient == ESCROW_ACTOR) revert ZeroAddress();
        _usable(sourceLotId);
        _requireWholeLot(sender, sourceLotId, quantity);
        if (quantity == 0 || lotBalances[sourceLotId][sender] < quantity) revert InsufficientLotBalance(sourceLotId);
        orders[orderId] = Order(sender, recipient, sourceLotId, 0, quantity, documentHash, 0, OrderStatus.REQUESTED);
        emit OrderCreated(orderId, sender, recipient, sourceLotId, quantity, documentHash);
        _orderEvent(orderId);
    }
    function acceptOrder(bytes32 orderId) external {
        Order storage order = orders[orderId];
        _requireHolder(order.recipient);
        if (order.status != OrderStatus.REQUESTED) revert InvalidOrderState();
        order.status = OrderStatus.ACCEPTED;
        _orderEvent(orderId);
    }
    /// @notice Splits a dedicated child id directly into escrow and starts the 24-hour window.
    function lockOrder(bytes32 orderId) external nonReentrant {
        Order storage order = orders[orderId];
        _requireHolder(order.sender);
        if (order.status != OrderStatus.ACCEPTED) revert InvalidOrderState();
        _usable(order.sourceLotId);
        _requireWholeLot(order.sender, order.sourceLotId, order.quantity);
        bytes32 operationId = keccak256(abi.encode(address(this), "ORDER_PARCEL", orderId));
        _useOperation(operationId);
        order.status = OrderStatus.LOCKED;
        order.deadline = uint64(block.timestamp + RECEIPT_WINDOW);
        order.parcelLotId = _parcel(operationId, order.sourceLotId, order.sender, ESCROW_ACTOR, order.quantity);
        _orderEvent(orderId);
    }
    function confirmReceipt(bytes32 orderId) external nonReentrant {
        Order storage order = orders[orderId];
        _requireHolder(order.recipient);
        _completeOrder(orderId, OrderStatus.RECEIVED);
    }
    /// @notice Callable by anyone after the deadline. Time alone does not execute this call.
    function finalizeOrder(bytes32 orderId) external nonReentrant {
        Order storage order = orders[orderId];
        if (order.status != OrderStatus.LOCKED) revert InvalidOrderState();
        if (block.timestamp < order.deadline) revert DeadlineNotReached();
        _completeOrder(orderId, OrderStatus.TIMED_OUT);
    }
    function cancelOrder(bytes32 orderId) external nonReentrant {
        _requireHolder(orders[orderId].sender);
        _closeOrder(orderId, OrderStatus.CANCELLED);
    }
    function rejectOrder(bytes32 orderId) external nonReentrant {
        _requireHolder(orders[orderId].recipient);
        _closeOrder(orderId, OrderStatus.REJECTED);
    }
    function _completeOrder(bytes32 orderId, OrderStatus status) internal {
        Order storage order = orders[orderId];
        if (order.status != OrderStatus.LOCKED) revert InvalidOrderState();
        _requireActive(order.recipient);
        _usable(order.parcelLotId);
        order.status = status;
        _move(ESCROW_ACTOR, order.recipient, order.parcelLotId, order.quantity);
        _orderEvent(orderId);
    }
    function _closeOrder(bytes32 orderId, OrderStatus status) internal {
        Order storage order = orders[orderId];
        OrderStatus previous = order.status;
        if (previous != OrderStatus.REQUESTED && previous != OrderStatus.ACCEPTED && previous != OrderStatus.LOCKED) revert InvalidOrderState();
        order.status = status;
        order.deadline = 0;
        if (previous == OrderStatus.LOCKED) _move(ESCROW_ACTOR, order.sender, order.parcelLotId, order.quantity);
        _orderEvent(orderId);
    }

    function _parcel(bytes32 operationId, uint256 parentId, bytes32 from, bytes32 to, uint256 quantity) internal returns (uint256 id) {
        if (quantity == 0) revert InvalidQuantity();
        Lot memory parent = _lot(parentId);
        Component[] memory carried=new Component[](lotComponents[parentId].length);
        for(uint256 i; i<carried.length; ++i) {
            bytes32 basis=lotComponents[parentId][i].basisHash;
            carried[i]=Component(basis,componentBalances[parentId][from][basis]);
        }
        _burnLot(from, parentId, quantity);
        id = ++lotCount;
        parent.operationId = operationId;
        parent.issued = quantity;
        parent.supply = quantity;
        lots[id] = parent;
        for(uint256 i; i<carried.length; ++i) {
            lotComponents[id].push(carried[i]);
            componentBalances[id][to][carried[i].basisHash]=carried[i].quantity;
        }
        compositionProof[id]=compositionProof[parentId];
        lotParents[id].push(parentId);
        operationLots[operationId].push(id);
        lotBalances[id][to] = quantity;
        emit LotCreated(id, parent.evidenceId, operationId, parent.basisHash, parent.metadataHash, parent.streamId, quantity);
        emit LotDerived(id, parentId, operationId);
        emit ActorBalanceChanged(msg.sender, bytes32(0), to, id, quantity);
    }
    function _orderEvent(bytes32 orderId) internal {
        Order storage order = orders[orderId];
        emit OrderUpdated(orderId, order.status, order.parcelLotId, order.deadline);
    }
    function _lot(uint256 id) internal view returns (Lot storage lot) {
        lot = lots[id];
        if (lot.evidenceId == bytes32(0)) revert LotNotFound(id);
    }
    /// @dev Follow parents so a revised source proof cannot be bypassed with a child id.
    ///      Bounded traversal fails closed rather than allowing unbounded gas consumption.
    function _usable(uint256 id) internal view {
        uint256[] memory queue = new uint256[](256);
        queue[0] = id;
        uint256 count = 1;
        for (uint256 cursor; cursor < count; ++cursor) {
            uint256 current = queue[cursor];
            Lot storage lot = _lot(current);
            if (!registry.proofsCurrent(lot.evidenceId, lot.mufProofId, lot.elementalProofId)) revert LotNotUsable(current);
            uint256[] storage parents = lotParents[current];
            for (uint256 j; j < parents.length; ++j) {
                bool found;
                for (uint256 k; k < count; ++k) {
                    if (queue[k] == parents[j]) { found = true; break; }
                }
                if (!found) {
                    if (count == queue.length) revert LineageLimit();
                    queue[count++] = parents[j];
                }
            }
        }
    }
    function _checkCount(uint256 count) internal pure {
        if (count == 0 || count > MAX_ITEMS) revert TooManyItems();
    }
    function _useOperation(bytes32 id) internal {
        if (id == bytes32(0)) revert ZeroIdentifier();
        if (usedOperations[id]) revert OperationAlreadyUsed(id);
        usedOperations[id] = true;
    }
    function _requireActive(bytes32 actorId) internal view {
        if (actorId == bytes32(0) || actorId == ESCROW_ACTOR || !registry.actorActive(actorId)) revert NotTokenHolder();
    }
    function _requireHolder(bytes32 holder) internal view {
        _requireActive(holder);
        if (!registry.authorizedWallets(holder, msg.sender)) revert NotTokenHolder();
    }
    function _debit(bytes32 from, uint256 id, uint256 quantity) internal {
        if (lotBalances[id][from] < quantity) revert InsufficientLotBalance(id);
        lotBalances[id][from] -= quantity;
    }
    function _burnLot(bytes32 from, uint256 id, uint256 quantity) internal {
        _requireWholeLot(from,id,quantity);
        for(uint256 i; i<lotComponents[id].length; ++i) delete componentBalances[id][from][lotComponents[id][i].basisHash];
        _debit(from, id, quantity);
        lots[id].supply -= quantity;
        emit ActorBalanceChanged(msg.sender, from, bytes32(0), id, quantity);
    }
    function _move(bytes32 from, bytes32 to, uint256 id, uint256 quantity) internal {
        if (to == bytes32(0)) revert ZeroAddress();
        if(quantity!=lotBalances[id][from]) revert WholeLotRequired();
        for(uint256 i; i<lotComponents[id].length; ++i) {
            bytes32 basis=lotComponents[id][i].basisHash;
            componentBalances[id][to][basis]+=componentBalances[id][from][basis];
            delete componentBalances[id][from][basis];
        }
        _debit(from, id, quantity);
        lotBalances[id][to] += quantity;
        emit ActorBalanceChanged(msg.sender, from, to, id, quantity);
    }
}