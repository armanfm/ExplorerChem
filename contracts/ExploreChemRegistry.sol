// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice ERC-165 minimo usado pelo forwarder do Chainlink CRE.
interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

/// @notice Interface padrao chamada pelo KeystoneForwarder.
interface IReceiver is IERC165 {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

/// @title ExploreChemRegistry
/// @notice Registro minimo de identidade, evidencias e resultados do ExploreChem.
///
/// @dev O contrato nao conhece a relacao comercial. Ele guarda:
///      - quem submeteu cada evidencia e a qual identidade ela pertence;
///      - o hash do documento no momento da submissao;
///      - o estado da evidencia: PENDING ou MATCHED;
///      - o hash do resultado do balanco de massa.
///
///      Nao vao para a cadeia: lotId, origem, destino, CNPJ, actorType,
///      documentRef, massas, teores, arquivos nem qualquer campo de
///      correlacao. Nao existe metadataHash: os campos usados na
///      correlacao sao extraidos do proprio documento ja comprometido
///      pelo evidenceHash, e um compromisso separado sobre um conjunto
///      pequeno e previsivel de campos seria enumeravel.
///
///      A correlacao e o calculo acontecem no CRE/TEE, sobre dados
///      privados. O contrato recebe apenas o veredito, entregue pelo
///      forwarder autorizado.
contract ExploreChemRegistry is IReceiver {
    // ---------------------------------------------------------------
    // Tipos
    // ---------------------------------------------------------------

    /// @dev NONE e apenas o zero-value do storage. Mappings em Solidity
    ///      retornam o zero-value para chave inexistente, entao sem NONE
    ///      o contrato nao distingue "nao existe" de "pendente".
    enum EvidenceStatus {
        NONE,
        PENDING,
        MATCHED
    }

    enum BalanceStatus {
        NONE,
        CONFORME,
        DIVERGENTE,
        NAO_ATESTADO
    }

    struct ActorIdentity {
        bytes32 actorId;
        address controller;
        uint64 createdAt;
    }

    struct Evidence {
        bytes32 evidenceId;
        bytes32 actorId;
        address submittedBy;
        bytes32 evidenceHash;
        EvidenceStatus status;
        uint64 createdAt;
        uint64 matchedAt;
    }

    /// @dev Resultado do balanco de massa, um registro por parceiro.
    ///
    ///      O resultHash e proprio de cada parceiro: deriva do resultado
    ///      mais os dados dele e de um privateNonce aleatorio no manifesto
    ///      privado. Dois parceiros nunca carregam o mesmo valor.
    ///
    ///      Isso e deliberado. Com um hash unico compartilhado pelos tres,
    ///      bastaria dois deles exibirem o mesmo valor para que qualquer um
    ///      concluisse que estao na mesma operacao: a correlacao vazaria
    ///      pela posse do hash. O privateNonce fecha o outro lado, que e
    ///      enumerar um manifesto pequeno e previsivel.
    struct BalanceResult {
        bytes32 resultId;
        bytes32 actorId;
        bytes32 resultHash;
        bytes32 previousResultId;
        bytes32 aggregateInputHash;
        BalanceStatus status;
        uint32 calculationVersion;
        uint64 createdAt;
    }

    /// @dev Payload do workflow de correlacao (CRE/TEE 1).
    struct CorrelationReport {
        bytes32[] evidenceIds;
    }

    /// @dev Payload do workflow de balanco (CRE/TEE 2), um parceiro por
    ///      relatorio. A lista de evidencias nao viaja aqui: entra apenas
    ///      o aggregateInputHash, que prova quais entraram no calculo sem
    ///      revelar quais sao. Enviar os parceiros juntos, ou a lista de
    ///      evidenceIds no calldata, tornaria a correlacao legivel por
    ///      qualquer observador da cadeia.
    struct BalanceReport {
        bytes32 resultId;
        bytes32 actorId;
        bytes32 resultHash;
        bytes32 previousResultId;
        bytes32 aggregateInputHash;
        uint8 balanceStatus;
        uint32 calculationVersion;
    }

    uint256 public constant MAX_BATCH = 64;

    /// @notice Prazo de validade de uma evidencia PENDING.
    /// @dev Publico e constante para que qualquer um confira a regra. A
    ///      expiracao e derivada de createdAt: nao existe estado gravado
    ///      nem transacao para expirar. Contrato nao executa sozinho, e
    ///      validade e propriedade do tempo, nao um evento.
    uint64 public constant EVIDENCE_TTL = 365 days;

    // ---------------------------------------------------------------
    // Estado
    // ---------------------------------------------------------------

    address public owner;

    /// @dev Correlacao e balanco sao workflows distintos, com workflowId
    ///      proprio. Um unico expectedWorkflowId rejeitaria o segundo.
    address public forwarder;
    bytes32 public expectedWorkflowId;

    address public balanceForwarder;
    bytes32 public expectedBalanceWorkflowId;

    mapping(bytes32 => ActorIdentity) private actors;
    mapping(bytes32 => mapping(address => bool)) public authorizedWallets;

    mapping(bytes32 => Evidence) private evidences;
    mapping(bytes32 => BalanceResult) private results;

    // ---------------------------------------------------------------
    // Erros
    // ---------------------------------------------------------------

    error OnlyOwner();
    error ZeroAddress();
    error ZeroIdentifier();
    error InvalidHash();
    error ActorAlreadyExists(bytes32 actorId);
    error ActorNotFound(bytes32 actorId);
    error UnauthorizedWallet(bytes32 actorId, address wallet);
    error EvidenceAlreadyExists(bytes32 evidenceId);
    error EvidenceNotFound(bytes32 evidenceId);
    error EvidenceNotPending(bytes32 evidenceId);
    error EvidenceExpired(bytes32 evidenceId, uint64 createdAt, uint64 deadline);
    error ResultAlreadyExists(bytes32 resultId);
    error PreviousResultNotFound(bytes32 previousResultId);
    error PreviousResultActorMismatch(bytes32 previousResultId, bytes32 actorId);
    error InvalidBalanceStatus(uint8 balanceStatus);
    error InvalidForwarder(address caller, address expected);
    error InvalidWorkflowId(bytes32 received, bytes32 expected);
    error InvalidMetadataLength(uint256 received);
    error EmptyBatch();
    error BatchTooLarge(uint256 size);

    // ---------------------------------------------------------------
    // Eventos
    // ---------------------------------------------------------------

    event OwnershipTransferred(address indexed previous, address indexed current);
    event ForwarderUpdated(address indexed previous, address indexed current);
    event ExpectedWorkflowIdUpdated(bytes32 indexed previous, bytes32 indexed current);
    event BalanceForwarderUpdated(address indexed previous, address indexed current);
    event ExpectedBalanceWorkflowIdUpdated(bytes32 indexed previous, bytes32 indexed current);

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

    /// @notice Gatilho do workflow de correlacao. Mappings em Solidity nao
    ///         sao iteraveis, entao o CRE nao consegue varrer pendencias:
    ///         ele reage a este evento ou consome um indexador que o segue.
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

    /// @dev actorId fica fora dos campos indexados de proposito. Evento
    ///      indexado e filtravel de fora da cadeia; sem indice, quem quiser
    ///      achar o resultado precisa do resultId, que o parceiro recebe
    ///      pelo ExploreChem.
    event BalanceResultAnchored(
        bytes32 indexed resultId,
        bytes32 resultHash,
        BalanceStatus status,
        uint32 calculationVersion,
        uint64 createdAt
    );

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    constructor(address initialForwarder) {
        if (initialForwarder == address(0)) revert ZeroAddress();

        owner = msg.sender;
        forwarder = initialForwarder;

        emit OwnershipTransferred(address(0), msg.sender);
        emit ForwarderUpdated(address(0), initialForwarder);
    }

    // ---------------------------------------------------------------
    // Administracao
    // ---------------------------------------------------------------

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

    /// @notice Deixe em bytes32(0) na simulacao: o MockForwarder pode nao
    ///         fornecer metadados de workflow. Em producao, nunca zero.
    function setExpectedWorkflowId(bytes32 newWorkflowId) external onlyOwner {
        bytes32 previous = expectedWorkflowId;
        expectedWorkflowId = newWorkflowId;
        emit ExpectedWorkflowIdUpdated(previous, newWorkflowId);
    }

    /// @notice Forwarder do workflow de balanco. Se ficar em zero, o
    ///         forwarder de correlacao e aceito tambem para o balanco.
    function setBalanceForwarder(address newForwarder) external onlyOwner {
        if (newForwarder == address(0)) revert ZeroAddress();
        address previous = balanceForwarder;
        balanceForwarder = newForwarder;
        emit BalanceForwarderUpdated(previous, newForwarder);
    }

    function setExpectedBalanceWorkflowId(bytes32 newWorkflowId) external onlyOwner {
        bytes32 previous = expectedBalanceWorkflowId;
        expectedBalanceWorkflowId = newWorkflowId;
        emit ExpectedBalanceWorkflowIdUpdated(previous, newWorkflowId);
    }

    // ---------------------------------------------------------------
    // Identidade do ator
    // ---------------------------------------------------------------

    /// @notice Registra a identidade logica de um participante.
    /// @dev O cadastro nao tem estados de aprovacao. Nome, CNPJ, actorType
    ///      e unidades ficam off-chain. A cadeia guarda apenas o actorId
    ///      opaco e a carteira que o controla.
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

    /// @notice Troca a carteira administrativa sem alterar o actorId.
    /// @dev A autorizacao da carteira anterior nao e removida automaticamente:
    ///      revogue explicitamente quando for o caso, para nao invalidar por
    ///      engano uma chave ainda em uso operacional.
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

    /// @notice Autoriza ou revoga uma carteira do ator.
    /// @dev Varias carteiras por actorId: a empresa troca chave sem perder
    ///      a identidade nem o historico ja ancorado.
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
    // Evidencias
    // ---------------------------------------------------------------

    /// @notice Ancora o hash de um documento e abre a evidencia como PENDING.
    /// @param evidenceId identificador opaco, sem CNPJ, lote ou data embutidos
    /// @param actorId identidade a que a evidencia pertence
    /// @param evidenceHash hash dos bytes exatos do documento
    ///
    /// @dev O documento, os metadados e o lote ficam off-chain. Os campos
    ///      usados depois na correlacao precisam ser extraidos deste mesmo
    ///      documento: valor digitado a mao ou vindo de outra API nao esta
    ///      coberto por este hash.
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
            matchedAt: 0
        });

        emit EvidenceSubmitted(evidenceId, actorId, msg.sender, evidenceHash, timestamp);
    }

    // ---------------------------------------------------------------
    // Correlacao — CRE/TEE 1
    // ---------------------------------------------------------------

    /// @inheritdoc IReceiver
    /// @dev Payload esperado: abi.encode(CorrelationReport).
    ///      Marca como MATCHED as evidencias aprovadas pelo CRE/TEE.
    ///      O contrato nao correlaciona: aplica o veredito.
    function onReport(
        bytes calldata metadata,
        bytes calldata report
    ) external override {
        if (msg.sender != forwarder) {
            revert InvalidForwarder(msg.sender, forwarder);
        }

        bytes32 workflowId = _readWorkflowId(metadata, expectedWorkflowId);

        if (expectedWorkflowId != bytes32(0) && workflowId != expectedWorkflowId) {
            revert InvalidWorkflowId(workflowId, expectedWorkflowId);
        }

        CorrelationReport memory decoded = abi.decode(report, (CorrelationReport));

        uint256 count = decoded.evidenceIds.length;
        if (count == 0) revert EmptyBatch();
        if (count > MAX_BATCH) revert BatchTooLarge(count);

        uint64 timestamp = uint64(block.timestamp);

        for (uint256 i = 0; i < count; i++) {
            bytes32 id = decoded.evidenceIds[i];
            Evidence storage e = evidences[id];

            if (e.status == EvidenceStatus.NONE) revert EvidenceNotFound(id);
            if (e.status != EvidenceStatus.PENDING) revert EvidenceNotPending(id);

            // Evidencia vencida nao entra em correlacao. Nao e reprovacao
            // do material: e encerramento por decurso de prazo.
            uint64 deadline = e.createdAt + EVIDENCE_TTL;
            if (timestamp > deadline) {
                revert EvidenceExpired(id, e.createdAt, deadline);
            }

            e.status = EvidenceStatus.MATCHED;
            e.matchedAt = timestamp;

            emit EvidenceMatched(id, e.actorId, workflowId, timestamp);
        }
    }

    // ---------------------------------------------------------------
    // Balanco de massa — CRE/TEE 2
    // ---------------------------------------------------------------

    /// @notice Ancora o resultado do balanco de massa de um parceiro.
    ///
    /// @dev Sem esta ancoragem o resultado existiria apenas no banco do
    ///      ExploreChem, que e mutavel: quem opera o sistema poderia
    ///      alterar o balanco sem deixar rastro. Com o hash na cadeia,
    ///      qualquer alteracao posterior quebra a correspondencia.
    ///
    ///      Um parceiro por chamada. Enviar os tres juntos colocaria os
    ///      actorId no mesmo calldata e emitiria eventos irmaos no mesmo
    ///      bloco: hashes diferentes nao esconderiam nada.
    ///
    ///      Correlacao e balanco tem forwarder e workflowId proprios, entao
    ///      esta entrada e separada do onReport.
    function anchorBalanceResult(
        bytes calldata metadata,
        bytes calldata report
    ) external {
        address expectedSender = balanceForwarder == address(0)
            ? forwarder
            : balanceForwarder;

        if (msg.sender != expectedSender) {
            revert InvalidForwarder(msg.sender, expectedSender);
        }

        bytes32 workflowId = _readWorkflowId(metadata, expectedBalanceWorkflowId);

        if (
            expectedBalanceWorkflowId != bytes32(0) &&
            workflowId != expectedBalanceWorkflowId
        ) {
            revert InvalidWorkflowId(workflowId, expectedBalanceWorkflowId);
        }

        BalanceReport memory r = abi.decode(report, (BalanceReport));

        if (r.resultId == bytes32(0) || r.actorId == bytes32(0)) revert ZeroIdentifier();
        if (r.resultHash == bytes32(0) || r.aggregateInputHash == bytes32(0)) {
            revert InvalidHash();
        }
        if (
            r.balanceStatus < uint8(BalanceStatus.CONFORME) ||
            r.balanceStatus > uint8(BalanceStatus.NAO_ATESTADO)
        ) revert InvalidBalanceStatus(r.balanceStatus);

        _requireActor(r.actorId);

        if (results[r.resultId].resultId != bytes32(0)) {
            revert ResultAlreadyExists(r.resultId);
        }

        // Versoes anteriores nao sao apagadas. O encadeamento so vale
        // dentro do mesmo parceiro: apontar para o resultado de outro
        // ator misturaria historicos distintos.
        if (r.previousResultId != bytes32(0)) {
            BalanceResult storage prev = results[r.previousResultId];
            if (prev.resultId == bytes32(0)) {
                revert PreviousResultNotFound(r.previousResultId);
            }
            if (prev.actorId != r.actorId) {
                revert PreviousResultActorMismatch(r.previousResultId, r.actorId);
            }
        }

        uint64 timestamp = uint64(block.timestamp);
        BalanceStatus status = BalanceStatus(r.balanceStatus);

        results[r.resultId] = BalanceResult({
            resultId: r.resultId,
            actorId: r.actorId,
            resultHash: r.resultHash,
            previousResultId: r.previousResultId,
            aggregateInputHash: r.aggregateInputHash,
            status: status,
            calculationVersion: r.calculationVersion,
            createdAt: timestamp
        });

        emit BalanceResultAnchored(
            r.resultId,
            r.resultHash,
            status,
            r.calculationVersion,
            timestamp
        );
    }

    // ---------------------------------------------------------------
    // Leitura
    // ---------------------------------------------------------------

    function getActor(bytes32 actorId) external view returns (ActorIdentity memory) {
        return _requireActor(actorId);
    }

    function getEvidence(bytes32 evidenceId) external view returns (Evidence memory) {
        Evidence storage e = evidences[evidenceId];
        if (e.status == EvidenceStatus.NONE) revert EvidenceNotFound(evidenceId);
        return e;
    }

    function getResult(bytes32 resultId) external view returns (BalanceResult memory) {
        return results[resultId];
    }

    /// @notice Confere um documento contra o hash ancorado.
    /// @dev Quem tem o arquivo recalcula o hash e chama esta funcao. Se
    ///      retornar false, o documento apresentado nao e o que foi
    ///      registrado.
    function verifyEvidenceHash(
        bytes32 evidenceId,
        bytes32 candidateHash
    ) external view returns (bool) {
        Evidence storage e = evidences[evidenceId];
        if (e.status == EvidenceStatus.NONE) revert EvidenceNotFound(evidenceId);
        return e.evidenceHash == candidateHash;
    }

    /// @notice Confere o resultado do balanco que um parceiro recebeu.
    /// @dev Ele recalcula o proprio hash a partir do manifesto privado e
    ///      compara. Se o ExploreChem alterar o resultado depois, o hash
    ///      recalculado deixa de bater com o ancorado.
    function verifyResultHash(
        bytes32 resultId,
        bytes32 candidateHash
    ) external view returns (bool) {
        BalanceResult storage r = results[resultId];
        if (r.resultId == bytes32(0)) return false;
        return r.resultHash == candidateHash;
    }

    /// @notice Uma evidencia PENDING que passou do prazo.
    /// @dev Derivado de createdAt, sem custo de transacao. MATCHED nunca
    ///      expira: a correlacao ja aconteceu dentro da validade.
    function isExpired(bytes32 evidenceId) external view returns (bool) {
        Evidence storage e = evidences[evidenceId];
        if (e.status == EvidenceStatus.NONE) revert EvidenceNotFound(evidenceId);
        if (e.status != EvidenceStatus.PENDING) return false;
        return block.timestamp > e.createdAt + EVIDENCE_TTL;
    }

    function evidenceDeadline(bytes32 evidenceId) external view returns (uint64) {
        Evidence storage e = evidences[evidenceId];
        if (e.status == EvidenceStatus.NONE) revert EvidenceNotFound(evidenceId);
        return e.createdAt + EVIDENCE_TTL;
    }

    function isWalletAuthorized(
        bytes32 actorId,
        address wallet
    ) external view returns (bool) {
        return authorizedWallets[actorId][wallet];
    }

    // ---------------------------------------------------------------
    // Internos
    // ---------------------------------------------------------------

    function _requireActor(bytes32 actorId) internal view returns (ActorIdentity storage actor) {
        actor = actors[actorId];
        if (actor.controller == address(0)) revert ActorNotFound(actorId);
    }

    function _readWorkflowId(
        bytes calldata metadata,
        bytes32 expected
    ) internal pure returns (bytes32 workflowId) {
        if (metadata.length >= 32) {
            assembly {
                workflowId := calldataload(metadata.offset)
            }
        } else if (expected != bytes32(0)) {
            revert InvalidMetadataLength(metadata.length);
        }
    }

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return
            interfaceId == type(IReceiver).interfaceId ||
            interfaceId == type(IERC165).interfaceId;
    }
}
