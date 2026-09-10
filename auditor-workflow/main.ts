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
 * ExploreChem — Independent Auditor.
 *
 * This workflow does NOT search for PENDING evidence, does NOT correlate
 * documents, and does NOT create the original bilateral result. It consumes
 * a MATCHED evidence that already has a BalanceResult anchored by the
 * primary workflow.
 *
 * When the committed document contains elementalBalance, the Auditor also:
 *   - normalizes each stream to the correct basis;
 *   - converts oxides into elemental Nd, Pr, Dy, or Tb;
 *   - recalculates elementalMassMg for each stream;
 *   - aggregates inputs, outputs, and inventories;
 *   - recalculates MUF per element and private product recovery.
 *
 * Flow:
 *   MATCHED + pairwise/elemental compliant   -> VERIFIED
 *   MATCHED + DIVERGENT result               -> DIVERGENT
 *   MATCHED + integrity/business divergence   -> DIVERGENT
 *   MATCHED + infrastructure/access failure   -> remains MATCHED (RETRY_REQUIRED)
 *   MATCHED with no result yet               -> remains MATCHED
 *
 * The blockchain is always the authority. Supabase is mirrored only after
 * rereading the final on-chain state.
 */


const DEFAULT_AUDIT_SCHEDULE = "0 */5 * * * *";

const bytes32Schema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/) as z.ZodType<Hex>;

const massStatusSchema = z.enum([
  "CONFORME",
  "DIVERGENTE",
  "NAO_ATESTADO",
]);

type MassStatus = z.infer<typeof massStatusSchema>;

const configSchema = z.object({
  supabaseUrl: z.string().min(1),
  secretNamespace: z.string().min(1),
  chainSelectorName: z.string().min(1),
  contractAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  gasLimit: z.string().regex(/^\d+$/),
  auditSchedule: z.string().min(1).optional(),
  requireElementalBalance: z.boolean().optional(),
  massToleranceBps: z.number().int().min(0).max(10_000).optional(),
});

type Config = z.infer<typeof configSchema>;

class IntegrityViolation extends Error {}

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
});

type EvidenceRow = z.infer<typeof evidenceRowSchema>;

type ActorDirectory = {
  byDbId: Map<string, ActorRow>;
  byName: Map<string, Hex>;
};

type NormalizedEvidence = {
  actorType: ActorType;
  ownerActorId: Hex;
  originActorId: Hex | null;
  destinationActorId: Hex | null;
  lotReference: string | null;
  grossMassKg: string | null;
  collectedMassKg: string | null;
  deliveredMassKg: string | null;
  inputMassKg: string | null;
  outputMassKg: string | null;
  scrapMassKg: string | null;
  recoveredMassKg: string | null;
};

type IndependentlyVerifiedEvidence = {
  row: EvidenceRow;
  onchain: OnchainEvidence;
  document: Record<string, unknown>;
  normalized: NormalizedEvidence;
  rowHashMatchesChain: boolean;
};

type MassEndpoint = {
  massMg: bigint | null;
  field: string;
};

type IndependentAudit = {
  evidenceCount: number;
  pairCount: number;
  rowHashWarnings: string[];
  errors: string[];
  documents: Map<string, IndependentlyVerifiedEvidence>;
};

const correlationEdgeSchema = z.object({
  fromEvidenceId: bytes32Schema,
  toEvidenceId: bytes32Schema,
  relationType: z.enum(["PHYSICAL_HANDOFF", "LAB_ANALYSIS"]),
  lotReference: z.string().min(1),
});

const pairMassResultSchema = z.object({
  pairId: bytes32Schema,
  relationType: z.enum(["PHYSICAL_HANDOFF", "LAB_ANALYSIS"]),
  fromEvidenceId: bytes32Schema,
  toEvidenceId: bytes32Schema,
  fromActorId: bytes32Schema,
  toActorId: bytes32Schema,
  lotReference: z.string().min(1),
  leftMassMg: z.string().regex(/^\d+$/).nullable(),
  rightMassMg: z.string().regex(/^\d+$/).nullable(),
  leftMassField: z.string(),
  rightMassField: z.string(),
  deltaMg: z.string().regex(/^-?\d+$/).nullable(),
  status: massStatusSchema,
});

const currentPrivatePairwiseResultSchema = z.object({
  schema: z.literal("ExploreChem/PrivatePairwiseMass/v1"),
  sourceEvidenceId: bytes32Schema,
  sourceActorId: bytes32Schema,
  sourceEvidenceHash: bytes32Schema,
  lotReference: z.string().min(1),
  evidenceIds: z.array(bytes32Schema).min(1),
  correlationEdges: z.array(correlationEdgeSchema),
  massPairs: z.array(pairMassResultSchema),
  calculationVersion: z.number().int().positive(),
  relationFingerprint: bytes32Schema,
  aggregateInputHash: bytes32Schema,
  canonicalResultHash: bytes32Schema,
  resultHash: bytes32Schema,
  resultId: bytes32Schema,
  status: massStatusSchema,
  onchain: z.unknown().optional(),
});

type CurrentPrivatePairwiseResult = z.infer<
  typeof currentPrivatePairwiseResultSchema
>;

type PrivatePairwiseResult = CurrentPrivatePairwiseResult;

const privatePairwiseResultSchema = currentPrivatePairwiseResultSchema;

const decimalSchema = z
  .union([z.string(), z.number()])
  .transform((value) => String(value))
  .refine(
    (value) => /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value),
    "decimal nao negativo invalido",
  );

const signedIntegerSchema = z.string().regex(/^-?\d+$/);
const unsignedIntegerSchema = z.string().regex(/^\d+$/);

const elementSchema = z.enum(["ND", "PR", "DY", "TB"]);
type ElementSymbol = z.infer<typeof elementSchema>;

const streamTypeSchema = z.enum([
  "INPUT",
  "PRODUCT",
  "WASTE",
  "PURGE",
  "EFFLUENT",
  "OPENING_INVENTORY",
  "CLOSING_INVENTORY",
]);

const declaredBasisSchema = z.enum([
  "AS_RECEIVED",
  "DRY_105C",
  "CALCINED",
  "LIQUID_TOTAL",
]);

const reportedFormSchema = z.enum([
  "ND2O3",
  "PR6O11",
  "PR2O3",
  "DY2O3",
  "TB4O7",
  "TB2O3",
  "DIRECT_ELEMENTAL",
]);

const elementalAnalysisSchema = z.object({
  element: elementSchema,
  reportedForm: reportedFormSchema,
  reportedContent: decimalSchema,
  reportedContentUnit: z.enum(["PERCENT", "MG_PER_KG"]),
  contentBasis: declaredBasisSchema,
  declaredElementalMassMg: unsignedIntegerSchema,
});

const elementalStreamSchema = z.object({
  streamId: z.string().min(1),
  streamType: streamTypeSchema,
  grossMassKg: decimalSchema,
  declaredBasis: declaredBasisSchema,
  measurementPoint: z.string().min(1),
  weighingTimestamp: z.string().datetime({ offset: true }),
  freeMoisturePct: decimalSchema.optional(),
  moistureMethod: z.string().min(1).optional(),
  dryingTemperatureC: decimalSchema.optional(),
  moistureSamplingTimestamp: z.string().datetime({ offset: true }).optional(),
  hoursBetweenDeterminations: decimalSchema.optional(),
  lossOnIgnitionPct: decimalSchema.optional(),
  ignitionTemperatureC: decimalSchema.optional(),
  ignitionAtmosphere: z.string().min(1).optional(),
  ignitionResidenceMinutes: decimalSchema.optional(),
  elements: z.array(elementalAnalysisSchema).min(1),
});

const declaredMufSchema = z
  .object({
    ND: signedIntegerSchema.optional(),
    PR: signedIntegerSchema.optional(),
    DY: signedIntegerSchema.optional(),
    TB: signedIntegerSchema.optional(),
  })
  .refine(
    (value) => Object.values(value).some((item) => item !== undefined),
    "ao menos um MUF elementar deve ser declarado",
  );

const elementalBalanceSchema = z.object({
  schema: z.literal("ExploreChem/PeriodicElementalBalance/v1"),
  actorId: bytes32Schema,
  periodStart: z.string().datetime({ offset: true }),
  periodEnd: z.string().datetime({ offset: true }),
  factorTableVersion: z.literal("1.0.0"),
  previousBalanceHash: bytes32Schema.optional(),
  streams: z.array(elementalStreamSchema).min(1),
  declaredMufMg: declaredMufSchema,
});

type ElementalBalance = z.infer<typeof elementalBalanceSchema>;

type ElementTotals = {
  inputMg: string;
  productMg: string;
  otherOutputMg: string;
  openingInventoryMg: string;
  closingInventoryMg: string;
  mufMg: string;
  productRecoveryPpm: string | null;
};

type ElementalAudit =
  | {
      status: "NOT_PRESENT";
      resultHash: null;
      periodStart: null;
      periodEnd: null;
      totals: Record<string, never>;
      errors: string[];
    }
  | {
      status: "CONFORME" | "DIVERGENTE";
      resultHash: Hex;
      periodStart: string | null;
      periodEnd: string | null;
      totals: Partial<Record<ElementSymbol, ElementTotals>>;
      errors: string[];
    };

type OnchainEvidence = {
  evidenceId: Hex;
  actorId: Hex;
  evidenceHash: Hex;
  status: number;
};

type OnchainBalanceResult = {
  resultId: Hex;
  evidenceId: Hex;
  actorId: Hex;
  resultHash: Hex;
  previousResultId: Hex;
  aggregateInputHash: Hex;
  status: number;
  calculationVersion: number;
};

const ABI = [
  {
    type: "function",
    name: "getNextMatched",
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
  {
    type: "function",
    name: "latestResultIdByEvidence",
    stateMutability: "view",
    inputs: [{ name: "evidenceId", type: "bytes32" }],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "getResult",
    stateMutability: "view",
    inputs: [{ name: "resultId", type: "bytes32" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "resultId", type: "bytes32" },
          { name: "evidenceId", type: "bytes32" },
          { name: "actorId", type: "bytes32" },
          { name: "resultHash", type: "bytes32" },
          { name: "previousResultId", type: "bytes32" },
          { name: "aggregateInputHash", type: "bytes32" },
          { name: "status", type: "uint8" },
          { name: "calculationVersion", type: "uint32" },
          { name: "createdAt", type: "uint64" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "verifyResultHash",
    stateMutability: "view",
    inputs: [
      { name: "resultId", type: "bytes32" },
      { name: "candidateHash", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

function lower(value: string): string {
  return value.toLowerCase();
}

function canonicalName(value: string): string {
  return value.trim().toLowerCase();
}

function sameHex(left: string, right: string): boolean {
  return lower(left) === lower(right);
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);

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

function hashText(value: string): Hex {
  return keccak256(toHex(value));
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
  if (value === null || value === undefined) return null;

  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    const rendered = value.toString();
    return /^\d+(?:\.\d+)?$/.test(rendered) ? rendered : null;
  }

  if (typeof value !== "string") return null;
  const rendered = value.trim();
  return /^\d+(?:\.\d+)?$/.test(rendered) ? rendered : null;
}

function kgToMg(value: string | null): bigint | null {
  if (value === null) return null;

  const parts = value.split(".");
  const whole = BigInt(parts[0]);
  const fractional = parts[1] ?? "";
  const firstSix = fractional.slice(0, 6).padEnd(6, "0");
  let result = whole * 1_000_000n + BigInt(firstSix);

  if (fractional.length > 6 && Number(fractional[6]) >= 5) {
    result += 1n;
  }

  return result;
}

function idEquals(left: Hex | null, right: Hex): boolean {
  return left !== null && sameHex(left, right);
}

function encPath(path: string): string {
  return path
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

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
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY ausente");

  return { key };
}

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

function loadEvidenceRow(
  runtime: TeeRuntime<Config>,
  key: string,
  evidenceId: Hex,
): EvidenceRow {
  const path =
    "/rest/v1/explorerchem_evidences" +
    "?select=evidence_id,actor_db_id,state,evidence_hash,hash_algorithm,storage_bucket,storage_path,mime_type" +
    `&evidence_id=eq.${encodeURIComponent(evidenceId)}&limit=1`;

  const raw = text(request(runtime, key, path, "GET"));
  const rows = z.array(evidenceRowSchema).parse(JSON.parse(raw));

  if (rows.length !== 1) {
    throw new Error(`${evidenceId}: evidencia ausente no Supabase`);
  }

  return rows[0];
}

function loadActorDirectory(
  runtime: TeeRuntime<Config>,
  key: string,
): ActorDirectory {
  const path =
    "/rest/v1/explorerchem_actors" +
    "?select=id,actor_id,display_name,actor_type" +
    "&active=eq.true&order=created_at.asc";

  const raw = text(request(runtime, key, path, "GET"));
  const rows = z.array(actorRowSchema).parse(JSON.parse(raw));

  return {
    byDbId: new Map(rows.map((actor) => [actor.id, actor])),
    byName: new Map(
      rows.map((actor) => [canonicalName(actor.display_name), actor.actor_id]),
    ),
  };
}

function privateResultPath(evidenceId: Hex, resultId: Hex): string {
  return `mass-results/${evidenceId.slice(2)}/${resultId.slice(2)}.json`;
}

function auditReceiptPath(evidenceId: Hex, resultId: Hex): string {
  return `audit-results/${evidenceId.slice(2)}/${resultId.slice(2)}.json`;
}

function loadPrivateResult(
  runtime: TeeRuntime<Config>,
  key: string,
  bucket: string,
  path: string,
): PrivatePairwiseResult {
  const response = request(
    runtime,
    key,
    `/storage/v1/object/authenticated/${encodeURIComponent(bucket)}/${encPath(path)}`,
    "GET",
  );

  const parsed = JSON.parse(new TextDecoder().decode(response.body));
  return privatePairwiseResultSchema.parse(parsed);
}

function loadEvidenceDocument(
  runtime: TeeRuntime<Config>,
  key: string,
  row: EvidenceRow,
  evidence: OnchainEvidence,
): Record<string, unknown> {
  const response = request(
    runtime,
    key,
    `/storage/v1/object/authenticated/${encodeURIComponent(row.storage_bucket)}/${encPath(row.storage_path)}`,
    "GET",
  );

  const bytes = new Uint8Array(response.body);
  const recomputedHash =
    row.hash_algorithm === "SHA-256" || row.hash_algorithm === "SHA256"
      ? sha256(bytes)
      : keccak256(bytes);

  if (!sameHex(recomputedHash, evidence.evidenceHash)) {
    throw new IntegrityViolation(
      `${evidence.evidenceId}: hash recalculado do JSON diverge da blockchain`,
    );
  }

  if (!row.mime_type.toLowerCase().includes("json")) {
    throw new IntegrityViolation(
      `${evidence.evidenceId}: auditor independente exige JSON; mime=${row.mime_type}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new IntegrityViolation(
      `${evidence.evidenceId}: documento comprometido nao e JSON valido`,
    );
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new IntegrityViolation("documento original precisa ser um objeto JSON");
  }

  return parsed as Record<string, unknown>;
}

function saveAuditReceipt(
  runtime: TeeRuntime<Config>,
  key: string,
  bucket: string,
  path: string,
  value: unknown,
) {
  request(
    runtime,
    key,
    `/storage/v1/object/${encodeURIComponent(bucket)}/${encPath(path)}`,
    "POST",
    value,
    {
      "x-upsert": { values: ["true"] },
    },
  );
}

function mirrorFinalState(
  runtime: TeeRuntime<Config>,
  key: string,
  evidenceId: Hex,
  state: "VERIFIED" | "DIVERGENT",
) {
  request(
    runtime,
    key,
    `/rest/v1/explorerchem_evidences?evidence_id=eq.${encodeURIComponent(evidenceId)}&state=eq.MATCHED`,
    "PATCH",
    { state },
    {
      prefer: { values: ["return=minimal"] },
    },
  );
}

function callContract(
  runtime: TeeRuntime<Config>,
  data: Hex,
): Hex {
  const response = new EVMClient(network(runtime).chainSelector.selector)
    .callContract(runtime.usingTheDons(), {
      call: encodeCallMsg({
        from: zeroAddress,
        to: runtime.config.contractAddress as Address,
        data,
      }),
      blockNumber: LATEST_BLOCK_NUMBER,
    })
    .result();

  return bytesToHex(response.data) as Hex;
}

function getNextMatched(runtime: TeeRuntime<Config>): Hex {
  const data = callContract(
    runtime,
    encodeFunctionData({
      abi: ABI,
      functionName: "getNextMatched",
      args: [],
    }),
  );

  return decodeFunctionResult({
    abi: ABI,
    functionName: "getNextMatched",
    data,
  }) as Hex;
}

function readEvidence(
  runtime: TeeRuntime<Config>,
  evidenceId: Hex,
): OnchainEvidence {
  const data = callContract(
    runtime,
    encodeFunctionData({
      abi: ABI,
      functionName: "getEvidence",
      args: [evidenceId],
    }),
  );

  const decoded = decodeFunctionResult({
    abi: ABI,
    functionName: "getEvidence",
    data,
  });

  return {
    evidenceId: decoded.evidenceId,
    actorId: decoded.actorId,
    evidenceHash: decoded.evidenceHash,
    status: Number(decoded.status),
  };
}

function latestResultId(
  runtime: TeeRuntime<Config>,
  evidenceId: Hex,
): Hex {
  const data = callContract(
    runtime,
    encodeFunctionData({
      abi: ABI,
      functionName: "latestResultIdByEvidence",
      args: [evidenceId],
    }),
  );

  return decodeFunctionResult({
    abi: ABI,
    functionName: "latestResultIdByEvidence",
    data,
  }) as Hex;
}

function readResult(
  runtime: TeeRuntime<Config>,
  resultId: Hex,
): OnchainBalanceResult {
  const data = callContract(
    runtime,
    encodeFunctionData({
      abi: ABI,
      functionName: "getResult",
      args: [resultId],
    }),
  );

  const decoded = decodeFunctionResult({
    abi: ABI,
    functionName: "getResult",
    data,
  });

  return {
    resultId: decoded.resultId,
    evidenceId: decoded.evidenceId,
    actorId: decoded.actorId,
    resultHash: decoded.resultHash,
    previousResultId: decoded.previousResultId,
    aggregateInputHash: decoded.aggregateInputHash,
    status: Number(decoded.status),
    calculationVersion: Number(decoded.calculationVersion),
  };
}

function verifyResultHash(
  runtime: TeeRuntime<Config>,
  resultId: Hex,
  candidateHash: Hex,
): boolean {
  const data = callContract(
    runtime,
    encodeFunctionData({
      abi: ABI,
      functionName: "verifyResultHash",
      args: [resultId, candidateHash],
    }),
  );

  return decodeFunctionResult({
    abi: ABI,
    functionName: "verifyResultHash",
    data,
  }) as boolean;
}

type Fraction = {
  numerator: bigint;
  denominator: bigint;
};

function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;

  while (b !== 0n) {
    const next = a % b;
    a = b;
    b = next;
  }

  return a === 0n ? 1n : a;
}

function fraction(numerator: bigint, denominator = 1n): Fraction {
  if (denominator === 0n) throw new Error("divisao por zero");

  const sign = denominator < 0n ? -1n : 1n;
  const divisor = gcd(numerator, denominator);

  return {
    numerator: (numerator / divisor) * sign,
    denominator: (denominator / divisor) * sign,
  };
}

function decimalFraction(value: string): Fraction {
  const [whole, decimals = ""] = value.split(".");
  const denominator = 10n ** BigInt(decimals.length);
  return fraction(BigInt(`${whole}${decimals}`), denominator);
}

function addFraction(left: Fraction, right: Fraction): Fraction {
  return fraction(
    left.numerator * right.denominator +
      right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
}

function subtractFraction(left: Fraction, right: Fraction): Fraction {
  return fraction(
    left.numerator * right.denominator -
      right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
}

function multiplyFraction(left: Fraction, right: Fraction): Fraction {
  return fraction(
    left.numerator * right.numerator,
    left.denominator * right.denominator,
  );
}

function divideFraction(left: Fraction, right: Fraction): Fraction {
  if (right.numerator === 0n) throw new Error("divisao por zero");

  return fraction(
    left.numerator * right.denominator,
    left.denominator * right.numerator,
  );
}

function compareFraction(left: Fraction, right: Fraction): number {
  const delta =
    left.numerator * right.denominator -
    right.numerator * left.denominator;

  return delta < 0n ? -1 : delta > 0n ? 1 : 0;
}

function roundHalfUp(value: Fraction): bigint {
  if (value.numerator < 0n) {
    throw new Error("roundHalfUp recebeu valor negativo");
  }

  const quotient = value.numerator / value.denominator;
  const remainder = value.numerator % value.denominator;
  return remainder * 2n >= value.denominator ? quotient + 1n : quotient;
}

function percentMultiplier(percent: string): Fraction {
  const parsed = decimalFraction(percent);
  const zero = fraction(0n);
  const hundred = fraction(100n);

  if (
    compareFraction(parsed, zero) < 0 ||
    compareFraction(parsed, hundred) >= 0
  ) {
    throw new Error(`percentual fora da faixa [0,100): ${percent}`);
  }

  return divideFraction(parsed, hundred);
}

const OXIDE_TO_ELEMENT_FACTOR: Record<
  ElementSymbol,
  Partial<Record<z.infer<typeof reportedFormSchema>, string>>
> = {
  ND: {
    ND2O3: "0.857356",
    DIRECT_ELEMENTAL: "1.000000",
  },
  PR: {
    PR6O11: "0.827704",
    PR2O3: "0.854472",
    DIRECT_ELEMENTAL: "1.000000",
  },
  DY: {
    DY2O3: "0.871321",
    DIRECT_ELEMENTAL: "1.000000",
  },
  TB: {
    TB4O7: "0.850215",
    TB2O3: "0.868806",
    DIRECT_ELEMENTAL: "1.000000",
  },
};

function requireFields(
  stream: z.infer<typeof elementalStreamSchema>,
  fields: Array<keyof z.infer<typeof elementalStreamSchema>>,
) {
  const missing = fields.filter((field) => stream[field] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `${stream.streamId}: campos obrigatorios ausentes: ${missing.join(", ")}`,
    );
  }
}

function normalizedMassKg(
  stream: z.infer<typeof elementalStreamSchema>,
): Fraction {
  const gross = decimalFraction(stream.grossMassKg);

  if (stream.declaredBasis === "DRY_105C") return gross;
  if (stream.declaredBasis === "LIQUID_TOTAL") return gross;

  if (stream.declaredBasis === "AS_RECEIVED") {
    requireFields(stream, [
      "freeMoisturePct",
      "moistureMethod",
      "dryingTemperatureC",
      "moistureSamplingTimestamp",
      "hoursBetweenDeterminations",
    ]);

    const temperature = decimalFraction(stream.dryingTemperatureC!);
    if (
      compareFraction(temperature, fraction(100n)) < 0 ||
      compareFraction(temperature, fraction(110n)) > 0
    ) {
      throw new Error(
        `${stream.streamId}: dryingTemperatureC deve estar entre 100 e 110`,
      );
    }

    return multiplyFraction(
      gross,
      subtractFraction(
        fraction(1n),
        percentMultiplier(stream.freeMoisturePct!),
      ),
    );
  }

  requireFields(stream, [
    "lossOnIgnitionPct",
    "ignitionTemperatureC",
    "ignitionAtmosphere",
    "ignitionResidenceMinutes",
  ]);

  return divideFraction(
    gross,
    subtractFraction(
      fraction(1n),
      percentMultiplier(stream.lossOnIgnitionPct!),
    ),
  );
}

function elementalMassMg(
  stream: z.infer<typeof elementalStreamSchema>,
  analysis: z.infer<typeof elementalAnalysisSchema>,
): bigint {
  const massKg = normalizedMassKg(stream);

  if (stream.declaredBasis === "LIQUID_TOTAL") {
    if (
      analysis.reportedContentUnit !== "MG_PER_KG" ||
      analysis.contentBasis !== "LIQUID_TOTAL" ||
      analysis.reportedForm !== "DIRECT_ELEMENTAL"
    ) {
      throw new Error(
        `${stream.streamId}/${analysis.element}: LIQUID_TOTAL exige DIRECT_ELEMENTAL em MG_PER_KG`,
      );
    }

    return roundHalfUp(
      multiplyFraction(
        massKg,
        decimalFraction(analysis.reportedContent),
      ),
    );
  }

  if (analysis.reportedContentUnit !== "PERCENT") {
    throw new Error(
      `${stream.streamId}/${analysis.element}: corrente solida exige teor em PERCENT`,
    );
  }
  if (analysis.contentBasis !== "DRY_105C") {
    throw new Error(
      `${stream.streamId}/${analysis.element}: teor deve estar em DRY_105C`,
    );
  }

  const factorValue =
    OXIDE_TO_ELEMENT_FACTOR[analysis.element][analysis.reportedForm];

  if (factorValue === undefined) {
    throw new Error(
      `${stream.streamId}/${analysis.element}: formula ${analysis.reportedForm} invalida para o elemento`,
    );
  }

  const elementKg = multiplyFraction(
    multiplyFraction(
      massKg,
      divideFraction(
        decimalFraction(analysis.reportedContent),
        fraction(100n),
      ),
    ),
    decimalFraction(factorValue),
  );

  return roundHalfUp(
    multiplyFraction(elementKg, fraction(1_000_000n)),
  );
}

function emptyTotals() {
  return {
    inputMg: 0n,
    productMg: 0n,
    otherOutputMg: 0n,
    openingInventoryMg: 0n,
    closingInventoryMg: 0n,
  };
}

function auditElementalBalance(
  document: Record<string, unknown>,
  actorId: Hex,
): ElementalAudit {
  const raw = document.elementalBalance;

  if (raw === undefined) {
    return {
      status: "NOT_PRESENT",
      resultHash: null,
      periodStart: null,
      periodEnd: null,
      totals: {},
      errors: [],
    };
  }

  const parsed = elementalBalanceSchema.safeParse(raw);
  if (!parsed.success) {
    const errors = parsed.error.issues.map(
      (issue) =>
        `elementalBalance.${issue.path.join(".") || "root"}: ${issue.message}`,
    );
    const invalidPayloadHash = hashText(stableJson(raw));
    const resultHash = hashText(
      stableJson({
        domain: "ExploreChem/PeriodicElementalBalanceAudit/v1",
        actorId,
        invalidPayloadHash,
        errors,
      }),
    );

    return {
      status: "DIVERGENTE",
      resultHash,
      periodStart: null,
      periodEnd: null,
      totals: {},
      errors,
    };
  }

  const balance: ElementalBalance = parsed.data;
  const errors: string[] = [];

  if (!sameHex(balance.actorId, actorId)) {
    errors.push("elementalBalance.actorId diverge do ator da evidencia");
  }

  const periodStartMs = Date.parse(balance.periodStart);
  const periodEndMs = Date.parse(balance.periodEnd);
  if (periodEndMs <= periodStartMs) {
    errors.push("periodEnd deve ser posterior a periodStart");
  }

  const streamIds = new Set<string>();
  const totals = new Map<ElementSymbol, ReturnType<typeof emptyTotals>>();
  const streamResults: Array<{
    streamId: string;
    streamType: z.infer<typeof streamTypeSchema>;
    element: ElementSymbol;
    declaredElementalMassMg: string;
    recalculatedElementalMassMg: string | null;
  }> = [];

  for (const stream of [...balance.streams].sort((a, b) =>
    a.streamId.localeCompare(b.streamId),
  )) {
    if (streamIds.has(stream.streamId)) {
      errors.push(`${stream.streamId}: streamId duplicado`);
      continue;
    }
    streamIds.add(stream.streamId);

    const weighingMs = Date.parse(stream.weighingTimestamp);
    if (weighingMs < periodStartMs || weighingMs > periodEndMs) {
      errors.push(
        `${stream.streamId}: weighingTimestamp fora do periodo declarado`,
      );
    }

    const streamElements = new Set<ElementSymbol>();
    for (const analysis of [...stream.elements].sort((a, b) =>
      a.element.localeCompare(b.element),
    )) {
      if (streamElements.has(analysis.element)) {
        errors.push(
          `${stream.streamId}/${analysis.element}: elemento duplicado na corrente`,
        );
        continue;
      }
      streamElements.add(analysis.element);

      let recalculated: bigint | null = null;
      try {
        recalculated = elementalMassMg(stream, analysis);
        const declared = BigInt(analysis.declaredElementalMassMg);

        if (recalculated !== declared) {
          errors.push(
            `${stream.streamId}/${analysis.element}: massaElementarMg declarada=${declared} recalculada=${recalculated}`,
          );
        }

        const aggregate = totals.get(analysis.element) ?? emptyTotals();
        if (stream.streamType === "INPUT") {
          aggregate.inputMg += recalculated;
        } else if (stream.streamType === "PRODUCT") {
          aggregate.productMg += recalculated;
        } else if (
          stream.streamType === "WASTE" ||
          stream.streamType === "PURGE" ||
          stream.streamType === "EFFLUENT"
        ) {
          aggregate.otherOutputMg += recalculated;
        } else if (stream.streamType === "OPENING_INVENTORY") {
          aggregate.openingInventoryMg += recalculated;
        } else {
          aggregate.closingInventoryMg += recalculated;
        }
        totals.set(analysis.element, aggregate);
      } catch (error) {
        errors.push(
          error instanceof Error
            ? error.message
            : `${stream.streamId}/${analysis.element}: erro de calculo`,
        );
      }

      streamResults.push({
        streamId: stream.streamId,
        streamType: stream.streamType,
        element: analysis.element,
        declaredElementalMassMg: analysis.declaredElementalMassMg,
        recalculatedElementalMassMg: recalculated?.toString() ?? null,
      });
    }
  }

  const finalTotals: Partial<Record<ElementSymbol, ElementTotals>> = {};

  for (const element of [...totals.keys()].sort()) {
    const aggregate = totals.get(element)!;
    const muf =
      aggregate.inputMg +
      aggregate.openingInventoryMg -
      aggregate.productMg -
      aggregate.otherOutputMg -
      aggregate.closingInventoryMg;

    const declaredMuf = balance.declaredMufMg[element];
    if (declaredMuf === undefined) {
      errors.push(`${element}: declaredMufMg ausente`);
    } else if (BigInt(declaredMuf) !== muf) {
      errors.push(
        `${element}: MUF declarado=${declaredMuf} recalculado=${muf}`,
      );
    }

    const productRecoveryPpm =
      aggregate.inputMg === 0n
        ? null
        : roundHalfUp(
            multiplyFraction(
              fraction(aggregate.productMg, aggregate.inputMg),
              fraction(1_000_000n),
            ),
          );

    finalTotals[element] = {
      inputMg: aggregate.inputMg.toString(),
      productMg: aggregate.productMg.toString(),
      otherOutputMg: aggregate.otherOutputMg.toString(),
      openingInventoryMg: aggregate.openingInventoryMg.toString(),
      closingInventoryMg: aggregate.closingInventoryMg.toString(),
      mufMg: muf.toString(),
      productRecoveryPpm: productRecoveryPpm?.toString() ?? null,
    };
  }

  for (const element of Object.keys(balance.declaredMufMg) as ElementSymbol[]) {
    if (!totals.has(element)) {
      errors.push(`${element}: MUF declarado sem corrente elementar`);
    }
  }

  const resultHash = hashText(
    stableJson({
      domain: "ExploreChem/PeriodicElementalBalanceAudit/v1",
      factorTableVersion: balance.factorTableVersion,
      actorId: balance.actorId,
      periodStart: balance.periodStart,
      periodEnd: balance.periodEnd,
      previousBalanceHash: balance.previousBalanceHash ?? zeroHash,
      streamResults,
      totals: finalTotals,
    }),
  );

  return {
    status: errors.length === 0 ? "CONFORME" : "DIVERGENTE",
    resultHash,
    periodStart: balance.periodStart,
    periodEnd: balance.periodEnd,
    totals: finalTotals,
    errors,
  };
}

function recomputeCurrentManifestCommitments(
  manifest: CurrentPrivatePairwiseResult,
) {
  const result = {
    schema: "ExploreChem/PairwiseMassResult/v1" as const,
    calculationVersion: manifest.calculationVersion,
    focusActorId: manifest.sourceActorId,
    focusEvidenceId: manifest.sourceEvidenceId,
    lotReference: manifest.lotReference,
    evidenceIds: manifest.evidenceIds,
    correlationEdges: manifest.correlationEdges,
    massPairs: manifest.massPairs,
    status: manifest.status,
  };

  const aggregateInputHash = hashText(
    stableJson({
      domain: "ExploreChem/PairwiseMassInput/v1",
      calculationVersion: manifest.calculationVersion,
      actorId: manifest.sourceActorId,
      focusEvidenceId: manifest.sourceEvidenceId,
      evidenceIds: manifest.evidenceIds,
      correlationEdges: manifest.correlationEdges,
    }),
  );

  const canonicalResultHash = hashText(
    stableJson({
      domain: "ExploreChem/PairwiseMass/v1",
      calculationVersion: manifest.calculationVersion,
      actorId: manifest.sourceActorId,
      focusEvidenceId: manifest.sourceEvidenceId,
      result,
    }),
  );

  const resultId = hashText(
    stableJson({
      domain: "ExploreChem/PairwiseMassResultId/v1",
      calculationVersion: manifest.calculationVersion,
      actorId: manifest.sourceActorId,
      focusEvidenceId: manifest.sourceEvidenceId,
      resultHash: canonicalResultHash,
    }),
  );

  return {
    aggregateInputHash,
    resultHash: canonicalResultHash,
    resultId,
  };
}

type RecomputedManifestCommitments = {
  aggregateInputHash: Hex;
  resultHash: Hex;
  resultId: Hex;
};

function recomputeManifestCommitments(
  manifest: PrivatePairwiseResult,
): RecomputedManifestCommitments {
  return recomputeCurrentManifestCommitments(manifest);
}

function actorIdFromValue(
  value: unknown,
  actors: ActorDirectory,
): Hex | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const trimmed = value.trim();

  if (/^0x[0-9a-fA-F]{64}$/.test(trimmed)) {
    return trimmed as Hex;
  }

  return actors.byName.get(canonicalName(trimmed)) ?? null;
}

function normalizeCommittedEvidence(
  document: Record<string, unknown>,
  row: EvidenceRow,
  onchain: OnchainEvidence,
  actors: ActorDirectory,
): NormalizedEvidence {
  const actor = actors.byDbId.get(row.actor_db_id);
  if (!actor) {
    throw new Error(`${row.evidence_id}: actor_db_id nao encontrado`);
  }
  if (!sameHex(actor.actor_id, onchain.actorId)) {
    throw new Error(`${row.evidence_id}: ator cadastrado diverge da blockchain`);
  }

  if (typeof document.actorType === "string") {
    const declaredType = document.actorType.trim().toUpperCase();
    if (
      (actorTypeSchema.options as readonly string[]).includes(declaredType) &&
      declaredType !== actor.actor_type
    ) {
      throw new Error(`${row.evidence_id}: actorType do JSON diverge do cadastro`);
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

function outgoingMass(
  from: IndependentlyVerifiedEvidence,
  to: IndependentlyVerifiedEvidence,
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
    if (to.normalized.actorType === "RECYCLER" && n.scrapMassKg !== null) {
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

  return {
    massMg: kgToMg(
      n.deliveredMassKg ??
        n.recoveredMassKg ??
        n.scrapMassKg ??
        n.outputMassKg ??
        n.grossMassKg,
    ),
    field: "bestAvailableOutgoingMass",
  };
}

function incomingMass(to: IndependentlyVerifiedEvidence): MassEndpoint {
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
      massMg: kgToMg(n.inputMassKg ?? n.grossMassKg ?? n.collectedMassKg),
      field:
        n.inputMassKg !== null
          ? "transformation.inputMassKg"
          : n.grossMassKg !== null
            ? "massBalance.grossMassKg"
            : "custody.massCollectedKg",
    };
  }

  return {
    massMg: kgToMg(n.inputMassKg ?? n.collectedMassKg ?? n.grossMassKg),
    field: "bestAvailableIncomingMass",
  };
}

function independentlyAuditCommittedDocuments(
  runtime: TeeRuntime<Config>,
  key: string,
  manifest: PrivatePairwiseResult,
  focusEvidence: OnchainEvidence,
  actors: ActorDirectory,
): IndependentAudit {
  const errors: string[] = [];
  const rowHashWarnings: string[] = [];
  const documents = new Map<string, IndependentlyVerifiedEvidence>();
  const seenEvidenceIds = new Set<string>();

  const incomingEdges = manifest.correlationEdges.filter(
    (edge) =>
      edge.relationType === "PHYSICAL_HANDOFF" &&
      sameHex(edge.toEvidenceId, manifest.sourceEvidenceId),
  );
  const incomingPairs = manifest.massPairs.filter(
    (pair) =>
      pair.relationType === "PHYSICAL_HANDOFF" &&
      sameHex(pair.toEvidenceId, manifest.sourceEvidenceId),
  );

  if (
    incomingEdges.length !== 1 ||
    incomingPairs.length !== 1 ||
    !sameHex(incomingEdges[0].fromEvidenceId, incomingPairs[0].fromEvidenceId) ||
    !sameHex(incomingEdges[0].toEvidenceId, incomingPairs[0].toEvidenceId)
  ) {
    errors.push(
      "resultado sem um unico par fisico anterior direcionado para a evidencia atual",
    );
    return {
      evidenceCount: 0,
      pairCount: 0,
      rowHashWarnings,
      errors,
      documents,
    };
  }

  const directEvidenceIds = [
    incomingEdges[0].fromEvidenceId,
    manifest.sourceEvidenceId,
  ];

  for (const evidenceId of directEvidenceIds) {
    const normalizedId = lower(evidenceId);
    if (seenEvidenceIds.has(normalizedId)) {
      errors.push(`${evidenceId}: evidenceId duplicado no resultado privado`);
      continue;
    }
    seenEvidenceIds.add(normalizedId);

    try {
      const onchain = sameHex(evidenceId, focusEvidence.evidenceId)
        ? focusEvidence
        : readEvidence(runtime, evidenceId);
      if (!sameHex(onchain.evidenceId, evidenceId)) {
        throw new IntegrityViolation(
          `${evidenceId}: getEvidence retornou outro evidenceId`,
        );
      }

      const row = loadEvidenceRow(runtime, key, evidenceId);
      const document = loadEvidenceDocument(runtime, key, row, onchain);
      const normalized = normalizeCommittedEvidence(
        document,
        row,
        onchain,
        actors,
      );

      if (normalized.lotReference !== manifest.lotReference) {
        throw new IntegrityViolation(
          `${evidenceId}: lotId do JSON=${String(normalized.lotReference)} diverge do resultado=${manifest.lotReference}`,
        );
      }

      const rowHashMatchesChain = sameHex(
        row.evidence_hash,
        onchain.evidenceHash,
      );
      if (!rowHashMatchesChain) {
        rowHashWarnings.push(
          `${evidenceId}: hash do indice Supabase diverge da blockchain; JSON confirmou a blockchain`,
        );
      }

      documents.set(normalizedId, {
        row,
        onchain,
        document,
        normalized,
        rowHashMatchesChain,
      });
    } catch (error) {
      if (error instanceof IntegrityViolation) {
        errors.push(error.message);
        continue;
      }
      throw error;
    }
  }

  if (!seenEvidenceIds.has(lower(manifest.sourceEvidenceId))) {
    errors.push("sourceEvidenceId nao esta em evidenceIds");
  }

  const physicalEdgeKeys = new Set<string>();
  const allEdgeKeys = new Set<string>();
  for (const edge of incomingEdges) {
    const edgeKey = [
      lower(edge.fromEvidenceId),
      lower(edge.toEvidenceId),
      edge.relationType,
    ].join("|");
    if (allEdgeKeys.has(edgeKey)) {
      errors.push(`${edgeKey}: correlationEdge duplicada`);
      continue;
    }
    allEdgeKeys.add(edgeKey);
    if (edge.relationType === "PHYSICAL_HANDOFF") physicalEdgeKeys.add(edgeKey);

    const from = documents.get(lower(edge.fromEvidenceId));
    const to = documents.get(lower(edge.toEvidenceId));
    if (!from || !to) {
      errors.push(`${edgeKey}: documentos comprometidos indisponiveis`);
      continue;
    }
    if (edge.lotReference !== manifest.lotReference) {
      errors.push(`${edgeKey}: lotReference da aresta diverge do resultado`);
    }

    if (edge.relationType === "LAB_ANALYSIS") {
      if (
        from.normalized.actorType !== "LABORATORY" ||
        !idEquals(from.normalized.destinationActorId, to.onchain.actorId)
      ) {
        errors.push(`${edgeKey}: relacao LAB_ANALYSIS nao e reproduzivel dos JSONs`);
      }
    } else if (
      from.normalized.actorType === "LABORATORY" ||
      to.normalized.actorType === "LABORATORY" ||
      !idEquals(from.normalized.destinationActorId, to.onchain.actorId) ||
      !idEquals(to.normalized.originActorId, from.onchain.actorId)
    ) {
      errors.push(`${edgeKey}: PHYSICAL_HANDOFF nao e reproduzivel dos JSONs`);
    }
  }

  const pairKeys = new Set<string>();
  const reconstructedStatuses: MassStatus[] = [];
  for (const pair of incomingPairs) {
    const pairKey = [
      lower(pair.fromEvidenceId),
      lower(pair.toEvidenceId),
      pair.relationType,
    ].join("|");
    if (pairKeys.has(pairKey)) {
      errors.push(`${pair.pairId}: par de massa duplicado`);
      continue;
    }
    pairKeys.add(pairKey);

    if (!allEdgeKeys.has(pairKey)) {
      errors.push(`${pair.pairId}: par nao possui correlationEdge correspondente`);
    }

    const from = documents.get(lower(pair.fromEvidenceId));
    const to = documents.get(lower(pair.toEvidenceId));
    if (!from || !to) {
      errors.push(`${pair.pairId}: documentos do par indisponiveis`);
      continue;
    }
    if (!sameHex(pair.fromActorId, from.onchain.actorId)) {
      errors.push(`${pair.pairId}: fromActorId diverge da blockchain`);
    }
    if (!sameHex(pair.toActorId, to.onchain.actorId)) {
      errors.push(`${pair.pairId}: toActorId diverge da blockchain`);
    }
    if (pair.lotReference !== manifest.lotReference) {
      errors.push(`${pair.pairId}: lotReference diverge do resultado`);
    }

    const left =
      pair.relationType === "LAB_ANALYSIS"
        ? { massMg: null, field: "NO_PHYSICAL_MASS" }
        : outgoingMass(from, to);
    const right =
      pair.relationType === "LAB_ANALYSIS"
        ? { massMg: null, field: "NO_PHYSICAL_MASS" }
        : incomingMass(to);
    const expectedLeft = left.massMg?.toString() ?? null;
    const expectedRight = right.massMg?.toString() ?? null;
    const expectedDelta =
      left.massMg !== null && right.massMg !== null
        ? (left.massMg - right.massMg).toString()
        : null;
    const expectedStatus: MassStatus =
      expectedDelta === null
        ? "NAO_ATESTADO"
        : expectedDelta === "0"
          ? "CONFORME"
          : "DIVERGENTE";
    reconstructedStatuses.push(expectedStatus);

    if (pair.leftMassMg !== expectedLeft) {
      errors.push(`${pair.pairId}: leftMassMg nao confere com o JSON comprometido`);
    }
    if (pair.rightMassMg !== expectedRight) {
      errors.push(`${pair.pairId}: rightMassMg nao confere com o JSON comprometido`);
    }
    if (pair.leftMassField !== left.field) {
      errors.push(`${pair.pairId}: leftMassField nao confere com a regra independente`);
    }
    if (pair.rightMassField !== right.field) {
      errors.push(`${pair.pairId}: rightMassField nao confere com a regra independente`);
    }
    if (pair.deltaMg !== expectedDelta) {
      errors.push(`${pair.pairId}: deltaMg nao confere com os JSONs comprometidos`);
    }
    if (pair.status !== expectedStatus) {
      errors.push(`${pair.pairId}: status nao confere com os JSONs comprometidos`);
    }
  }

  for (const edgeKey of physicalEdgeKeys) {
    if (!pairKeys.has(edgeKey)) {
      errors.push(`${edgeKey}: PHYSICAL_HANDOFF sem par de massa`);
    }
  }

  const expectedOverallStatus: MassStatus = reconstructedStatuses.some(
    (status) => status === "DIVERGENTE",
  )
    ? "DIVERGENTE"
    : reconstructedStatuses.length > 0 &&
        reconstructedStatuses.every((status) => status === "CONFORME")
      ? "CONFORME"
      : "NAO_ATESTADO";

  return {
    evidenceCount: documents.size,
    pairCount: pairKeys.size,
    rowHashWarnings,
    errors,
    documents,
  };
}

function recomputeMassVerdict(
  manifest: PrivatePairwiseResult,
  toleranceBps: number,
) {
  const errors: string[] = [];
  const statuses: MassStatus[] = [];
  const toleranceChecks: Array<{
    pairId: Hex;
    absoluteDeltaMg: string | null;
    toleranceReference: "OUTGOING_MASS";
    toleranceReferenceMassMg: string | null;
    toleranceBps: number;
    toleranceLimitMg: string | null;
    status: MassStatus;
  }> = [];

  const auditedPairs = manifest.massPairs.filter(
    (pair) =>
      pair.relationType === "PHYSICAL_HANDOFF" &&
      sameHex(pair.toEvidenceId, manifest.sourceEvidenceId),
  );

  if (auditedPairs.length !== 1) {
    errors.push(
      "resultado sem um unico par de massa anterior direcionado para a evidencia atual",
    );
  }

  for (const pair of auditedPairs) {
    let expectedStatus: MassStatus;
    let expectedDelta: string | null;

    if (pair.leftMassMg === null || pair.rightMassMg === null) {
      expectedStatus = "NAO_ATESTADO";
      expectedDelta = null;
      toleranceChecks.push({
        pairId: pair.pairId,
        absoluteDeltaMg: null,
        toleranceReference: "OUTGOING_MASS",
        toleranceReferenceMassMg: pair.leftMassMg,
        toleranceBps,
        toleranceLimitMg: null,
        status: expectedStatus,
      });
    } else {
      const left = BigInt(pair.leftMassMg);
      const right = BigInt(pair.rightMassMg);
      const delta = left - right;
      const absoluteDelta = delta < 0n ? -delta : delta;
      const allowed = absoluteDelta * 10_000n <= left * BigInt(toleranceBps);
      expectedDelta = delta.toString();
      expectedStatus = allowed ? "CONFORME" : "DIVERGENTE";
      toleranceChecks.push({
        pairId: pair.pairId,
        absoluteDeltaMg: absoluteDelta.toString(),
        toleranceReference: "OUTGOING_MASS",
        toleranceReferenceMassMg: left.toString(),
        toleranceBps,
        toleranceLimitMg: ((left * BigInt(toleranceBps)) / 10_000n).toString(),
        status: expectedStatus,
      });
    }

    statuses.push(expectedStatus);

    if (pair.deltaMg !== expectedDelta) {
      errors.push(
        `${pair.pairId}: deltaMg declarado=${String(pair.deltaMg)} esperado=${String(expectedDelta)}`,
      );
    }
  }

  const expectedOverallStatus: MassStatus = statuses.some(
    (status) => status === "DIVERGENTE",
  )
    ? "DIVERGENTE"
    : statuses.length > 0 && statuses.every((status) => status === "CONFORME")
      ? "CONFORME"
      : "NAO_ATESTADO";

  return { expectedOverallStatus, toleranceChecks, errors };
}

function auditReport(
  evidenceId: Hex,
  verdict: "VERIFIED" | "DIVERGENT",
): Hex {
  const evidenceStatus = verdict === "VERIFIED" ? 3 : 4;

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
      evidenceStatus,
      0,
    ],
  );
}

function writeAudit(runtime: TeeRuntime<Config>, payload: Hex): Hex {
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
    throw new Error(`writeReport de auditoria falhou: ${result.txStatus}`);
  }

  if (
    result.receiverContractExecutionStatus !== undefined &&
    result.receiverContractExecutionStatus !== 0
  ) {
    throw new Error(
      `receiver de auditoria reverteu: ${result.receiverContractExecutionStatus}` +
        (result.errorMessage ? ` · ${result.errorMessage}` : ""),
    );
  }

  return bytesToHex(result.txHash ?? new Uint8Array(32)) as Hex;
}

function run(runtime: TeeRuntime<Config>): string {
  const evidenceId = getNextMatched(runtime);

  if (sameHex(evidenceId, zeroHash)) {
    return JSON.stringify({
      workflow: "PAIRWISE_MASS_AUDITOR",
      discovery: "BLOCKCHAIN_GET_NEXT_MATCHED",
      authority: "BLOCKCHAIN",
      message: "nenhuma evidencia MATCHED aguardando auditoria",
    });
  }

  const evidence = readEvidence(runtime, evidenceId);

  if (evidence.status !== 2) {
    return JSON.stringify({
      workflow: "PAIRWISE_MASS_AUDITOR",
      discovery: "BLOCKCHAIN_GET_NEXT_MATCHED",
      evidenceId,
      observedStatus: evidence.status,
      message: "evidencia deixou de estar MATCHED antes da auditoria",
    });
  }

  const resultId = latestResultId(runtime, evidenceId);

  if (sameHex(resultId, zeroHash)) {
    return JSON.stringify({
      workflow: "PAIRWISE_MASS_AUDITOR",
      discovery: "BLOCKCHAIN_GET_NEXT_MATCHED",
      evidenceId,
      message: "evidencia MATCHED ainda sem resultado de massa; permanece MATCHED",
    });
  }

  const onchainResult = readResult(runtime, resultId);

  const { key } = secrets(runtime);
  const row = loadEvidenceRow(runtime, key, evidenceId);
  const resultPath = privateResultPath(evidenceId, resultId);
  const manifest = loadPrivateResult(
    runtime,
    key,
    row.storage_bucket,
    resultPath,
  );
  const compatibilityMode = "CURRENT_V1_DIRECT_PREVIOUS_ONLY";

  const actors = loadActorDirectory(runtime, key);
  const independentAudit = independentlyAuditCommittedDocuments(
    runtime,
    key,
    manifest,
    evidence,
    actors,
  );

  let elementalAudit: ElementalAudit;
  try {
    const evidenceDocument =
      independentAudit.documents.get(lower(evidenceId))?.document ??
      loadEvidenceDocument(runtime, key, row, evidence);
    elementalAudit = auditElementalBalance(
      evidenceDocument,
      evidence.actorId,
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "falha ao abrir o documento elementar";
    elementalAudit = {
      status: "DIVERGENTE",
      resultHash: hashText(
        stableJson({
          domain: "ExploreChem/PeriodicElementalBalanceAudit/v1",
          actorId: evidence.actorId,
          error: message,
        }),
      ),
      periodStart: null,
      periodEnd: null,
      totals: {},
      errors: [message],
    };
  }

  const integrityErrors: string[] = [];

  if (!sameHex(manifest.sourceEvidenceId, evidenceId)) {
    integrityErrors.push("sourceEvidenceId privado diverge da evidencia auditada");
  }
  if (!sameHex(manifest.sourceActorId, evidence.actorId)) {
    integrityErrors.push("sourceActorId privado diverge do ator on-chain");
  }
  if (!sameHex(manifest.sourceEvidenceHash, evidence.evidenceHash)) {
    integrityErrors.push("sourceEvidenceHash privado diverge do hash on-chain");
  }
  if (!sameHex(onchainResult.evidenceId, evidenceId)) {
    integrityErrors.push("resultado on-chain pertence a outra evidencia");
  }
  if (!sameHex(onchainResult.actorId, evidence.actorId)) {
    integrityErrors.push("resultado on-chain pertence a outro ator");
  }

  const expectedCalculationVersion = manifest.calculationVersion;

  if (onchainResult.calculationVersion !== expectedCalculationVersion) {
    integrityErrors.push(
      `calculationVersion on-chain=${onchainResult.calculationVersion} esperada=${expectedCalculationVersion}`,
    );
  }

  const recomputed = recomputeManifestCommitments(manifest);

  if (!sameHex(recomputed.resultHash, manifest.canonicalResultHash)) {
    integrityErrors.push("canonicalResultHash privado nao e reproduzivel");
  }
  if (!sameHex(recomputed.aggregateInputHash, manifest.aggregateInputHash)) {
    integrityErrors.push("aggregateInputHash privado nao e reproduzivel");
  }
  if (!sameHex(recomputed.aggregateInputHash, onchainResult.aggregateInputHash)) {
    integrityErrors.push("aggregateInputHash privado diverge do resultado on-chain");
  }
  if (!sameHex(recomputed.resultHash, manifest.resultHash)) {
    integrityErrors.push("resultHash privado nao e reproduzivel");
  }
  if (!sameHex(recomputed.resultHash, onchainResult.resultHash)) {
    integrityErrors.push("resultHash recalculado diverge do resultado on-chain");
  }
  if (!sameHex(recomputed.resultId, manifest.resultId)) {
    integrityErrors.push("resultId privado nao e reproduzivel");
  }
  if (!sameHex(recomputed.resultId, onchainResult.resultId)) {
    integrityErrors.push("resultId recalculado diverge do resultado on-chain");
  }
  if (
    !verifyResultHash(
      runtime,
      onchainResult.resultId,
      recomputed.resultHash,
    )
  ) {
    integrityErrors.push("verifyResultHash retornou false");
  }

  const toleranceBps = runtime.config.massToleranceBps ?? 200;
  const massAudit = recomputeMassVerdict(manifest, toleranceBps);
  const elementalErrors = elementalAudit.errors.map(
    (error) => `elemental: ${error}`,
  );

  if (
    runtime.config.requireElementalBalance === true &&
    elementalAudit.status === "NOT_PRESENT"
  ) {
    elementalErrors.push(
      "elemental: bloco elementalBalance obrigatorio e ausente",
    );
  }

  const allErrors = [
    ...integrityErrors,
    ...independentAudit.errors.map(
      (error) => `independent: ${error}`,
    ),
    ...massAudit.errors,
    ...elementalErrors,
  ];

  if (massAudit.expectedOverallStatus !== "CONFORME") {
    allErrors.push(
      `massa auditada=${massAudit.expectedOverallStatus}; somente CONFORME pode ser VERIFIED`,
    );
  }

  const verdict: "VERIFIED" | "DIVERGENT" =
    allErrors.length === 0 ? "VERIFIED" : "DIVERGENT";

  const auditTxHash = writeAudit(
    runtime,
    auditReport(evidenceId, verdict),
  );

  const finalEvidence = readEvidence(runtime, evidenceId);
  const expectedFinalStatus = verdict === "VERIFIED" ? 3 : 4;

  if (finalEvidence.status !== expectedFinalStatus) {
    throw new Error(
      `${evidenceId}: auditoria enviada, mas estado on-chain recebido=${finalEvidence.status} esperado=${expectedFinalStatus}`,
    );
  }

  saveAuditReceipt(
    runtime,
    key,
    row.storage_bucket,
    auditReceiptPath(evidenceId, resultId),
    {
      schema: "ExploreChem/PairwiseMassAudit/v2",
      auditedManifestSchema: manifest.schema,
      compatibilityMode,
      evidenceId,
      actorId: evidence.actorId,
      evidenceHash: evidence.evidenceHash,
      resultId,
      resultHash: onchainResult.resultHash,
      aggregateInputHash: onchainResult.aggregateInputHash,
      calculationVersion: onchainResult.calculationVersion,
      previousResultId: onchainResult.previousResultId,
      independentVerification: {
        status:
          independentAudit.errors.length === 0
            ? "VERIFIED_FROM_COMMITTED_JSONS"
            : "DIVERGENT",
        evidenceCount: independentAudit.evidenceCount,
        pairCount: independentAudit.pairCount,
        rowHashWarnings: independentAudit.rowHashWarnings,
        errors: independentAudit.errors,
      },
      recalculatedMassStatus: massAudit.expectedOverallStatus,
      tolerancePolicy: {
        reference: "OUTGOING_MASS",
        toleranceBps,
        arbitrated: true,
      },
      toleranceChecks: massAudit.toleranceChecks,
      elementalBalanceRequired:
        runtime.config.requireElementalBalance === true,
      elementalAudit,
      verdict,
      errors: allErrors,
      auditTxHash,
    },
  );

  let supabaseMirrorError: string | null = null;
  try {
    mirrorFinalState(runtime, key, evidenceId, verdict);
  } catch (error) {
    supabaseMirrorError =
      error instanceof Error
        ? error.message
        : "falha desconhecida ao espelhar o estado final no Supabase";
  }

  return JSON.stringify({
    workflow: "PAIRWISE_MASS_AUDITOR",
    discovery: "BLOCKCHAIN_GET_NEXT_MATCHED",
    authority: "BLOCKCHAIN",
    evidenceId,
    actorId: evidence.actorId,
    resultId,
    auditedManifestSchema: manifest.schema,
    compatibilityMode,
    resultHash: onchainResult.resultHash,
    aggregateInputHash: onchainResult.aggregateInputHash,
    independentVerification: {
      status:
        independentAudit.errors.length === 0
          ? "VERIFIED_FROM_COMMITTED_JSONS"
          : "DIVERGENT",
      evidenceCount: independentAudit.evidenceCount,
      pairCount: independentAudit.pairCount,
      rowHashWarnings: independentAudit.rowHashWarnings,
      errors: independentAudit.errors,
    },
    declaredMassStatus: manifest.status,
    recalculatedMassStatus: massAudit.expectedOverallStatus,
    tolerancePolicy: {
      reference: "OUTGOING_MASS",
      toleranceBps,
      arbitrated: true,
    },
    toleranceChecks: massAudit.toleranceChecks,
    elementalBalanceRequired:
      runtime.config.requireElementalBalance === true,
    elementalAudit,
    auditErrorCount: allErrors.length,
    auditErrors: allErrors,
    finalEvidenceStatus: verdict,
    auditTxHash,
    supabaseMirror: {
      updated: supabaseMirrorError === null,
      error: supabaseMirrorError,
    },
    privateAudit: {
      bucket: row.storage_bucket,
      path: auditReceiptPath(evidenceId, resultId),
    },
  });
}

function onCron(
  runtime: TeeRuntime<Config>,
  _payload: CronPayload,
): string {
  try {
    return run(runtime);
  } catch (error) {
    return JSON.stringify({
      workflow: "PAIRWISE_MASS_AUDITOR",
      status: "RETRY_REQUIRED",
      message: error instanceof Error ? error.message : "falha tecnica desconhecida",
      instruction:
        "Nenhum veredito foi derivado da falha; a evidencia permanece MATCHED para nova tentativa.",
    });
  }
}

const initWorkflow = (config: Config) => {
  const cron = new CronCapability();

  return [
    handlerInTee(
      cron.trigger({
        schedule: config.auditSchedule ?? DEFAULT_AUDIT_SCHEDULE,
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


