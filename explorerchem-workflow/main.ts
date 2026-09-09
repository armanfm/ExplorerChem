import {
  CronCapability,
  EVMClient,
  HTTPClient,
  LATEST_BLOCK_NUMBER,
  Runner,
  TxStatus,
  bytesToHex,
  encodeCallMsg,
  getNetwork,
  handlerInTee,
  hexToBase64,
  ok,
  text,
  type CronPayload,
  type TeeRuntime,
} from "@chainlink/cre-sdk";

import {
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbiParameters,
  sha256,
  toHex,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
} from "viem";

import { z } from "zod";


/**
 * ExploreChem — full chain by lotId + strict origin/destination
 *
 * RULES FOR THIS VERSION
 * ------------------------------------------------------------
 * 1. The blockchain is queried first using getNextPending().
 * 2. In real execution, this PENDING evidence naturally advances after each MATCH.
 * 3. In SIMULATION, since writeReport does not persist the on-chain state between
 *    executions, the Supabase MATCHED mirror is used ONLY as simulation progress
 *    tracking to avoid selecting the same focus again. The on-chain PENDING status
 *    remains mandatory for the newly selected focus.
 * 4. The TEE downloads the original JSON and verifies the evidenceHash.
 * 5. lotId is the logical correlation token for the MVP. Supabase keeps only
 *    lot_reference as a discovery INDEX, never as an authority. The TEE uses the
 *    lotId from the JSON whose hash was verified against the blockchain.
 * 6. There is no longer a global scan of explorerchem_evidences: after verifying
 *    the focus evidence, the workflow queries only rows indexed under the same lot.
 * 7. A physical edge STRICTLY requires:
 *      from.lotId             == to.lotId
 *      from.destinationActor  == owner actor of to
 *      to.originActor         == owner actor of from
 * 8. There is no temporal window in this version. Timestamps do not determine
 *    correlation.
 * 9. The chain is expanded in both directions using BFS until no new links are found.
 *    For every newly discovered JSON, its fields are used to guide the next search.
 * 10. Laboratory evidence may be attached as LAB_ANALYSIS when it belongs to the
 *     same lotId and points to the destination actor. It does not create mass flow.
 * 11. Mass does NOT determine correlation. Each physical link is calculated
 *     pairwise.
 * 12. Each execution anchors only the result of the NEW PENDING focus evidence.
 * 13. An invalid physical self-relation finalizes the focus as DIVERGENT on-chain
 *     and mirrors the same state in Supabase. MINER and LABORATORY are excluded
 *     from the rule that prohibits origin from being equal to the actor itself.
 */


const DEFAULT_SCHEDULE = "0 0 0 * * 0";

const bytes32Schema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/) as z.ZodType<Hex>;

const actorTypeSchema = z.enum([
  "MINER",
  "CARRIER",
  "LABORATORY",
  "PROCESSOR",
  "REFINER",
  "RECYCLER",
  "MANUFACTURER",
  "OTHER",
]);

type ActorType = z.infer<typeof actorTypeSchema>;

type Status = "CONFORME" | "DIVERGENTE" | "NAO_ATESTADO";

type RelationType = "PHYSICAL_HANDOFF" | "LAB_ANALYSIS";

const configSchema = z.object({
  supabaseUrl: z.string().min(1),
  secretNamespace: z.string().min(1),
  chainSelectorName: z.string().min(1),
  contractAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  gasLimit: z.string().regex(/^\d+$/),
  correlationSchedule: z.string().min(1).optional(),
});

type Config = z.infer<typeof configSchema>;

const actorRowSchema = z.object({
  id: z.string().uuid(),
  actor_id: bytes32Schema,
  display_name: z.string().min(1),
  actor_type: actorTypeSchema,
});

type ActorRow = z.infer<typeof actorRowSchema>;

const evidenceRowSchema = z.object({
  evidence_id: bytes32Schema,
  actor_db_id: z.string().uuid(),
  state: z.string().min(1),
  evidence_hash: bytes32Schema,
  hash_algorithm: z.enum([
    "KECCAK256",
    "KECCAK-256",
    "SHA-256",
    "SHA256",
  ]),
  storage_bucket: z.string().min(1),
  storage_path: z.string().min(1),
  mime_type: z.string().min(1),
  lot_reference: z.string().min(1).nullable(),
  chain_created_at: z.string().nullable().optional(),
});

type EvidenceRow = z.infer<typeof evidenceRowSchema>;

type ActorDirectory = {
  byDbId: Map<string, ActorRow>;
  byName: Map<string, Hex>;
};

type OnchainEvidence = {
  evidenceId: Hex;
  actorId: Hex;
  evidenceHash: Hex;
  status: number;
};

type NormalizedEvidence = {
  actorType: ActorType;
  ownerActorId: Hex;
  originActorId: Hex | null;
  destinationActorId: Hex | null;
  carrierActorId: Hex | null;
  originSite: string | null;
  destinationSite: string | null;
  lotReference: string | null;
  grossMassKg: string | null;
  collectedMassKg: string | null;
  deliveredMassKg: string | null;
  inputMassKg: string | null;
  outputMassKg: string | null;
  scrapMassKg: string | null;
  recoveredMassKg: string | null;
};

type IntegrityCheck = {
  rowHashMatchesChain: boolean;
  documentHashMatchesChain: boolean;
  ownerActorMatchesChain: boolean;
};

type VerifiedEvidence = {
  row: EvidenceRow;
  onchain: OnchainEvidence;
  document: Record<string, unknown>;
  normalized: NormalizedEvidence;
  integrity: IntegrityCheck;
};

type MassEndpoint = {
  massMg: bigint | null;
  field: string;
};

type CorrelationEdge = {
  from: VerifiedEvidence;
  to: VerifiedEvidence;
  relationType: RelationType;
  lotReference: string;
  left: MassEndpoint;
  right: MassEndpoint;
};

type CorrelationComponent = {
  evidences: VerifiedEvidence[];
  edges: CorrelationEdge[];
};

type PairMassResult = {
  pairId: Hex;
  relationType: RelationType;
  fromEvidenceId: Hex;
  toEvidenceId: Hex;
  fromActorId: Hex;
  toActorId: Hex;
  lotReference: string;
  leftMassMg: string | null;
  rightMassMg: string | null;
  leftMassField: string;
  rightMassField: string;
  deltaMg: string | null;
  status: Status;
};

type ComponentMassResult = {
  schema: "ExploreChem/PairwiseMassResult/v1";
  calculationVersion: 1;
  focusActorId: Hex;
  focusEvidenceId: Hex;
  lotReference: string;
  evidenceIds: Hex[];
  correlationEdges: Array<{
    fromEvidenceId: Hex;
    toEvidenceId: Hex;
    relationType: RelationType;
    lotReference: string;
  }>;
  massPairs: PairMassResult[];
  status: Status;
};

type PendingSelection = {
  initialBlockchainPendingId: Hex;
  row: EvidenceRow;
  onchain: OnchainEvidence;
  mode:
    | "CHAIN_GET_NEXT_PENDING"
    | "SIMULATION_PROGRESS_FALLBACK";
};

/* ============================================================
 * ABI
 * ============================================================
 */

const ABI = [
  {
    type: "function",
    name: "getNextPending",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "getEvidence",
    stateMutability: "view",
    inputs: [{ name: "evidenceId", type: "bytes32" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "evidenceId", type: "bytes32" },
          { name: "actorId", type: "bytes32" },
          { name: "submittedBy", type: "address" },
          { name: "evidenceHash", type: "bytes32" },
          { name: "status", type: "uint8" },
          { name: "createdAt", type: "uint64" },
          { name: "matchedAt", type: "uint64" },
          { name: "auditedAt", type: "uint64" },
        ],
      },
    ],
  },
] as const;

const EVIDENCE_SELECT = [
  "evidence_id",
  "actor_db_id",
  "state",
  "evidence_hash",
  "hash_algorithm",
  "storage_bucket",
  "storage_path",
  "mime_type",
  "lot_reference",
  "chain_created_at",
].join(",");

/* ============================================================
 * Helpers
 * ============================================================
 */

function lower(value: string): string {
  return value.toLowerCase();
}

function canonicalName(value: string): string {
  return value.trim().toLowerCase();
}

function hashText(value: string): Hex {
  return keccak256(toHex(value));
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stable);
  }

  if (value !== null && typeof value === "object") {
    const objectValue = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(objectValue)
        .sort()
        .map((key) => [key, stable(objectValue[key])]),
    );
  }

  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stable(value));
}

function recordOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function sameLot(
  left: NormalizedEvidence,
  right: NormalizedEvidence,
): boolean {
  return (
    left.lotReference !== null &&
    right.lotReference !== null &&
    left.lotReference === right.lotReference
  );
}

function decimalString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      return null;
    }
    const rendered = value.toString();
    return /^\d+(?:\.\d+)?$/.test(rendered) ? rendered : null;
  }

  if (typeof value !== "string") {
    return null;
  }

  const rendered = value.trim();
  return /^\d+(?:\.\d+)?$/.test(rendered) ? rendered : null;
}

function kgToMg(value: string | null): bigint | null {
  if (value === null) {
    return null;
  }

  const parts = value.split(".");
  const whole = BigInt(parts[0]);
  const fractional = parts[1] ?? "";
  const firstSix = fractional.slice(0, 6).padEnd(6, "0");

  let result = whole * 1_000_000n + BigInt(firstSix);

  if (fractional.length > 6) {
    const seventhDigit = Number(fractional[6]);
    if (seventhDigit >= 5) {
      result += 1n;
    }
  }

  return result;
}

function idEquals(left: Hex | null, right: Hex): boolean {
  return left !== null && lower(left) === lower(right);
}

function encPath(path: string): string {
  return path
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

/* ============================================================
 * CRE network / secrets
 * ============================================================
 */

function network(runtime: TeeRuntime<Config>) {
  const found = getNetwork({
    chainFamily: "evm",
    chainSelectorName: runtime.config.chainSelectorName,
    isTestnet: true,
  });

  if (!found) {
    throw new Error(`rede nao encontrada: ${runtime.config.chainSelectorName}`);
  }

  return found;
}

function secrets(runtime: TeeRuntime<Config>) {
  const result = runtime
    .getSecrets([
      {
        id: "SUPABASE_SERVICE_ROLE_KEY",
        namespace: runtime.config.secretNamespace,
      },
    ])
    .result();

  const key = result.SUPABASE_SERVICE_ROLE_KEY?.value;

  if (!key) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY ausente");
  }

  return { key };
}

/* ============================================================
 * HTTP / Supabase
 * ============================================================
 */

type Method = "GET" | "POST" | "PATCH";

function request(
  runtime: TeeRuntime<Config>,
  key: string,
  path: string,
  method: Method,
  body?: unknown,
  extra?: Record<string, { values: string[] }>,
) {
  const baseHeaders = {
    apikey: { values: [key] },
    authorization: { values: [`Bearer ${key}`] },
    accept: { values: ["application/json"] },
    ...extra,
  };

  const req =
    body === undefined
      ? {
          url: `${runtime.config.supabaseUrl}${path}`,
          method,
          multiHeaders: baseHeaders,
        }
      : {
          url: `${runtime.config.supabaseUrl}${path}`,
          method,
          multiHeaders: {
            ...baseHeaders,
            "content-type": { values: ["application/json"] },
          },
          body: Buffer.from(JSON.stringify(body)).toString("base64"),
        };

  const response = new HTTPClient().sendRequest(runtime, req).result();

  if (!ok(response)) {
    throw new Error(
      `Supabase ${method} ${path}: ${response.statusCode} ${text(response)}`,
    );
  }

  return response;
}

function getJson<T>(
  runtime: TeeRuntime<Config>,
  key: string,
  path: string,
): T {
  const raw = text(request(runtime, key, path, "GET"));
  return (raw.length > 0 ? JSON.parse(raw) : null) as T;
}

function loadActorDirectory(
  runtime: TeeRuntime<Config>,
  key: string,
): ActorDirectory {
  const rows = z.array(actorRowSchema).parse(
    getJson<unknown>(
      runtime,
      key,
      "/rest/v1/explorerchem_actors?select=id,actor_id,display_name,actor_type&active=eq.true&order=created_at.asc",
    ),
  );

  return {
    byDbId: new Map(rows.map((row) => [row.id, row])),
    byName: new Map(
      rows.map((row) => [canonicalName(row.display_name), row.actor_id]),
    ),
  };
}

function loadOneEvidenceRow(
  runtime: TeeRuntime<Config>,
  key: string,
  evidenceId: Hex,
): EvidenceRow {
  const path =
    `/rest/v1/explorerchem_evidences?select=${EVIDENCE_SELECT}` +
    `&evidence_id=eq.${encodeURIComponent(evidenceId)}&limit=1`;

  const rows = z.array(evidenceRowSchema).parse(
    getJson<unknown>(runtime, key, path),
  );

  if (rows.length !== 1) {
    throw new Error(`${evidenceId}: nao encontrado no Supabase`);
  }

  return rows[0];
}

function loadEvidenceRowsByLot(
  runtime: TeeRuntime<Config>,
  key: string,
  lotReference: string,
): EvidenceRow[] {
  /*
   * Descoberta indexada: esta consulta nao prova correlacao. Ela so reduz o
   * universo de candidatos. Cada linha retornada ainda tera blockchain + JSON
   * verificados pelo TEE antes de participar da BFS.
   */
  const path =
    `/rest/v1/explorerchem_evidences?select=${EVIDENCE_SELECT}` +
    `&lot_reference=eq.${encodeURIComponent(lotReference)}` +
    `&order=chain_created_at.asc,evidence_id.asc`;

  return z.array(evidenceRowSchema).parse(
    getJson<unknown>(runtime, key, path),
  );
}

function loadSimulationPendingRows(
  runtime: TeeRuntime<Config>,
  key: string,
  excludedEvidenceId: Hex,
): EvidenceRow[] {
  /*
   * Fallback EXCLUSIVO da simulacao: nao varre todas as evidencias. Busca apenas
   * um pequeno lote de linhas ainda PENDING no espelho e confirma status=1
   * on-chain antes de escolher qualquer uma.
   */
  const path =
    `/rest/v1/explorerchem_evidences?select=${EVIDENCE_SELECT}` +
    `&state=eq.PENDING` +
    `&evidence_id=neq.${encodeURIComponent(excludedEvidenceId)}` +
    `&order=chain_created_at.asc,evidence_id.asc` +
    `&limit=32`;

  return z.array(evidenceRowSchema).parse(
    getJson<unknown>(runtime, key, path),
  );
}

function downloadEvidenceDocument(
  runtime: TeeRuntime<Config>,
  key: string,
  row: EvidenceRow,
): Uint8Array {
  const path =
    `/storage/v1/object/authenticated/${encodeURIComponent(row.storage_bucket)}/` +
    `${encPath(row.storage_path)}`;

  const response = request(
    runtime,
    key,
    path,
    "GET",
    undefined,
    {
      accept: { values: [row.mime_type] },
    },
  );

  return new Uint8Array(response.body);
}

function parseJsonDocument(
  row: EvidenceRow,
  bytes: Uint8Array,
): Record<string, unknown> {
  if (!row.mime_type.toLowerCase().includes("json")) {
    throw new Error(
      `${row.evidence_id}: este workflow bilateral do MVP exige JSON; mime=${row.mime_type}`,
    );
  }

  const parsed = JSON.parse(new TextDecoder().decode(bytes));

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${row.evidence_id}: JSON invalido`);
  }

  return parsed as Record<string, unknown>;
}

function savePrivateResult(
  runtime: TeeRuntime<Config>,
  key: string,
  bucket: string,
  path: string,
  value: unknown,
) {
  const response = new HTTPClient()
    .sendRequest(runtime, {
      url:
        `${runtime.config.supabaseUrl}/storage/v1/object/` +
        `${encodeURIComponent(bucket)}/${encPath(path)}`,
      method: "POST",
      multiHeaders: {
        apikey: { values: [key] },
        authorization: { values: [`Bearer ${key}`] },
        "content-type": { values: ["application/json"] },
        "x-upsert": { values: ["true"] },
      },
      body: Buffer.from(JSON.stringify(value)).toString("base64"),
    })
    .result();

  if (!ok(response)) {
    throw new Error(
      `falha ao salvar resultado privado: ${response.statusCode} ${text(response)}`,
    );
  }
}

function mirrorMatch(
  runtime: TeeRuntime<Config>,
  key: string,
  evidenceId: Hex,
  txHash: Hex,
) {
  request(
    runtime,
    key,
    `/rest/v1/explorerchem_evidences?evidence_id=eq.${encodeURIComponent(evidenceId)}&state=eq.PENDING`,
    "PATCH",
    {
      state: "MATCHED",
      matched_at: new Date(runtime.now()).toISOString(),
      match_tx_hash: txHash,
    },
    {
      prefer: { values: ["return=minimal"] },
    },
  );
}

function mirrorDivergent(
  runtime: TeeRuntime<Config>,
  key: string,
  evidenceId: Hex,
) {
  request(
    runtime,
    key,
    `/rest/v1/explorerchem_evidences?evidence_id=eq.${encodeURIComponent(evidenceId)}&state=eq.MATCHED`,
    "PATCH",
    {
      state: "DIVERGENT",
    },
    {
      prefer: { values: ["return=minimal"] },
    },
  );
}

/* ============================================================
 * Blockchain FIRST
 * ============================================================
 */

function getNextPending(runtime: TeeRuntime<Config>): Hex {
  const callData = encodeFunctionData({
    abi: ABI,
    functionName: "getNextPending",
    args: [],
  });

  const response = new EVMClient(network(runtime).chainSelector.selector)
    .callContract(runtime.usingTheDons(), {
      call: encodeCallMsg({
        from: zeroAddress,
        to: runtime.config.contractAddress as Address,
        data: callData,
      }),
      blockNumber: LATEST_BLOCK_NUMBER,
    })
    .result();

  return decodeFunctionResult({
    abi: ABI,
    functionName: "getNextPending",
    data: bytesToHex(response.data),
  }) as Hex;
}

function readEvidence(
  runtime: TeeRuntime<Config>,
  evidenceId: Hex,
): OnchainEvidence {
  const callData = encodeFunctionData({
    abi: ABI,
    functionName: "getEvidence",
    args: [evidenceId],
  });

  const response = new EVMClient(network(runtime).chainSelector.selector)
    .callContract(runtime.usingTheDons(), {
      call: encodeCallMsg({
        from: zeroAddress,
        to: runtime.config.contractAddress as Address,
        data: callData,
      }),
      blockNumber: LATEST_BLOCK_NUMBER,
    })
    .result();

  const decoded = decodeFunctionResult({
    abi: ABI,
    functionName: "getEvidence",
    data: bytesToHex(response.data),
  });

  return {
    evidenceId: decoded.evidenceId,
    actorId: decoded.actorId,
    evidenceHash: decoded.evidenceHash,
    status: Number(decoded.status),
  };
}

/**
 * Seleciona o foco efetivo sem perder a regra "blockchain first".
 *
 * A PRIMEIRA consulta sempre e getNextPending() on-chain.
 *
 * Em rede real:
 *   - o id retornado deve estar PENDING tambem no espelho Supabase;
 *   - ele e usado diretamente.
 *
 * Em SIMULATION:
 *   - writeReport nao persiste o status para a proxima execucao;
 *   - o Supabase, porem, pode ja ter sido espelhado como MATCHED;
 *   - nesse caso varremos somente linhas ainda PENDING no Supabase e
 *     CONFIRMAMOS on-chain que o candidato escolhido continua status=1.
 *
 * Assim a simulacao consegue avancar E1 -> E2 -> E3 sem transformar
 * Supabase em autoridade: nenhum foco e aceito sem status PENDING on-chain.
 */
function selectEffectivePending(
  runtime: TeeRuntime<Config>,
  key: string,
  initialBlockchainPendingId: Hex,
): PendingSelection | null {
  /*
   * Caminho normal: consulta pontual pelo evidenceId que veio da blockchain.
   * Nenhuma lista global e carregada.
   */
  try {
    const initialRow = loadOneEvidenceRow(
      runtime,
      key,
      initialBlockchainPendingId,
    );
    const initialOnchain = readEvidence(
      runtime,
      initialBlockchainPendingId,
    );

    if (
      initialOnchain.status === 1 &&
      initialRow.state.trim().toUpperCase() === "PENDING"
    ) {
      return {
        initialBlockchainPendingId,
        row: initialRow,
        onchain: initialOnchain,
        mode: "CHAIN_GET_NEXT_PENDING",
      };
    }
  } catch {
    // Em SIMULATION pode existir divergencia de espelho; segue ao fallback.
  }

  /*
   * Fallback controlado da SIMULATION. O Supabase serve apenas como cursor de
   * progresso. Nenhum candidato e aceito sem readEvidence(...).status === 1.
   */
  const pendingRows = loadSimulationPendingRows(
    runtime,
    key,
    initialBlockchainPendingId,
  );

  for (const row of pendingRows) {
    try {
      const onchain = readEvidence(runtime, row.evidence_id);
      if (onchain.status !== 1) {
        continue;
      }

      return {
        initialBlockchainPendingId,
        row,
        onchain,
        mode: "SIMULATION_PROGRESS_FALLBACK",
      };
    } catch {
      // indice sem evidencia legivel on-chain: ignora e continua
    }
  }

  return null;
}

/* ============================================================
 * Documento -> atores / lote / massa
 * ============================================================
 */

function actorIdFromValue(
  value: unknown,
  actors: ActorDirectory,
): Hex | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }

  const trimmed = value.trim();

  if (/^0x[0-9a-fA-F]{64}$/.test(trimmed)) {
    return trimmed as Hex;
  }

  return actors.byName.get(canonicalName(trimmed)) ?? null;
}

function normalizeEvidence(
  document: Record<string, unknown>,
  row: EvidenceRow,
  actors: ActorDirectory,
): NormalizedEvidence {
  const actor = actors.byDbId.get(row.actor_db_id);

  if (!actor) {
    throw new Error(`${row.evidence_id}: actor_db_id nao encontrado`);
  }

  /*
   * O actorId do JSON nao e a autoridade sobre o dono da evidencia.
   * A identidade autoritativa vem de:
   *   row.actor_db_id -> explorerchem_actors.actor_id -> blockchain actorId.
   *
   * Para correlacao usamos apenas campos comprometidos no documento:
   * lotId, originActor e destinationActor.
   */

  if (typeof document.actorType === "string") {
    const declaredType = document.actorType.trim().toUpperCase();
    if (
      (actorTypeSchema.options as readonly string[]).includes(declaredType) &&
      declaredType !== actor.actor_type
    ) {
      throw new Error(
        `${row.evidence_id}: actorType do documento diverge do cadastro`,
      );
    }
  }

  const massBalance = recordOf(document.massBalance);
  const custody = recordOf(document.custody);
  const transformation = recordOf(document.transformation);
  const recovery = recordOf(document.recovery);

  return {
    actorType: actor.actor_type,
    ownerActorId: actor.actor_id,
    originActorId: actorIdFromValue(
      document.originActorId ?? document.originActor,
      actors,
    ),
    destinationActorId: actorIdFromValue(
      document.destinationActorId ?? document.destinationActor,
      actors,
    ),
    carrierActorId: actorIdFromValue(
      document.carrierActorId ?? document.carrierActor,
      actors,
    ),
    originSite: nullableString(document.originSite),
    destinationSite: nullableString(document.destinationSite),
    lotReference: nullableString(document.lotId ?? document.lotReference),
    grossMassKg: decimalString(
      massBalance.grossMassKg ?? document.grossMassKg ?? document.massKg,
    ),
    collectedMassKg: decimalString(
      custody.massCollectedKg ?? document.collectedMassKg,
    ),
    deliveredMassKg: decimalString(
      custody.massDeliveredKg ?? document.deliveredMassKg,
    ),
    inputMassKg: decimalString(
      transformation.inputMassKg ??
        transformation.inputProductMassKg ??
        recovery.inputMassKg ??
        document.inputMassKg,
    ),
    outputMassKg: decimalString(
      transformation.outputProductMassKg ??
        transformation.finishedProductMassKg ??
        recovery.recoveredProductMassKg ??
        document.outputMassKg,
    ),
    scrapMassKg: decimalString(
      transformation.scrapMassKg ?? document.scrapMassKg,
    ),
    recoveredMassKg: decimalString(
      recovery.recoveredProductMassKg ?? document.recoveredMassKg,
    ),
  };
}

function recomputeEvidenceHash(
  row: EvidenceRow,
  bytes: Uint8Array,
): Hex {
  if (row.hash_algorithm === "SHA-256" || row.hash_algorithm === "SHA256") {
    return sha256(bytes);
  }

  return keccak256(bytes);
}

function loadVerifiedEvidence(
  runtime: TeeRuntime<Config>,
  key: string,
  row: EvidenceRow,
  actors: ActorDirectory,
  onchain?: OnchainEvidence,
): VerifiedEvidence {
  const chainEvidence = onchain ?? readEvidence(runtime, row.evidence_id);

  if (lower(chainEvidence.evidenceId) !== lower(row.evidence_id)) {
    throw new Error(`${row.evidence_id}: evidenceId on-chain divergente`);
  }

  const bytes = downloadEvidenceDocument(runtime, key, row);
  const recomputedHash = recomputeEvidenceHash(row, bytes);
  const document = parseJsonDocument(row, bytes);
  const normalized = normalizeEvidence(document, row, actors);

  const integrity: IntegrityCheck = {
    rowHashMatchesChain:
      lower(row.evidence_hash) === lower(chainEvidence.evidenceHash),
    documentHashMatchesChain:
      lower(recomputedHash) === lower(chainEvidence.evidenceHash),
    ownerActorMatchesChain:
      lower(normalized.ownerActorId) === lower(chainEvidence.actorId),
  };

  if (!integrity.documentHashMatchesChain) {
    throw new Error(`${row.evidence_id}: hash do JSON diverge da blockchain`);
  }

  if (!integrity.ownerActorMatchesChain) {
    throw new Error(`${row.evidence_id}: ator dono diverge da blockchain`);
  }

  return {
    row,
    onchain: chainEvidence,
    document,
    normalized,
    integrity,
  };
}

/* ============================================================
 * Correlacao temporal + origem/destino
 * ============================================================
 */

function outgoingMass(
  from: VerifiedEvidence,
  to: VerifiedEvidence,
): MassEndpoint {
  const n = from.normalized;

  if (n.actorType === "LABORATORY") {
    return { massMg: null, field: "NO_PHYSICAL_MASS" };
  }

  if (n.actorType === "MINER") {
    return {
      massMg: kgToMg(n.outputMassKg ?? n.grossMassKg),
      field:
        n.outputMassKg !== null
          ? "outputMassKg"
          : "massBalance.grossMassKg",
    };
  }

  if (n.actorType === "CARRIER") {
    return {
      massMg: kgToMg(n.deliveredMassKg ?? n.outputMassKg),
      field:
        n.deliveredMassKg !== null
          ? "custody.massDeliveredKg"
          : "outputMassKg",
    };
  }

  if (n.actorType === "PROCESSOR" || n.actorType === "REFINER") {
    return {
      massMg: kgToMg(n.outputMassKg),
      field: "transformation.outputMassKg",
    };
  }

  if (n.actorType === "MANUFACTURER") {
    if (
      to.normalized.actorType === "RECYCLER" &&
      n.scrapMassKg !== null
    ) {
      return {
        massMg: kgToMg(n.scrapMassKg),
        field: "transformation.scrapMassKg",
      };
    }

    return {
      massMg: kgToMg(n.outputMassKg ?? n.scrapMassKg),
      field:
        n.outputMassKg !== null
          ? "outputMassKg"
          : "transformation.scrapMassKg",
    };
  }

  if (n.actorType === "RECYCLER") {
    return {
      massMg: kgToMg(n.recoveredMassKg ?? n.outputMassKg),
      field:
        n.recoveredMassKg !== null
          ? "recovery.recoveredProductMassKg"
          : "outputMassKg",
    };
  }

  const value =
    n.deliveredMassKg ??
    n.recoveredMassKg ??
    n.scrapMassKg ??
    n.outputMassKg ??
    n.grossMassKg;

  return {
    massMg: kgToMg(value),
    field: "bestAvailableOutgoingMass",
  };
}

function incomingMass(to: VerifiedEvidence): MassEndpoint {
  const n = to.normalized;

  if (n.actorType === "LABORATORY") {
    return { massMg: null, field: "NO_PHYSICAL_MASS" };
  }

  if (n.actorType === "CARRIER") {
    return {
      massMg: kgToMg(
        n.collectedMassKg ??
          n.inputMassKg ??
          n.grossMassKg,
      ),
      field:
        n.collectedMassKg !== null
          ? "custody.massCollectedKg"
          : n.inputMassKg !== null
            ? "inputMassKg"
            : "massBalance.grossMassKg",
    };
  }

  if (
    n.actorType === "PROCESSOR" ||
    n.actorType === "REFINER" ||
    n.actorType === "MANUFACTURER" ||
    n.actorType === "RECYCLER"
  ) {
    return {
      massMg: kgToMg(
        n.inputMassKg ??
          n.grossMassKg ??
          n.collectedMassKg,
      ),
      field:
        n.inputMassKg !== null
          ? "transformation.inputMassKg"
          : n.grossMassKg !== null
            ? "massBalance.grossMassKg"
            : "custody.massCollectedKg",
    };
  }

  return {
    massMg: kgToMg(
      n.inputMassKg ??
        n.collectedMassKg ??
        n.grossMassKg,
    ),
    field: "bestAvailableIncomingMass",
  };
}

function edgeCandidate(
  from: VerifiedEvidence,
  to: VerifiedEvidence,
  relationType: RelationType,
): CorrelationEdge {
  const lotReference = from.normalized.lotReference;

  if (lotReference === null || !sameLot(from.normalized, to.normalized)) {
    throw new Error("edgeCandidate chamado sem lotId comum");
  }

  if (relationType === "LAB_ANALYSIS") {
    return {
      from,
      to,
      relationType,
      lotReference,
      left: {
        massMg: null,
        field: "NO_PHYSICAL_MASS",
      },
      right: {
        massMg: null,
        field: "NO_PHYSICAL_MASS",
      },
    };
  }

  return {
    from,
    to,
    relationType,
    lotReference,
    left: outgoingMass(from, to),
    right: incomingMass(to),
  };
}

/**
 * REGRA CENTRAL.
 *
 * PHYSICAL_HANDOFF exige, sem fallback:
 *
 *   from.lotId              == to.lotId
 *   from.destinationActorId == to.actorId
 *   to.originActorId        == from.actorId
 *
 * Timestamp NAO participa da correlacao nesta versao.
 * Massa tambem NAO participa da descoberta.
 *
 * LAB_ANALYSIS nao representa transferencia fisica. O laudo so pode ser
 * anexado quando pertence ao mesmo lotId e aponta para o ator alvo.
 */
function directedRelation(
  from: VerifiedEvidence,
  to: VerifiedEvidence,
): CorrelationEdge | null {
  if (
    lower(from.row.evidence_id) ===
    lower(to.row.evidence_id)
  ) {
    return null;
  }

  const a = from.normalized;
  const b = to.normalized;

  if (!sameLot(a, b)) {
    return null;
  }

  /*
   * Laboratorio: evidencia analitica, nao fluxo fisico.
   */
  if (a.actorType === "LABORATORY") {
    if (
      !idEquals(
        a.destinationActorId,
        to.onchain.actorId,
      )
    ) {
      return null;
    }

    return edgeCandidate(
      from,
      to,
      "LAB_ANALYSIS",
    );
  }

  /*
   * Nenhum evento fisico termina "no laboratorio" neste modelo.
   */
  if (b.actorType === "LABORATORY") {
    return null;
  }

  /*
   * CORRELACAO FISICA ESTRITA.
   *
   * Nao aceitamos:
   *   - lotId diferente ou ausente;
   *   - destino aproximado;
   *   - originActor ausente;
   *   - originActor igual ao proprio receptor como fallback;
   *   - massa como criterio de match;
   *   - timestamp como criterio de match.
   */
  const destinationMatches =
    idEquals(
      a.destinationActorId,
      to.onchain.actorId,
    );

  const originMatches =
    idEquals(
      b.originActorId,
      from.onchain.actorId,
    );

  if (
    !destinationMatches ||
    !originMatches
  ) {
    return null;
  }

  return edgeCandidate(
    from,
    to,
    "PHYSICAL_HANDOFF",
  );
}

function edgeKey(
  edge: CorrelationEdge,
): string {
  return [
    lower(edge.from.row.evidence_id),
    lower(edge.to.row.evidence_id),
    edge.relationType,
    edge.lotReference,
  ].join("|");
}

/**
 * Expande a cadeia COMPLETA por BFS.
 *
 * O lotId define o universo logico da cadeia.
 * Para cada evidencia encontrada:
 *   - abre/usa o JSON daquele novo no;
 *   - testa current -> other;
 *   - testa other -> current;
 *   - exige o mesmo lotId em cada conexao;
 *   - exige origem/destino estritos;
 *   - cada novo no entra na fila e passa a orientar a proxima busca.
 */
function buildCorrelatedComponent(
  focus: VerifiedEvidence,
  candidates: VerifiedEvidence[],
): CorrelationComponent {
  const all = [focus, ...candidates].filter(
    (item) => sameLot(focus.normalized, item.normalized),
  );

  const byId = new Map(
    all.map(
      (item) =>
        [
          lower(item.row.evidence_id),
          item,
        ] as const,
    ),
  );

  byId.set(
    lower(focus.row.evidence_id),
    focus,
  );

  const seen = new Set<string>([
    lower(focus.row.evidence_id),
  ]);

  const queue: string[] = [
    lower(focus.row.evidence_id),
  ];

  const edges =
    new Map<string, CorrelationEdge>();

  while (queue.length > 0) {
    const currentId =
      queue.shift()!;

    const current =
      byId.get(currentId);

    if (!current) {
      continue;
    }

    for (
      const other of
      byId.values()
    ) {
      const otherId =
        lower(
          other.row.evidence_id,
        );

      if (
        otherId === currentId
      ) {
        continue;
      }

      const forward =
        directedRelation(
          current,
          other,
        );

      if (forward) {
        edges.set(
          edgeKey(forward),
          forward,
        );

        if (!seen.has(otherId)) {
          seen.add(otherId);
          queue.push(otherId);
        }
      }

      const backward =
        directedRelation(
          other,
          current,
        );

      if (backward) {
        edges.set(
          edgeKey(backward),
          backward,
        );

        if (!seen.has(otherId)) {
          seen.add(otherId);
          queue.push(otherId);
        }
      }
    }
  }

  const evidences =
    [...seen]
      .map((id) =>
        byId.get(id),
      )
      .filter(
        (
          item,
        ): item is VerifiedEvidence =>
          item !== undefined,
      )
      .sort((a, b) =>
        a.row.evidence_id.localeCompare(
          b.row.evidence_id,
        ),
      );

  const componentEdges =
    [...edges.values()]
      .filter(
        (edge) =>
          seen.has(
            lower(
              edge.from.row
                .evidence_id,
            ),
          ) &&
          seen.has(
            lower(
              edge.to.row
                .evidence_id,
            ),
          ),
      )
      .sort((a, b) =>
        edgeKey(a).localeCompare(
          edgeKey(b),
        ),
      );

  return {
    evidences,
    edges: componentEdges,
  };
}

/* ============================================================
 * Massa: toda a cadeia, mas SEM soma global
 * Cada PHYSICAL_HANDOFF e calculado de dois em dois.
 * ============================================================
 */

function calculatePairMass(
  edge: CorrelationEdge,
): PairMassResult | null {
  if (
    edge.relationType !==
    "PHYSICAL_HANDOFF"
  ) {
    return null;
  }

  const left = edge.left.massMg;
  const right = edge.right.massMg;

  const delta =
    left !== null &&
    right !== null
      ? left - right
      : null;

  const status: Status =
    delta === null
      ? "NAO_ATESTADO"
      : delta === 0n
        ? "CONFORME"
        : "DIVERGENTE";

  const pairId =
    hashText(
      stableJson({
        domain:
          "ExploreChem/LotPairwiseMassPair/v4",
        lotReference:
          edge.lotReference,
        fromEvidenceId:
          edge.from.row.evidence_id,
        toEvidenceId:
          edge.to.row.evidence_id,
        relationType:
          edge.relationType,
      }),
    );

  return {
    pairId,
    relationType:
      edge.relationType,
    fromEvidenceId:
      edge.from.row.evidence_id,
    toEvidenceId:
      edge.to.row.evidence_id,
    fromActorId:
      edge.from.onchain.actorId,
    toActorId:
      edge.to.onchain.actorId,
    lotReference:
      edge.lotReference,
    leftMassMg:
      left?.toString() ?? null,
    rightMassMg:
      right?.toString() ?? null,
    leftMassField:
      edge.left.field,
    rightMassField:
      edge.right.field,
    deltaMg:
      delta?.toString() ?? null,
    status,
  };
}

function calculateComponentMass(
  focus: VerifiedEvidence,
  component: CorrelationComponent,
): ComponentMassResult {
  const lotReference =
    focus.normalized.lotReference;

  if (lotReference === null) {
    throw new Error(
      `${focus.row.evidence_id}: lotId ausente no foco`,
    );
  }

  const massPairs =
    component.edges
      .map(calculatePairMass)
      .filter(
        (
          pair,
        ): pair is PairMassResult =>
          pair !== null,
      );

  let status: Status;

  if (
    massPairs.some(
      (pair) =>
        pair.status ===
        "DIVERGENTE",
    )
  ) {
    status = "DIVERGENTE";
  } else if (
    massPairs.length > 0 &&
    massPairs.every(
      (pair) =>
        pair.status ===
        "CONFORME",
    )
  ) {
    status = "CONFORME";
  } else {
    status = "NAO_ATESTADO";
  }

  return {
    schema:
      "ExploreChem/PairwiseMassResult/v1",
    calculationVersion: 1,
    focusActorId:
      focus.onchain.actorId,
    focusEvidenceId:
      focus.row.evidence_id,
    lotReference,
    evidenceIds:
      component.evidences
        .map(
          (item) =>
            item.row.evidence_id,
        ),
    correlationEdges:
      component.edges.map(
        (edge) => ({
          fromEvidenceId:
            edge.from.row
              .evidence_id,
          toEvidenceId:
            edge.to.row
              .evidence_id,
          relationType:
            edge.relationType,
          lotReference:
            edge.lotReference,
        }),
      ),
    massPairs,
    status,
  };
}

/* ============================================================
 * Fingerprints e commitments deterministicos para blockchain
 * ============================================================
 */

function commitment(
  focus: OnchainEvidence,
  result: ComponentMassResult,
) {
  const canonicalResultHash =
    hashText(
      stableJson(result),
    );

  const relationFingerprint =
    hashText(
      stableJson({
        domain:
          "ExploreChem/PairwiseMassRelation/v1",
        calculationVersion:
          result.calculationVersion,
        focusActorId:
          result.focusActorId,
        focusEvidenceId:
          result.focusEvidenceId,
        lotReference:
          result.lotReference,
        evidenceIds:
          result.evidenceIds,
        correlationEdges:
          result.correlationEdges,
        massPairs:
          result.massPairs,
      }),
    );

  const aggregateInputHash =
    hashText(
      stableJson({
        domain:
          "ExploreChem/PairwiseMassInput/v1",
        calculationVersion:
          result.calculationVersion,
        actorId:
          focus.actorId,
        focusEvidenceId:
          focus.evidenceId,
        evidenceIds:
          result.evidenceIds,
        correlationEdges:
          result.correlationEdges,
      }),
    );

  const resultHash =
    hashText(
      stableJson({
        domain:
          "ExploreChem/PairwiseMass/v1",
        calculationVersion:
          result.calculationVersion,
        actorId:
          focus.actorId,
        focusEvidenceId:
          focus.evidenceId,
        result,
      }),
    );

  const resultId =
    hashText(
      stableJson({
        domain:
          "ExploreChem/PairwiseMassResultId/v1",
        calculationVersion:
          result.calculationVersion,
        actorId:
          focus.actorId,
        focusEvidenceId:
          focus.evidenceId,
        resultHash,
      }),
    );

  return {
    relationFingerprint,
    componentFingerprint:
      relationFingerprint,
    canonicalResultHash,
    aggregateInputHash,
    resultHash,
    resultId,
  };
}

function privateResultPath(focusId: Hex, resultId: Hex): string {
  return `mass-results/${focusId.slice(2)}/${resultId.slice(2)}.json`;
}

/* ============================================================
 * Reports on-chain
 * ============================================================
 */

function matchReport(evidenceId: Hex): Hex {
  return encodeAbiParameters(
    parseAbiParameters(
      "uint8 reportType, bytes32 evidenceId, bytes32 resultId, bytes32 actorId, bytes32 resultHash, bytes32 previousResultId, bytes32 aggregateInputHash, uint8 balanceStatus, uint32 calculationVersion",
    ),
    [
      1,
      evidenceId,
      zeroHash,
      zeroHash,
      zeroHash,
      zeroHash,
      zeroHash,
      0,
      0,
    ],
  );
}

function balanceReport(
  focus: OnchainEvidence,
  committed: ReturnType<typeof commitment>,
  status: Status,
): Hex {
  const balanceStatus =
    status === "CONFORME" ? 1 : status === "DIVERGENTE" ? 2 : 3;

  return encodeAbiParameters(
    parseAbiParameters(
      "uint8 reportType, bytes32 evidenceId, bytes32 resultId, bytes32 actorId, bytes32 resultHash, bytes32 previousResultId, bytes32 aggregateInputHash, uint8 balanceStatus, uint32 calculationVersion",
    ),
    [
      2,
      focus.evidenceId,
      committed.resultId,
      focus.actorId,
      committed.resultHash,
      zeroHash,
      committed.aggregateInputHash,
      balanceStatus,
      1,
    ],
  );
}

function divergentEvidenceReport(evidenceId: Hex): Hex {
  return encodeAbiParameters(
    parseAbiParameters(
      "uint8 reportType, bytes32 evidenceId, bytes32 resultId, bytes32 actorId, bytes32 resultHash, bytes32 previousResultId, bytes32 aggregateInputHash, uint8 balanceStatus, uint32 calculationVersion",
    ),
    [
      3,
      evidenceId,
      zeroHash,
      zeroHash,
      zeroHash,
      zeroHash,
      zeroHash,
      4,
      0,
    ],
  );
}

function write(runtime: TeeRuntime<Config>, payload: Hex): Hex {
  const don = runtime.usingTheDons();

  const report = don
    .report({
      encodedPayload: hexToBase64(payload),
      encoderName: "evm",
      signingAlgo: "ecdsa",
      hashingAlgo: "keccak256",
    })
    .result();

  const result = new EVMClient(network(runtime).chainSelector.selector)
    .writeReport(don, {
      receiver: runtime.config.contractAddress as Address,
      report,
      gasConfig: {
        gasLimit: runtime.config.gasLimit,
      },
    })
    .result();

  if (result.txStatus !== TxStatus.SUCCESS) {
    throw new Error(`writeReport falhou: ${result.txStatus}`);
  }

  if (
    result.receiverContractExecutionStatus !== undefined &&
    result.receiverContractExecutionStatus !== 0
  ) {
    throw new Error(
      `receiver reverteu: ${result.receiverContractExecutionStatus}` +
        (result.errorMessage ? ` · ${result.errorMessage}` : ""),
    );
  }

  return bytesToHex(result.txHash ?? new Uint8Array(32)) as Hex;
}

/* ============================================================
 * RUN
 * ============================================================
 */

function run(
  runtime: TeeRuntime<Config>,
): string {
  /*
   * 1) BLOCKCHAIN PRIMEIRO.
   */
  const initialBlockchainPendingId =
    getNextPending(runtime);

  if (
    lower(
      initialBlockchainPendingId,
    ) === lower(zeroHash)
  ) {
    return JSON.stringify({
      workflow:
        "LOT_CHAIN_PAIRWISE_MASS",
      discovery:
        "BLOCKCHAIN_FIRST",
      pendingAuthority:
        "BLOCKCHAIN_STATUS_REQUIRED",
      message:
        "nenhum PENDING on-chain",
    });
  }

  /*
   * 2) So depois da primeira leitura on-chain:
   * secrets + consulta PONTUAL do evidenceId no indice Supabase.
   *
   * Nao carregamos mais explorerchem_evidences inteiro.
   */
  const { key } =
    secrets(runtime);

  const selection =
    selectEffectivePending(
      runtime,
      key,
      initialBlockchainPendingId,
    );

  if (selection === null) {
    return JSON.stringify({
      workflow:
        "LOT_CHAIN_PAIRWISE_MASS",
      discovery:
        "BLOCKCHAIN_FIRST",
      pendingAuthority:
        "BLOCKCHAIN_STATUS_REQUIRED",
      initialBlockchainPendingId,
      message:
        "nenhum novo PENDING efetivo: o primeiro PENDING on-chain ja pode estar espelhado como MATCHED pela simulacao",
    });
  }

  const actors =
    loadActorDirectory(
      runtime,
      key,
    );

  const focus =
    loadVerifiedEvidence(
      runtime,
      key,
      selection.row,
      actors,
      selection.onchain,
    );

  /*
   * lotId e obrigatorio nesta versao porque e o token logico de correlacao.
   */
  if (
    focus.normalized
      .lotReference === null
  ) {
    return JSON.stringify({
      workflow:
        "LOT_CHAIN_PAIRWISE_MASS",
      discovery:
        "BLOCKCHAIN_FIRST",
      pendingAuthority:
        "BLOCKCHAIN_STATUS_REQUIRED",
      initialBlockchainPendingId,
      pendingSelectionMode:
        selection.mode,
      focusEvidenceId:
        focus.row.evidence_id,
      message:
        "lotId ausente no documento comprometido; continua PENDING",
    });
  }

  /*
   * O indice do foco e apenas um espelho de descoberta. Ele pode estar nulo ou
   * desatualizado sem invalidar o documento: o lotId usado abaixo veio do JSON
   * cujo hash ja foi confirmado contra o evidenceHash da blockchain.
   */
  const focusLotIndexStatus =
    focus.row.lot_reference === focus.normalized.lotReference
      ? "MATCHED"
      : focus.row.lot_reference === null
        ? "MISSING_IGNORED"
        : "MISMATCH_IGNORED";

  /*
   * Aqui esta a mudanca de escala: uma unica consulta indexada traz somente as
   * evidencias do lote do foco. Nenhuma evidencia de outros lotes e baixada.
   */
  const lotRows = loadEvidenceRowsByLot(
    runtime,
    key,
    focus.normalized.lotReference,
  );

  if (
    focus.normalized
      .originActorId === null &&
    focus.normalized
      .destinationActorId === null
  ) {
    return JSON.stringify({
      workflow:
        "LOT_CHAIN_PAIRWISE_MASS",
      discovery:
        "BLOCKCHAIN_FIRST",
      pendingAuthority:
        "BLOCKCHAIN_STATUS_REQUIRED",
      initialBlockchainPendingId,
      pendingSelectionMode:
        selection.mode,
      focusEvidenceId:
        focus.row.evidence_id,
      focusLotReference:
        focus.normalized.lotReference,
      message:
        "origem e destino ausentes no documento comprometido; continua PENDING",
    });
  }

  /*
   * Divergencia estrutural objetiva.
   *
   * Uma evidencia fisica nao pode declarar origem e destino iguais. Alem
   * disso, um ator intermediario nao pode declarar a si proprio como origem;
   * MINER e LABORATORY ficam fora dessa segunda verificacao.
   * Esses casos produzem um resultado DIVERGENTE sem par numerico e sao
   * finalizados como DIVERGENT on-chain.
   */
  const originEqualsDestination =
    focus.normalized.originActorId !== null &&
    focus.normalized.destinationActorId !== null &&
    lower(focus.normalized.originActorId) ===
      lower(focus.normalized.destinationActorId);

  const originEqualsOwner =
    focus.normalized.actorType !== "MINER" &&
    focus.normalized.actorType !== "LABORATORY" &&
    focus.normalized.originActorId !== null &&
    lower(focus.normalized.originActorId) ===
      lower(focus.onchain.actorId);

  const structuralDivergenceCode =
    originEqualsDestination
      ? "ORIGIN_EQUALS_DESTINATION"
      : originEqualsOwner
        ? "ORIGIN_EQUALS_OWNER"
        : null;

  /*
   * 3) Candidatos DO MESMO LOTE, vindos da consulta indexada.
   *
   * PENDING, MATCHED, VERIFIED e DIVERGENT podem ser consultados.
   * Um MATCH anterior continua participando da reconstituicao da cadeia.
   *
   * O Supabase so aponta os candidatos. Para cada linha retornada, o TEE ainda:
   *   - le o estado/evidenceHash on-chain;
   *   - baixa o JSON;
   *   - recomputa o hash;
   *   - confirma ownerActor;
   *   - confirma que o lotId real do JSON e o mesmo do foco.
   */
  const candidates:
    VerifiedEvidence[] = [];

  const candidateErrors:
    Array<{
      evidenceId: Hex;
      error: string;
    }> = [];

  for (
    const row of lotRows
  ) {
    if (
      lower(row.evidence_id) ===
      lower(
        focus.row.evidence_id,
      )
    ) {
      continue;
    }

    try {
      const candidateOnchain =
        readEvidence(
          runtime,
          row.evidence_id,
        );

      if (
        ![1, 2, 3, 4].includes(
          candidateOnchain.status,
        )
      ) {
        continue;
      }

      const verified =
        loadVerifiedEvidence(
          runtime,
          key,
          row,
          actors,
          candidateOnchain,
        );

      if (
        !sameLot(
          focus.normalized,
          verified.normalized,
        )
      ) {
        candidateErrors.push({
          evidenceId: row.evidence_id,
          error:
            "candidato retornado pelo indice nao pertence ao mesmo lotId no JSON comprometido",
        });
        continue;
      }

      candidates.push(
        verified,
      );
    } catch (error) {
      candidateErrors.push({
        evidenceId:
          row.evidence_id,
        error:
          error instanceof Error
            ? error.message
            : String(error),
      });
    }
  }

  /*
   * 4) BFS POR LOTE + ORIGEM/DESTINO ESTRITOS.
   *
   * PHYSICAL_HANDOFF:
   *   lotId(A)        == lotId(B)
   *   destination(A) == owner(B)
   *   origin(B)      == owner(A)
   *
   * Nao existe janela temporal.
   * A busca testa os dois sentidos.
   * A cada novo no encontrado, o JSON daquele no passa a orientar a proxima
   * conexao da BFS.
   */
  const component =
    buildCorrelatedComponent(
      focus,
      candidates,
    );

  if (
    component.edges.length === 0 &&
    structuralDivergenceCode === null
  ) {
    return JSON.stringify({
      workflow:
        "LOT_CHAIN_PAIRWISE_MASS",
      discovery:
        "BLOCKCHAIN_FIRST",
      pendingAuthority:
        "BLOCKCHAIN_STATUS_REQUIRED",
      initialBlockchainPendingId,
      pendingSelectionMode:
        selection.mode,
      correlation:
        "SAME_LOT_PLUS_STRICT_ORIGIN_DESTINATION_BIDIRECTIONAL_BFS",
      focusEvidenceId:
        focus.row.evidence_id,
      focusActorId:
        focus.onchain.actorId,
      focusLotReference:
        focus.normalized.lotReference,
      focusIndexedLotReference:
        focus.row.lot_reference,
      focusLotIndexStatus,
      focusOriginActorId:
        focus.normalized
          .originActorId,
      focusDestinationActorId:
        focus.normalized
          .destinationActorId,
      evidenceCount:
        component.evidences.length,
      evidenceIds:
        component.evidences.map(
          (item) =>
            item.row.evidence_id,
        ),
      candidateDiscovery:
        "SUPABASE_INDEX_BY_LOT_ONLY",
      indexedLotRowCount:
        lotRows.length,
      verifiedSameLotCandidateCount:
        candidates.length,
      candidateErrors,
      message:
        "nenhuma relacao fisica origem/destino encontrada dentro do mesmo lotId; continua PENDING",
    });
  }

  /*
   * 5) Massa por elo, nunca usada para descobrir a correlacao.
   */
  const mass: ComponentMassResult =
    structuralDivergenceCode !== null
      ? {
          schema:
            "ExploreChem/PairwiseMassResult/v1",
          calculationVersion: 1,
          focusActorId:
            focus.onchain.actorId,
          focusEvidenceId:
            focus.row.evidence_id,
          lotReference:
            focus.normalized.lotReference!,
          evidenceIds: [
            focus.row.evidence_id,
          ],
          correlationEdges: [],
          massPairs: [],
          status: "DIVERGENTE",
        }
      : calculateComponentMass(
          focus,
          component,
        );

  const committed =
    commitment(
      focus.onchain,
      mass,
    );

  const resultPath =
    privateResultPath(
      focus.onchain.evidenceId,
      committed.resultId,
    );

  const privateBase = {
    schema:
      "ExploreChem/PrivatePairwiseMass/v1",
    sourceEvidenceId:
      focus.onchain.evidenceId,
    sourceActorId:
      focus.onchain.actorId,
    sourceEvidenceHash:
      focus.onchain.evidenceHash,
    lotReference:
      mass.lotReference,
    evidenceIds:
      mass.evidenceIds,
    correlationEdges:
      mass.correlationEdges,
    massPairs:
      mass.massPairs,
    calculationVersion:
      mass.calculationVersion,

    /* Fingerprints e commitments deterministicos. */
    relationFingerprint:
      committed.relationFingerprint,
    canonicalResultHash:
      committed.canonicalResultHash,
    aggregateInputHash:
      committed.aggregateInputHash,
    resultHash:
      committed.resultHash,
    resultId:
      committed.resultId,
    status:
      mass.status,
  };

  /*
   * 6) Salva manifest privado antes das transacoes.
   */
  savePrivateResult(
    runtime,
    key,
    focus.row.storage_bucket,
    resultPath,
    {
      ...privateBase,
      onchain: {
        matchTxHash: null,
        resultTxHash: null,
      },
    },
  );

  /*
   * 7) Gate final: o NOVO foco selecionado precisa continuar PENDING on-chain.
   */
  const gate =
    readEvidence(
      runtime,
      focus.onchain.evidenceId,
    );

  if (gate.status !== 1) {
    return JSON.stringify({
      workflow:
        "LOT_CHAIN_PAIRWISE_MASS",
      discovery:
        "BLOCKCHAIN_FIRST",
      pendingAuthority:
        "BLOCKCHAIN_STATUS_REQUIRED",
      initialBlockchainPendingId,
      pendingSelectionMode:
        selection.mode,
      focusEvidenceId:
        focus.onchain.evidenceId,
      focusLotReference:
        mass.lotReference,
      message:
        "focus deixou de estar PENDING antes do MATCH; nenhuma transacao enviada",
    });
  }

  /*
   * 8) MATCH somente do NOVO PENDING foco.
   */
  const matchTxHash =
    write(
      runtime,
      matchReport(
        focus.onchain.evidenceId,
      ),
    );

  /*
   * 9) Resultado somente do mesmo foco.
   */
  const resultTxHash =
    write(
      runtime,
      balanceReport(
        focus.onchain,
        committed,
        mass.status,
      ),
    );

  /*
   * O reportType 3 finaliza apenas a autorrelacao invalida como DIVERGENT.
   * Resultados normais continuam MATCHED e seguem para o auditor separado.
   */
  const divergenceTxHash =
    structuralDivergenceCode !== null
      ? write(
          runtime,
          divergentEvidenceReport(
            focus.onchain.evidenceId,
          ),
        )
      : null;

  /*
   * 10) Espelha MATCH somente no foco.
   *
   * Isso tambem funciona como cursor de progresso durante SIMULATION:
   * na proxima execucao, se getNextPending() on-chain ainda devolver o mesmo
   * id por falta de persistencia do simulador, selectEffectivePending() ignora
   * a linha ja MATCHED no Supabase e escolhe outro row PENDING cujo status
   * on-chain tambem seja 1.
   */
  savePrivateResult(
    runtime,
    key,
    focus.row.storage_bucket,
    resultPath,
    {
      ...privateBase,
      onchain: {
        matchTxHash,
        resultTxHash,
        divergenceTxHash,
      },
    },
  );

  mirrorMatch(
    runtime,
    key,
    focus.onchain.evidenceId,
    matchTxHash,
  );

  if (structuralDivergenceCode !== null) {
    mirrorDivergent(
      runtime,
      key,
      focus.onchain.evidenceId,
    );
  }

  return JSON.stringify({
    workflow:
      "LOT_CHAIN_PAIRWISE_MASS",
    discovery:
      "BLOCKCHAIN_FIRST",
    pendingAuthority:
      "BLOCKCHAIN_STATUS_REQUIRED",
    simulationProgress:
      "SUPABASE_MATCHED_MIRROR_ONLY_WHEN_CHAIN_SIMULATION_DOES_NOT_ADVANCE",
    candidateDiscovery:
      "SUPABASE_INDEX_BY_LOT_ONLY",
    indexedLotRowCount:
      lotRows.length,
    initialBlockchainPendingId,
    pendingSelectionMode:
      selection.mode,
    correlation:
      "SAME_LOT_PLUS_STRICT_ORIGIN_DESTINATION_BIDIRECTIONAL_BFS",
    massPolicy:
      "FULL_CORRELATED_COMPONENT_PAIRWISE_EDGES_NO_GLOBAL_SUM",
    focusEvidenceId:
      focus.onchain.evidenceId,
    focusLotReference:
      mass.lotReference,
    focusIndexedLotReference:
      focus.row.lot_reference,
    focusLotIndexStatus,
    evidenceCount:
      mass.evidenceIds.length,
    evidenceIds:
      mass.evidenceIds,
    correlationEdgeCount:
      mass.correlationEdges.length,
    correlationEdges:
      mass.correlationEdges,
    massPairCount:
      mass.massPairs.length,
    massPairs:
      mass.massPairs,
    massStatus:
      mass.status,
    structuralDivergence:
      structuralDivergenceCode,
    candidateErrors,

    commitment: {
      relationFingerprint:
        committed.relationFingerprint,
      canonicalResultHash:
        committed.canonicalResultHash,
      resultId:
        committed.resultId,
      resultHash:
        committed.resultHash,
      aggregateInputHash:
        committed.aggregateInputHash,
    },

    privateResult: {
      bucket:
        focus.row.storage_bucket,
      path:
        resultPath,
    },
    onchain: {
      matchedEvidenceId:
        focus.onchain.evidenceId,
      matchTxHash,
      resultTxHash,
      divergenceTxHash,
    },
  });
}

/* ============================================================
 * Trigger / main
 * ============================================================
 */

function onCron(
  runtime: TeeRuntime<Config>,
  _payload: CronPayload,
): string {
  return run(runtime);
}

const initWorkflow = (config: Config) => {
  const cron = new CronCapability();

  return [
    handlerInTee(
      cron.trigger({
        schedule: config.correlationSchedule ?? DEFAULT_SCHEDULE,
      }),
      onCron,
      [
        {
          tee: "nitro",
          regions: ["us-west-2"],
        },
      ],
    ),
  ];
};

export async function main() {
  const runner = await Runner.newRunner<Config>({
    configSchema,
  });

  await runner.run(initWorkflow);
}
