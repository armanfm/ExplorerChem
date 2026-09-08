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
 * ExploreChem — MASS bilateral / blockchain-first
 *
 * REGRA DESTA VERSAO
 * ------------------------------------------------------------
 * 1. Blockchain escolhe UM PENDING com getNextPending().
 * 2. Somente depois o TEE consulta Supabase/Storage.
 * 3. O TEE baixa o documento original e confere o evidenceHash.
 * 4. originActor / destinationActor / lotId sao extraidos do JSON
 *    comprometido; os campos auxiliares do banco NAO sao prova.
 * 5. A correlacao e procurada nos dois sentidos:
 *      focus -> other
 *      other -> focus
 * 6. Para transferencia fisica, a relacao exige:
 *      mesmo lotId
 *      from.destinationActorId == to.ownerActorId
 *      to.originActorId == from.ownerActorId
 * 7. Massa NAO decide correlacao.
 *    Primeiro correlaciona; depois compara a massa das duas partes.
 * 8. Cada execucao ancora apenas o resultado local do PENDING escolhido.
 *    Nao existe soma global, grafo global, CUSUM ou Pedersen aqui.
 * 9. A contraparte nao recebe MATCH antecipado. Ela continua com seu
 *    proprio estado ate ser escolhida pela blockchain em outra execucao.
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

type FocusDirection = "FORWARD" | "BACKWARD";

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

type PairCandidate = {
  from: VerifiedEvidence;
  to: VerifiedEvidence;
  relationType: RelationType;
  focusDirection: FocusDirection;
  lotReference: string;
  left: MassEndpoint;
  right: MassEndpoint;
};

type BilateralMassResult = {
  schema: "ExploreChem/BilateralMassResult/v1";
  pairId: Hex;
  focusEvidenceId: Hex;
  counterpartEvidenceId: Hex;
  focusDirection: FocusDirection;
  relationType: RelationType;
  lotReference: string;
  fromEvidenceId: Hex;
  toEvidenceId: Hex;
  fromActorId: Hex;
  toActorId: Hex;
  leftMassMg: string | null;
  rightMassMg: string | null;
  leftMassField: string;
  rightMassField: string;
  deltaMg: string | null;
  status: Status;
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
      {
        id: "COMMITMENT_MASTER_KEY",
        namespace: runtime.config.secretNamespace,
      },
    ])
    .result();

  const key = result.SUPABASE_SERVICE_ROLE_KEY?.value;
  const master = result.COMMITMENT_MASTER_KEY?.value;

  if (!key) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY ausente");
  }

  if (!master || master.length < 32) {
    throw new Error("COMMITMENT_MASTER_KEY invalida");
  }

  return { key, master };
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

function loadAllEvidenceRows(
  runtime: TeeRuntime<Config>,
  key: string,
): EvidenceRow[] {
  const path =
    `/rest/v1/explorerchem_evidences?select=${EVIDENCE_SELECT}` +
    `&order=chain_created_at.asc,evidence_id.asc`;

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
   * Depois de recadastro/redeploy ele pode ser um identificador antigo, embora
   * o documento original e seu evidenceHash continuem validos.
   *
   * A identidade autoritativa do dono vem de:
   *   row.actor_db_id -> explorerchem_actors.actor_id -> blockchain actorId.
   * Essa cadeia continua sendo verificada em loadVerifiedEvidence().
   *
   * Para correlacao usamos do documento comprometido apenas os campos de
   * relacao (originActor/destinationActor/lotId etc.), nunca document.actorId
   * como autoridade de propriedade.
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
    lotReference:
      nullableString(document.lotId) ?? nullableString(document.lotReference),
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

  if (!integrity.rowHashMatchesChain) {
    throw new Error(`${row.evidence_id}: evidence_hash do banco diverge da blockchain`);
  }

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
 * Correlacao BILATERAL
 * ============================================================
 */

function sameRequiredLot(
  left: NormalizedEvidence,
  right: NormalizedEvidence,
): boolean {
  if (left.lotReference === null || right.lotReference === null) {
    return false;
  }

  return canonicalName(left.lotReference) === canonicalName(right.lotReference);
}

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
      field: n.outputMassKg !== null ? "outputMassKg" : "grossMassKg",
    };
  }

  if (n.actorType === "CARRIER") {
    return {
      massMg: kgToMg(n.deliveredMassKg ?? n.outputMassKg),
      field:
        n.deliveredMassKg !== null ? "custody.massDeliveredKg" : "outputMassKg",
    };
  }

  if (n.actorType === "PROCESSOR" || n.actorType === "REFINER") {
    return {
      massMg: kgToMg(n.outputMassKg),
      field: "transformation.outputMassKg",
    };
  }

  if (n.actorType === "MANUFACTURER") {
    if (to.normalized.actorType === "RECYCLER" && n.scrapMassKg !== null) {
      return {
        massMg: kgToMg(n.scrapMassKg),
        field: "transformation.scrapMassKg",
      };
    }

    return {
      massMg: kgToMg(n.outputMassKg ?? n.scrapMassKg),
      field: n.outputMassKg !== null ? "outputMassKg" : "transformation.scrapMassKg",
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
      massMg: kgToMg(n.collectedMassKg ?? n.inputMassKg ?? n.grossMassKg),
      field:
        n.collectedMassKg !== null
          ? "custody.massCollectedKg"
          : n.inputMassKg !== null
            ? "inputMassKg"
            : "grossMassKg",
    };
  }

  if (
    n.actorType === "PROCESSOR" ||
    n.actorType === "REFINER" ||
    n.actorType === "MANUFACTURER" ||
    n.actorType === "RECYCLER"
  ) {
    return {
      massMg: kgToMg(n.inputMassKg ?? n.grossMassKg ?? n.collectedMassKg),
      field:
        n.inputMassKg !== null
          ? "transformation.inputMassKg"
          : n.grossMassKg !== null
            ? "grossMassKg"
            : "custody.massCollectedKg",
    };
  }

  return {
    massMg: kgToMg(n.inputMassKg ?? n.collectedMassKg ?? n.grossMassKg),
    field: "bestAvailableIncomingMass",
  };
}

function sitesCompatible(left: string | null, right: string | null): boolean {
  if (left === null || right === null) {
    return true;
  }

  return canonicalName(left) === canonicalName(right);
}

function physicalPair(
  from: VerifiedEvidence,
  to: VerifiedEvidence,
  focusDirection: FocusDirection,
  lotReference: string,
): PairCandidate {
  return {
    from,
    to,
    relationType: "PHYSICAL_HANDOFF",
    focusDirection,
    lotReference,
    left: outgoingMass(from, to),
    right: incomingMass(to),
  };
}

function directedRelation(
  from: VerifiedEvidence,
  to: VerifiedEvidence,
  focusDirection: FocusDirection,
): PairCandidate | null {
  if (lower(from.row.evidence_id) === lower(to.row.evidence_id)) {
    return null;
  }

  const a = from.normalized;
  const b = to.normalized;

  if (!sameRequiredLot(a, b)) {
    return null;
  }

  const lotReference = a.lotReference!;

  /*
   * LABORATORIO -> ESTADO DE MATERIAL DO DESTINO
   *
   * O laboratorio apenas qualifica o material. Nao cria corrente fisica.
   */
  if (
    a.actorType === "LABORATORY" &&
    b.actorType !== "LABORATORY" &&
    b.actorType !== "CARRIER"
  ) {
    if (
      !idEquals(a.destinationActorId, to.onchain.actorId) ||
      !sitesCompatible(a.destinationSite, b.originSite)
    ) {
      return null;
    }

    return {
      from,
      to,
      relationType: "LAB_ANALYSIS",
      focusDirection,
      lotReference,
      left: { massMg: null, field: "NO_PHYSICAL_MASS" },
      right: { massMg: null, field: "NO_PHYSICAL_MASS" },
    };
  }

  /*
   * MINERADOR -> TRANSPORTADORA
   *
   * O documento da transportadora cobre a coleta no minerador e a entrega
   * no proximo no. Por isso a ORIGEM da evidencia da transportadora aponta
   * para o minerador, enquanto a propria evidencia pertence ao CARRIER.
   */
  if (a.actorType === "MINER" && b.actorType === "CARRIER") {
    const originMatches = idEquals(b.originActorId, from.onchain.actorId);
    const carrierMatches =
      idEquals(a.destinationActorId, to.onchain.actorId) ||
      idEquals(b.carrierActorId, to.onchain.actorId);

    if (!originMatches || !carrierMatches) {
      return null;
    }

    return physicalPair(from, to, focusDirection, lotReference);
  }

  /*
   * TRANSPORTADORA -> PROCESSADOR/PURIFICADOR
   *
   * Aqui o elo e o DESTINO declarado pela transportadora contra o ator dono
   * da evidencia receptora. O documento do purificador pode declarar a
   * propria planta como originActor; por isso nao exigimos b.origin == carrier.
   */
  if (
    a.actorType === "CARRIER" &&
    (b.actorType === "PROCESSOR" || b.actorType === "REFINER")
  ) {
    if (
      !idEquals(a.destinationActorId, to.onchain.actorId) ||
      !sitesCompatible(a.destinationSite, b.originSite)
    ) {
      return null;
    }

    return physicalPair(from, to, focusDirection, lotReference);
  }

  /* PROCESSADOR/PURIFICADOR -> FABRICANTE */
  if (
    (a.actorType === "PROCESSOR" || a.actorType === "REFINER") &&
    b.actorType === "MANUFACTURER"
  ) {
    if (
      !idEquals(a.destinationActorId, to.onchain.actorId) ||
      !sitesCompatible(a.destinationSite, b.originSite)
    ) {
      return null;
    }

    return physicalPair(from, to, focusDirection, lotReference);
  }

  /* FABRICANTE -> RECICLADOR */
  if (a.actorType === "MANUFACTURER" && b.actorType === "RECYCLER") {
    if (
      !idEquals(a.destinationActorId, to.onchain.actorId) ||
      !sitesCompatible(a.destinationSite, b.originSite)
    ) {
      return null;
    }

    return physicalPair(from, to, focusDirection, lotReference);
  }

  /* RECICLADOR -> NOVO RECEPTOR */
  if (
    a.actorType === "RECYCLER" &&
    (b.actorType === "MANUFACTURER" ||
      b.actorType === "PROCESSOR" ||
      b.actorType === "REFINER")
  ) {
    if (
      !idEquals(a.destinationActorId, to.onchain.actorId) ||
      !sitesCompatible(a.destinationSite, b.originSite)
    ) {
      return null;
    }

    return physicalPair(from, to, focusDirection, lotReference);
  }

  /*
   * FALLBACK CONTROLADO
   *
   * Para tipos OTHER ou uma evolucao de papel ainda nao especializada:
   * mesmo lote + destino de A igual ao ator dono de B + origem de B
   * consistente com A ou com o proprio B.
   *
   * A massa continua fora da prova de correlacao.
   */
  if (a.actorType === "OTHER" || b.actorType === "OTHER") {
    const destinationMatches = idEquals(a.destinationActorId, to.onchain.actorId);
    const originConsistent =
      b.originActorId === null ||
      idEquals(b.originActorId, from.onchain.actorId) ||
      idEquals(b.originActorId, to.onchain.actorId);

    if (destinationMatches && originConsistent) {
      return physicalPair(from, to, focusDirection, lotReference);
    }
  }

  return null;
}

function candidateKey(candidate: PairCandidate): string {
  return [
    lower(candidate.from.row.evidence_id),
    lower(candidate.to.row.evidence_id),
    candidate.relationType,
  ].join("|");
}

function findPairsForFocus(
  focus: VerifiedEvidence,
  others: VerifiedEvidence[],
): PairCandidate[] {
  const result = new Map<string, PairCandidate>();

  for (const other of others) {
    if (lower(other.row.evidence_id) === lower(focus.row.evidence_id)) {
      continue;
    }

    const forward = directedRelation(focus, other, "FORWARD");
    if (forward) {
      result.set(candidateKey(forward), forward);
    }

    const backward = directedRelation(other, focus, "BACKWARD");
    if (backward) {
      result.set(candidateKey(backward), backward);
    }
  }

  return [...result.values()].sort((a, b) =>
    candidateKey(a).localeCompare(candidateKey(b)),
  );
}

/**
 * O foco pode ter um elo anterior e um posterior.
 * Para manter "1 PENDING -> 1 contraparte -> 1 resultado":
 *   1) prefere o elo fisico PARA FRENTE;
 *   2) se nao houver, usa o elo fisico PARA TRAS;
 *   3) depois laboratorio para frente/tras.
 *
 * Se houver mais de uma opcao no mesmo nivel, nao escolhe silenciosamente:
 * retorna ambiguidade e mantem o PENDING.
 */
function selectPair(pairs: PairCandidate[]): PairCandidate | null {
  const groups: PairCandidate[][] = [
    pairs.filter(
      (pair) =>
        pair.relationType === "PHYSICAL_HANDOFF" &&
        pair.focusDirection === "FORWARD",
    ),
    pairs.filter(
      (pair) =>
        pair.relationType === "PHYSICAL_HANDOFF" &&
        pair.focusDirection === "BACKWARD",
    ),
    pairs.filter(
      (pair) =>
        pair.relationType === "LAB_ANALYSIS" &&
        pair.focusDirection === "FORWARD",
    ),
    pairs.filter(
      (pair) =>
        pair.relationType === "LAB_ANALYSIS" &&
        pair.focusDirection === "BACKWARD",
    ),
  ];

  for (const group of groups) {
    if (group.length > 1) {
      throw new Error(
        `correlacao ambigua: ${group.length} contrapartes validas no mesmo nivel`,
      );
    }

    if (group.length === 1) {
      return group[0];
    }
  }

  return null;
}

/* ============================================================
 * Massa bilateral
 * ============================================================
 */

function calculateBilateralMass(
  focus: VerifiedEvidence,
  pair: PairCandidate,
): BilateralMassResult {
  const left = pair.left.massMg;
  const right = pair.right.massMg;
  const delta = left !== null && right !== null ? left - right : null;

  const status: Status =
    delta === null ? "NAO_ATESTADO" : delta === 0n ? "CONFORME" : "DIVERGENTE";

  const counterpartEvidenceId =
    pair.focusDirection === "FORWARD"
      ? pair.to.row.evidence_id
      : pair.from.row.evidence_id;

  const pairId = hashText(
    stableJson({
      domain: "ExploreChem/BilateralPair/v1",
      lotReference: pair.lotReference,
      fromEvidenceId: pair.from.row.evidence_id,
      toEvidenceId: pair.to.row.evidence_id,
      relationType: pair.relationType,
    }),
  );

  return {
    schema: "ExploreChem/BilateralMassResult/v1",
    pairId,
    focusEvidenceId: focus.row.evidence_id,
    counterpartEvidenceId,
    focusDirection: pair.focusDirection,
    relationType: pair.relationType,
    lotReference: pair.lotReference,
    fromEvidenceId: pair.from.row.evidence_id,
    toEvidenceId: pair.to.row.evidence_id,
    fromActorId: pair.from.onchain.actorId,
    toActorId: pair.to.onchain.actorId,
    leftMassMg: left?.toString() ?? null,
    rightMassMg: right?.toString() ?? null,
    leftMassField: pair.left.field,
    rightMassField: pair.right.field,
    deltaMg: delta?.toString() ?? null,
    status,
  };
}

/* ============================================================
 * Commitment privado do resultado local
 * ============================================================
 */

function commitment(
  runtime: TeeRuntime<Config>,
  master: string,
  focus: OnchainEvidence,
  result: BilateralMassResult,
) {
  const resultPlainHash = hashText(stableJson(result));

  /*
   * CRE/Javy nao fornece crypto.getRandomValues().
   * O salt e derivado por hash com uma chave privada forte do Vault,
   * dados unicos da dupla e o tempo deterministico da execucao.
   * Sem o master, o observador da blockchain nao consegue precomputar o salt.
   */
  const salt = hashText(
    stableJson({
      domain: "ExploreChem/BilateralPrivateSalt/v1",
      master,
      executionTime: runtime.now(),
      focusEvidenceId: focus.evidenceId,
      focusEvidenceHash: focus.evidenceHash,
      pairId: result.pairId,
      resultPlainHash,
    }),
  );

  const aggregateInputHash = hashText(
    stableJson({
      domain: "ExploreChem/BilateralInput/v1",
      salt,
      focusEvidenceId: focus.evidenceId,
      pairId: result.pairId,
      fromEvidenceId: result.fromEvidenceId,
      toEvidenceId: result.toEvidenceId,
      fromActorId: result.fromActorId,
      toActorId: result.toActorId,
      lotReference: result.lotReference,
    }),
  );

  const resultHash = hashText(
    stableJson({
      domain: "ExploreChem/BilateralResult/v1",
      salt,
      result,
    }),
  );

  const resultId = hashText(
    `ExploreChem/BilateralResultId/v1|${focus.actorId}|${focus.evidenceId}|${result.pairId}|${resultHash}`,
  );

  return {
    salt,
    resultPlainHash,
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

function run(runtime: TeeRuntime<Config>): string {
  /*
   * 1) BLOCKCHAIN PRIMEIRO.
   * Nenhuma consulta ao Supabase ocorre antes disto.
   */
  const pendingId = getNextPending(runtime);

  if (lower(pendingId) === lower(zeroHash)) {
    return JSON.stringify({
      workflow: "BILATERAL_MASS",
      discovery: "BLOCKCHAIN_FIRST",
      pendingAuthority: "BLOCKCHAIN",
      message: "nenhum PENDING on-chain",
    });
  }

  const focusOnchain = readEvidence(runtime, pendingId);

  if (focusOnchain.status !== 1) {
    return JSON.stringify({
      workflow: "BILATERAL_MASS",
      discovery: "BLOCKCHAIN_FIRST",
      pendingAuthority: "BLOCKCHAIN",
      focusEvidenceId: pendingId,
      message: "evidencia escolhida deixou de estar PENDING",
    });
  }

  /*
   * 2) SOMENTE AGORA: secrets + Supabase + Storage.
   */
  const { key, master } = secrets(runtime);
  const actors = loadActorDirectory(runtime, key);
  const focusRow = loadOneEvidenceRow(runtime, key, focusOnchain.evidenceId);
  const focus = loadVerifiedEvidence(
    runtime,
    key,
    focusRow,
    actors,
    focusOnchain,
  );

  if (focus.normalized.lotReference === null) {
    return JSON.stringify({
      workflow: "BILATERAL_MASS",
      discovery: "BLOCKCHAIN_FIRST",
      pendingAuthority: "BLOCKCHAIN",
      focusEvidenceId: focus.row.evidence_id,
      message: "lotId ausente no documento comprometido; continua PENDING",
    });
  }

  if (
    focus.normalized.destinationActorId === null &&
    focus.normalized.originActorId === null
  ) {
    return JSON.stringify({
      workflow: "BILATERAL_MASS",
      discovery: "BLOCKCHAIN_FIRST",
      pendingAuthority: "BLOCKCHAIN",
      focusEvidenceId: focus.row.evidence_id,
      lotReference: focus.normalized.lotReference,
      message: "origem e destino ausentes no documento comprometido; continua PENDING",
    });
  }

  /*
   * 3) Carrega candidatos DEPOIS que a blockchain escolheu o foco.
   * Cada candidato e conferido contra a propria ancora on-chain.
   */
  const allRows = loadAllEvidenceRows(runtime, key);
  const candidates: VerifiedEvidence[] = [];
  const candidateErrors: Array<{ evidenceId: Hex; error: string }> = [];

  for (const row of allRows) {
    if (lower(row.evidence_id) === lower(focus.row.evidence_id)) {
      continue;
    }

    try {
      const candidateOnchain = readEvidence(runtime, row.evidence_id);

      /*
       * NONE nao existe porque getEvidence reverte.
       * Aceitamos contraparte PENDING, MATCHED ou VERIFIED.
       * DIVERGENT nao e usada como nova contraparte fisica neste workflow.
       */
      if (![1, 2, 3].includes(candidateOnchain.status)) {
        continue;
      }

      candidates.push(
        loadVerifiedEvidence(
          runtime,
          key,
          row,
          actors,
          candidateOnchain,
        ),
      );
    } catch (error) {
      candidateErrors.push({
        evidenceId: row.evidence_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /*
   * 4) Procura PARA FRENTE e PARA TRAS.
   */
  const pairs = findPairsForFocus(focus, candidates);

  let selected: PairCandidate | null;

  try {
    selected = selectPair(pairs);
  } catch (error) {
    return JSON.stringify({
      workflow: "BILATERAL_MASS",
      discovery: "BLOCKCHAIN_FIRST",
      pendingAuthority: "BLOCKCHAIN",
      focusEvidenceId: focus.row.evidence_id,
      lotReference: focus.normalized.lotReference,
      pairCandidates: pairs.map((pair) => ({
        fromEvidenceId: pair.from.row.evidence_id,
        toEvidenceId: pair.to.row.evidence_id,
        relationType: pair.relationType,
        focusDirection: pair.focusDirection,
      })),
      message: error instanceof Error ? error.message : String(error),
    });
  }

  if (!selected) {
    return JSON.stringify({
      workflow: "BILATERAL_MASS",
      discovery: "BLOCKCHAIN_FIRST",
      pendingAuthority: "BLOCKCHAIN",
      correlation: "ORIGIN_DESTINATION_PLUS_LOT_BIDIRECTIONAL",
      focusEvidenceId: focus.row.evidence_id,
      focusActorId: focus.onchain.actorId,
      focusOriginActorId: focus.normalized.originActorId,
      focusDestinationActorId: focus.normalized.destinationActorId,
      lotReference: focus.normalized.lotReference,
      scannedCandidates: candidates.length,
      candidateErrors,
      message: "nenhuma contraparte bilateral encontrada; continua PENDING",
    });
  }

  /*
   * 5) CORRELACAO JA EXISTE.
   * Agora, e somente agora, a massa das duas partes vira o veredito.
   */
  const mass = calculateBilateralMass(focus, selected);

  const committed = commitment(
    runtime,
    master,
    focus.onchain,
    mass,
  );

  const resultPath = privateResultPath(
    focus.onchain.evidenceId,
    committed.resultId,
  );

  const privateBase = {
    schema: "ExploreChem/PrivateBilateralCommittedMass/v1",
    sourceEvidenceId: focus.onchain.evidenceId,
    sourceActorId: focus.onchain.actorId,
    sourceEvidenceHash: focus.onchain.evidenceHash,
    counterpartEvidenceId: mass.counterpartEvidenceId,
    pairId: mass.pairId,
    salt: committed.salt,
    resultPlainHash: committed.resultPlainHash,
    aggregateInputHash: committed.aggregateInputHash,
    resultHash: committed.resultHash,
    resultId: committed.resultId,
    mass,
  };

  /*
   * 6) Salva primeiro o resultado privado sem tx hashes.
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
   * 7) Reconfere o gate on-chain imediatamente antes da mudanca.
   */
  const gate = readEvidence(runtime, focus.onchain.evidenceId);

  if (gate.status !== 1) {
    return JSON.stringify({
      workflow: "BILATERAL_MASS",
      discovery: "BLOCKCHAIN_FIRST",
      pendingAuthority: "BLOCKCHAIN",
      focusEvidenceId: focus.onchain.evidenceId,
      message: "focus deixou de estar PENDING antes do MATCH; nenhuma transacao enviada",
    });
  }

  /*
   * 8) MATCH somente do foco.
   * A contraparte nao muda de estado aqui.
   */
  const matchTxHash = write(
    runtime,
    matchReport(focus.onchain.evidenceId),
  );

  /*
   * 9) Resultado bilateral somente do foco.
   * O contrato novo exige evidenceId + actorId do dono do resultado.
   */
  const resultTxHash = write(
    runtime,
    balanceReport(focus.onchain, committed, mass.status),
  );

  /*
   * 10) Atualiza Storage + espelho Supabase apenas do foco.
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
      },
    },
  );

  mirrorMatch(
    runtime,
    key,
    focus.onchain.evidenceId,
    matchTxHash,
  );

  return JSON.stringify({
    workflow: "BILATERAL_MASS",
    discovery: "BLOCKCHAIN_FIRST",
    pendingAuthority: "BLOCKCHAIN",
    correlation: "ORIGIN_DESTINATION_PLUS_LOT_BIDIRECTIONAL",
    massPolicy: "PAIRWISE_ONLY_NO_GLOBAL_AGGREGATION",
    focusEvidenceId: focus.onchain.evidenceId,
    counterpartEvidenceId: mass.counterpartEvidenceId,
    focusDirection: mass.focusDirection,
    relationType: mass.relationType,
    lotReference: mass.lotReference,
    fromEvidenceId: mass.fromEvidenceId,
    toEvidenceId: mass.toEvidenceId,
    leftMassMg: mass.leftMassMg,
    rightMassMg: mass.rightMassMg,
    deltaMg: mass.deltaMg,
    massStatus: mass.status,
    commitment: {
      resultId: committed.resultId,
      resultHash: committed.resultHash,
      aggregateInputHash: committed.aggregateInputHash,
    },
    privateResult: {
      bucket: focus.row.storage_bucket,
      path: resultPath,
    },
    onchain: {
      matchedEvidenceId: focus.onchain.evidenceId,
      matchTxHash,
      resultTxHash,
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

