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
 * ExploreChem — mass balance from a single hash-verified JSON.
 * Lot, origin and destination are descriptive metadata, never calculation gates.
 * Identical origin and destination are accepted. No predecessor is queried.
 * MUF compares input plus opening inventory with product, scrap, other outputs
 * and closing inventory. Documents without inventory/other-output fields keep
 * the original simplified input-minus-product-and-scrap calculation.
 * Carrier documents compare collected mass with delivered mass.
 * Missing operands remain unknown; the workflow still records NAO_ATESTADO.
 * Mass differences never produce a verdict. Only a mismatching document hash
 * stops processing; verified documents advance to MATCHED.
 * Elemental calculations are retained. JSON schema v2 identifies document
 * balances; initial on-chain calculationVersion is 1, as the receiver requires.
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

// The primary workflow records calculations without an audit verdict.
// Existing ABI/database value 3 means not yet attested by the auditor.
type Status = "NAO_ATESTADO";

type RelationType = "PHYSICAL_HANDOFF" | "LAB_ANALYSIS" | "DOCUMENT_MASS_BALANCE";

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
  byActorId: Map<string, ActorRow>;
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
  documentHashMatchesChain: boolean;
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
  lotReference: string | null;
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
  lotReference: string | null;
  leftMassMg: string | null;
  rightMassMg: string | null;
  leftMassField: string;
  rightMassField: string;
  deltaMg: string | null;
  status: Status;
};

type ElementalCalculation = {
  evidenceId: Hex;
  actorId: Hex;
  element: "Nd";
  compound: "Nd2O3" | null;
  calculationType: "COMPOUND_TO_ELEMENT" | "ELEMENTAL_PARTITION";
  sourceMassField: string | null;
  sourceMassMg: string | null;
  gradeField: string | null;
  gradePpm: string | null;
  declaredElementalMassField: string;
  declaredElementalMassMg: string;
  calculatedElementalMassMg: string;
  signedDifferenceMg: string;
  formula: string;
};

type ComponentMassResult = {
  schema: "ExploreChem/DocumentMassResult/v2";
  calculationVersion: 1;
  focusActorId: Hex;
  focusEvidenceId: Hex;
  lotReference: string | null;
  evidenceIds: Hex[];
  correlationEdges: Array<{
    fromEvidenceId: Hex;
    toEvidenceId: Hex;
    relationType: RelationType;
    lotReference: string | null;
  }>;
  massPairs: PairMassResult[];
  elementalCalculations: ElementalCalculation[];
  status: Status;
};

type PendingSelection = {
  initialBlockchainPendingId: Hex;
  row: EvidenceRow;
  onchain: OnchainEvidence;
  mode:
    | "CHAIN_GET_NEXT_PENDING"
    | "CHAIN_MATCHED_WITHOUT_RESULT_RECOVERY"
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
    name: "getNextMatched",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "latestResultIdByEvidence",
    stateMutability: "view",
    inputs: [{ name: "evidenceId", type: "bytes32" }],
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

function decimalToScaledInteger(
  value: unknown,
  scaleDigits: number,
): bigint | null {
  const rendered = decimalString(value);
  if (rendered === null) return null;

  const [wholePart, fractionalPart = ""] = rendered.split(".");
  const kept = fractionalPart.slice(0, scaleDigits).padEnd(scaleDigits, "0");
  let result = BigInt(wholePart) * 10n ** BigInt(scaleDigits) + BigInt(kept || "0");

  if (fractionalPart.length > scaleDigits && Number(fractionalPart[scaleDigits]) >= 5) {
    result += 1n;
  }

  return result;
}

function percentToPpm(value: unknown): bigint | null {
  const percentScaled = decimalToScaledInteger(value, 4);
  return percentScaled;
}

function roundedDivide(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator / 2n) / denominator;
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
    byActorId: new Map(
      rows.map((row) => [lower(row.actor_id), row]),
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
    `/rest/v1/explorerchem_evidences?evidence_id=eq.${encodeURIComponent(evidenceId)}`,
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

function mirrorBalanceResult(
  runtime: TeeRuntime<Config>,
  key: string,
  focus: VerifiedEvidence,
  committed: ReturnType<typeof commitment>,
  privateResult: Record<string, unknown>,
  resultTxHash: Hex,
) {
  request(
    runtime,
    key,
    "/rest/v1/explorerchem_balance_results?on_conflict=result_id",
    "POST",
    {
      result_id: committed.resultId,
      actor_db_id: focus.row.actor_db_id,
      result_hash: committed.resultHash,
      status: privateResult.status as Status,
      calculation_version: privateResult.calculationVersion,
      summary: privateResult,
      anchor_tx_hash: resultTxHash,
      anchored_at: new Date(runtime.now()).toISOString(),
    },
    {
      prefer: {
        // A tabela possui trigger append-only. Se este result_id ja foi
        // espelhado por uma execucao anterior, nao tente atualiza-lo.
        values: ["resolution=ignore-duplicates,return=minimal"],
      },
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
    `/rest/v1/explorerchem_evidences?evidence_id=eq.${encodeURIComponent(evidenceId)}&state=in.(PENDING,MATCHED)`,
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

function getNextMatched(runtime: TeeRuntime<Config>): Hex {
  const callData = encodeFunctionData({
    abi: ABI,
    functionName: "getNextMatched",
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
    functionName: "getNextMatched",
    data: bytesToHex(response.data),
  }) as Hex;
}

function latestResultIdForEvidence(
  runtime: TeeRuntime<Config>,
  evidenceId: Hex,
): Hex {
  const callData = encodeFunctionData({
    abi: ABI,
    functionName: "latestResultIdByEvidence",
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

  return decodeFunctionResult({
    abi: ABI,
    functionName: "latestResultIdByEvidence",
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

/** Select strictly by blockchain status; never filter by the Supabase mirror. */
function selectEffectiveEvidence(
  runtime: TeeRuntime<Config>,
  key: string,
  initialBlockchainPendingId: Hex,
  evidenceId: Hex,
  expectedStatus: 1 | 2,
  mode: PendingSelection["mode"],
): PendingSelection | null {
  const onchain = readEvidence(runtime, evidenceId);
  if (onchain.status !== expectedStatus) return null;
  // Supabase resolves the file location only. Its state never vetoes blockchain state.
  const row = loadOneEvidenceRow(runtime, key, evidenceId);
  return { initialBlockchainPendingId, row, onchain, mode };
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
   * Lot and origin/destination metadata do not gate the calculation.
   */

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

class DocumentHashMismatch extends Error {
  constructor(
    readonly evidenceId: Hex,
    readonly expectedHash: Hex,
    readonly actualHash: Hex,
  ) {
    super(`${evidenceId}: hash do JSON diverge da blockchain`);
    this.name = "DocumentHashMismatch";
  }
}

function loadVerifiedEvidence(
  runtime: TeeRuntime<Config>,
  key: string,
  row: EvidenceRow,
  actors: ActorDirectory,
  onchain?: OnchainEvidence,
): VerifiedEvidence {
  const chainEvidence = onchain ?? readEvidence(runtime, row.evidence_id);

  const bytes = downloadEvidenceDocument(runtime, key, row);
  const recomputedHash = recomputeEvidenceHash(row, bytes);

  const integrity: IntegrityCheck = {
    documentHashMatchesChain:
      lower(recomputedHash) === lower(chainEvidence.evidenceHash),
  };

  if (!integrity.documentHashMatchesChain) {
    throw new DocumentHashMismatch(row.evidence_id, chainEvidence.evidenceHash, recomputedHash);
  }

  const document = parseJsonDocument(row, bytes);
  const normalized = normalizeEvidence(document, row, actors);

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

function calculatePairMass(
  edge: CorrelationEdge,
): PairMassResult | null {
  if (
    edge.relationType ===
    "LAB_ANALYSIS"
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

  const status: Status = "NAO_ATESTADO";

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

const ND_IN_ND2O3_NUMERATOR = 288_484n;
const ND2O3_MOLAR_MASS_DENOMINATOR = 336_481n;
const PPM_DENOMINATOR = 1_000_000n;

function compoundToNdCalculation(
  evidence: VerifiedEvidence,
  sectionName: string,
  section: Record<string, unknown>,
  massKey: string,
  gradeKey: string,
  declaredKey: string,
  compoundValue: unknown,
): ElementalCalculation | null {
  const sourceMassMg = kgToMg(decimalString(section[massKey]));
  const gradePpm = percentToPpm(section[gradeKey]);
  const declaredMassMg = decimalToScaledInteger(section[declaredKey], 0);
  const compound = nullableString(compoundValue)?.toUpperCase();

  if (
    sourceMassMg === null ||
    gradePpm === null ||
    declaredMassMg === null ||
    compound !== "ND2O3"
  ) {
    return null;
  }

  const calculatedMassMg = roundedDivide(
    sourceMassMg * gradePpm * ND_IN_ND2O3_NUMERATOR,
    PPM_DENOMINATOR * ND2O3_MOLAR_MASS_DENOMINATOR,
  );

  return {
    evidenceId: evidence.row.evidence_id,
    actorId: evidence.onchain.actorId,
    element: "Nd",
    compound: "Nd2O3",
    calculationType: "COMPOUND_TO_ELEMENT",
    sourceMassField: `${sectionName}.${massKey}`,
    sourceMassMg: sourceMassMg.toString(),
    gradeField: `${sectionName}.${gradeKey}`,
    gradePpm: gradePpm.toString(),
    declaredElementalMassField: `${sectionName}.${declaredKey}`,
    declaredElementalMassMg: declaredMassMg.toString(),
    calculatedElementalMassMg: calculatedMassMg.toString(),
    signedDifferenceMg: (declaredMassMg - calculatedMassMg).toString(),
    formula: "massMg * gradePpm / 1000000 * (2*Nd)/(2*Nd+3*O)",
  };
}

function calculateElementalEvidence(
  evidence: VerifiedEvidence,
): ElementalCalculation[] {
  const document = evidence.document;
  const material = recordOf(document.material);
  const massBalance = recordOf(document.massBalance);
  const transformation = recordOf(document.transformation);
  const recovery = recordOf(document.recovery);
  const calculations: ElementalCalculation[] = [];

  const miner = compoundToNdCalculation(
    evidence,
    "massBalance",
    massBalance,
    "dryMassKg",
    "gradeNd2O3Pct",
    "elementalNdMassMg",
    material.compound,
  );
  if (miner !== null) calculations.push(miner);

  const refinerOutput = compoundToNdCalculation(
    evidence,
    "transformation",
    transformation,
    "outputProductMassKg",
    "outputProductGradePct",
    "elementalNdOutputMassMg",
    transformation.outputProductCompound,
  );
  if (refinerOutput !== null) calculations.push(refinerOutput);

  const recycler = compoundToNdCalculation(
    evidence,
    "recovery",
    recovery,
    "recoveredProductMassKg",
    "recoveredProductGradePct",
    "elementalNdRecoveredMassMg",
    recovery.recoveredCompound,
  );
  if (recycler !== null) calculations.push(recycler);

  const input = decimalToScaledInteger(
    transformation.inputElementalNdMassMg,
    0,
  );
  const finished = decimalToScaledInteger(
    transformation.elementalNdFinishedProductMassMg,
    0,
  );
  const scrap = decimalToScaledInteger(
    transformation.elementalNdScrapMassMg,
    0,
  );

  if (input !== null && finished !== null && scrap !== null) {
    const calculated = finished + scrap;
    calculations.push({
      evidenceId: evidence.row.evidence_id,
      actorId: evidence.onchain.actorId,
      element: "Nd",
      compound: nullableString(transformation.inputCompound)?.toUpperCase() === "ND2O3"
        ? "Nd2O3"
        : null,
      calculationType: "ELEMENTAL_PARTITION",
      sourceMassField: null,
      sourceMassMg: null,
      gradeField: null,
      gradePpm: null,
      declaredElementalMassField: "transformation.inputElementalNdMassMg",
      declaredElementalMassMg: input.toString(),
      calculatedElementalMassMg: calculated.toString(),
      signedDifferenceMg: (input - calculated).toString(),
      formula: "elementalNdFinishedProductMassMg + elementalNdScrapMassMg",
    });
  }

  return calculations;
}

function calculateElementalComponent(
  component: CorrelationComponent,
): ElementalCalculation[] {
  return component.evidences.flatMap(calculateElementalEvidence);
}

/** Resolve aliases once: aliases are alternatives, never additional streams. */
function documentMassEndpoint(
  document: Record<string, unknown>,
  paths: string[],
): MassEndpoint {
  for (const path of paths) {
    const value = path.split(".").reduce<unknown>(
      (parent, key) => recordOf(parent)[key], document,
    );
    if (value !== undefined && value !== null) {
      return { massMg: kgToMg(decimalString(value)), field: path };
    }
  }
  return { massMg: null, field: paths.join(" | ") };
}

function documentHasAnyPath(
  document: Record<string, unknown>,
  paths: string[],
): boolean {
  return paths.some(path => {
    const value = path.split(".").reduce<unknown>(
      (parent, key) => recordOf(parent)[key], document,
    );
    return value !== undefined && value !== null;
  });
}

/**
 * Adds optional MUF streams without treating an absent stream as an error.
 * If a stream was supplied but is not a valid mass, the result stays unknown.
 */
function sumMassEndpoints(
  required: MassEndpoint,
  optional: Array<{ present: boolean; endpoint: MassEndpoint }>,
): MassEndpoint {
  const included = optional.filter(term => term.present);
  const field = [required.field, ...included.map(term => term.endpoint.field)]
    .join(" + ");

  if (
    required.massMg === null ||
    included.some(term => term.endpoint.massMg === null)
  ) {
    return { massMg: null, field };
  }

  return {
    massMg: included.reduce(
      (total, term) => total + term.endpoint.massMg!,
      required.massMg,
    ),
    field,
  };
}

function calculateDocumentMass(focus: VerifiedEvidence): ComponentMassResult {
  const document = focus.document;
  const carrier = focus.normalized.actorType === "CARRIER";
  const laboratory = focus.normalized.actorType === "LABORATORY";
  const input = documentMassEndpoint(document, carrier
    ? ["custody.massCollectedKg", "collectedMassKg", "inputMassKg"]
    : ["transformation.inputMassKg", "transformation.inputProductMassKg",
       "recovery.inputMassKg", "inputMassKg", "massBalance.inputMassKg"]);
  const product = documentMassEndpoint(document, carrier
    ? ["custody.massDeliveredKg", "deliveredMassKg", "outputMassKg"]
    : ["transformation.outputMassKg", "transformation.outputProductMassKg",
       "transformation.finishedProductMassKg", "recovery.recoveredProductMassKg",
       "outputMassKg", "recoveredMassKg", "massBalance.outputMassKg"]);
  const scrapPaths = [
    "transformation.scrapMassKg",
    "massBalance.scrapMassKg",
    "scrapMassKg",
  ];
  const scrap = documentMassEndpoint(document, scrapPaths);
  const openingInventoryPaths = [
    "massBalance.openingInventoryMassKg",
    "transformation.openingInventoryMassKg",
    "openingInventoryMassKg",
  ];
  const closingInventoryPaths = [
    "massBalance.closingInventoryMassKg",
    "transformation.closingInventoryMassKg",
    "closingInventoryMassKg",
  ];
  const otherOutputPaths = [
    "massBalance.otherOutputMassKg",
    "massBalance.otherOutputsMassKg",
    "transformation.otherOutputMassKg",
    "transformation.otherOutputsMassKg",
    "otherOutputMassKg",
    "otherOutputsMassKg",
  ];
  const openingInventory = documentMassEndpoint(document, openingInventoryPaths);
  const closingInventory = documentMassEndpoint(document, closingInventoryPaths);
  const otherOutput = documentMassEndpoint(document, otherOutputPaths);

  // MUF = (input + opening inventory)
  //     - (product + scrap + other outputs + closing inventory).
  // Carrier custody remains collected minus delivered.
  const left = carrier ? input : sumMassEndpoints(input, [
    {
      present: documentHasAnyPath(document, openingInventoryPaths),
      endpoint: openingInventory,
    },
  ]);
  const output = carrier ? product : sumMassEndpoints(product, [
    {
      present: documentHasAnyPath(document, scrapPaths),
      endpoint: scrap,
    },
    {
      present: documentHasAnyPath(document, otherOutputPaths),
      endpoint: otherOutput,
    },
    {
      present: documentHasAnyPath(document, closingInventoryPaths),
      endpoint: closingInventory,
    },
  ]);
  const massPairs: PairMassResult[] = [];
  if (!laboratory) {
    const pair = calculatePairMass({
      from: focus, to: focus, relationType: "DOCUMENT_MASS_BALANCE",
      lotReference: focus.normalized.lotReference,
      left, right: output,
    });
    if (pair !== null) massPairs.push(pair);
  }
  const elementalCalculations = calculateElementalEvidence(focus);
  const status: Status = "NAO_ATESTADO";
  return {
    schema: "ExploreChem/DocumentMassResult/v2",
    calculationVersion: 1,
    focusActorId: focus.onchain.actorId,
    focusEvidenceId: focus.onchain.evidenceId,
    lotReference: focus.normalized.lotReference,
    evidenceIds: [focus.onchain.evidenceId],
    correlationEdges: [],
    massPairs,
    elementalCalculations,
    status,
  };
}

/* ============================================================
 * Deterministic commitments. JSON schema v2; initial on-chain revision 1.
 * ============================================================
 */

function commitment(
  focus: OnchainEvidence,
  result: ComponentMassResult,
) {
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
          "ExploreChem/DocumentMassInput/v2",
        sourceEvidenceHash: focus.evidenceHash,
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
    canonicalResultHash:
      resultHash,
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
): Hex {
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
      3,
      1,
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

  if (!result.txHash || result.txHash.length !== 32) {
    throw new Error("writeReport nao retornou hash de transacao valido; banco nao atualizado");
  }

  /*
   * writeReport already waits for the final TxStatus and exposes the receiver
   * execution status. Calling getTransactionReceipt immediately afterwards is
   * invalid in the CRE simulator because the RPC index can still return
   * gRPC NOT_FOUND even though writeReport has completed successfully.
   */
  return bytesToHex(result.txHash) as Hex;
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

  let focusEvidenceId = initialBlockchainPendingId;
  let expectedStatus: 1 | 2 = 1;
  let selectionMode: PendingSelection["mode"] = "CHAIN_GET_NEXT_PENDING";

  /*
   * Recovery for a previous execution whose MATCH succeeded but whose balance
   * report was rejected. It never trusts the Supabase mirror: MATCHED and the
   * absence of a result are both read from the new registry.
   */
  if (lower(initialBlockchainPendingId) === lower(zeroHash)) {
    const matchedEvidenceId = getNextMatched(runtime);
    if (lower(matchedEvidenceId) === lower(zeroHash)) {
      return JSON.stringify({
        workflow: "DOCUMENT_MASS_BALANCE",
        discovery: "BLOCKCHAIN_FIRST",
        pendingAuthority: "BLOCKCHAIN_STATUS_REQUIRED",
        message: "nenhum PENDING on-chain e nenhum MATCHED recuperavel",
      });
    }

    const existingResultId = latestResultIdForEvidence(runtime, matchedEvidenceId);
    if (lower(existingResultId) !== lower(zeroHash)) {
      return JSON.stringify({
        workflow: "DOCUMENT_MASS_BALANCE",
        discovery: "BLOCKCHAIN_FIRST",
        pendingAuthority: "BLOCKCHAIN_STATUS_REQUIRED",
        matchedEvidenceId,
        existingResultId,
        message: "nenhum PENDING on-chain; o primeiro MATCHED ja possui resultado",
      });
    }

    focusEvidenceId = matchedEvidenceId;
    expectedStatus = 2;
    selectionMode = "CHAIN_MATCHED_WITHOUT_RESULT_RECOVERY";
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
    selectEffectiveEvidence(
      runtime,
      key,
      initialBlockchainPendingId,
      focusEvidenceId,
      expectedStatus,
      selectionMode,
    );

  if (selection === null) {
    return JSON.stringify({
      workflow:
        "DOCUMENT_MASS_BALANCE",
      discovery:
        "BLOCKCHAIN_FIRST",
      pendingAuthority:
        "BLOCKCHAIN_STATUS_REQUIRED",
      initialBlockchainPendingId,
      message:
        "a evidencia mudou de estado on-chain antes da selecao",
    });
  }

  const actors =
    loadActorDirectory(
      runtime,
      key,
    );

  // A mismatching hash throws before MATCH or any balance report.
  // The independent auditor owns the VERIFIED/DIVERGENT evidence verdict.
  const focus = loadVerifiedEvidence(
    runtime, key, selection.row, actors, selection.onchain,
  );

  const mass = calculateDocumentMass(focus);

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
      "ExploreChem/PrivateDocumentMass/v2",
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
    elementalCalculations:
      mass.elementalCalculations,
    calculationVersion:
      mass.calculationVersion,
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
      privateResult: {
        bucket: focus.row.storage_bucket,
        path: resultPath,
      },
      onchain: {
        matchedEvidenceId: focus.onchain.evidenceId,
        matchTxHash: null,
        resultTxHash: null,
        divergenceTxHash: null,
      },
    },
  );

  /* 7) Final blockchain-state gate. */
  const gate =
    readEvidence(
      runtime,
      focus.onchain.evidenceId,
    );

  if (gate.status !== expectedStatus) {
    return JSON.stringify({
      workflow:
        "DOCUMENT_MASS_BALANCE",
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
        "focus mudou de estado antes da escrita; nenhuma transacao enviada",
    });
  }

  /*
   * 8) MATCH only for a new PENDING. A recovery run starts from MATCHED.
   */
  let matchTxHash: Hex | null = null;
  if (gate.status === 1) {
    matchTxHash = write(runtime, matchReport(focus.onchain.evidenceId));
    const afterMatch = readEvidence(runtime, focus.onchain.evidenceId);
    if (afterMatch.status !== 2) {
      throw new Error(
        `${focus.onchain.evidenceId}: MATCH nao confirmado on-chain apos ${matchTxHash}`,
      );
    }
  }

  /*
   * 9) The balance belongs to this exact evidence in the deployed registry.
   */
  const resultBeforeWrite = latestResultIdForEvidence(
    runtime,
    focus.onchain.evidenceId,
  );
  if (lower(resultBeforeWrite) !== lower(zeroHash)) {
    throw new Error(
      `${focus.onchain.evidenceId}: ja possui resultado ${resultBeforeWrite}`,
    );
  }

  const resultTxHash =
    write(
      runtime,
      balanceReport(
        focus.onchain,
        committed,
      ),
    );

  const anchoredResultId = latestResultIdForEvidence(
    runtime,
    focus.onchain.evidenceId,
  );
  if (lower(anchoredResultId) !== lower(committed.resultId)) {
    throw new Error(
      `${focus.onchain.evidenceId}: resultado nao confirmado on-chain apos ${resultTxHash}; esperado=${committed.resultId}; encontrado=${anchoredResultId}`,
    );
  }

  const divergenceTxHash = null;

  // Mirror only after blockchain postconditions confirm both state transitions.
  const finalPrivateResult = {
    ...privateBase,
    privateResult: {
      bucket: focus.row.storage_bucket,
      path: resultPath,
    },
    onchain: {
      matchedEvidenceId: focus.onchain.evidenceId,
      matchTxHash,
      resultTxHash,
      divergenceTxHash,
    },
  };

  mirrorBalanceResult(
    runtime,
    key,
    focus,
    committed,
    finalPrivateResult,
    resultTxHash,
  );

  if (matchTxHash !== null) {
    mirrorMatch(
      runtime,
      key,
      focus.onchain.evidenceId,
      matchTxHash,
    );
  }

  return JSON.stringify({
    workflow:
      "DOCUMENT_MASS_BALANCE",
    discovery:
      "BLOCKCHAIN_FIRST",
    pendingAuthority:
      "BLOCKCHAIN_STATUS_REQUIRED",
    simulationProgress:
      "DISABLED_BLOCKCHAIN_IS_AUTHORITY",
    candidateDiscovery:
      "NONE_SINGLE_VERIFIED_JSON",
    indexedPreviousEvidenceCount:
      0,
    initialBlockchainPendingId,
    pendingSelectionMode:
      selection.mode,
    correlation:
      "HASH_VERIFIED_JSON",
    massPolicy:
      "MUF_INPUT_PLUS_OPENING_INVENTORY_MINUS_PRODUCT_SCRAP_OTHER_OUTPUTS_AND_CLOSING_INVENTORY",
    focusEvidenceId:
      focus.onchain.evidenceId,
    focusLotReference:
      mass.lotReference,
    focusIndexedLotReference:
      focus.row.lot_reference,

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
    elementalCalculationCount:
      mass.elementalCalculations.length,
    elementalCalculations:
      mass.elementalCalculations,
    evidenceStatus: "MATCHED",
    auditStatus: "AWAITING_AUDITOR",
    massStatus:
      mass.status,
    structuralDivergence:
      null,


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
