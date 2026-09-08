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
///      - o estado da evidencia: PENDING, MATCHED, VERIFIED ou DIVERGENT;
///      - o resultado minimo do balanco de massa vinculado a uma evidencia.
///
///      Nao vao para a cadeia: lotId, origem, destino, CNPJ, actorType,
///      documentRef, massas, teores, arquivos nem qualquer campo de
///      correlacao. Nao existe metadataHash: os campos usados na
///      correlacao sao extraidos do proprio documento ja comprometido
///      pelo evidenceHash, e um compromisso separado sobre um conjunto
///      pequeno e previsivel de campos seria enumeravel.
///
///      A correlacao acontece no CRE/TEE, sobre dados privados. O
///      contrato so recebe o veredito, entregue pelo forwarder.
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
        MATCHED,
        VERIFIED,
        DIVERGENT
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
        uint64 auditedAt;
    }

    /// @dev One immutable result per partner and revision.
    ///      CRE/TEE computes resultHash and aggregateInputHash OFF-CHAIN,
    ///      with fresh cryptographically random private salts per partner
    ///      and revision, and distinct hash domains for the two commitments.
    ///      Store the same resulting hashes in Supabase and on-chain.
    ///      Never send salts, manifests, evidence lists or group IDs here.
    ///      The contract checks neither salt quality nor hidden membership:
    ///      those are responsibilities of the authenticated CRE/TEE workflow.
    struct BalanceResult {
        bytes32 resultId;
        bytes32 evidenceId;       // evidencia dona deste resultado
        bytes32 actorId;
        bytes32 resultHash;
        bytes32 previousResultId; // encadeia versoes da mesma evidencia
        bytes32 aggregateInputHash;
        BalanceStatus status;
        uint32 calculationVersion;
        uint64 createdAt;
    }

    /// @dev abi.encode(CREReport), a STATIC tuple of nine words.
    ///      Type 1 (correlation): reportType + evidenceId.
    ///      Type 2 (mass result): evidenceId + result/actor/hash/version fields.
    ///      Type 3 (audit): reportType + evidenceId + balanceStatus, where
    ///      balanceStatus carries uint8(EvidenceStatus.VERIFIED|DIVERGENT).
    ///      One evidence/result per invocation. No arrays.
    struct CREReport {
        uint8 reportType;
        bytes32 evidenceId;
        bytes32 resultId;
        bytes32 actorId;
        bytes32 resultHash;
        bytes32 previousResultId;
        bytes32 aggregateInputHash;
        uint8 balanceStatus;
        uint32 calculationVersion;
    }

    uint8 public constant REPORT_CORRELATION = 1;
    uint8 public constant REPORT_BALANCE = 2;
    uint8 public constant REPORT_AUDIT = 3;

    uint256 public constant REPORT_LENGTH = 9 * 32;

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
    address public forwarder;
    bytes32 public expectedWorkflowId;
    /// @dev Zero means use expectedWorkflowId for balance reports too.
    bytes32 public expectedBalanceWorkflowId;
    /// @dev Zero means use expectedWorkflowId for audit reports too.
    bytes32 public expectedAuditWorkflowId;

    mapping(bytes32 => ActorIdentity) private actors;
    mapping(bytes32 => mapping(address => bool)) public authorizedWallets;

    mapping(bytes32 => Evidence) private evidences;
    // Indice minimo para permitir consultas por estado sem varrer logs/eventos.
    bytes32[] private evidenceIds;
    mapping(bytes32 => BalanceResult) private results;
    /// @notice Successor of a result, zero while it is the latest revision.
    mapping(bytes32 => bytes32) public nextResultId;
    /// @notice Latest mass result anchored for each evidence.
    mapping(bytes32 => bytes32) public latestResultIdByEvidence;

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
    error EvidenceNotMatchable(bytes32 evidenceId, uint8 status);
    error EvidenceNotAuditable(bytes32 evidenceId, uint8 status);
    error EvidenceNotEligibleForBalance(bytes32 evidenceId, uint8 status);
    error EvidenceActorMismatch(bytes32 evidenceId, bytes32 expectedActorId, bytes32 receivedActorId);
    error EvidenceExpired(bytes32 evidenceId, uint64 createdAt, uint64 expiresAt);
    error ResultAlreadyExists(bytes32 resultId);
    error PreviousResultNotFound(bytes32 previousResultId);
    error PreviousResultActorMismatch(bytes32 previousResultId, bytes32 actorId);
    error PreviousResultEvidenceMismatch(bytes32 previousResultId, bytes32 evidenceId);
    error PreviousResultAlreadySuperseded(bytes32 previousResultId);
    error InvalidCalculationVersion(uint32 received, uint32 previous);
    error WorkflowNotConfigured();
    error InvalidReportLength(uint256 received);
    error UnexpectedReportFields();
    error InvalidForwarder(address caller, address expected);
    error InvalidWorkflowId(bytes32 received, bytes32 expected);
    error InvalidMetadataLength(uint256 received);
    error InvalidReportType(uint8 reportType);
    error InvalidBalanceStatus(uint8 balanceStatus);
    error InvalidEvidenceAuditStatus(uint8 status);

    // ---------------------------------------------------------------
    // Eventos
    // ---------------------------------------------------------------

    event OwnershipTransferred(address indexed previous, address indexed current);
    event ForwarderUpdated(address indexed previous, address indexed current);
    event ExpectedWorkflowIdUpdated(bytes32 indexed previous, bytes32 indexed current);
    event ExpectedBalanceWorkflowIdUpdated(bytes32 indexed previous, bytes32 indexed current);
    event ExpectedAuditWorkflowIdUpdated(bytes32 indexed previous, bytes32 indexed current);

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

    event EvidenceAudited(
        bytes32 indexed evidenceId,
        bytes32 indexed actorId,
        EvidenceStatus status,
        bytes32 workflowId,
        uint64 auditedAt
    );

    event BalanceResultAnchored(
        bytes32 indexed resultId,
        bytes32 indexed evidenceId,
        bytes32 indexed actorId,
        bytes32 previousResultId,
        bytes32 resultHash,
        BalanceStatus status,
        uint32 calculationVersion,
        uint64 createdAt
    );

    // ---------------------------------------------------------------
    // Modificadores
    // ---------------------------------------------------------------

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

    /// @notice Configure the real workflow ID before accepting any reports.
    /// @dev Fail-closed: zero never disables identity checks.
    ///      Local tests use a mock forwarder with explicit test metadata.
    function setExpectedWorkflowId(bytes32 newWorkflowId) external onlyOwner {
        if (newWorkflowId == bytes32(0)) revert ZeroIdentifier();
        bytes32 previous = expectedWorkflowId;
        expectedWorkflowId = newWorkflowId;
        emit ExpectedWorkflowIdUpdated(previous, newWorkflowId);
    }

    /// @notice Optional distinct balance workflow; zero restores primary ID.
    /// @dev Both workflow types use the configured KeystoneForwarder.
    function setExpectedBalanceWorkflowId(bytes32 newWorkflowId) external onlyOwner {
        bytes32 previous = expectedBalanceWorkflowId;
        expectedBalanceWorkflowId = newWorkflowId;
        emit ExpectedBalanceWorkflowIdUpdated(previous, newWorkflowId);
    }

    /// @notice Optional distinct auditor workflow; zero restores primary ID.
    function setExpectedAuditWorkflowId(bytes32 newWorkflowId) external onlyOwner {
        bytes32 previous = expectedAuditWorkflowId;
        expectedAuditWorkflowId = newWorkflowId;
        emit ExpectedAuditWorkflowIdUpdated(previous, newWorkflowId);
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
            matchedAt: 0,
            auditedAt: 0
        });

        // Mantem apenas o indice dos IDs. O estado continua sendo a fonte da verdade
        // dentro de evidences[evidenceId].
        evidenceIds.push(evidenceId);

        emit EvidenceSubmitted(
            evidenceId,
            actorId,
            msg.sender,
            evidenceHash,
            timestamp
        );
    }

    // ---------------------------------------------------------------
    // Recepcao dos relatorios do CRE
    // ---------------------------------------------------------------

    /// @inheritdoc IReceiver
    /// @dev abi.encode(CREReport). Exactly one record, with no private fields.
    ///      The forwarder authenticates delivery; the workflow authenticates
    ///      documents, re-extracts fields, correlates and calculates off-chain.
    function onReport(bytes calldata metadata, bytes calldata report) external override {
        if (msg.sender != forwarder) {
            revert InvalidForwarder(msg.sender, forwarder);
        }
        if (report.length != REPORT_LENGTH) revert InvalidReportLength(report.length);
        CREReport memory decoded = abi.decode(report, (CREReport));
        if (
            decoded.reportType != REPORT_CORRELATION &&
            decoded.reportType != REPORT_BALANCE &&
            decoded.reportType != REPORT_AUDIT
        ) {
            revert InvalidReportType(decoded.reportType);
        }

        bytes32 expected;
        if (decoded.reportType == REPORT_BALANCE && expectedBalanceWorkflowId != bytes32(0)) {
            expected = expectedBalanceWorkflowId;
        } else if (decoded.reportType == REPORT_AUDIT && expectedAuditWorkflowId != bytes32(0)) {
            expected = expectedAuditWorkflowId;
        } else {
            expected = expectedWorkflowId;
        }

        if (expected == bytes32(0)) revert WorkflowNotConfigured();
        bytes32 workflowId = _readWorkflowId(metadata);
        if (workflowId != expected) revert InvalidWorkflowId(workflowId, expected);

        if (decoded.reportType == REPORT_CORRELATION) {
            _applyEvidenceMatch(decoded, workflowId);
        } else if (decoded.reportType == REPORT_BALANCE) {
            _applyBalance(decoded);
        } else {
            _applyEvidenceAudit(decoded, workflowId);
        }
    }

    /// @dev Applies an off-chain verdict, NOT correlation logic.
    ///      Existing MATCHED evidence never returns to PENDING. A new document
    ///      gets a new evidenceId and is confirmed in its own transaction.
    function _applyEvidenceMatch(CREReport memory r, bytes32 workflowId) internal {
        if (
            r.resultId != bytes32(0) || r.actorId != bytes32(0) ||
            r.resultHash != bytes32(0) || r.previousResultId != bytes32(0) ||
            r.aggregateInputHash != bytes32(0) || r.balanceStatus != 0 ||
            r.calculationVersion != 0
        ) revert UnexpectedReportFields();
        if (r.evidenceId == bytes32(0)) revert ZeroIdentifier();

        Evidence storage e = evidences[r.evidenceId];
        if (e.status == EvidenceStatus.NONE) revert EvidenceNotFound(r.evidenceId);
        if (e.status != EvidenceStatus.PENDING && e.status != EvidenceStatus.VERIFIED) {
            revert EvidenceNotMatchable(r.evidenceId, uint8(e.status));
        }

        uint64 timestamp = uint64(block.timestamp);
        if (e.status == EvidenceStatus.PENDING) {
            uint64 deadline = e.createdAt + EVIDENCE_TTL;
            if (timestamp > deadline) revert EvidenceExpired(r.evidenceId, e.createdAt, deadline);
        }

        e.status = EvidenceStatus.MATCHED;
        e.matchedAt = timestamp;
        emit EvidenceMatched(r.evidenceId, e.actorId, workflowId, timestamp);
    }

    /// @dev Auditor verdict. Uses balanceStatus as the evidence-status byte to
    ///      preserve the existing static nine-word CREReport ABI.
    function _applyEvidenceAudit(CREReport memory r, bytes32 workflowId) internal {
        if (
            r.resultId != bytes32(0) || r.actorId != bytes32(0) ||
            r.resultHash != bytes32(0) || r.previousResultId != bytes32(0) ||
            r.aggregateInputHash != bytes32(0) || r.calculationVersion != 0
        ) revert UnexpectedReportFields();
        if (r.evidenceId == bytes32(0)) revert ZeroIdentifier();

        Evidence storage e = evidences[r.evidenceId];
        if (e.status == EvidenceStatus.NONE) revert EvidenceNotFound(r.evidenceId);
        if (e.status != EvidenceStatus.MATCHED) {
            revert EvidenceNotAuditable(r.evidenceId, uint8(e.status));
        }

        EvidenceStatus verdict = EvidenceStatus(r.balanceStatus);
        if (verdict != EvidenceStatus.VERIFIED && verdict != EvidenceStatus.DIVERGENT) {
            revert InvalidEvidenceAuditStatus(r.balanceStatus);
        }

        uint64 timestamp = uint64(block.timestamp);
        e.status = verdict;
        e.auditedAt = timestamp;

        emit EvidenceAudited(r.evidenceId, e.actorId, verdict, workflowId, timestamp);
    }

    /// @dev One partner result per call, with no evidence list.
    ///      aggregateInputHash commits to a private canonical input manifest;
    ///      it does NOT let this contract check which inputs were MATCHED.
    ///      The trusted workflow must verify input integrity, correlation,
    ///      eligibility and mass accounting before submitting the report.
    ///      All calldata/storage, actor IDs and block times remain public.
    function _applyBalance(CREReport memory r) internal {
        if (r.evidenceId == bytes32(0) || r.actorId == bytes32(0) || r.resultId == bytes32(0)) {
            revert ZeroIdentifier();
        }
        if (r.resultHash == bytes32(0) || r.aggregateInputHash == bytes32(0)) {
            revert InvalidHash();
        }
        if (
            r.balanceStatus < uint8(BalanceStatus.CONFORME) ||
            r.balanceStatus > uint8(BalanceStatus.NAO_ATESTADO)
        ) revert InvalidBalanceStatus(r.balanceStatus);

        Evidence storage evidence = evidences[r.evidenceId];
        if (evidence.status == EvidenceStatus.NONE) revert EvidenceNotFound(r.evidenceId);
        if (
            evidence.status != EvidenceStatus.MATCHED &&
            evidence.status != EvidenceStatus.VERIFIED
        ) {
            revert EvidenceNotEligibleForBalance(r.evidenceId, uint8(evidence.status));
        }
        if (evidence.actorId != r.actorId) {
            revert EvidenceActorMismatch(r.evidenceId, evidence.actorId, r.actorId);
        }

        _requireActor(r.actorId);
        if (results[r.resultId].resultId != bytes32(0)) {
            revert ResultAlreadyExists(r.resultId);
        }

        // calculationVersion is the result REVISION, not the algorithm version.
        // Algorithm/factor versions belong in the private committed manifest.
        // Different private balances of one actor may have independent roots.
        if (r.previousResultId == bytes32(0)) {
            if (r.calculationVersion != 1) {
                revert InvalidCalculationVersion(r.calculationVersion, 0);
            }
        } else {
            BalanceResult storage prev = results[r.previousResultId];
            if (prev.resultId == bytes32(0)) {
                revert PreviousResultNotFound(r.previousResultId);
            }
            if (prev.actorId != r.actorId) {
                revert PreviousResultActorMismatch(r.previousResultId, r.actorId);
            }
            if (prev.evidenceId != r.evidenceId) {
                revert PreviousResultEvidenceMismatch(r.previousResultId, r.evidenceId);
            }
            if (nextResultId[r.previousResultId] != bytes32(0)) {
                revert PreviousResultAlreadySuperseded(r.previousResultId);
            }
            if (uint256(r.calculationVersion) != uint256(prev.calculationVersion) + 1) {
                revert InvalidCalculationVersion(r.calculationVersion, prev.calculationVersion);
            }
            nextResultId[r.previousResultId] = r.resultId;
        }

        uint64 timestamp = uint64(block.timestamp);
        BalanceStatus status = BalanceStatus(r.balanceStatus);
        results[r.resultId] = BalanceResult({
            resultId: r.resultId,
            evidenceId: r.evidenceId,
            actorId: r.actorId,
            resultHash: r.resultHash,
            previousResultId: r.previousResultId,
            aggregateInputHash: r.aggregateInputHash,
            status: status,
            calculationVersion: r.calculationVersion,
            createdAt: timestamp
        });
        latestResultIdByEvidence[r.evidenceId] = r.resultId;

        emit BalanceResultAnchored(
            r.resultId, r.evidenceId, r.actorId, r.previousResultId,
            r.resultHash, status, r.calculationVersion, timestamp
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

    /// @notice Retorna uma evidencia atualmente PENDING, ou zero se nao houver.
    function getNextPending() external view returns (bytes32) {
        return _getNextByStatus(EvidenceStatus.PENDING);
    }

    /// @notice Retorna uma evidencia atualmente MATCHED, ou zero se nao houver.
    function getNextMatched() external view returns (bytes32) {
        return _getNextByStatus(EvidenceStatus.MATCHED);
    }

    /// @notice Retorna uma evidencia atualmente VERIFIED, ou zero se nao houver.
    function getNextVerified() external view returns (bytes32) {
        return _getNextByStatus(EvidenceStatus.VERIFIED);
    }

    /// @notice Retorna uma evidencia atualmente DIVERGENT, ou zero se nao houver.
    function getNextDivergent() external view returns (bytes32) {
        return _getNextByStatus(EvidenceStatus.DIVERGENT);
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

    /// @notice Uma evidencia PENDING que passou do prazo.
    /// @dev Derivado de createdAt, sem custo de transacao. MATCHED nunca
    ///      expira: a correlacao ja aconteceu dentro da validade.
    function isExpired(bytes32 evidenceId) external view returns (bool) {
        Evidence storage e = evidences[evidenceId];
        if (e.status == EvidenceStatus.NONE) revert EvidenceNotFound(evidenceId);
        if (e.status != EvidenceStatus.PENDING) return false;
        return block.timestamp > e.createdAt + EVIDENCE_TTL;
    }

    function expiresAt(bytes32 evidenceId) external view returns (uint64) {
        Evidence storage e = evidences[evidenceId];
        if (e.status == EvidenceStatus.NONE) revert EvidenceNotFound(evidenceId);
        return e.createdAt + EVIDENCE_TTL;
    }

    /// @notice Compare an anchored result with a locally recomputed hash.
    /// @dev The authorized recipient recomputes from the private canonical
    ///      manifest AND private salt. Only candidateHash is sent on-chain.
    function verifyResultHash(
        bytes32 resultId,
        bytes32 candidateHash
    ) external view returns (bool) {
        BalanceResult storage r = results[resultId];
        if (r.resultId == bytes32(0)) return false;
        return r.resultHash == candidateHash;
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

    function _getNextByStatus(EvidenceStatus wanted) internal view returns (bytes32) {
        uint256 length = evidenceIds.length;
        for (uint256 i = 0; i < length; ++i) {
            bytes32 evidenceId = evidenceIds[i];
            if (evidences[evidenceId].status == wanted) {
                return evidenceId;
            }
        }
        return bytes32(0);
    }

    function _requireActor(bytes32 actorId) internal view returns (ActorIdentity storage actor) {
        actor = actors[actorId];
        if (actor.controller == address(0)) revert ActorNotFound(actorId);
    }

    function _readWorkflowId(
        bytes calldata metadata
    ) internal pure returns (bytes32 workflowId) {
        // Accept the real forwarder's longer metadata (currently 64 bytes).
        // Only its first 32-byte workflow ID is needed for this allowlist.
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
}



