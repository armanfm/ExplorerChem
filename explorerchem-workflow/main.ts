import {
  CronCapability,
  EVMClient,
  HTTPClient,
  HTTPCapability,
  LAST_FINALIZED_BLOCK_NUMBER,
  LATEST_BLOCK_NUMBER,
  Runner,
  TxStatus,
  bytesToHex,
  decodeJson,
  encodeCallMsg,
  getNetwork,
  handlerInTee,
  hexToBase64,
  ok,
  text,
  type CronPayload,
  type HTTPPayload,
  type TeeRuntime,
} from "@chainlink/cre-sdk";
import { hashToCurve, secp256k1 } from "@noble/curves/secp256k1";
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
 * ExploreChem — unified CRE workflow
 *
 * One confidential workflow handles both protocol report types:
 *   - reportType 1: evidence correlation (PENDING -> MATCHED)
 *   - reportType 2: chain-wide elemental mass-balance result
 *
 * Confidentiality boundary:
 *   - HTTP and Cron triggers are both registered with handlerInTee;
 *   - document bytes, service credentials, canonicalization, correlation and
 *     elemental calculations stay in TeeRuntime;
 *   - runtime.usingTheDons() is used only for public chain reads/reports;
 *   - no global private API URL is required by the staging config.
 *
 * Final correlation policy implemented here:
 *   - ONE Cron only.
 *   - Supabase is the discovery/index layer for PENDING/MATCHED candidates;
 *   - correlation does not pre-read getEvidence() before doing TEE work;
 *   - correlation is EVENT/EVIDENCE-first: document actorId is not proof;
 *     exact document bytes + evidenceHash + deterministic extraction are proof;
 *   - every indexed PENDING evidence is eligible on each cycle until MATCHED
 *     or the indexed 365-day PENDING TTL expires;
 *   - MATCHED younger than seven days is skipped;
 *   - MATCHED aged seven days or more may be queried for graph expansion;
 *   - if no additional valid relationship is found, nothing changes and no
 *     blockchain transaction is sent;
 *   - MATCHED is monotonic and never receives reportType 1 twice;
 *   - timestamps never form a candidate search window;
 *   - correlationGroupId/lot references are discovery aids, never proof;
 *   - transport/laboratory evidence corroborates the graph but is not counted
 *     as a second physical mass stream.
 *
 * Balance policy implemented here:
 *   - only evidence whose final state is MATCHED enters the mass calculation;
 *   - DIVERGENT is terminal and is never searched or calculated again;
 *   - MATCHED remains reusable as a correlation counterpart and checkpoint;
 *   - the TEE keeps the correlation graph private;
 *   - one correlated operation produces ONE deterministic mass-proof hash;
 *   - that proof is anchored once, with no actorId/evidenceId membership exposed;
 *   - every involved participant receives the same resultHash and txHash off-chain;
 *   - there is no per-actor/per-evidence salt in the shared mass proof.
 */

const ELEMENTS = ["ND", "PR", "DY", "TB"] as const;
type Element = (typeof ELEMENTS)[number];

const STREAM_TYPES = ["ENTRADA", "PRODUTO", "REJEITO", "PURGA", "EFLUENTE"] as const;
const BASES = ["AS_RECEIVED", "DRY_105C", "CALCINED", "LIQUIDO_TOTAL"] as const;

const OXIDE_FACTORS = {
  ND2O3: { element: "ND", numerator: 857356n, denominator: 1000000n },
  PR6O11: { element: "PR", numerator: 827704n, denominator: 1000000n },
  PR2O3: { element: "PR", numerator: 854472n, denominator: 1000000n },
  DY2O3: { element: "DY", numerator: 871321n, denominator: 1000000n },
  TB4O7: { element: "TB", numerator: 850215n, denominator: 1000000n },
  TB2O3: { element: "TB", numerator: 868806n, denominator: 1000000n },
  ELEMENTAR_DIRETO: { element: null, numerator: 1n, denominator: 1n },
} as const;

const MATCH_REVIEW_DELAY_MS = 7 * 24 * 60 * 60 * 1000;
const PENDING_TTL_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * MVP DEMO / PRODUCTION-CADENCE POLICY
 *
 * - Immediate/manual verification is available through RUN_CORRELATION so the
 *   demonstration can show PENDING -> MATCHED without waiting for the scheduler.
 * - The scheduled trigger is intentionally WEEKLY. Its job is periodic
 *   revalidation of existing MATCHED relationships plus recovery/retry of
 *   evidence that is still PENDING.
 * - The immediate trigger does NOT weaken or bypass any matching rule: it runs
 *   the same hash verification, deterministic extraction and relationship checks.
 * - A future production event trigger (for example EvidenceSubmitted) can invoke
 *   the same IMMEDIATE_MATCH mode without changing the correlation engine.
 *
 * CRE cron format here uses: second minute hour day-of-month month day-of-week.
 * Sunday 00:00 UTC = 0 0 0 * * 0.
 */
const DEFAULT_SCHEDULE = "0 0 0 * * 0";

type CorrelationRunMode = "IMMEDIATE_MATCH" | "WEEKLY_REVALIDATION";

const decimalSchema = z
  .string()
  .regex(/^\d+(?:\.\d+)?$/, "use decimal positivo com ponto, sem notação científica");
const integerSchema = z.string().regex(/^-?\d+$/, "use miligramas inteiros");
const nonNegativeIntegerSchema = z.string().regex(/^\d+$/, "use miligramas inteiros positivos");
const bytes32Schema = z.string().regex(/^0x[0-9a-fA-F]{64}$/) as z.ZodType<Hex>;

const elementIntegerRecordSchema = z.object({
  ND: integerSchema,
  PR: integerSchema,
  DY: integerSchema,
  TB: integerSchema,
});

const elementNonNegativeRecordSchema = z.object({
  ND: nonNegativeIntegerSchema,
  PR: nonNegativeIntegerSchema,
  DY: nonNegativeIntegerSchema,
  TB: nonNegativeIntegerSchema,
});

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

const calculationRoleSchema = z.enum([
  "PHYSICAL_INPUT",
  "PHYSICAL_OUTPUT",
  "INITIAL_INVENTORY",
  "FINAL_INVENTORY",
  "CUSTODY_ONLY",
  "COMPOSITION_ONLY",
  "COMMERCIAL_ONLY",
  "TRANSFORMATION_SUPPORT",
  "NOT_CLASSIFIED",
]);

const relationTypeSchema = z.enum([
  "ORIGIN_DESTINATION",
  "CUSTODY_HANDOFF",
  "LAB_ANALYSIS",
  "TRANSFORMATION_INPUT",
  "TRANSFORMATION_OUTPUT",
  "RECYCLE",
  "RETURN",
  "DOCUMENT_SUPERSESSION",
]);

type RelationType = z.infer<typeof relationTypeSchema>;

const analysisSchema = z.object({
  element: z.enum(ELEMENTS),
  oxideFormula: z.enum([
    "ND2O3",
    "PR6O11",
    "PR2O3",
    "DY2O3",
    "TB4O7",
    "TB2O3",
    "ELEMENTAR_DIRETO",
  ]),
  reportedValue: decimalSchema,
  unit: z.enum(["PERCENT", "MG_PER_KG"]),
  basis: z.enum(BASES),
  denominatorPurity: z.enum(["MASSA_SECA", "MASSA_TOTAL"]),
  factorTableVersion: z.literal("1.0.0"),
});

const analyticalMeasurementSchema = analysisSchema.extend({
  // A measurement qualifies a physical material state. It never creates a
  // second physical mass flow by itself.
  measurementRole: z.enum(["RECEIVING", "OUTGOING", "PROCESS", "UNSPECIFIED"]),
  sourceKind: z.enum(["LAB_REPORT", "DECLARED_ASSAY", "PROCESS_ASSAY"]),
  sourceField: z.string().min(1),
  method: z.string().min(1).nullable().default(null),
});

type AnalyticalMeasurement = z.infer<typeof analyticalMeasurementSchema>;

const laboratoryReportSchema = z.object({
  sampleId: z.string().min(1).nullable().default(null),
  sampleMassKg: decimalSchema.nullable().default(null),
  massBasis: z.enum(BASES).nullable().default(null),
  analysisMethod: z.string().min(1).nullable().default(null),
  dryingTemperatureC: decimalSchema.nullable().default(null),
  moisturePct: decimalSchema.nullable().default(null),
  gradeNd2O3Pct: decimalSchema.nullable().default(null),
  elementalNdPct: decimalSchema.nullable().default(null),
  // Laboratory sample mass is analytical support only. It is never added to
  // the physical mass balance.
  contributesToMassBalance: z.literal(false),
});

const verifiedEvidenceSchema = z.object({
  evidenceId: bytes32Schema,
  actorId: bytes32Schema,
  evidenceHash: bytes32Schema,
  evidenceState: z.literal("MATCHED"),
  calculationRole: calculationRoleSchema,
});

const streamSchema = z.object({
  streamId: z.string().min(1),
  // Stable key for the physical movement/transformation. When omitted for an
  // older payload, streamId is used. Different documents may corroborate the
  // same flow, but one canonical flow is counted only once.
  canonicalFlowKey: z.string().min(1).optional(),
  evidenceId: bytes32Schema,
  evidenceHash: bytes32Schema,
  supportingEvidenceIds: z.array(bytes32Schema).default([]),
  type: z.enum(STREAM_TYPES),
  grossMassKg: decimalSchema,
  basis: z.enum(BASES),
  measurementPoint: z.string().min(1),
  // Kept as audit metadata only. It is NOT checked against a t0/t1 window and
  // never filters correlation candidates.
  weighingTimestamp: z.string().datetime({ offset: true }),
  moisturePct: decimalSchema.nullable().default(null),
  dryingTemperatureC: decimalSchema.nullable().default(null),
  moistureSamplingTimestamp: z.string().datetime({ offset: true }).nullable().default(null),
  determinationIntervalHours: decimalSchema.nullable().default(null),
  lossOnIgnitionPct: decimalSchema.nullable().default(null),
  ignitionTemperatureC: decimalSchema.nullable().default(null),
  atmosphere: z.string().min(1).nullable().default(null),
  residenceTimeMinutes: decimalSchema.nullable().default(null),
  coolingCondition: z.enum(["DESSECADOR", "ATMOSFERA_INERTE"]).nullable().default(null),
  timeBetweenIgnitionAndWeighingMinutes: decimalSchema.nullable().default(null),
  analyses: z.array(analysisSchema).length(4),
});

const correlationEdgeSchema = z.object({
  fromEvidenceId: bytes32Schema,
  toEvidenceId: bytes32Schema,
  relationType: relationTypeSchema,
});

const workflowInputSchema = z.object({
  chain: z.object({
    chainId: z.string().min(1),
    lotDbId: z.string().uuid(),
    nodeActorDbId: z.string().uuid(),
    nodeActorId: bytes32Schema,
    calculationVersion: z.number().int().positive().max(4294967295),
    previousResultDbId: z.string().uuid().nullable().default(null),
    previousResultId: bytes32Schema.nullable().default(null),
    correlationPolicyVersion: z.string().min(1),
    calculationPolicyVersion: z.string().min(1),
    factorTableVersion: z.literal("1.0.0"),
  }),
  parameters: z.object({
    coverageFactorK: decimalSchema,
    // Optional versioned tolerance for comparing two PERCENT assays of the
    // same compound. When omitted, the difference is recorded without forcing
    // a compatible/divergent analytical verdict.
    analyticalTolerancePctPoints: decimalSchema.optional(),
    sigmaMg: elementNonNegativeRecordSchema,
    bMaxMg: elementNonNegativeRecordSchema,
    cusumAllowanceMg: elementNonNegativeRecordSchema,
    cusumDecisionIntervalMg: elementNonNegativeRecordSchema,
    provenance: z.enum(["NORMATIVO", "CALCULADO", "MEDIDO", "ARBITRADO"]),
    decidedBy: z.string().min(1),
    decidedAt: z.string().datetime({ offset: true }),
  }),
  history: z.object({
    cumufMg: elementIntegerRecordSchema,
    cusumPositiveMg: elementNonNegativeRecordSchema,
    cusumNegativeMg: elementNonNegativeRecordSchema,
  }),
  verifiedEvidences: z.array(verifiedEvidenceSchema).min(1),
  streams: z.array(streamSchema).min(1),
  correlationEdges: z.array(correlationEdgeSchema),
});

const elementMassesSchema = z
  .object({
    ND: nonNegativeIntegerSchema.optional(),
    PR: nonNegativeIntegerSchema.optional(),
    DY: nonNegativeIntegerSchema.optional(),
    TB: nonNegativeIntegerSchema.optional(),
  })
  .default({});

type ElementMasses = z.infer<typeof elementMassesSchema>;

const normalizedEvidenceSchema = z.object({
  actorType: actorTypeSchema,
  calculationRole: calculationRoleSchema,
  originActorId: bytes32Schema.nullable().default(null),
  destinationActorId: bytes32Schema.nullable().default(null),
  carrierActorId: bytes32Schema.nullable().default(null),
  // actorId identifies the organization; site identifies the physical/operational point.
  // Sites remain private and are never emitted in the on-chain report.
  originSite: z.string().min(1).nullable().default(null),
  destinationSite: z.string().min(1).nullable().default(null),
  lotReference: z.string().min(1).nullable().default(null),
  correlationGroupId: z.string().min(1).nullable().default(null),
  documentReference: z.string().min(1).nullable().default(null),
  eventAt: z.string().datetime({ offset: true }).nullable().default(null),
  grossMassMg: nonNegativeIntegerSchema.nullable().default(null),
  collectedMassMg: nonNegativeIntegerSchema.nullable().default(null),
  deliveredMassMg: nonNegativeIntegerSchema.nullable().default(null),
  inputMassMg: nonNegativeIntegerSchema.nullable().default(null),
  outputMassMg: nonNegativeIntegerSchema.nullable().default(null),
  scrapMassMg: nonNegativeIntegerSchema.nullable().default(null),
  recoveredMassMg: nonNegativeIntegerSchema.nullable().default(null),
  elementalInputMg: elementMassesSchema,
  elementalOutputMg: elementMassesSchema,
  elementalScrapMg: elementMassesSchema,
  elementalRecoveredMg: elementMassesSchema,
  analyticalMeasurements: z.array(analyticalMeasurementSchema).default([]),
  laboratoryReport: laboratoryReportSchema.nullable().default(null),
});

type NormalizedEvidence = z.infer<typeof normalizedEvidenceSchema>;

const candidateSchema = z.object({ evidenceId: bytes32Schema });
type Candidate = z.infer<typeof candidateSchema>;

const inlineDocumentSchema = z.object({
  mode: z.literal("INLINE"),
  dataBase64: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
});

const chunkedDocumentSchema = z.object({
  mode: z.literal("CHUNKED"),
  sizeBytes: z.number().int().nonnegative(),
  chunkCount: z.number().int().positive(),
});

const evidenceBundleSchema = z.object({
  evidenceId: bytes32Schema,
  actorId: bytes32Schema,
  evidenceHash: bytes32Schema,
  hashAlgorithm: z.enum(["SHA-256", "SHA256", "KECCAK256", "KECCAK-256"]),
  mimeType: z.string().min(1),
  document: z.union([inlineDocumentSchema, chunkedDocumentSchema]),
  extractorVersion: z.string().min(1),
  extractionHash: bytes32Schema,
  normalized: normalizedEvidenceSchema,
});

type EvidenceBundle = z.infer<typeof evidenceBundleSchema>;

const existingEdgeSchema = correlationEdgeSchema;
type ExistingEdge = z.infer<typeof existingEdgeSchema>;

const listCandidatesResponseSchema = z.object({ candidates: z.array(candidateSchema) });
const correlationDeltaResponseSchema = z.object({
  hasAdditionalCandidates: z.boolean(),
  hasPendingRecovery: z.boolean().default(false),
});

const correlationContextSchema = z.object({
  focusEvidenceId: bytes32Schema,
  workflowRunDbId: z.string().uuid(),
  onchainWorkflowId: bytes32Schema,
  correlationPolicyVersion: z.string().min(1),
  existingEdges: z.array(existingEdgeSchema).default([]),
  evidences: z.array(evidenceBundleSchema).min(1),
});

type CorrelationContext = z.infer<typeof correlationContextSchema>;

const documentChunkResponseSchema = z.object({
  evidenceId: bytes32Schema,
  chunkIndex: z.number().int().nonnegative(),
  dataBase64: z.string(),
});

const persistVerificationResponseSchema = z.object({
  ok: z.boolean(),
  runStatus: z.literal("SUCCEEDED"),
});
const confirmMatchResponseSchema = z.object({ ok: z.boolean() });
const persistBalanceResponseSchema = z.object({ ok: z.boolean() });

const actionRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("RUN_CORRELATION") }),
  z.object({
    action: z.literal("CALCULATE_CHAIN_BALANCE"),
    chainId: z.string().min(1).optional(),
    input: workflowInputSchema.optional(),
  }),
]);

const balanceContextResponseSchema = z.object({
  input: workflowInputSchema,
  evidences: z.array(evidenceBundleSchema).min(1),
});

const configSchema = z.object({
  publicKey: z.string(),
  // Same control-plane URL already present in the original working workflow.
  // All HTTP access below still happens from TeeRuntime inside handlerInTee.
  // Keep compatibility with the original staging config/CRE parser.
  // The previous working workflow intentionally treated this as a plain string;
  // URL composition is performed at request time inside the TeeRuntime.
  supabaseUrl: z.string().min(1),
  secretNamespace: z.string(),
  chainSelectorName: z.string(),
  contractAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  gasLimit: z.string().regex(/^\d+$/),
  correlationSchedule: z.string().min(1).optional(),
});

type Config = z.infer<typeof configSchema>;
type WorkflowInput = z.infer<typeof workflowInputSchema>;
type Stream = WorkflowInput["streams"][number];
type Analysis = Stream["analyses"][number];
type Point = InstanceType<typeof secp256k1.ProjectivePoint>;
type Fraction = { numerator: bigint; denominator: bigint };
type ElementTotals = { inputMg: bigint; outputMg: bigint; mufMg: bigint };
type BalanceVerdict = "CONFORME" | "DIVERGENTE" | "NAO_ATESTADO";
type CusumState = { cumufMg: bigint; positiveMg: bigint; negativeMg: bigint; alarm: boolean };

type BitOrProof = {
  weight: string;
  commitment: string;
  t0: string;
  t1: string;
  c0: string;
  c1: string;
  s0: string;
  s1: string;
};

type BoundedRangeProof = {
  protocol: "PEDERSEN_BIT_OR_RANGE_V1";
  upperBound: string;
  bitLength: number;
  valueCommitment: string;
  complementCommitment: string;
  sumBlind: string;
  valueBits: BitOrProof[];
  complementBits: BitOrProof[];
};

const CURVE_ORDER = secp256k1.CURVE.n;
const G = secp256k1.ProjectivePoint.BASE;
const H = secp256k1.ProjectivePoint.fromAffine(
  hashToCurve(new TextEncoder().encode("ExploreChem/Pedersen/H/v1")).toAffine(),
);
const ZERO_POINT = secp256k1.ProjectivePoint.ZERO;
const MILLIGRAMS_PER_KILOGRAM = 1000000n;

const EXPLORERCHEM_READ_ABI = [
  {
    type: "function",
    name: "expectedWorkflowId",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "expectedBalanceWorkflowId",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "expectedAuditWorkflowId",
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


type OnchainEvidence = {
  evidenceId: Hex;
  actorId: Hex;
  submittedBy: Address;
  evidenceHash: Hex;
  status: number;
  createdAt: bigint;
  matchedAt: bigint;
  auditedAt: bigint;
};

function mod(value: bigint): bigint {
  const reduced = value % CURVE_ORDER;
  return reduced >= 0n ? reduced : reduced + CURVE_ORDER;
}

function multiply(point: Point, scalar: bigint): Point {
  const normalized = mod(scalar);
  return normalized === 0n ? ZERO_POINT : point.multiply(normalized);
}

function pointHex(point: Point): string {
  return point.equals(ZERO_POINT) ? "00" : point.toHex(true);
}

function scalarHex(value: bigint): string {
  return mod(value).toString(16).padStart(64, "0");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const objectValue = value as Record<string, unknown>;
  const keys = Object.keys(objectValue).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableJson(objectValue[key])}`)
    .join(",")}}`;
}

function hashText(value: string): Hex {
  return keccak256(toHex(value));
}

function deriveScalar(masterKey: string, label: string): bigint {
  const scalar = mod(BigInt(hashText(`ExploreChem/Scalar/v1|${masterKey}|${label}`)));
  return scalar === 0n ? 1n : scalar;
}

function challengeScalar(parts: string[]): bigint {
  return mod(BigInt(hashText(`ExploreChem/RangeChallenge/v1|${parts.join("|")}`)));
}

function parseDecimal(value: string): Fraction {
  const [whole, fractional = ""] = value.split(".");
  const denominator = 10n ** BigInt(fractional.length);
  return {
    numerator: BigInt(`${whole}${fractional}`),
    denominator,
  };
}

function multiplyFractions(...values: Fraction[]): Fraction {
  return values.reduce(
    (acc, item) => ({
      numerator: acc.numerator * item.numerator,
      denominator: acc.denominator * item.denominator,
    }),
    { numerator: 1n, denominator: 1n },
  );
}

function divideFractions(left: Fraction, right: Fraction): Fraction {
  if (right.numerator === 0n) throw new Error("divisão por zero");
  return {
    numerator: left.numerator * right.denominator,
    denominator: left.denominator * right.numerator,
  };
}

function subtractFractions(left: Fraction, right: Fraction): Fraction {
  return {
    numerator: left.numerator * right.denominator - right.numerator * left.denominator,
    denominator: left.denominator * right.denominator,
  };
}

function roundHalfUp(value: Fraction): bigint {
  if (value.numerator < 0n) {
    return -roundHalfUp({ numerator: -value.numerator, denominator: value.denominator });
  }
  const quotient = value.numerator / value.denominator;
  const remainder = value.numerator % value.denominator;
  return remainder * 2n >= value.denominator ? quotient + 1n : quotient;
}

function decimalBetween(value: string, min: bigint, maxExclusive: bigint): boolean {
  const parsed = parseDecimal(value);
  return (
    parsed.numerator >= min * parsed.denominator &&
    parsed.numerator < maxExclusive * parsed.denominator
  );
}

function decimalAtMost(value: string, maximum: bigint): boolean {
  const parsed = parseDecimal(value);
  return parsed.numerator <= maximum * parsed.denominator;
}

function dryOrReferenceMassKg(stream: Stream): Fraction {
  const gross = parseDecimal(stream.grossMassKg);

  if (stream.basis === "DRY_105C" || stream.basis === "LIQUIDO_TOTAL") return gross;

  if (stream.basis === "AS_RECEIVED") {
    if (
      stream.moisturePct === null ||
      stream.dryingTemperatureC === null ||
      stream.moistureSamplingTimestamp === null ||
      stream.determinationIntervalHours === null
    ) {
      throw new Error(`corrente ${stream.streamId}: campos de umidade incompletos`);
    }
    if (!decimalBetween(stream.moisturePct, 0n, 100n)) {
      throw new Error(`corrente ${stream.streamId}: umidade fora de [0,100)`);
    }
    if (
      !decimalBetween(stream.dryingTemperatureC, 100n, 111n) ||
      !decimalAtMost(stream.dryingTemperatureC, 110n)
    ) {
      throw new Error(`corrente ${stream.streamId}: secagem deve estar entre 100 e 110 °C`);
    }
    const dryFraction = subtractFractions(
      { numerator: 1n, denominator: 1n },
      divideFractions(parseDecimal(stream.moisturePct), { numerator: 100n, denominator: 1n }),
    );
    return multiplyFractions(gross, dryFraction);
  }

  if (
    stream.lossOnIgnitionPct === null ||
    stream.ignitionTemperatureC === null ||
    stream.atmosphere === null ||
    stream.residenceTimeMinutes === null
  ) {
    throw new Error(`corrente ${stream.streamId}: campos de perda por ignição incompletos`);
  }
  if (!decimalBetween(stream.lossOnIgnitionPct, 0n, 100n)) {
    throw new Error(`corrente ${stream.streamId}: perda por ignição fora de [0,100)`);
  }
  if (
    stream.type === "PRODUTO" &&
    (stream.coolingCondition === null || stream.timeBetweenIgnitionAndWeighingMinutes === null)
  ) {
    throw new Error(`corrente ${stream.streamId}: resfriamento do produto calcinado incompleto`);
  }
  const retainedFraction = subtractFractions(
    { numerator: 1n, denominator: 1n },
    divideFractions(parseDecimal(stream.lossOnIgnitionPct), { numerator: 100n, denominator: 1n }),
  );
  return divideFractions(gross, retainedFraction);
}

function validateAnalysis(stream: Stream, analysis: Analysis): void {
  const referenceBasis = stream.basis === "LIQUIDO_TOTAL" ? "LIQUIDO_TOTAL" : "DRY_105C";
  if (analysis.basis !== referenceBasis) {
    throw new Error(
      `corrente ${stream.streamId}: teor de ${analysis.element} deve estar em ${referenceBasis}`,
    );
  }
  const factor = OXIDE_FACTORS[analysis.oxideFormula];
  if (factor.element !== null && factor.element !== analysis.element) {
    throw new Error(`corrente ${stream.streamId}: fórmula ${analysis.oxideFormula} inválida para ${analysis.element}`);
  }
  if (analysis.unit === "PERCENT" && analysis.denominatorPurity !== "MASSA_SECA") {
    throw new Error(`corrente ${stream.streamId}: percentual deve usar MASSA_SECA no MVP`);
  }
  if (stream.basis === "LIQUIDO_TOTAL" && analysis.unit !== "MG_PER_KG") {
    throw new Error(`corrente ${stream.streamId}: líquido total deve usar MG_PER_KG`);
  }
  if (analysis.oxideFormula === "ELEMENTAR_DIRETO" && analysis.unit !== "MG_PER_KG") {
    throw new Error(`corrente ${stream.streamId}: ELEMENTAR_DIRETO deve usar MG_PER_KG`);
  }
}

function elementalMassMg(stream: Stream, analysis: Analysis): bigint {
  validateAnalysis(stream, analysis);
  const massKg = dryOrReferenceMassKg(stream);
  const reported = parseDecimal(analysis.reportedValue);
  const factor = OXIDE_FACTORS[analysis.oxideFormula];
  const factorFraction = { numerator: factor.numerator, denominator: factor.denominator };

  if (analysis.unit === "PERCENT") {
    return roundHalfUp(
      multiplyFractions(
        massKg,
        { numerator: MILLIGRAMS_PER_KILOGRAM, denominator: 1n },
        divideFractions(reported, { numerator: 100n, denominator: 1n }),
        factorFraction,
      ),
    );
  }

  return roundHalfUp(multiplyFractions(massKg, reported, factorFraction));
}

function emptyTotals(): Record<Element, ElementTotals> {
  return Object.fromEntries(
    ELEMENTS.map((element) => [element, { inputMg: 0n, outputMg: 0n, mufMg: 0n }]),
  ) as Record<Element, ElementTotals>;
}

function calculateBalance(input: WorkflowInput) {
  const totals = emptyTotals();
  const nodeTotals: Record<string, Record<Element, ElementTotals>> = {};
  const streamValues: Array<{
    streamId: string;
    evidenceId: Hex;
    evidenceHash: Hex;
    measurementPoint: string;
    type: Stream["type"];
    valuesMg: Record<Element, bigint>;
  }> = [];

  for (const stream of input.streams) {
    const valuesMg = Object.fromEntries(
      ELEMENTS.map((element) => {
        const analysis = stream.analyses.find((item) => item.element === element)!;
        return [element, elementalMassMg(stream, analysis)];
      }),
    ) as Record<Element, bigint>;

    const node = nodeTotals[stream.measurementPoint] ?? emptyTotals();
    nodeTotals[stream.measurementPoint] = node;

    for (const element of ELEMENTS) {
      const value = valuesMg[element];
      if (stream.type === "ENTRADA") {
        totals[element].inputMg += value;
        node[element].inputMg += value;
      } else {
        totals[element].outputMg += value;
        node[element].outputMg += value;
      }
    }

    streamValues.push({
      streamId: stream.streamId,
      evidenceId: stream.evidenceId,
      evidenceHash: stream.evidenceHash,
      measurementPoint: stream.measurementPoint,
      type: stream.type,
      valuesMg,
    });
  }

  for (const element of ELEMENTS) {
    totals[element].mufMg = totals[element].inputMg - totals[element].outputMg;
  }
  for (const node of Object.values(nodeTotals)) {
    for (const element of ELEMENTS) {
      node[element].mufMg = node[element].inputMg - node[element].outputMg;
    }
  }

  return { totals, nodeTotals, streamValues };
}

function thresholdMg(k: string, sigmaMg: string): bigint {
  return roundHalfUp(multiplyFractions(parseDecimal(k), { numerator: BigInt(sigmaMg), denominator: 1n }));
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function maximum(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}

function calculateCusum(input: WorkflowInput, totals: Record<Element, ElementTotals>): Record<Element, CusumState> {
  // Retained as a revision-to-revision monitoring signal for compatibility.
  // It is NOT a time-period filter and does not define correlation membership.
  return Object.fromEntries(
    ELEMENTS.map((element) => {
      const muf = totals[element].mufMg;
      const allowance = BigInt(input.parameters.cusumAllowanceMg[element]);
      const decisionInterval = BigInt(input.parameters.cusumDecisionIntervalMg[element]);
      const previousPositive = BigInt(input.history.cusumPositiveMg[element]);
      const previousNegative = BigInt(input.history.cusumNegativeMg[element]);
      const positive = maximum(0n, previousPositive + muf - allowance);
      const negative = maximum(0n, previousNegative - muf - allowance);
      return [
        element,
        {
          cumufMg: BigInt(input.history.cumufMg[element]) + muf,
          positiveMg: positive,
          negativeMg: negative,
          alarm: input.chain.calculationVersion >= 2 && (positive > decisionInterval || negative > decisionInterval),
        },
      ];
    }),
  ) as Record<Element, CusumState>;
}

function commitment(value: bigint, blind: bigint): Point {
  return multiply(G, value).add(multiply(H, blind));
}

function bitLengthFor(upperBound: bigint): number {
  let bits = 1;
  let ceiling = 2n;
  while (ceiling <= upperBound) {
    bits += 1;
    ceiling <<= 1n;
  }
  return bits;
}

function proveBit(
  masterKey: string,
  label: string,
  bit: 0 | 1,
  weight: bigint,
  blind: bigint,
): BitOrProof {
  const c = commitment(bit === 1 ? weight : 0n, blind);
  const statement0 = c;
  const statement1 = c.subtract(multiply(G, weight));
  let c0: bigint;
  let c1: bigint;
  let s0: bigint;
  let s1: bigint;
  let t0: Point;
  let t1: Point;

  if (bit === 0) {
    const witnessNonce = deriveScalar(masterKey, `${label}|witness`);
    c1 = deriveScalar(masterKey, `${label}|fake-c1`);
    s1 = deriveScalar(masterKey, `${label}|fake-s1`);
    t0 = multiply(H, witnessNonce);
    t1 = multiply(H, s1).subtract(multiply(statement1, c1));
    const challenge = challengeScalar([label, weight.toString(), pointHex(c), pointHex(t0), pointHex(t1)]);
    c0 = mod(challenge - c1);
    s0 = mod(witnessNonce + c0 * blind);
  } else {
    const witnessNonce = deriveScalar(masterKey, `${label}|witness`);
    c0 = deriveScalar(masterKey, `${label}|fake-c0`);
    s0 = deriveScalar(masterKey, `${label}|fake-s0`);
    t0 = multiply(H, s0).subtract(multiply(statement0, c0));
    t1 = multiply(H, witnessNonce);
    const challenge = challengeScalar([label, weight.toString(), pointHex(c), pointHex(t0), pointHex(t1)]);
    c1 = mod(challenge - c0);
    s1 = mod(witnessNonce + c1 * blind);
  }

  return {
    weight: weight.toString(),
    commitment: pointHex(c),
    t0: pointHex(t0),
    t1: pointHex(t1),
    c0: scalarHex(c0),
    c1: scalarHex(c1),
    s0: scalarHex(s0),
    s1: scalarHex(s1),
  };
}

function proveBits(
  masterKey: string,
  label: string,
  value: bigint,
  totalBlind: bigint,
  bitLength: number,
): BitOrProof[] {
  const blinds: bigint[] = [];
  let accumulated = 0n;
  for (let index = 0; index < bitLength - 1; index += 1) {
    const blind = deriveScalar(masterKey, `${label}|blind|${index}`);
    blinds.push(blind);
    accumulated = mod(accumulated + blind);
  }
  blinds.push(mod(totalBlind - accumulated));

  return Array.from({ length: bitLength }, (_, index) => {
    const weight = 1n << BigInt(index);
    const bit = Number((value >> BigInt(index)) & 1n) as 0 | 1;
    return proveBit(masterKey, `${label}|bit|${index}`, bit, weight, blinds[index]);
  });
}

function pointFromHex(value: string): Point {
  if (value === "00") return ZERO_POINT;
  return secp256k1.ProjectivePoint.fromHex(value);
}

function scalarFromHex(value: string): bigint {
  return BigInt(`0x${value}`);
}

function verifyBit(label: string, proof: BitOrProof): boolean {
  const weight = BigInt(proof.weight);
  const c = pointFromHex(proof.commitment);
  const t0 = pointFromHex(proof.t0);
  const t1 = pointFromHex(proof.t1);
  const c0 = scalarFromHex(proof.c0);
  const c1 = scalarFromHex(proof.c1);
  const s0 = scalarFromHex(proof.s0);
  const s1 = scalarFromHex(proof.s1);
  const statement0 = c;
  const statement1 = c.subtract(multiply(G, weight));
  const challenge = challengeScalar([label, weight.toString(), pointHex(c), pointHex(t0), pointHex(t1)]);
  return (
    mod(c0 + c1) === challenge &&
    multiply(H, s0).equals(t0.add(multiply(statement0, c0))) &&
    multiply(H, s1).equals(t1.add(multiply(statement1, c1)))
  );
}

function sumBitCommitments(proofs: BitOrProof[]): Point {
  return proofs.reduce((sum, proof) => sum.add(pointFromHex(proof.commitment)), ZERO_POINT);
}

function proveBoundedRange(
  masterKey: string,
  label: string,
  value: bigint,
  upperBound: bigint,
  valueBlind: bigint,
): BoundedRangeProof {
  if (value < 0n || value > upperBound) throw new Error(`${label}: valor fora do intervalo`);
  const complement = upperBound - value;
  const bitLength = bitLengthFor(upperBound);
  const complementBlind = deriveScalar(masterKey, `${label}|complement-blind`);
  const valueBits = proveBits(masterKey, `${label}|value`, value, valueBlind, bitLength);
  const complementBits = proveBits(masterKey, `${label}|complement`, complement, complementBlind, bitLength);
  const proof: BoundedRangeProof = {
    protocol: "PEDERSEN_BIT_OR_RANGE_V1",
    upperBound: upperBound.toString(),
    bitLength,
    valueCommitment: pointHex(commitment(value, valueBlind)),
    complementCommitment: pointHex(commitment(complement, complementBlind)),
    sumBlind: scalarHex(valueBlind + complementBlind),
    valueBits,
    complementBits,
  };
  if (!verifyBoundedRange(label, proof)) throw new Error(`${label}: prova de intervalo interna inválida`);
  return proof;
}

function verifyBoundedRange(label: string, proof: BoundedRangeProof): boolean {
  if (proof.valueBits.length !== proof.bitLength || proof.complementBits.length !== proof.bitLength) {
    return false;
  }
  for (let index = 0; index < proof.bitLength; index += 1) {
    if (!verifyBit(`${label}|value|bit|${index}`, proof.valueBits[index])) return false;
    if (!verifyBit(`${label}|complement|bit|${index}`, proof.complementBits[index])) return false;
  }
  const valueCommitment = pointFromHex(proof.valueCommitment);
  const complementCommitment = pointFromHex(proof.complementCommitment);
  if (!sumBitCommitments(proof.valueBits).equals(valueCommitment)) return false;
  if (!sumBitCommitments(proof.complementBits).equals(complementCommitment)) return false;
  const upperBound = BigInt(proof.upperBound);
  return valueCommitment
    .add(complementCommitment)
    .equals(multiply(G, upperBound).add(multiply(H, scalarFromHex(proof.sumBlind))));
}

function streamSign(type: Stream["type"]): bigint {
  return type === "ENTRADA" ? 1n : -1n;
}

function buildCryptography(
  input: WorkflowInput,
  masterKey: string,
  calculation: ReturnType<typeof calculateBalance>,
  aggregateStatusByElement: Record<Element, BalanceVerdict>,
  statusByNode: Record<string, Record<Element, BalanceVerdict>>,
) {
  return Object.fromEntries(
    ELEMENTS.map((element) => {
      const commitmentsByStream = new Map<string, { blind: bigint; commitment: Point }>();
      let aggregateBlind = 0n;
      let aggregateCommitment = ZERO_POINT;

      const streamCommitments = calculation.streamValues.map((stream) => {
        const blind = deriveScalar(
          masterKey,
          `${input.chain.chainId}|${input.chain.calculationVersion}|${element}|${stream.streamId}`,
        );
        const currentCommitment = commitment(stream.valuesMg[element], blind);
        commitmentsByStream.set(stream.streamId, { blind, commitment: currentCommitment });
        const sign = streamSign(stream.type);
        aggregateBlind = mod(aggregateBlind + sign * blind);
        aggregateCommitment = sign === 1n
          ? aggregateCommitment.add(currentCommitment)
          : aggregateCommitment.subtract(currentCommitment);
        return {
          streamId: stream.streamId,
          evidenceId: stream.evidenceId,
          measurementPoint: stream.measurementPoint,
          commitment: pointHex(currentCommitment),
        };
      });

      const aggregateResidual = calculation.totals[element].mufMg;
      const aggregateResidualCommitment = commitment(aggregateResidual, aggregateBlind);
      if (!aggregateCommitment.subtract(aggregateResidualCommitment).equals(ZERO_POINT)) {
        throw new Error(`${element}: identidade homomórfica agregada inválida`);
      }

      const aggregateStatus = aggregateStatusByElement[element];
      const narrowBound = thresholdMg(
        input.parameters.coverageFactorK,
        input.parameters.sigmaMg[element],
      );
      const aggregateBound = aggregateStatus === "CONFORME"
        ? narrowBound
        : BigInt(input.parameters.bMaxMg[element]);
      const aggregateRangeProof = aggregateStatus === "NAO_ATESTADO"
        ? null
        : proveBoundedRange(
            masterKey,
            `${input.chain.chainId}|${input.chain.calculationVersion}|${element}|AGGREGATE|${aggregateStatus}`,
            aggregateResidual + aggregateBound,
            2n * aggregateBound,
            aggregateBlind,
          );

      const transformations = Object.fromEntries(
        Object.keys(calculation.nodeTotals)
          .sort()
          .map((measurementPoint) => {
            let blindSum = 0n;
            let commitmentSum = ZERO_POINT;
            const nodeStreams = calculation.streamValues
              .filter((stream) => stream.measurementPoint === measurementPoint)
              .map((stream) => {
                const stored = commitmentsByStream.get(stream.streamId)!;
                const sign = streamSign(stream.type);
                blindSum = mod(blindSum + sign * stored.blind);
                commitmentSum = sign === 1n
                  ? commitmentSum.add(stored.commitment)
                  : commitmentSum.subtract(stored.commitment);
                return {
                  streamId: stream.streamId,
                  evidenceId: stream.evidenceId,
                  commitment: pointHex(stored.commitment),
                };
              });

            const residual = calculation.nodeTotals[measurementPoint][element].mufMg;
            const residualCommitment = commitment(residual, blindSum);
            if (!commitmentSum.subtract(residualCommitment).equals(ZERO_POINT)) {
              throw new Error(`${element}/${measurementPoint}: identidade homomórfica inválida`);
            }

            const nodeStatus = statusByNode[measurementPoint][element];
            if (nodeStatus === "NAO_ATESTADO") {
              return [
                measurementPoint,
                {
                  residualMg: residual.toString(),
                  residualCommitment: pointHex(residualCommitment),
                  streamCommitments: nodeStreams,
                  status: nodeStatus,
                  proofPath: "NONE",
                  rangeProof: null,
                },
              ];
            }

            const bound = nodeStatus === "CONFORME"
              ? narrowBound
              : BigInt(input.parameters.bMaxMg[element]);
            const shiftedResidual = residual + bound;
            const rangeProof = proveBoundedRange(
              masterKey,
              `${input.chain.chainId}|${input.chain.calculationVersion}|${element}|${measurementPoint}|${nodeStatus}`,
              shiftedResidual,
              2n * bound,
              blindSum,
            );
            const expectedShiftedCommitment = residualCommitment.add(multiply(G, bound));
            if (!pointFromHex(rangeProof.valueCommitment).equals(expectedShiftedCommitment)) {
              throw new Error(`${element}/${measurementPoint}: compromisso deslocado inválido`);
            }

            return [
              measurementPoint,
              {
                residualMg: residual.toString(),
                residualCommitment: pointHex(residualCommitment),
                streamCommitments: nodeStreams,
                status: nodeStatus,
                proofPath: nodeStatus === "CONFORME" ? "NARROW" : "WIDE",
                rangeProof,
              },
            ];
          }),
      );

      return [
        element,
        {
          generator: "secp256k1-hash-to-curve:ExploreChem/Pedersen/H/v1",
          aggregateResidualMg: aggregateResidual.toString(),
          aggregateResidualCommitment: pointHex(aggregateResidualCommitment),
          aggregateStatus,
          aggregateRangeProof,
          streamCommitments,
          transformations,
        },
      ];
    }),
  );
}

function serializableTotals(totals: Record<Element, ElementTotals>) {
  return Object.fromEntries(
    ELEMENTS.map((element) => [
      element,
      {
        inputMg: totals[element].inputMg.toString(),
        outputMg: totals[element].outputMg.toString(),
        mufMg: totals[element].mufMg.toString(),
      },
    ]),
  );
}

function serializableNodeTotals(
  nodeTotals: Record<string, Record<Element, ElementTotals>>,
) {
  return Object.fromEntries(
    Object.keys(nodeTotals)
      .sort()
      .map((measurementPoint) => [measurementPoint, serializableTotals(nodeTotals[measurementPoint])]),
  );
}

function serializableCusum(cusum: Record<Element, CusumState>) {
  return Object.fromEntries(
    ELEMENTS.map((element) => [
      element,
      {
        cumufMg: cusum[element].cumufMg.toString(),
        positiveMg: cusum[element].positiveMg.toString(),
        negativeMg: cusum[element].negativeMg.toString(),
        alarm: cusum[element].alarm,
      },
    ]),
  );
}

function classifyResidual(
  input: WorkflowInput,
  element: Element,
  residualMg: bigint,
): BalanceVerdict {
  const narrowBound = thresholdMg(
    input.parameters.coverageFactorK,
    input.parameters.sigmaMg[element],
  );
  const maximumBound = BigInt(input.parameters.bMaxMg[element]);
  if (maximumBound < narrowBound) throw new Error(`${element}: B_max menor que k.sigma`);
  const absoluteResidual = absolute(residualMg);
  return absoluteResidual <= narrowBound
    ? "CONFORME"
    : absoluteResidual <= maximumBound
      ? "DIVERGENTE"
      : "NAO_ATESTADO";
}

function worstVerdict(values: BalanceVerdict[]): BalanceVerdict {
  if (values.includes("NAO_ATESTADO")) return "NAO_ATESTADO";
  if (values.includes("DIVERGENTE")) return "DIVERGENTE";
  return "CONFORME";
}

function determineStatuses(
  input: WorkflowInput,
  calculation: ReturnType<typeof calculateBalance>,
): {
  statusByElement: Record<Element, BalanceVerdict>;
  aggregateStatusByElement: Record<Element, BalanceVerdict>;
  statusByNode: Record<string, Record<Element, BalanceVerdict>>;
  overallStatus: BalanceVerdict;
} {
  const statusByNode = Object.fromEntries(
    Object.keys(calculation.nodeTotals)
      .sort()
      .map((measurementPoint) => [
        measurementPoint,
        Object.fromEntries(
          ELEMENTS.map((element) => [
            element,
            classifyResidual(input, element, calculation.nodeTotals[measurementPoint][element].mufMg),
          ]),
        ) as Record<Element, BalanceVerdict>,
      ]),
  ) as Record<string, Record<Element, BalanceVerdict>>;

  const aggregateStatusByElement = Object.fromEntries(
    ELEMENTS.map((element) => [
      element,
      classifyResidual(input, element, calculation.totals[element].mufMg),
    ]),
  ) as Record<Element, BalanceVerdict>;

  // The chain verdict is intentionally node-aware. Opposite residuals from two
  // different transformations are never allowed to cancel into a false
  // CONFORME result. The aggregate residual is kept for audit/CUSUM only.
  const statusByElement = Object.fromEntries(
    ELEMENTS.map((element) => [
      element,
      worstVerdict(Object.values(statusByNode).map((node) => node[element])),
    ]),
  ) as Record<Element, BalanceVerdict>;

  return {
    statusByElement,
    aggregateStatusByElement,
    statusByNode,
    overallStatus: worstVerdict(ELEMENTS.map((element) => statusByElement[element])),
  };
}



function getSupabaseServiceRoleKey(runtime: TeeRuntime<Config>): string {
  const secrets = runtime
    .getSecrets([
      { id: "SUPABASE_SERVICE_ROLE_KEY", namespace: runtime.config.secretNamespace },
    ])
    .result();
  const key = secrets.SUPABASE_SERVICE_ROLE_KEY?.value;
  if (!key) throw new Error("segredo SUPABASE_SERVICE_ROLE_KEY ausente");
  return key;
}

type SupabaseMethod = "GET" | "POST" | "PATCH";

function supabaseRequestRaw(
  runtime: TeeRuntime<Config>,
  serviceRoleKey: string,
  path: string,
  method: SupabaseMethod,
  body?: unknown,
  extraHeaders?: Record<string, { values: string[] }>,
) {
  const baseHeaders = {
    apikey: { values: [serviceRoleKey] },
    authorization: { values: [`Bearer ${serviceRoleKey}`] },
    accept: { values: ["application/json"] },
    ...extraHeaders,
  };

  const request = body === undefined
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

  const response = new HTTPClient().sendRequest(runtime, request).result();
  if (!ok(response)) {
    throw new Error(`Supabase ${method} ${path} falhou (${response.statusCode}): ${text(response)}`);
  }
  return response;
}

function supabaseJson<T>(
  runtime: TeeRuntime<Config>,
  serviceRoleKey: string,
  path: string,
  method: SupabaseMethod = "GET",
  body?: unknown,
  extraHeaders?: Record<string, { values: string[] }>,
): T {
  const response = supabaseRequestRaw(
    runtime,
    serviceRoleKey,
    path,
    method,
    body,
    extraHeaders,
  );
  const raw = text(response);
  return (raw.length === 0 ? null : JSON.parse(raw)) as T;
}

const supabaseActorRowSchema = z.object({
  id: z.string().uuid(),
  actor_id: bytes32Schema,
  display_name: z.string().min(1),
  actor_type: actorTypeSchema,
});
type SupabaseActorRow = z.infer<typeof supabaseActorRowSchema>;

const supabaseEvidenceRowSchema = z.object({
  evidence_id: bytes32Schema,
  actor_db_id: z.string().uuid(),
  state: z.enum(["PENDING", "MATCHED", "VERIFIED", "DIVERGENT"]),
  evidence_hash: bytes32Schema,
  hash_algorithm: z.enum(["KECCAK256", "SHA-256", "SHA256", "KECCAK-256"]),
  storage_bucket: z.string().min(1),
  storage_path: z.string().min(1),
  original_filename: z.string().min(1),
  mime_type: z.string().min(1),
  size_bytes: z.union([z.number(), z.string()]).transform((value) => Number(value)),
  extractor_version: z.string().nullable(),
  chain_created_at: z.string().datetime({ offset: true }),
  matched_at: z.string().datetime({ offset: true }).nullable(),
  document_type: z.string().min(1),
  calculation_role: calculationRoleSchema,
  declared_lot_db_id: z.string().uuid().nullable(),
  verified_lot_db_id: z.string().uuid().nullable(),
});
type SupabaseEvidenceRow = z.infer<typeof supabaseEvidenceRowSchema>;

type ActorDirectory = {
  byDbId: Map<string, SupabaseActorRow>;
  byName: Map<string, Hex>;
};

function canonicalName(value: string): string {
  return value.trim().toLowerCase();
}

function loadActorDirectory(
  runtime: TeeRuntime<Config>,
  serviceRoleKey: string,
): ActorDirectory {
  const rows = z.array(supabaseActorRowSchema).parse(
    supabaseJson<unknown>(
      runtime,
      serviceRoleKey,
      "/rest/v1/explorerchem_actors?select=id,actor_id,display_name,actor_type&active=eq.true&order=created_at.asc",
    ),
  );
  return {
    byDbId: new Map(rows.map((row) => [row.id, row])),
    byName: new Map(rows.map((row) => [canonicalName(row.display_name), row.actor_id])),
  };
}

function listEvidenceRows(
  runtime: TeeRuntime<Config>,
  serviceRoleKey: string,
): SupabaseEvidenceRow[] {
  const select = [
    "evidence_id",
    "actor_db_id",
    "state",
    "evidence_hash",
    "hash_algorithm",
    "storage_bucket",
    "storage_path",
    "original_filename",
    "mime_type",
    "size_bytes",
    "extractor_version",
    "chain_created_at",
    "matched_at",
    "document_type",
    "calculation_role",
    "declared_lot_db_id",
    "verified_lot_db_id",
  ].join(",");
  const path = `/rest/v1/explorerchem_evidences?select=${select}&state=in.(PENDING,MATCHED,VERIFIED)&order=chain_created_at.asc,evidence_id.asc`;
  return z.array(supabaseEvidenceRowSchema).parse(
    supabaseJson<unknown>(runtime, serviceRoleKey, path),
  );
}

function encodeStoragePath(path: string): string {
  return path.split("/").map((part) => encodeURIComponent(part)).join("/");
}

function downloadEvidenceDocument(
  runtime: TeeRuntime<Config>,
  serviceRoleKey: string,
  row: SupabaseEvidenceRow,
): Uint8Array {
  // HTTP responses in the simulator are capped at 250 KiB. Use byte ranges so
  // larger evidence never needs one oversized response. JSON demo evidence is
  // tiny, but keeping this here preserves the same exact-byte hash semantics.
  const chunkSize = 200_000;
  const parts: Uint8Array[] = [];
  let total = 0;
  const objectPath = `/storage/v1/object/authenticated/${encodeURIComponent(row.storage_bucket)}/${encodeStoragePath(row.storage_path)}`;

  for (let start = 0; start < row.size_bytes; start += chunkSize) {
    const end = Math.min(start + chunkSize - 1, row.size_bytes - 1);
    const response = supabaseRequestRaw(
      runtime,
      serviceRoleKey,
      objectPath,
      "GET",
      undefined,
      {
        accept: { values: [row.mime_type] },
        range: { values: [`bytes=${start}-${end}`] },
      },
    );
    const bytes = new Uint8Array(response.body);
    // Some storage gateways may ignore Range and return the full object with
    // HTTP 200. Accept that exact response instead of downloading it again.
    if (start === 0 && bytes.length === row.size_bytes) return bytes;
    parts.push(bytes);
    total += bytes.length;
  }

  if (total !== row.size_bytes) {
    throw new Error(
      `${row.evidence_id}: tamanho do documento ${total} difere do size_bytes ${row.size_bytes}`,
    );
  }
  return concatBytes(parts, total);
}

function recordOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function integerString(value: unknown): string | null {
  if (typeof value === "bigint") return value >= 0n ? value.toString() : null;
  if (typeof value === "number") {
    return Number.isFinite(value) && Number.isInteger(value) && value >= 0
      ? value.toString()
      : null;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  return null;
}

function kgToMgString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const decimal = typeof value === "number" ? value.toString() : String(value);
  if (!/^\d+(?:\.\d+)?$/.test(decimal)) return null;
  return roundHalfUp(
    multiplyFractions(
      parseDecimal(decimal),
      { numerator: MILLIGRAMS_PER_KILOGRAM, denominator: 1n },
    ),
  ).toString();
}

function decimalString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    const text = value.toString();
    return /^\d+(?:\.\d+)?$/.test(text) ? text : null;
  }
  if (typeof value !== "string") return null;
  const text = value.trim();
  return /^\d+(?:\.\d+)?$/.test(text) ? text : null;
}

function basisValue(value: unknown): (typeof BASES)[number] | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  return (BASES as readonly string[]).includes(normalized)
    ? normalized as (typeof BASES)[number]
    : null;
}

function measurementRoleValue(value: unknown): AnalyticalMeasurement["measurementRole"] | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  return ["RECEIVING", "OUTGOING", "PROCESS", "UNSPECIFIED"].includes(normalized)
    ? normalized as AnalyticalMeasurement["measurementRole"]
    : null;
}

function assayBasisFromSample(sample: Record<string, unknown>): (typeof BASES)[number] {
  const explicit = basisValue(sample.assayBasis ?? sample.resultBasis);
  if (explicit) return explicit;
  // A sample received wet can still have its reported assay normalized to the
  // dry basis after a declared drying step. The original sample basis remains
  // preserved separately in laboratoryReport.
  if (decimalString(sample.dryingTemperatureC) !== null) return "DRY_105C";
  return basisValue(sample.massBasis) ?? "DRY_105C";
}

function actorIdFromValue(value: unknown, actors: ActorDirectory): Hex | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const trimmed = value.trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(trimmed)) return trimmed as Hex;
  return actors.byName.get(canonicalName(trimmed)) ?? null;
}

function eventTime(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

class EvidenceDivergenceError extends Error {
  readonly evidenceId: Hex;
  readonly code: string;

  constructor(evidenceId: Hex, code: string, message: string) {
    super(`${evidenceId}: ${code}: ${message}`);
    this.name = "EvidenceDivergenceError";
    this.evidenceId = evidenceId;
    this.code = code;
  }
}

function isEvidenceDivergenceError(error: unknown): error is EvidenceDivergenceError {
  return error instanceof EvidenceDivergenceError;
}

function allowedActorTypesForEvidenceType(value: unknown): ReadonlySet<z.infer<typeof actorTypeSchema>> | null {
  if (typeof value !== "string") return null;
  switch (value.trim().toUpperCase()) {
    case "ORIGIN_AND_QUANTITY":
      return new Set(["MINER"]);
    case "TRANSPORT_CUSTODY":
      return new Set(["CARRIER"]);
    case "ELEMENTAL_ANALYSIS":
      return new Set(["LABORATORY"]);
    case "TRANSFORMATION_RECORD":
      return new Set(["PROCESSOR", "REFINER"]);
    case "MANUFACTURING_RECORD":
      return new Set(["MANUFACTURER"]);
    case "RECYCLING_RECOVERY":
      return new Set(["RECYCLER"]);
    default:
      return null;
  }
}

function canonicalizeEvidenceJson(
  rawValue: unknown,
  row: SupabaseEvidenceRow,
  actors: ActorDirectory,
): NormalizedEvidence {
  const raw = recordOf(rawValue);
  const actor = actors.byDbId.get(row.actor_db_id);
  if (!actor) throw new Error(`${row.evidence_id}: actor_db_id não encontrado`);

  const declaredActorTypeRaw = nullableString(raw.actorType);
  if (declaredActorTypeRaw !== null) {
    const declaredActorType = actorTypeSchema.safeParse(declaredActorTypeRaw.trim().toUpperCase());
    if (!declaredActorType.success) {
      throw new EvidenceDivergenceError(
        row.evidence_id,
        "INVALID_ACTOR_TYPE",
        `actorType do documento é inválido: ${declaredActorTypeRaw}`,
      );
    }
    if (declaredActorType.data !== actor.actor_type) {
      throw new EvidenceDivergenceError(
        row.evidence_id,
        "ACTOR_TYPE_MISMATCH",
        `evento declara ${declaredActorType.data}, mas o vínculo atual da evidência é ${actor.actor_type}`,
      );
    }
  }

  const allowedTypes = allowedActorTypesForEvidenceType(raw.evidenceType ?? row.document_type);
  if (allowedTypes !== null && !allowedTypes.has(actor.actor_type)) {
    throw new EvidenceDivergenceError(
      row.evidence_id,
      "EVENT_ROLE_MISMATCH",
      `tipo de evento ${String(raw.evidenceType ?? row.document_type)} incompatível com ${actor.actor_type}`,
    );
  }

  // Event-first correlation: an actorId embedded in the document is not
  // authoritative correlation proof. The current submitter/actor context comes
  // from row.actor_db_id -> explorerchem_actors, while the event itself is
  // authenticated by the exact document bytes committed by evidenceHash.
  // Older documents may therefore carry a historical actorId without making
  // the new evidence/event invalid.

  const massBalance = recordOf(raw.massBalance);
  const custody = recordOf(raw.custody);
  const transformation = recordOf(raw.transformation);
  const recovery = recordOf(raw.recovery);
  const sample = recordOf(raw.sample);

  const analyticalMeasurements: AnalyticalMeasurement[] = [];
  const addNd2O3Measurement = (
    value: unknown,
    measurementRole: AnalyticalMeasurement["measurementRole"],
    sourceKind: AnalyticalMeasurement["sourceKind"],
    sourceField: string,
    basis: (typeof BASES)[number],
    method: string | null = null,
  ) => {
    const reportedValue = decimalString(value);
    if (reportedValue === null) return;
    analyticalMeasurements.push(analyticalMeasurementSchema.parse({
      element: "ND",
      oxideFormula: "ND2O3",
      reportedValue,
      unit: "PERCENT",
      basis,
      denominatorPurity: "MASSA_SECA",
      factorTableVersion: "1.0.0",
      measurementRole,
      sourceKind,
      sourceField,
      method,
    }));
  };

  // Outgoing assay/grade belongs to the material state produced by the actor.
  // It qualifies the next physical handoff but does not itself add mass.
  addNd2O3Measurement(
    massBalance.gradeNd2O3Pct,
    "OUTGOING",
    "DECLARED_ASSAY",
    "massBalance.gradeNd2O3Pct",
    basisValue(massBalance.massBasis) ?? "DRY_105C",
  );
  addNd2O3Measurement(
    transformation.outputProductGradePct,
    "OUTGOING",
    "PROCESS_ASSAY",
    "transformation.outputProductGradePct",
    basisValue(transformation.massBasis) ?? "DRY_105C",
  );
  addNd2O3Measurement(
    recovery.recoveredProductGradePct,
    "OUTGOING",
    "PROCESS_ASSAY",
    "recovery.recoveredProductGradePct",
    basisValue(recovery.massBasis) ?? "DRY_105C",
  );

  let laboratoryReport: z.infer<typeof laboratoryReportSchema> | null = null;
  if (actor.actor_type === "LABORATORY") {
    if (sample.contributesToMassBalance === true) {
      throw new EvidenceDivergenceError(
        row.evidence_id,
        "LAB_SAMPLE_PHYSICAL_FLOW",
        "amostra laboratorial não pode criar fluxo físico de massa",
      );
    }
    const method = nullableString(sample.analysisMethod);
    addNd2O3Measurement(
      sample.gradeNd2O3Pct,
      measurementRoleValue(sample.measurementRole ?? raw.measurementRole) ?? "UNSPECIFIED",
      "LAB_REPORT",
      "sample.gradeNd2O3Pct",
      assayBasisFromSample(sample),
      method,
    );
    laboratoryReport = laboratoryReportSchema.parse({
      sampleId: nullableString(sample.sampleId),
      sampleMassKg: decimalString(sample.sampleMassKg),
      massBasis: basisValue(sample.massBasis),
      analysisMethod: method,
      dryingTemperatureC: decimalString(sample.dryingTemperatureC),
      moisturePct: decimalString(sample.moisturePct),
      gradeNd2O3Pct: decimalString(sample.gradeNd2O3Pct),
      elementalNdPct: decimalString(sample.elementalNdPct),
      contributesToMassBalance: false,
    });
  }

  const elementalInputMg: ElementMasses = {};
  const elementalOutputMg: ElementMasses = {};
  const elementalScrapMg: ElementMasses = {};
  const elementalRecoveredMg: ElementMasses = {};

  const minerNd = integerString(massBalance.elementalNdMassMg);
  if (minerNd) elementalOutputMg.ND = minerNd;

  const inputNd = integerString(
    transformation.elementalNdInputMassMg ?? transformation.inputElementalNdMassMg,
  );
  if (inputNd) elementalInputMg.ND = inputNd;

  const outputNd = integerString(
    transformation.elementalNdOutputMassMg ?? transformation.elementalNdFinishedProductMassMg,
  );
  if (outputNd) elementalOutputMg.ND = outputNd;

  const scrapNd = integerString(transformation.elementalNdScrapMassMg);
  if (scrapNd) elementalScrapMg.ND = scrapNd;

  const recoveredNd = integerString(recovery.elementalNdRecoveredMassMg);
  if (recoveredNd) {
    elementalRecoveredMg.ND = recoveredNd;
    // For a recycler record this is also the best available elemental
    // statement about the accepted scrap input unless a separate assay exists.
    elementalInputMg.ND = elementalInputMg.ND ?? recoveredNd;
  }

  const grossMassMg = kgToMgString(
    massBalance.grossMassKg ?? raw.grossMassKg ?? raw.massKg,
  );
  const collectedMassMg = kgToMgString(custody.massCollectedKg ?? raw.collectedMassKg);
  const deliveredMassMg = kgToMgString(custody.massDeliveredKg ?? raw.deliveredMassKg);
  const inputMassMg = kgToMgString(
    transformation.inputMassKg ?? transformation.inputProductMassKg ?? recovery.inputMassKg ?? raw.inputMassKg,
  );
  const outputMassMg = kgToMgString(
    transformation.outputProductMassKg ?? transformation.finishedProductMassKg ?? recovery.recoveredProductMassKg ?? raw.outputMassKg,
  );
  const scrapMassMg = kgToMgString(transformation.scrapMassKg ?? raw.scrapMassKg);
  const recoveredMassMg = kgToMgString(recovery.recoveredProductMassKg ?? raw.recoveredMassKg);

  return normalizedEvidenceSchema.parse({
    actorType: actor.actor_type,
    calculationRole: row.calculation_role,
    originActorId: actorIdFromValue(raw.originActorId ?? raw.originActor, actors),
    destinationActorId: actorIdFromValue(raw.destinationActorId ?? raw.destinationActor, actors),
    carrierActorId: actorIdFromValue(raw.carrierActorId ?? raw.carrierActor, actors),
    originSite: nullableString(raw.originSite),
    destinationSite: nullableString(raw.destinationSite),
    lotReference: nullableString(raw.lotId ?? raw.lotReference),
    correlationGroupId: nullableString(raw.correlationGroupId),
    documentReference: nullableString(raw.documentRef ?? raw.documentReference),
    eventAt: eventTime(raw.timestamp ?? raw.eventAt),
    grossMassMg,
    collectedMassMg,
    deliveredMassMg,
    inputMassMg,
    outputMassMg,
    scrapMassMg,
    recoveredMassMg,
    elementalInputMg,
    elementalOutputMg,
    elementalScrapMg,
    elementalRecoveredMg,
    analyticalMeasurements,
    laboratoryReport,
  });
}

function loadEvidenceBundleDirect(
  runtime: TeeRuntime<Config>,
  serviceRoleKey: string,
  row: SupabaseEvidenceRow,
  actors: ActorDirectory,
): EvidenceBundle {
  const bytes = downloadEvidenceDocument(runtime, serviceRoleKey, row);
  const mime = row.mime_type.toLowerCase();
  if (!mime.includes("json")) {
    throw new Error(
      `${row.evidence_id}: correlação TEE direta exige JSON canônico neste MVP; ${row.mime_type} requer ExplorerAdapter/extrator`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new EvidenceDivergenceError(
      row.evidence_id,
      "INVALID_JSON",
      error instanceof Error ? error.message : "JSON inválido",
    );
  }
  const normalized = canonicalizeEvidenceJson(raw, row, actors);
  const extractorVersion = row.extractor_version ?? "explorechem-json-canonicalizer-v1";
  const extractionHash = hashStable({
    domain: "ExploreChem/Extraction/v1",
    extractorVersion,
    normalized,
  });

  return evidenceBundleSchema.parse({
    evidenceId: row.evidence_id,
    actorId: actors.byDbId.get(row.actor_db_id)!.actor_id,
    evidenceHash: row.evidence_hash,
    hashAlgorithm: row.hash_algorithm,
    mimeType: row.mime_type,
    document: {
      mode: "INLINE",
      dataBase64: Buffer.from(bytes).toString("base64"),
      sizeBytes: bytes.length,
    },
    extractorVersion,
    extractionHash,
    normalized,
  });
}

type DirectCorrelationSnapshot = {
  rows: SupabaseEvidenceRow[];
  actors: ActorDirectory;
  bundles: Map<string, EvidenceBundle>;
  bundleErrors: Map<string, string>;
  divergenceErrors: Map<string, string>;
};

function loadDirectCorrelationSnapshot(
  runtime: TeeRuntime<Config>,
  serviceRoleKey: string,
): DirectCorrelationSnapshot {
  const actors = loadActorDirectory(runtime, serviceRoleKey);
  const rows = listEvidenceRows(runtime, serviceRoleKey);
  const bundles = new Map<string, EvidenceBundle>();
  const bundleErrors = new Map<string, string>();
  const divergenceErrors = new Map<string, string>();
  const firstEvidenceByHash = new Map<string, Hex>();

  for (const row of rows) {
    const id = normalizeHex(row.evidence_id);
    const hashKey = normalizeHex(row.evidence_hash);
    const firstEvidenceId = firstEvidenceByHash.get(hashKey);
    if (firstEvidenceId !== undefined && row.state === "PENDING") {
      divergenceErrors.set(
        id,
        `${row.evidence_id}: DUPLICATE_DOCUMENT: evidenceHash idêntico ao evento anterior ${firstEvidenceId}`,
      );
      continue;
    }
    if (firstEvidenceId === undefined) firstEvidenceByHash.set(hashKey, row.evidence_id);

    try {
      bundles.set(
        id,
        loadEvidenceBundleDirect(runtime, serviceRoleKey, row, actors),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isEvidenceDivergenceError(error)) divergenceErrors.set(id, message);
      else bundleErrors.set(id, message);
    }
  }
  return { rows, actors, bundles, bundleErrors, divergenceErrors };
}

function loadBundlesByEvidenceIds(
  runtime: TeeRuntime<Config>,
  serviceRoleKey: string,
  evidenceIds: Hex[],
): EvidenceBundle[] {
  const wanted = new Set(evidenceIds.map(normalizeHex));
  const snapshot = loadDirectCorrelationSnapshot(runtime, serviceRoleKey);
  const bundles: EvidenceBundle[] = [];
  for (const id of wanted) {
    const bundle = snapshot.bundles.get(id);
    if (!bundle) {
      throw new Error(
        snapshot.divergenceErrors.get(id) ?? snapshot.bundleErrors.get(id) ?? `${id}: evidência não encontrada no Supabase`,
      );
    }
    bundles.push(bundle);
  }
  return bundles;
}

function patchEvidenceStateInSupabase(
  runtime: TeeRuntime<Config>,
  serviceRoleKey: string,
  evidenceId: Hex,
  patch: Record<string, unknown>,
): void {
  const path = `/rest/v1/explorerchem_evidences?evidence_id=eq.${encodeURIComponent(evidenceId)}`;
  const response = supabaseRequestRaw(
    runtime,
    serviceRoleKey,
    path,
    "PATCH",
    patch,
    { prefer: { values: ["return=representation"] } },
  );
  const raw = text(response);
  const updated = raw.length === 0 ? [] : JSON.parse(raw);
  if (!Array.isArray(updated) || updated.length !== 1) {
    throw new Error(`${evidenceId}: PATCH do Supabase atualizou ${Array.isArray(updated) ? updated.length : 0} linha(s)`);
  }
}

function reconcileMatchedInSupabase(
  runtime: TeeRuntime<Config>,
  serviceRoleKey: string,
  evidence: OnchainEvidence,
  transactionHash?: Hex,
): void {
  if (evidence.status !== 2 || evidence.matchedAt === 0n) {
    throw new Error(`${evidence.evidenceId}: Supabase só pode espelhar MATCHED já confirmado on-chain`);
  }
  const patch: Record<string, unknown> = {
    state: "MATCHED",
    matched_at: new Date(Number(evidence.matchedAt) * 1000).toISOString(),
  };
  if (transactionHash && normalizeHex(transactionHash) !== normalizeHex(zeroHash)) {
    patch.match_tx_hash = transactionHash;
  }
  patchEvidenceStateInSupabase(runtime, serviceRoleKey, evidence.evidenceId, patch);
}

function patchMatchedAfterReceiverSuccess(
  runtime: TeeRuntime<Config>,
  serviceRoleKey: string,
  row: SupabaseEvidenceRow,
  transactionHash: Hex,
): void {
  if (normalizeHex(transactionHash) === normalizeHex(zeroHash)) return;
  const matchedAt = new Date(runtime.now()).toISOString();
  patchEvidenceStateInSupabase(runtime, serviceRoleKey, row.evidence_id, {
    state: "MATCHED",
    matched_at: matchedAt,
    match_tx_hash: transactionHash,
  });
  row.state = "MATCHED";
  row.matched_at = matchedAt;
}

function patchDivergentInSupabaseBestEffort(
  runtime: TeeRuntime<Config>,
  serviceRoleKey: string,
  evidenceId: Hex,
  transactionHash?: Hex,
): void {
  try {
    const patch: Record<string, unknown> = { state: "DIVERGENT" };
    // Reuse the existing state-transition tx column in the MVP. The state tells
    // the UI whether this tx represents MATCHED or DIVERGENT.
    if (transactionHash && normalizeHex(transactionHash) !== normalizeHex(zeroHash)) {
      patch.match_tx_hash = transactionHash;
    }
    patchEvidenceStateInSupabase(runtime, serviceRoleKey, evidenceId, patch);
  } catch (error) {
    runtime.log(
      `${evidenceId}: aviso: não foi possível espelhar DIVERGENT no Supabase; ` +
      `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function getNetworkOrThrow(runtime: TeeRuntime<Config>) {
  const network = getNetwork({
    chainFamily: "evm",
    chainSelectorName: runtime.config.chainSelectorName,
    isTestnet: true,
  });
  if (!network) throw new Error(`rede CRE não encontrada: ${runtime.config.chainSelectorName}`);
  return network;
}

function readExpectedWorkflowId(
  runtime: TeeRuntime<Config>,
  reportType: 1 | 2 | 3,
): Hex {
  const network = getNetworkOrThrow(runtime);
  const donRuntime = runtime.usingTheDons();

  const readCorrelationWorkflowId = (): Hex => {
    const callData = encodeFunctionData({
      abi: EXPLORERCHEM_READ_ABI,
      functionName: "expectedWorkflowId",
    });
    const response = new EVMClient(network.chainSelector.selector)
      .callContract(donRuntime, {
        call: encodeCallMsg({
          from: zeroAddress,
          to: runtime.config.contractAddress as Address,
          data: callData,
        }),
        blockNumber: LATEST_BLOCK_NUMBER,
      })
      .result();
    return decodeFunctionResult({
      abi: EXPLORERCHEM_READ_ABI,
      functionName: "expectedWorkflowId",
      data: bytesToHex(response.data),
    });
  };

  const readBalanceWorkflowId = (): Hex => {
    const callData = encodeFunctionData({
      abi: EXPLORERCHEM_READ_ABI,
      functionName: "expectedBalanceWorkflowId",
    });
    const response = new EVMClient(network.chainSelector.selector)
      .callContract(donRuntime, {
        call: encodeCallMsg({
          from: zeroAddress,
          to: runtime.config.contractAddress as Address,
          data: callData,
        }),
        blockNumber: LATEST_BLOCK_NUMBER,
      })
      .result();
    return decodeFunctionResult({
      abi: EXPLORERCHEM_READ_ABI,
      functionName: "expectedBalanceWorkflowId",
      data: bytesToHex(response.data),
    });
  };

  const readAuditWorkflowId = (): Hex => {
    const callData = encodeFunctionData({
      abi: EXPLORERCHEM_READ_ABI,
      functionName: "expectedAuditWorkflowId",
    });
    const response = new EVMClient(network.chainSelector.selector)
      .callContract(donRuntime, {
        call: encodeCallMsg({
          from: zeroAddress,
          to: runtime.config.contractAddress as Address,
          data: callData,
        }),
        blockNumber: LATEST_BLOCK_NUMBER,
      })
      .result();
    return decodeFunctionResult({
      abi: EXPLORERCHEM_READ_ABI,
      functionName: "expectedAuditWorkflowId",
      data: bytesToHex(response.data),
    });
  };

  const correlationWorkflowId = readCorrelationWorkflowId();
  const expected = reportType === 2
    ? (() => {
        const balanceWorkflowId = readBalanceWorkflowId();
        return normalizeHex(balanceWorkflowId) === normalizeHex(zeroHash)
          ? correlationWorkflowId
          : balanceWorkflowId;
      })()
    : reportType === 3
      ? (() => {
          const auditWorkflowId = readAuditWorkflowId();
          return normalizeHex(auditWorkflowId) === normalizeHex(zeroHash)
            ? correlationWorkflowId
            : auditWorkflowId;
        })()
      : correlationWorkflowId;

  if (normalizeHex(expected) === normalizeHex(zeroHash)) {
    throw new Error(
      reportType === 1
        ? "ExploreChemRegistry.expectedWorkflowId está zero; configure o workflow CRE autorizado antes do broadcast"
        : reportType === 2
          ? "workflow de balanço não configurado; defina expectedWorkflowId ou expectedBalanceWorkflowId antes do broadcast"
          : "workflow de auditoria não configurado; defina expectedWorkflowId ou expectedAuditWorkflowId antes do broadcast",
    );
  }

  return expected;
}

function readOnchainEvidence(
  runtime: TeeRuntime<Config>,
  evidenceId: Hex,
  blockNumber = LAST_FINALIZED_BLOCK_NUMBER,
): OnchainEvidence {
  const network = getNetworkOrThrow(runtime);
  const callData = encodeFunctionData({
    abi: EXPLORERCHEM_READ_ABI,
    functionName: "getEvidence",
    args: [evidenceId],
  });
  const donRuntime = runtime.usingTheDons();
  const response = new EVMClient(network.chainSelector.selector)
    .callContract(donRuntime, {
      call: encodeCallMsg({
        from: zeroAddress,
        to: runtime.config.contractAddress as Address,
        data: callData,
      }),
      blockNumber,
    })
    .result();

  const decoded = decodeFunctionResult({
    abi: EXPLORERCHEM_READ_ABI,
    functionName: "getEvidence",
    data: bytesToHex(response.data),
  });

  return {
    evidenceId: decoded.evidenceId,
    actorId: decoded.actorId,
    submittedBy: decoded.submittedBy,
    evidenceHash: decoded.evidenceHash,
    status: Number(decoded.status),
    createdAt: decoded.createdAt,
    matchedAt: decoded.matchedAt,
    auditedAt: decoded.auditedAt,
  };
}

function shouldEvaluateOnchain(
  evidence: OnchainEvidence,
  nowMs: number,
  mode: CorrelationRunMode,
): { evaluate: true } | { evaluate: false; reason: string } {
  // Solidity enum: NONE=0, PENDING=1, MATCHED=2.
  //
  // PENDING is always eligible when a run is explicitly invoked. This is what
  // makes the demo button useful: a newly submitted evidence can be checked
  // immediately instead of waiting for the weekly scheduler.
  if (evidence.status === 1) {
    const createdAtMs = Number(evidence.createdAt) * 1000;
    if (nowMs - createdAtMs > PENDING_TTL_MS) {
      return { evaluate: false, reason: "PENDING_TTL_EXPIRED" };
    }
    return { evaluate: true };
  }

  if (evidence.status === 2) {
    const matchedAtMs = Number(evidence.matchedAt) * 1000;
    if (matchedAtMs <= 0) throw new Error(`${evidence.evidenceId}: MATCHED sem matchedAt`);

    // DEMO RULE: an immediate/manual run is for discovering/confirming new
    // PENDING evidence. Existing MATCHED evidence remains available as a
    // counterpart, but is not actively expanded/revalidated on every button
    // press. Periodic active revalidation is reserved for the weekly run.
    if (mode === "IMMEDIATE_MATCH") {
      return { evaluate: false, reason: "MATCHED_WEEKLY_REVALIDATION_ONLY" };
    }

    // Defensive age gate: even in WEEKLY_REVALIDATION mode, do not actively
    // re-review a relationship that was confirmed less than seven days ago.
    if (nowMs - matchedAtMs < MATCH_REVIEW_DELAY_MS) {
      return { evaluate: false, reason: "MATCHED_LT_7_DAYS" };
    }
    return { evaluate: true };
  }

  return { evaluate: false, reason: "NOT_PENDING_OR_MATCHED" };
}

function normalizeHex(value: Hex): string {
  return value.toLowerCase();
}

function hashStable(value: unknown): Hex {
  return keccak256(toHex(stableJson(value)));
}

function concatBytes(parts: Uint8Array[], total: number): Uint8Array {
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function loadDocumentBytes(
  _runtime: TeeRuntime<Config>,
  _serviceRoleKey: string,
  bundle: EvidenceBundle,
): Uint8Array {
  if (bundle.document.mode !== "INLINE") {
    throw new Error(`${bundle.evidenceId}: modo CHUNKED depende de ExplorerAdapter; snapshot direto usa INLINE`);
  }
  const bytes = new Uint8Array(Buffer.from(bundle.document.dataBase64, "base64"));
  if (bytes.length !== bundle.document.sizeBytes) {
    throw new Error(`${bundle.evidenceId}: tamanho INLINE divergente`);
  }
  return bytes;
}

function recomputeEvidenceHash(bundle: EvidenceBundle, bytes: Uint8Array): Hex {
  if (bundle.hashAlgorithm === "SHA-256" || bundle.hashAlgorithm === "SHA256") {
    return sha256(bytes);
  }
  return keccak256(bytes);
}

type IntegrityCheck = {
  evidenceId: Hex;
  actorId: Hex;
  anchoredHash: Hex;
  recomputedHash: Hex;
  hashMatches: boolean;
  actorMatches: boolean;
  extractionHashMatches: boolean;
  normalizationMode: "DOCUMENT_JSON" | "ADAPTER_NORMALIZED";
};

type VerifiedBundle = {
  bundle: EvidenceBundle;
  onchain: OnchainEvidence;
  normalized: NormalizedEvidence;
  integrity: IntegrityCheck;
};

function normalizeFromDocumentOrAdapter(
  bundle: EvidenceBundle,
  _bytes: Uint8Array,
): { normalized: NormalizedEvidence; mode: "DOCUMENT_JSON" | "ADAPTER_NORMALIZED"; extractionHashMatches: boolean } {
  const normalized = normalizedEvidenceSchema.parse(bundle.normalized);
  const recomputedExtractionHash = hashStable({
    domain: "ExploreChem/Extraction/v1",
    extractorVersion: bundle.extractorVersion,
    normalized,
  });
  return {
    normalized,
    mode: bundle.mimeType.toLowerCase().includes("json") ? "DOCUMENT_JSON" : "ADAPTER_NORMALIZED",
    extractionHashMatches:
      normalizeHex(recomputedExtractionHash) === normalizeHex(bundle.extractionHash),
  };
}

function verifyBundle(
  runtime: TeeRuntime<Config>,
  token: string,
  bundle: EvidenceBundle,
): VerifiedBundle {
  const onchain = readOnchainEvidence(runtime, bundle.evidenceId);
  const bytes = loadDocumentBytes(runtime, token, bundle);
  const recomputedHash = recomputeEvidenceHash(bundle, bytes);
  const normalizedResult = normalizeFromDocumentOrAdapter(bundle, bytes);
  const integrity: IntegrityCheck = {
    evidenceId: bundle.evidenceId,
    actorId: bundle.actorId,
    anchoredHash: onchain.evidenceHash,
    recomputedHash,
    hashMatches:
      normalizeHex(recomputedHash) === normalizeHex(onchain.evidenceHash) &&
      normalizeHex(bundle.evidenceHash) === normalizeHex(onchain.evidenceHash),
    actorMatches: normalizeHex(bundle.actorId) === normalizeHex(onchain.actorId),
    extractionHashMatches: normalizedResult.extractionHashMatches,
    normalizationMode: normalizedResult.mode,
  };
  return { bundle, onchain, normalized: normalizedResult.normalized, integrity };
}


/**
 * Correlation-only verifier.
 *
 * IMPORTANT: this path intentionally does NOT read getEvidence() before the
 * correlation work. Supabase is used as the discovery/index layer for PENDING
 * and MATCHED rows. The TEE still downloads the original document, recomputes
 * its hash and canonical extraction, and only then attempts reportType 1.
 *
 * The smart contract remains the authority that can accept/reject the
 * PENDING -> MATCHED transition. After a real broadcast, getEvidence() is read
 * once to confirm that the receiver actually applied MATCHED before Supabase
 * is updated.
 */
function indexedEvidenceFromSupabase(
  row: SupabaseEvidenceRow,
  bundle: EvidenceBundle,
): OnchainEvidence {
  const createdAtMs = new Date(row.chain_created_at).getTime();
  if (!Number.isFinite(createdAtMs)) {
    throw new Error(`${row.evidence_id}: chain_created_at inválido no índice Supabase`);
  }

  const matchedAtMs = row.matched_at === null ? 0 : new Date(row.matched_at).getTime();
  if (row.matched_at !== null && !Number.isFinite(matchedAtMs)) {
    throw new Error(`${row.evidence_id}: matched_at inválido no índice Supabase`);
  }

  return {
    evidenceId: row.evidence_id,
    actorId: bundle.actorId,
    submittedBy: zeroAddress,
    evidenceHash: row.evidence_hash,
    status: row.state === "PENDING" ? 1 : row.state === "MATCHED" ? 2 : row.state === "VERIFIED" ? 3 : 4,
    createdAt: BigInt(Math.floor(createdAtMs / 1000)),
    matchedAt: row.matched_at === null ? 0n : BigInt(Math.floor(matchedAtMs / 1000)),
    auditedAt: 0n,
  };
}

function verifyBundleForCorrelation(
  runtime: TeeRuntime<Config>,
  token: string,
  bundle: EvidenceBundle,
  row: SupabaseEvidenceRow,
): VerifiedBundle {
  const indexed = indexedEvidenceFromSupabase(row, bundle);
  const bytes = loadDocumentBytes(runtime, token, bundle);
  const recomputedHash = recomputeEvidenceHash(bundle, bytes);
  const normalizedResult = normalizeFromDocumentOrAdapter(bundle, bytes);

  const integrity: IntegrityCheck = {
    evidenceId: bundle.evidenceId,
    actorId: bundle.actorId,
    // In the Supabase-first correlation path this is the indexed/reference hash.
    // The authoritative on-chain anchor is checked before any receiver write.
    anchoredHash: bundle.evidenceHash,
    recomputedHash,
    hashMatches:
      normalizeHex(recomputedHash) === normalizeHex(bundle.evidenceHash) &&
      normalizeHex(bundle.evidenceHash) === normalizeHex(row.evidence_hash),
    actorMatches: normalizeHex(bundle.actorId) === normalizeHex(indexed.actorId),
    extractionHashMatches: normalizedResult.extractionHashMatches,
    normalizationMode: normalizedResult.mode,
  };

  if (!integrity.hashMatches) {
    throw new EvidenceDivergenceError(
      bundle.evidenceId,
      "HASH_MISMATCH",
      "bytes do documento não reproduzem o evidenceHash indexado",
    );
  }
  if (!integrity.extractionHashMatches) {
    throw new EvidenceDivergenceError(
      bundle.evidenceId,
      "EXTRACTION_MISMATCH",
      "extração canônica não reproduz o extractionHash",
    );
  }

  return {
    bundle,
    onchain: indexed,
    normalized: normalizedResult.normalized,
    integrity,
  };
}

function optionalIdEquals(left: Hex | null, right: Hex): boolean {
  return left !== null && normalizeHex(left) === normalizeHex(right);
}

function sameOptionalLot(left: NormalizedEvidence, right: NormalizedEvidence): boolean {
  if (left.lotReference === null || right.lotReference === null) return true;
  return left.lotReference.trim().toLowerCase() === right.lotReference.trim().toLowerCase();
}

function requireSameLot(left: NormalizedEvidence, right: NormalizedEvidence): boolean {
  return left.lotReference !== null && right.lotReference !== null &&
    left.lotReference.trim().toLowerCase() === right.lotReference.trim().toLowerCase();
}

function sitesCompatible(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return true;
  return canonicalName(left) === canonicalName(right);
}

function firstMass(...values: Array<string | null>): bigint | null {
  for (const value of values) if (value !== null) return BigInt(value);
  return null;
}

function equalRequiredMass(left: bigint | null, right: bigint | null): boolean {
  return left !== null && right !== null && left === right;
}

function comparableElementKeys(left: ElementMasses, right: ElementMasses): Element[] {
  return ELEMENTS.filter((key) => left[key] !== undefined && right[key] !== undefined);
}

function elementMassesDoNotContradict(left: ElementMasses, right: ElementMasses): boolean {
  return comparableElementKeys(left, right).every((key) => BigInt(left[key]!) === BigInt(right[key]!));
}

function hasComparableElements(left: ElementMasses, right: ElementMasses): boolean {
  return comparableElementKeys(left, right).length > 0;
}

type RelationshipCandidate = {
  fromEvidenceId: Hex;
  toEvidenceId: Hex;
  relationType: RelationType;
  reasonCodes: string[];
};

function relationship(
  from: VerifiedBundle,
  to: VerifiedBundle,
  relationType: RelationType,
  reasonCodes: string[],
): RelationshipCandidate {
  return { fromEvidenceId: from.bundle.evidenceId, toEvidenceId: to.bundle.evidenceId, relationType, reasonCodes };
}

function validForCorrelation(item: VerifiedBundle): boolean {
  // Correlation is event-first: the evidence/document must be authentic and its
  // deterministic extraction reproducible. actorId is contextual metadata and
  // does not decide whether two events can be correlated.
  return item.integrity.hashMatches && item.integrity.extractionHashMatches;
}

function validForBalance(item: VerifiedBundle): boolean {
  // Balance anchoring is different: the contract binds each balance result to
  // the actorId stored on-chain for the owning evidence, so actor consistency is
  // still required on this path.
  return validForCorrelation(item) && item.integrity.actorMatches;
}

function validateDirectedRelationship(
  from: VerifiedBundle,
  to: VerifiedBundle,
): RelationshipCandidate | null {
  if (normalizeHex(from.bundle.evidenceId) === normalizeHex(to.bundle.evidenceId)) return null;
  if (!validForCorrelation(from) || !validForCorrelation(to)) return null;

  const a = from.normalized;
  const b = to.normalized;
  if (!sameOptionalLot(a, b)) return null;

  if (a.actorType === "MINER" && b.actorType === "CARRIER") {
    const routeMatches = optionalIdEquals(b.originActorId, from.bundle.actorId) &&
      (optionalIdEquals(a.destinationActorId, to.bundle.actorId) || optionalIdEquals(b.carrierActorId, to.bundle.actorId));
    const massMatches = equalRequiredMass(firstMass(a.outputMassMg, a.grossMassMg), firstMass(b.collectedMassMg, b.inputMassMg));
    if (!routeMatches || !massMatches) return null;
    return relationship(from, to, "CUSTODY_HANDOFF", ["MINER_TO_CARRIER", "ROUTE_MATCH", "MASS_CONTINUITY"]);
  }

  if (a.actorType === "CARRIER" && (b.actorType === "PROCESSOR" || b.actorType === "REFINER")) {
    const routeMatches = optionalIdEquals(a.destinationActorId, to.bundle.actorId) &&
      sitesCompatible(a.destinationSite, b.originSite);
    const massMatches = equalRequiredMass(firstMass(a.deliveredMassMg, a.outputMassMg), firstMass(b.inputMassMg, b.grossMassMg));
    if (!routeMatches || !massMatches) return null;
    return relationship(from, to, "CUSTODY_HANDOFF", ["CARRIER_TO_PROCESS_NODE", "DESTINATION_MATCH", "MASS_CONTINUITY"]);
  }

  if (a.actorType === "LABORATORY" && b.actorType !== "LABORATORY" && b.actorType !== "CARRIER") {
    // A laboratory report annotates a material state owned/processed by the
    // destination actor. It is not a next hop in the physical mass chain.
    if (!requireSameLot(a, b) || !optionalIdEquals(a.destinationActorId, to.bundle.actorId) ||
        !sitesCompatible(a.destinationSite, b.originSite)) return null;
    return relationship(from, to, "LAB_ANALYSIS", [
      "ANALYTICAL_MEASUREMENT",
      "TARGET_MATERIAL_STATE",
      "LOT_MATCH",
      "DESTINATION_MATCH",
      "NO_PHYSICAL_MASS_FLOW",
    ]);
  }

  if ((a.actorType === "PROCESSOR" || a.actorType === "REFINER") && b.actorType === "MANUFACTURER") {
    const routeMatches = optionalIdEquals(a.destinationActorId, to.bundle.actorId) &&
      sitesCompatible(a.destinationSite, b.originSite);
    const massMatches = equalRequiredMass(firstMass(a.outputMassMg), firstMass(b.inputMassMg, b.grossMassMg));
    if (!routeMatches || !massMatches) return null;
    if (!elementMassesDoNotContradict(a.elementalOutputMg, b.elementalInputMg)) return null;
    return relationship(from, to, "TRANSFORMATION_OUTPUT", [
      "PROCESS_NODE_TO_MANUFACTURER", "DESTINATION_MATCH", "MASS_CONTINUITY",
      ...(hasComparableElements(a.elementalOutputMg, b.elementalInputMg) ? ["ELEMENTAL_CONTINUITY"] : []),
    ]);
  }

  if (a.actorType === "MANUFACTURER" && b.actorType === "RECYCLER") {
    const routeMatches = optionalIdEquals(a.destinationActorId, to.bundle.actorId) &&
      sitesCompatible(a.destinationSite, b.originSite);
    const massMatches = equalRequiredMass(firstMass(a.scrapMassMg, a.outputMassMg), firstMass(b.inputMassMg, b.grossMassMg));
    if (!routeMatches || !massMatches) return null;
    const rightElements = Object.keys(b.elementalInputMg).length > 0 ? b.elementalInputMg : b.elementalRecoveredMg;
    if (!elementMassesDoNotContradict(a.elementalScrapMg, rightElements)) return null;
    return relationship(from, to, "RECYCLE", [
      "MANUFACTURER_TO_RECYCLER", "DESTINATION_MATCH", "SCRAP_MASS_CONTINUITY",
      ...(hasComparableElements(a.elementalScrapMg, rightElements) ? ["ELEMENTAL_CONTINUITY"] : []),
    ]);
  }

  if (a.actorType === "RECYCLER" && (b.actorType === "MANUFACTURER" || b.actorType === "PROCESSOR" || b.actorType === "REFINER")) {
    const routeMatches = optionalIdEquals(a.destinationActorId, to.bundle.actorId) &&
      sitesCompatible(a.destinationSite, b.originSite);
    const massMatches = equalRequiredMass(firstMass(a.recoveredMassMg, a.outputMassMg), firstMass(b.inputMassMg, b.grossMassMg));
    if (!routeMatches || !massMatches) return null;
    if (!elementMassesDoNotContradict(a.elementalRecoveredMg, b.elementalInputMg)) return null;
    return relationship(from, to, "RETURN", [
      "RECYCLER_TO_RECEIVER", "RECEIVING_EVIDENCE_PRESENT", "DESTINATION_MATCH", "MASS_CONTINUITY",
      ...(hasComparableElements(a.elementalRecoveredMg, b.elementalInputMg) ? ["ELEMENTAL_CONTINUITY"] : []),
    ]);
  }

  // A single organization can operate several factories/plants. actorId identifies
  // responsibility, not the physical site. An explicit self-destination plus a
  // matching destination/origin site and mass continuity can therefore form an
  // internal physical handoff without inventing a second actorId.
  if (normalizeHex(from.bundle.actorId) === normalizeHex(to.bundle.actorId) &&
      optionalIdEquals(a.destinationActorId, to.bundle.actorId) &&
      a.destinationSite !== null && b.originSite !== null &&
      sitesCompatible(a.destinationSite, b.originSite)) {
    const leftMass = firstMass(
      a.deliveredMassMg, a.recoveredMassMg, a.scrapMassMg, a.outputMassMg, a.grossMassMg,
    );
    const rightMass = firstMass(b.inputMassMg, b.collectedMassMg, b.grossMassMg);
    if (equalRequiredMass(leftMass, rightMass)) {
      return relationship(from, to, "ORIGIN_DESTINATION", [
        "SAME_ACTOR_DIFFERENT_OPERATIONAL_SITE",
        "SITE_CONTINUITY",
        "MASS_CONTINUITY",
      ]);
    }
  }

  return null;
}

function edgeKey(edge: ExistingEdge | RelationshipCandidate): string {
  return `${normalizeHex(edge.fromEvidenceId)}|${normalizeHex(edge.toEvidenceId)}|${edge.relationType}`;
}

type VerifiedEdge = RelationshipCandidate & { verificationHash: Hex };

function verifyFocusRelationships(
  focusEvidenceId: Hex,
  correlationPolicyVersion: string,
  verified: VerifiedBundle[],
): VerifiedEdge[] {
  const focus = verified.find(
    (item) => normalizeHex(item.bundle.evidenceId) === normalizeHex(focusEvidenceId),
  );
  if (!focus || !validForCorrelation(focus)) return [];
  const result = new Map<string, VerifiedEdge>();

  for (const other of verified) {
    if (normalizeHex(other.bundle.evidenceId) === normalizeHex(focus.bundle.evidenceId)) continue;
    for (const candidate of [
      validateDirectedRelationship(focus, other),
      validateDirectedRelationship(other, focus),
    ]) {
      if (!candidate) continue;
      const verificationHash = hashStable({
        domain: "ExploreChem/CorrelationEdgeVerification/v1",
        policyVersion: correlationPolicyVersion,
        ...candidate,
      });
      const edge = { ...candidate, verificationHash };
      result.set(edgeKey(edge), edge);
    }
  }
  return [...result.values()].sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)));
}

function encodeEvidenceMatchReport(evidenceId: Hex): Hex {
  const encoded = encodeAbiParameters(
    parseAbiParameters(
      "uint8 reportType, bytes32 evidenceId, bytes32 resultId, bytes32 actorId, bytes32 resultHash, bytes32 previousResultId, bytes32 aggregateInputHash, uint8 balanceStatus, uint32 calculationVersion",
    ),
    [1, evidenceId, zeroHash, zeroHash, zeroHash, zeroHash, zeroHash, 0, 0],
  );
  if ((encoded.length - 2) / 2 !== 288) throw new Error("CREReport de correlação não possui 288 bytes");
  return encoded;
}

function encodeEvidenceDivergentReport(evidenceId: Hex): Hex {
  // EvidenceStatus.DIVERGENT = 4 in ExploreChemRegistry.
  const encoded = encodeAbiParameters(
    parseAbiParameters(
      "uint8 reportType, bytes32 evidenceId, bytes32 resultId, bytes32 actorId, bytes32 resultHash, bytes32 previousResultId, bytes32 aggregateInputHash, uint8 balanceStatus, uint32 calculationVersion",
    ),
    [3, evidenceId, zeroHash, zeroHash, zeroHash, zeroHash, zeroHash, 4, 0],
  );
  if ((encoded.length - 2) / 2 !== 288) throw new Error("CREReport de auditoria não possui 288 bytes");
  return encoded;
}

function writeReport(
  runtime: TeeRuntime<Config>,
  encodedReport: Hex,
  reportType: 1 | 2 | 3,
  preflightWorkflowId = true,
): Hex {
  // Correlation can deliberately skip this preflight to keep the flow
  // Supabase -> TEE -> receiver. The receiver remains the final authority and
  // the correlation path confirms getEvidence() after a real broadcast.
  if (preflightWorkflowId) {
    readExpectedWorkflowId(runtime, reportType);
  }

  const network = getNetworkOrThrow(runtime);
  const donRuntime = runtime.usingTheDons();
  const report = donRuntime
    .report({
      encodedPayload: hexToBase64(encodedReport),
      encoderName: "evm",
      signingAlgo: "ecdsa",
      hashingAlgo: "keccak256",
    })
    .result();
  const writeResult = new EVMClient(network.chainSelector.selector)
    .writeReport(donRuntime, {
      receiver: runtime.config.contractAddress as Address,
      report,
      gasConfig: { gasLimit: runtime.config.gasLimit },
    })
    .result();

  const dump = (v: any) =>
    JSON.stringify(v, (_k, x) =>
      typeof x === "bigint" ? x.toString() : x
    );

  runtime.log(`writeResp: ${dump(writeResult)}`);
  runtime.log(
    `receiverStatus: ${dump(
      (writeResult as any)?.receiverContractExecutionStatus
    )}`
  );
  runtime.log(
    `errorMessage: ${dump(
      (writeResult as any)?.errorMessage
    )}`
  );

  if (writeResult.txStatus !== TxStatus.SUCCESS) {
    throw new Error(`ancoragem falhou: txStatus=${writeResult.txStatus}`);
  }

  // The forwarder transaction can be mined successfully even when the receiver
  // contract reverts internally. In the SDK used by this workflow,
  // receiverContractExecutionStatus is SUCCESS=0 and REVERTED=1.
  const receiverStatus = writeResult.receiverContractExecutionStatus;
  if (receiverStatus !== undefined && receiverStatus !== 0) {
    throw new Error(
      `receiver reverteu: status=${receiverStatus}` +
      (writeResult.errorMessage ? ` · ${writeResult.errorMessage}` : ""),
    );
  }

  return bytesToHex(writeResult.txHash ?? new Uint8Array(32)) as Hex;
}

function markEvidenceDivergent(
  runtime: TeeRuntime<Config>,
  serviceRoleKey: string,
  row: SupabaseEvidenceRow,
): { transactionHash: Hex | null; alreadyDivergent: boolean } {
  const onchain = readOnchainEvidence(runtime, row.evidence_id, LATEST_BLOCK_NUMBER);

  if (onchain.status === 4) {
    patchDivergentInSupabaseBestEffort(runtime, serviceRoleKey, row.evidence_id);
    return { transactionHash: null, alreadyDivergent: true };
  }

  // Direct PENDING -> DIVERGENT is intentionally supported by the revised
  // receiver contract. MATCHED may also be audited to DIVERGENT later.
  if (onchain.status !== 1 && onchain.status !== 2 && onchain.status !== 3) {
    throw new Error(
      `${row.evidence_id}: estado on-chain ${onchain.status} não pode ser marcado DIVERGENT`,
    );
  }

  const transactionHash = writeReport(
    runtime,
    encodeEvidenceDivergentReport(row.evidence_id),
    3,
    true,
  );

  if (normalizeHex(transactionHash) !== normalizeHex(zeroHash)) {
    patchDivergentInSupabaseBestEffort(runtime, serviceRoleKey, row.evidence_id, transactionHash);
  }
  return { transactionHash, alreadyDivergent: false };
}

type MassContinuityCheck = {
  fromEvidenceId: Hex;
  toEvidenceId: Hex;
  relationType: RelationType;
  leftMassMg: string | null;
  rightMassMg: string | null;
  deltaMg: string | null;
  consistent: boolean;
};

type TransformationMassCheck = {
  evidenceId: Hex;
  actorId: Hex;
  actorType: z.infer<typeof actorTypeSchema>;
  element: Element;
  inputMg: string | null;
  accountedOutputMg: string | null;
  deltaMg: string | null;
  consistent: boolean | null;
};

type CorrelatedMassSnapshot = {
  schema: "ExploreChem/CorrelatedMassSnapshot/v1";
  correlationPolicyVersion: string;
  evidenceIds: Hex[];
  correlationEdges: Array<{
    fromEvidenceId: Hex;
    toEvidenceId: Hex;
    relationType: RelationType;
    verificationHash: Hex;
  }>;
  continuityChecks: MassContinuityCheck[];
  transformationChecks: TransformationMassCheck[];
  status: "CONFORME" | "DIVERGENTE" | "NAO_ATESTADO";
};

const correlatedMassSnapshotSchema = z.object({
  schema: z.literal("ExploreChem/CorrelatedMassSnapshot/v1"),
  correlationPolicyVersion: z.string().min(1),
  evidenceIds: z.array(bytes32Schema),
  correlationEdges: z.array(z.object({
    fromEvidenceId: bytes32Schema,
    toEvidenceId: bytes32Schema,
    relationType: relationTypeSchema,
    verificationHash: bytes32Schema,
  })),
  continuityChecks: z.array(z.object({
    fromEvidenceId: bytes32Schema,
    toEvidenceId: bytes32Schema,
    relationType: relationTypeSchema,
    leftMassMg: z.string().nullable(),
    rightMassMg: z.string().nullable(),
    deltaMg: z.string().nullable(),
    consistent: z.boolean(),
  })),
  transformationChecks: z.array(z.object({
    evidenceId: bytes32Schema,
    actorId: bytes32Schema,
    actorType: actorTypeSchema,
    element: z.enum(ELEMENTS),
    inputMg: z.string().nullable(),
    accountedOutputMg: z.string().nullable(),
    deltaMg: z.string().nullable(),
    consistent: z.boolean().nullable(),
  })),
  status: z.enum(["CONFORME", "DIVERGENTE", "NAO_ATESTADO"]),
});

type MassCheckpoint = {
  resultId: Hex;
  calculationVersion: number;
  snapshot: CorrelatedMassSnapshot;
};

function loadLatestMassCheckpointForEvidence(
  runtime: TeeRuntime<Config>,
  serviceRoleKey: string,
  evidenceId: Hex,
): MassCheckpoint | null {
  // Step 1: find this participant/evidence's private link to the shared proof.
  const linkPath =
    `/rest/v1/explorerchem_balance_results?select=result_id,summary,anchored_at` +
    `&summary->>sourceEvidenceId=eq.${encodeURIComponent(evidenceId)}` +
    `&order=anchored_at.desc&limit=1`;
  const linkRows = supabaseJson<unknown[]>(runtime, serviceRoleKey, linkPath);
  if (!Array.isArray(linkRows) || linkRows.length === 0) return null;

  const linkRow = recordOf(linkRows[0]);
  const linkSummary = recordOf(linkRow.summary);
  const sharedProofResultIdRaw = linkSummary.sharedProofResultId;
  if (typeof sharedProofResultIdRaw !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(sharedProofResultIdRaw)) {
    return null;
  }
  const sharedProofResultId = sharedProofResultIdRaw as Hex;

  // Step 2: load the private checkpoint row for that shared public proof.
  const checkpointPath =
    `/rest/v1/explorerchem_balance_results?select=result_id,calculation_version,summary` +
    `&result_id=eq.${encodeURIComponent(sharedProofResultId)}&limit=1`;
  const checkpointRows = supabaseJson<unknown[]>(runtime, serviceRoleKey, checkpointPath);
  if (!Array.isArray(checkpointRows) || checkpointRows.length === 0) return null;

  const checkpointRow = recordOf(checkpointRows[0]);
  const checkpointSummary = recordOf(checkpointRow.summary);
  const parsed = correlatedMassSnapshotSchema.safeParse(checkpointSummary.checkpoint);
  if (!parsed.success) {
    runtime.log(`${evidenceId}: checkpoint privado não reutilizável; será usado fallback de recálculo`);
    return null;
  }

  const versionRaw = checkpointRow.calculation_version;
  const calculationVersion = typeof versionRaw === "number" ? versionRaw : Number(versionRaw);
  return {
    resultId: sharedProofResultId,
    calculationVersion: Number.isFinite(calculationVersion) ? calculationVersion : 1,
    snapshot: parsed.data,
  };
}

function massStatusRank(value: CorrelatedMassSnapshot["status"]): number {
  return value === "DIVERGENTE" ? 3 : value === "CONFORME" ? 2 : 1;
}

function mergeCheckpointSnapshots(
  checkpoints: MassCheckpoint[],
  newItems: VerifiedBundle[],
  component: VerifiedBundle[],
  edges: VerifiedEdge[],
  correlationPolicyVersion: string,
): CorrelatedMassSnapshot {
  if (checkpoints.length === 0) {
    return buildCorrelatedMassSnapshot(component, edges, correlationPolicyVersion);
  }

  const byId = new Map(component.map((item) => [normalizeHex(item.bundle.evidenceId), item] as const));
  const evidenceIds = new Set<string>();
  const edgeMap = new Map<string, CorrelatedMassSnapshot["correlationEdges"][number]>();
  const continuityMap = new Map<string, MassContinuityCheck>();
  const transformationMap = new Map<string, TransformationMassCheck>();
  let inheritedStatus: CorrelatedMassSnapshot["status"] = "NAO_ATESTADO";

  for (const checkpoint of checkpoints) {
    const snapshot = checkpoint.snapshot;
    if (massStatusRank(snapshot.status) > massStatusRank(inheritedStatus)) inheritedStatus = snapshot.status;
    for (const id of snapshot.evidenceIds) evidenceIds.add(normalizeHex(id));
    for (const edge of snapshot.correlationEdges) edgeMap.set(edgeKey(edge), edge);
    for (const check of snapshot.continuityChecks) {
      continuityMap.set(`${edgeKey(check)}|${check.leftMassMg}|${check.rightMassMg}`, check);
    }
    for (const check of snapshot.transformationChecks) {
      transformationMap.set(`${normalizeHex(check.evidenceId)}|${check.element}`, check);
    }
  }

  const newIds = new Set(newItems.map((item) => normalizeHex(item.bundle.evidenceId)));
  for (const item of newItems) evidenceIds.add(normalizeHex(item.bundle.evidenceId));

  for (const edge of edges) {
    const key = edgeKey(edge);
    const isNewEdge = !edgeMap.has(key);
    if (!isNewEdge) continue;
    edgeMap.set(key, {
      fromEvidenceId: edge.fromEvidenceId,
      toEvidenceId: edge.toEvidenceId,
      relationType: edge.relationType,
      verificationHash: edge.verificationHash,
    });

    // A checkpoint already attests the old history. Only calculate continuity
    // for an edge that touches a newly matched event.
    if (!newIds.has(normalizeHex(edge.fromEvidenceId)) && !newIds.has(normalizeHex(edge.toEvidenceId))) continue;
    const from = byId.get(normalizeHex(edge.fromEvidenceId));
    const to = byId.get(normalizeHex(edge.toEvidenceId));
    if (!from || !to) continue;
    const { left, right } = continuityMasses(from, to, edge.relationType);
    const delta = left !== null && right !== null ? left - right : null;
    const check: MassContinuityCheck = {
      fromEvidenceId: edge.fromEvidenceId,
      toEvidenceId: edge.toEvidenceId,
      relationType: edge.relationType,
      leftMassMg: left?.toString() ?? null,
      rightMassMg: right?.toString() ?? null,
      deltaMg: delta?.toString() ?? null,
      consistent: delta === null ? true : delta === 0n,
    };
    continuityMap.set(`${key}|${check.leftMassMg}|${check.rightMassMg}`, check);
  }

  for (const item of newItems) {
    const n = item.normalized;
    for (const element of ELEMENTS) {
      const input = n.elementalInputMg[element] !== undefined ? BigInt(n.elementalInputMg[element]!) : null;
      const directOutput = n.elementalOutputMg[element] !== undefined ? BigInt(n.elementalOutputMg[element]!) : null;
      const scrap = n.elementalScrapMg[element] !== undefined ? BigInt(n.elementalScrapMg[element]!) : null;
      const recovered = n.elementalRecoveredMg[element] !== undefined ? BigInt(n.elementalRecoveredMg[element]!) : null;
      let accountedOutput: bigint | null = null;
      if (directOutput !== null || scrap !== null) accountedOutput = (directOutput ?? 0n) + (scrap ?? 0n);
      else if (recovered !== null) accountedOutput = recovered;
      if (input === null && accountedOutput === null) continue;
      const delta = input !== null && accountedOutput !== null ? input - accountedOutput : null;
      transformationMap.set(`${normalizeHex(item.bundle.evidenceId)}|${element}`, {
        evidenceId: item.bundle.evidenceId,
        actorId: item.bundle.actorId,
        actorType: n.actorType,
        element,
        inputMg: input?.toString() ?? null,
        accountedOutputMg: accountedOutput?.toString() ?? null,
        deltaMg: delta?.toString() ?? null,
        consistent: delta === null ? null : delta === 0n,
      });
    }
  }

  const continuityChecks = [...continuityMap.values()];
  const transformationChecks = [...transformationMap.values()];
  const newContradiction = continuityChecks.some((x) => x.consistent === false) ||
    transformationChecks.some((x) => x.consistent === false);
  const attested = continuityChecks.some((x) => x.deltaMg !== null) ||
    transformationChecks.some((x) => x.consistent !== null);
  const status: CorrelatedMassSnapshot["status"] =
    inheritedStatus === "DIVERGENTE" || newContradiction
      ? "DIVERGENTE"
      : inheritedStatus === "CONFORME" || attested
        ? "CONFORME"
        : "NAO_ATESTADO";

  return {
    schema: "ExploreChem/CorrelatedMassSnapshot/v1",
    correlationPolicyVersion,
    evidenceIds: [...evidenceIds].sort() as Hex[],
    correlationEdges: [...edgeMap.values()].sort((a, b) => edgeKey(a).localeCompare(edgeKey(b))),
    continuityChecks,
    transformationChecks,
    status,
  };
}

type CycleStats = {
  scanned: number;
  firstPending: Hex | null;
  correlatedEvidenceIds: Hex[];
  correlationEdges: number;
  matchedThisRun: Hex[];
  alreadyMatchedUsed: Hex[];
  waitingCounterpart: number;
  integrityRejected: number;
  divergentThisRun: Hex[];
  alreadyDivergent: Hex[];
  divergenceTransactions: Array<{ evidenceId: Hex; transactionHash: Hex }>;
  divergenceFailures: Array<{ evidenceId: Hex; error: string }>;
  simulatedMatches: number;
  matchTransactions: Array<{ evidenceId: Hex; transactionHash: Hex }>;
  massStatus: "CONFORME" | "DIVERGENTE" | "NAO_ATESTADO" | null;
  massResults: Array<{
    resultId: Hex;
    resultHash: Hex;
    transactionHash: Hex;
    participantEvidenceIds: Hex[];
  }>;
};

function continuityMasses(
  from: VerifiedBundle,
  to: VerifiedBundle,
  relationType: RelationType,
): { left: bigint | null; right: bigint | null } {
  const a = from.normalized;
  const b = to.normalized;
  if (relationType === "LAB_ANALYSIS") return { left: null, right: null };

  if (a.actorType === "MINER" && b.actorType === "CARRIER") {
    return {
      left: firstMass(a.outputMassMg, a.grossMassMg),
      right: firstMass(b.collectedMassMg, b.inputMassMg),
    };
  }
  if (a.actorType === "CARRIER" && (b.actorType === "PROCESSOR" || b.actorType === "REFINER")) {
    return {
      left: firstMass(a.deliveredMassMg, a.outputMassMg),
      right: firstMass(b.inputMassMg, b.grossMassMg),
    };
  }
  if ((a.actorType === "PROCESSOR" || a.actorType === "REFINER") && b.actorType === "MANUFACTURER") {
    return { left: firstMass(a.outputMassMg), right: firstMass(b.inputMassMg, b.grossMassMg) };
  }
  if (a.actorType === "MANUFACTURER" && b.actorType === "RECYCLER") {
    return {
      left: firstMass(a.scrapMassMg, a.outputMassMg),
      right: firstMass(b.inputMassMg, b.grossMassMg),
    };
  }
  if (a.actorType === "RECYCLER" && (b.actorType === "MANUFACTURER" || b.actorType === "PROCESSOR" || b.actorType === "REFINER")) {
    return {
      left: firstMass(a.recoveredMassMg, a.outputMassMg),
      right: firstMass(b.inputMassMg, b.grossMassMg),
    };
  }
  return {
    left: firstMass(a.deliveredMassMg, a.recoveredMassMg, a.scrapMassMg, a.outputMassMg, a.grossMassMg),
    right: firstMass(b.inputMassMg, b.collectedMassMg, b.grossMassMg),
  };
}

function buildCorrelatedMassSnapshot(
  component: VerifiedBundle[],
  edges: VerifiedEdge[],
  correlationPolicyVersion: string,
): CorrelatedMassSnapshot {
  const byId = new Map(component.map((item) => [normalizeHex(item.bundle.evidenceId), item] as const));
  const continuityChecks: MassContinuityCheck[] = [];

  for (const edge of edges) {
    const from = byId.get(normalizeHex(edge.fromEvidenceId));
    const to = byId.get(normalizeHex(edge.toEvidenceId));
    if (!from || !to) continue;
    const { left, right } = continuityMasses(from, to, edge.relationType);
    const delta = left !== null && right !== null ? left - right : null;
    continuityChecks.push({
      fromEvidenceId: edge.fromEvidenceId,
      toEvidenceId: edge.toEvidenceId,
      relationType: edge.relationType,
      leftMassMg: left?.toString() ?? null,
      rightMassMg: right?.toString() ?? null,
      deltaMg: delta?.toString() ?? null,
      consistent: delta === null ? true : delta === 0n,
    });
  }

  const transformationChecks: TransformationMassCheck[] = [];
  for (const item of component) {
    const n = item.normalized;
    for (const element of ELEMENTS) {
      const input = n.elementalInputMg[element] !== undefined ? BigInt(n.elementalInputMg[element]!) : null;
      const directOutput = n.elementalOutputMg[element] !== undefined ? BigInt(n.elementalOutputMg[element]!) : null;
      const scrap = n.elementalScrapMg[element] !== undefined ? BigInt(n.elementalScrapMg[element]!) : null;
      const recovered = n.elementalRecoveredMg[element] !== undefined ? BigInt(n.elementalRecoveredMg[element]!) : null;

      let accountedOutput: bigint | null = null;
      if (directOutput !== null || scrap !== null) {
        accountedOutput = (directOutput ?? 0n) + (scrap ?? 0n);
      } else if (recovered !== null) {
        accountedOutput = recovered;
      }

      if (input === null && accountedOutput === null) continue;
      const delta = input !== null && accountedOutput !== null ? input - accountedOutput : null;
      transformationChecks.push({
        evidenceId: item.bundle.evidenceId,
        actorId: item.bundle.actorId,
        actorType: n.actorType,
        element,
        inputMg: input?.toString() ?? null,
        accountedOutputMg: accountedOutput?.toString() ?? null,
        deltaMg: delta?.toString() ?? null,
        consistent: delta === null ? null : delta === 0n,
      });
    }
  }

  const contradictions = [
    ...continuityChecks.map((x) => x.consistent === false),
    ...transformationChecks.map((x) => x.consistent === false),
  ].some(Boolean);
  const attestedChecks = continuityChecks.some((x) => x.deltaMg !== null) ||
    transformationChecks.some((x) => x.consistent !== null);

  return {
    schema: "ExploreChem/CorrelatedMassSnapshot/v1",
    correlationPolicyVersion,
    evidenceIds: component.map((x) => x.bundle.evidenceId).sort(),
    correlationEdges: edges.map((edge) => ({
      fromEvidenceId: edge.fromEvidenceId,
      toEvidenceId: edge.toEvidenceId,
      relationType: edge.relationType,
      verificationHash: edge.verificationHash,
    })).sort((a, b) => edgeKey(a).localeCompare(edgeKey(b))),
    continuityChecks,
    transformationChecks,
    status: contradictions ? "DIVERGENTE" : attestedChecks ? "CONFORME" : "NAO_ATESTADO",
  };
}

type SharedMassProofPayload = {
  schema: "ExploreChem/SharedMassProofPayload/v1";
  status: CorrelatedMassSnapshot["status"];
  continuity: Array<{
    leftMassMg: string | null;
    rightMassMg: string | null;
    deltaMg: string | null;
    consistent: boolean;
  }>;
  transformations: Array<{
    element: Element;
    inputMg: string | null;
    accountedOutputMg: string | null;
    deltaMg: string | null;
    consistent: boolean | null;
  }>;
};

function buildSharedMassProofPayload(snapshot: CorrelatedMassSnapshot): SharedMassProofPayload {
  // Deliberately strips evidenceId, actorId, actorType, relation endpoints and
  // every membership field before hashing. This is what prevents the public
  // resultHash from becoming a correlation commitment.
  const continuity = snapshot.continuityChecks.map((check) => ({
    leftMassMg: check.leftMassMg,
    rightMassMg: check.rightMassMg,
    deltaMg: check.deltaMg,
    consistent: check.consistent,
  })).sort((a, b) => stableJson(a).localeCompare(stableJson(b)));

  const transformations = snapshot.transformationChecks.map((check) => ({
    element: check.element,
    inputMg: check.inputMg,
    accountedOutputMg: check.accountedOutputMg,
    deltaMg: check.deltaMg,
    consistent: check.consistent,
  })).sort((a, b) => stableJson(a).localeCompare(stableJson(b)));

  return {
    schema: "ExploreChem/SharedMassProofPayload/v1",
    status: snapshot.status,
    continuity,
    transformations,
  };
}

function encodeSharedMassProofReport(
  resultId: Hex,
  resultHash: Hex,
  revision = 1,
): Hex {
  // Public mass proof intentionally carries NO actorId, evidenceId, membership,
  // correlation group, Merkle root or public balance verdict. The report stays
  // nine static ABI words so the CRE transport format remains simple.
  //
  // IMPORTANT: the receiver contract must use the matching shared-proof
  // semantics for reportType 2 (evidenceId/actorId/other unused fields = zero).
  const encoded = encodeAbiParameters(
    parseAbiParameters(
      "uint8 reportType, bytes32 evidenceId, bytes32 resultId, bytes32 actorId, bytes32 resultHash, bytes32 previousResultId, bytes32 aggregateInputHash, uint8 balanceStatus, uint32 calculationVersion",
    ),
    [
      2,
      zeroHash,
      resultId,
      zeroHash,
      resultHash,
      zeroHash,
      zeroHash,
      0,
      revision,
    ],
  );
  if ((encoded.length - 2) / 2 !== 288) {
    throw new Error("CREReport de prova de massa compartilhada não possui 288 bytes");
  }
  return encoded;
}

function persistSharedMassProofForParticipants(
  runtime: TeeRuntime<Config>,
  serviceRoleKey: string,
  participantRows: SupabaseEvidenceRow[],
  result: {
    resultId: Hex;
    resultHash: Hex;
    transactionHash: Hex;
    checkpoint: CorrelatedMassSnapshot;
    proofPayload: SharedMassProofPayload;
  },
): void {
  if (normalizeHex(result.transactionHash) === normalizeHex(zeroHash)) return;
  if (participantRows.length === 0) return;

  const anchoredAt = new Date(runtime.now()).toISOString();
  const rowsWithLot = participantRows.filter(
    (row) => (row.verified_lot_db_id ?? row.declared_lot_db_id) !== null,
  );
  if (rowsWithLot.length === 0) {
    throw new Error("prova de massa compartilhada exige ao menos um lot_db_id off-chain");
  }

  // One internal checkpoint row mirrors the ONE public proof. Membership stays
  // off-chain; the public transaction contains only resultId/resultHash.
  const checkpointOwner = rowsWithLot[0]!;
  supabaseRequestRaw(
    runtime,
    serviceRoleKey,
    "/rest/v1/explorerchem_balance_results?on_conflict=result_id",
    "POST",
    {
      result_id: result.resultId,
      lot_db_id: checkpointOwner.verified_lot_db_id ?? checkpointOwner.declared_lot_db_id,
      actor_db_id: checkpointOwner.actor_db_id,
      result_hash: result.resultHash,
      previous_result_db_id: null,
      status: result.checkpoint.status,
      calculation_version: 1,
      summary: {
        schema: "ExploreChem/SharedMassProofCheckpoint/v1",
        sharedProofResultId: result.resultId,
        sharedResultHash: result.resultHash,
        participantCount: participantRows.length,
        publicMembershipCommitted: false,
        proofPayload: result.proofPayload,
        checkpoint: result.checkpoint,
      },
      anchor_tx_hash: result.transactionHash,
      anchored_at: anchoredAt,
    },
    { prefer: { values: ["resolution=merge-duplicates,return=representation"] } },
  );

  // Give every involved evidence its own private/off-chain pointer to the SAME
  // resultHash and SAME txHash. These link row ids are not blockchain ids.
  for (const row of participantRows) {
    const lotDbId = row.verified_lot_db_id ?? row.declared_lot_db_id;
    if (!lotDbId) {
      runtime.log(`${row.evidence_id}: sem lot_db_id; link da prova compartilhada não foi persistido`);
      continue;
    }
    const participantLinkId = hashText(
      `ExploreChem/SharedMassProofParticipantLink/v1|${result.resultId}|${row.evidence_id}`,
    );
    supabaseRequestRaw(
      runtime,
      serviceRoleKey,
      "/rest/v1/explorerchem_balance_results?on_conflict=result_id",
      "POST",
      {
        result_id: participantLinkId,
        lot_db_id: lotDbId,
        actor_db_id: row.actor_db_id,
        result_hash: result.resultHash,
        previous_result_db_id: null,
        status: result.checkpoint.status,
        calculation_version: 1,
        summary: {
          schema: "ExploreChem/SharedMassProofParticipant/v1",
          sourceEvidenceId: row.evidence_id,
          sharedProofResultId: result.resultId,
          sharedResultHash: result.resultHash,
          sharedTransactionHash: result.transactionHash,
          publicMembershipCommitted: false,
          proofPayload: result.proofPayload,
        },
        anchor_tx_hash: result.transactionHash,
        anchored_at: anchoredAt,
      },
      { prefer: { values: ["resolution=merge-duplicates,return=representation"] } },
    );
  }
}

function anchorSharedMassProof(
  runtime: TeeRuntime<Config>,
  serviceRoleKey: string,
  participantRows: SupabaseEvidenceRow[],
  massSnapshot: CorrelatedMassSnapshot,
): {
  resultId: Hex;
  resultHash: Hex;
  transactionHash: Hex;
  participantEvidenceIds: Hex[];
} {
  const participantEvidenceIds = participantRows
    .map((row) => row.evidence_id)
    .sort((a, b) => a.localeCompare(b));

  // No per-actor salt. The public commitment hashes only the canonical mass
  // proof payload, with all participant/evidence/correlation identifiers
  // stripped first. Therefore resultHash is shared but is NOT a membership hash.
  const proofPayload = buildSharedMassProofPayload(massSnapshot);
  const resultHash = hashText(stableJson({
    domain: "ExploreChem/SharedMassProofHash/v1",
    value: proofPayload,
  }));
  const resultId = hashText(`ExploreChem/SharedMassProofId/v1|${resultHash}`);

  const transactionHash = writeReport(
    runtime,
    encodeSharedMassProofReport(resultId, resultHash, 1),
    2,
    true,
  );

  persistSharedMassProofForParticipants(runtime, serviceRoleKey, participantRows, {
    resultId,
    resultHash,
    transactionHash,
    checkpoint: massSnapshot,
    proofPayload,
  });

  return { resultId, resultHash, transactionHash, participantEvidenceIds };
}

function runCorrelationCycle(
  runtime: TeeRuntime<Config>,
  _mode: CorrelationRunMode,
): string {
  const serviceRoleKey = getSupabaseServiceRoleKey(runtime);
  const snapshot = loadDirectCorrelationSnapshot(runtime, serviceRoleKey);
  const verifiedById = new Map<string, VerifiedBundle>();
  const rowsById = new Map(
    snapshot.rows.map((row) => [normalizeHex(row.evidence_id), row] as const),
  );
  const preExistingMatched = new Set(
    snapshot.rows.filter((row) => row.state === "MATCHED" || row.state === "VERIFIED").map((row) => normalizeHex(row.evidence_id)),
  );

  // Discovery remains Supabase-first. Integrity and event-role problems are
  // separated from transient infrastructure failures so only deterministic
  // evidence problems can become DIVERGENT.
  for (const [id, bundle] of snapshot.bundles) {
    try {
      const row = rowsById.get(id);
      if (!row) throw new Error(`${bundle.evidenceId}: linha Supabase não encontrada`);
      verifiedById.set(id, verifyBundleForCorrelation(runtime, serviceRoleKey, bundle, row));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isEvidenceDivergenceError(error)) snapshot.divergenceErrors.set(id, message);
      else snapshot.bundleErrors.set(id, message);
    }
  }

  // MATCHED is not terminal. Every run re-opens/re-hashes its document above
  // and now rechecks the immutable on-chain anchor before allowing it to act as
  // a counterpart or mass checkpoint. DIVERGENT is the only terminal state.
  for (const row of snapshot.rows) {
    if (row.state !== "MATCHED" && row.state !== "VERIFIED") continue;
    const id = normalizeHex(row.evidence_id);
    const item = verifiedById.get(id);
    if (!item) continue;
    try {
      const authoritative = readOnchainEvidence(runtime, row.evidence_id, LATEST_BLOCK_NUMBER);
      if (authoritative.status === 4) {
        snapshot.divergenceErrors.set(
          id,
          `${row.evidence_id}: ONCHAIN_DIVERGENT: evidência já está DIVERGENT no contrato`,
        );
        verifiedById.delete(id);
        continue;
      }
      if (authoritative.status !== 2 && authoritative.status !== 3) {
        snapshot.bundleErrors.set(
          id,
          `${row.evidence_id}: Supabase está MATCHED, mas estado on-chain é ${authoritative.status}`,
        );
        verifiedById.delete(id);
        continue;
      }
      if (normalizeHex(authoritative.evidenceHash) !== normalizeHex(item.integrity.recomputedHash)) {
        snapshot.divergenceErrors.set(
          id,
          `${row.evidence_id}: HASH_MISMATCH_ONCHAIN: documento revalidado diverge da âncora`,
        );
        verifiedById.delete(id);
        continue;
      }
      item.onchain = authoritative;
      item.integrity.anchoredHash = authoritative.evidenceHash;
      item.integrity.hashMatches = true;
    } catch (error) {
      snapshot.bundleErrors.set(
        id,
        `${row.evidence_id}: falha técnica ao revalidar MATCHED on-chain: ${error instanceof Error ? error.message : String(error)}`,
      );
      verifiedById.delete(id);
    }
  }

  const stats: CycleStats = {
    scanned: snapshot.rows.length,
    firstPending: null,
    correlatedEvidenceIds: [],
    correlationEdges: 0,
    matchedThisRun: [],
    alreadyMatchedUsed: [],
    waitingCounterpart: 0,
    integrityRejected: snapshot.bundleErrors.size,
    divergentThisRun: [],
    alreadyDivergent: [],
    divergenceTransactions: [],
    divergenceFailures: [],
    simulatedMatches: 0,
    matchTransactions: [],
    massStatus: null,
    massResults: [],
  };
  const correlationPolicyVersion = "explorechem-correlation-v2-event-first";

  // Deterministic bad evidence does not block the queue. Mark it DIVERGENT and
  // continue. Technical RPC/Storage/Supabase failures remain retryable and are
  // never converted into a business verdict.
  for (const [id, reason] of snapshot.divergenceErrors) {
    const row = rowsById.get(id);
    if (!row) continue;
    try {
      const outcome = markEvidenceDivergent(runtime, serviceRoleKey, row);
      if (outcome.alreadyDivergent) {
        stats.alreadyDivergent.push(row.evidence_id);
      } else if (outcome.transactionHash !== null) {
        if (normalizeHex(outcome.transactionHash) === normalizeHex(zeroHash)) {
          runtime.log(`${row.evidence_id}: DIVERGENT simulado · ${reason}`);
        } else {
          stats.divergentThisRun.push(row.evidence_id);
          stats.divergenceTransactions.push({ evidenceId: row.evidence_id, transactionHash: outcome.transactionHash });
        }
      }
    } catch (error) {
      stats.divergenceFailures.push({
        evidenceId: row.evidence_id,
        error: `${reason} · audit=${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  const firstPendingRow = snapshot.rows.find((row) =>
    row.state === "PENDING" &&
    !snapshot.divergenceErrors.has(normalizeHex(row.evidence_id)) &&
    verifiedById.has(normalizeHex(row.evidence_id))
  );
  if (!firstPendingRow) {
    return JSON.stringify({
      reviewedAt: new Date(runtime.now()).toISOString(),
      execution: {
        workflow: "MASS",
        discovery: "SUPABASE_API_FIRST",
        correlation: "EVIDENCE_CENTRIC_GRAPH",
        tee: "AWS_NITRO_US_WEST_2",
      },
      message: snapshot.divergenceErrors.size > 0
        ? "não restou evidência PENDING válida após auditoria de divergências"
        : "nenhuma evidência PENDING off-chain encontrada",
      divergenceErrors: [...snapshot.divergenceErrors.entries()].map(([evidenceId, error]) => ({ evidenceId, error })),
      bundleErrors: [...snapshot.bundleErrors.entries()].map(([evidenceId, error]) => ({ evidenceId, error })),
      ...stats,
    });
  }

  stats.firstPending = firstPendingRow.evidence_id;
  const queue: string[] = [normalizeHex(firstPendingRow.evidence_id)];
  const queued = new Set(queue);
  const component = new Set<string>();
  const edgeMap = new Map<string, VerifiedEdge>();
  const newlyMatched = new Set<string>();

  while (queue.length > 0) {
    const focusId = queue.shift()!;
    const focus = verifiedById.get(focusId);
    const row = rowsById.get(focusId);
    if (!focus || !row || !validForCorrelation(focus)) {
      stats.integrityRejected += 1;
      continue;
    }

    component.add(focusId);
    const validEdges = verifyFocusRelationships(
      focus.bundle.evidenceId,
      correlationPolicyVersion,
      [...verifiedById.values()],
    );

    if (validEdges.length === 0) {
      if (row.state === "PENDING") stats.waitingCounterpart += 1;
      continue;
    }

    for (const edge of validEdges) {
      edgeMap.set(edgeKey(edge), edge);
      for (const evidenceId of [edge.fromEvidenceId, edge.toEvidenceId]) {
        const id = normalizeHex(evidenceId);
        component.add(id);
        if (!queued.has(id)) {
          queue.push(id);
          queued.add(id);
        }
      }
    }

    if (row.state === "PENDING") {
      // Idempotency gate: the queue is off-chain, but before spending gas we
      // reconcile this exact evidenceId with the receiver. A previous run may
      // have succeeded on-chain and crashed before PATCHing Supabase.
      let authoritative: OnchainEvidence;
      try {
        authoritative = readOnchainEvidence(runtime, focus.bundle.evidenceId, LATEST_BLOCK_NUMBER);
      } catch (error) {
        stats.divergenceFailures.push({
          evidenceId: focus.bundle.evidenceId,
          error: `não foi possível reconciliar getEvidence antes do MATCH: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }

      if (authoritative.status === 4) {
        patchDivergentInSupabaseBestEffort(runtime, serviceRoleKey, focus.bundle.evidenceId);
        stats.alreadyDivergent.push(focus.bundle.evidenceId);
        continue;
      }

      if (authoritative.status === 2) {
        reconcileMatchedInSupabase(runtime, serviceRoleKey, authoritative);
        focus.onchain = authoritative;
        row.state = "MATCHED";
        row.matched_at = new Date(Number(authoritative.matchedAt) * 1000).toISOString();
        preExistingMatched.add(focusId);
        // Supabase was behind an already successful MATCH. Treat it as newly
        // available for the shared mass proof so an interrupted prior run can
        // recover without resending reportType 1.
        newlyMatched.add(focusId);
        stats.alreadyMatchedUsed.push(focus.bundle.evidenceId);
        continue;
      }

      if (authoritative.status !== 1) {
        stats.divergenceFailures.push({
          evidenceId: focus.bundle.evidenceId,
          error: `estado on-chain inesperado antes do MATCH: ${authoritative.status}`,
        });
        continue;
      }

      if (normalizeHex(authoritative.evidenceHash) !== normalizeHex(focus.integrity.recomputedHash)) {
        try {
          const outcome = markEvidenceDivergent(runtime, serviceRoleKey, row);
          if (outcome.transactionHash && normalizeHex(outcome.transactionHash) !== normalizeHex(zeroHash)) {
            stats.divergentThisRun.push(row.evidence_id);
            stats.divergenceTransactions.push({ evidenceId: row.evidence_id, transactionHash: outcome.transactionHash });
          }
        } catch (error) {
          stats.divergenceFailures.push({
            evidenceId: row.evidence_id,
            error: `HASH_MISMATCH_ONCHAIN · ${error instanceof Error ? error.message : String(error)}`,
          });
        }
        continue;
      }

      const transactionHash = writeReport(
        runtime,
        encodeEvidenceMatchReport(focus.bundle.evidenceId),
        1,
        false,
      );
      stats.matchTransactions.push({ evidenceId: focus.bundle.evidenceId, transactionHash });

      if (normalizeHex(transactionHash) === normalizeHex(zeroHash)) {
        stats.simulatedMatches += 1;
      } else {
        // writeReport already checks txStatus and receiverContractExecutionStatus.
        // Avoid a fragile immediate read-after-write; if this PATCH is ever
        // interrupted, the next run reconciles getEvidence before writing again.
        patchMatchedAfterReceiverSuccess(runtime, serviceRoleKey, row, transactionHash);
        focus.onchain = {
          ...authoritative,
          status: 2,
         matchedAt: BigInt(
  Math.floor(new Date(runtime.now()).getTime() / 1000)
        };
        newlyMatched.add(focusId);
        stats.matchedThisRun.push(focus.bundle.evidenceId);
      }
    } else if (row.state === "MATCHED" || row.state === "VERIFIED") {
      stats.alreadyMatchedUsed.push(focus.bundle.evidenceId);
    }
  }

  const componentItems = [...component]
    .map((id) => verifiedById.get(id))
    .filter((item): item is VerifiedBundle => item !== undefined && validForCorrelation(item));
  const componentEdges = [...edgeMap.values()].filter((edge) =>
    component.has(normalizeHex(edge.fromEvidenceId)) && component.has(normalizeHex(edge.toEvidenceId))
  );

  stats.correlatedEvidenceIds = componentItems.map((item) => item.bundle.evidenceId).sort();
  stats.correlationEdges = componentEdges.length;

  // FINAL MASS RULE:
  //   - MATCHED/VERIFIED enter the mass calculation;
  //   - PENDING does not enter yet;
  //   - DIVERGENT is the only terminal state and is not returned by discovery.
  const matchedComponentItems = componentItems.filter((item) => {
    const row = rowsById.get(normalizeHex(item.bundle.evidenceId));
    return row?.state === "MATCHED" || row?.state === "VERIFIED";
  });
  const matchedIds = new Set(
    matchedComponentItems.map((item) => normalizeHex(item.bundle.evidenceId)),
  );
  const matchedComponentEdges = componentEdges.filter((edge) =>
    matchedIds.has(normalizeHex(edge.fromEvidenceId)) &&
    matchedIds.has(normalizeHex(edge.toEvidenceId))
  );
  const newlyMatchedItems = [...newlyMatched]
    .map((id) => verifiedById.get(id))
    .filter((item): item is VerifiedBundle =>
      item !== undefined && matchedIds.has(normalizeHex(item.bundle.evidenceId))
    );

  if (
    newlyMatchedItems.length > 0 &&
    matchedComponentItems.length > 1 &&
    matchedComponentEdges.length > 0
  ) {
    // A pre-existing MATCHED can provide the previous private checkpoint. We
    // still revalidated its document in this run before it was allowed into the
    // active graph. If a historical checkpoint contains any evidence that is no
    // longer MATCHED (for example it later became DIVERGENT), that checkpoint is
    // discarded and the active MATCHED component is recalculated instead.
    const checkpointsByResult = new Map<string, MassCheckpoint>();
    for (const id of preExistingMatched) {
      if (!matchedIds.has(id)) continue;
      const item = verifiedById.get(id);
      if (!item) continue;
      try {
        const checkpoint = loadLatestMassCheckpointForEvidence(
          runtime,
          serviceRoleKey,
          item.bundle.evidenceId,
        );
        if (!checkpoint) continue;
        const checkpointStillActive = checkpoint.snapshot.evidenceIds.every((evidenceId) =>
          matchedIds.has(normalizeHex(evidenceId))
        );
        if (!checkpointStillActive) {
          runtime.log(`${item.bundle.evidenceId}: checkpoint antigo contém evidência fora do conjunto MATCHED; ignorado`);
          continue;
        }
        checkpointsByResult.set(normalizeHex(checkpoint.resultId), checkpoint);
      } catch (error) {
        runtime.log(`${item.bundle.evidenceId}: checkpoint indisponível: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const checkpoints = [...checkpointsByResult.values()];
    const massSnapshot = checkpoints.length > 0
      ? mergeCheckpointSnapshots(
          checkpoints,
          newlyMatchedItems,
          matchedComponentItems,
          matchedComponentEdges,
          correlationPolicyVersion,
        )
      : buildCorrelatedMassSnapshot(
          matchedComponentItems,
          matchedComponentEdges,
          correlationPolicyVersion,
        );

    // IMPORTANT: a DIVERGENTE mass result is NOT an evidence-integrity verdict.
    // No evidence is changed to DIVERGENT here. Evidence DIVERGENT happens only
    // in the integrity/audit path and never enters this calculation.
    stats.massStatus = massSnapshot.status;

    const participantRows = matchedComponentItems
      .map((item) => rowsById.get(normalizeHex(item.bundle.evidenceId)))
      .filter((row): row is SupabaseEvidenceRow =>
        row !== undefined && (row.state === "MATCHED" || row.state === "VERIFIED")
      );

    // ONE operation -> ONE deterministic hash -> ONE blockchain tx. The same
    // resultHash/txHash is then linked privately to every involved participant.
    stats.massResults.push(
      anchorSharedMassProof(
        runtime,
        serviceRoleKey,
        participantRows,
        massSnapshot,
      ),
    );
  }

  return JSON.stringify({
    reviewedAt: new Date(runtime.now()).toISOString(),
    execution: {
      workflow: "MASS",
      discovery: "SUPABASE_API_FIRST",
      pendingAuthority: "OFFCHAIN_QUEUE_WITH_ONCHAIN_IDEMPOTENCY_GATE",
      correlation: "EVIDENCE_CENTRIC_GRAPH",
      matchTiming: "IMMEDIATE_PER_VALID_EVIDENCE",
      massTiming: "CHECKPOINT_INCREMENTAL_AFTER_NEW_MATCH",
      massAnchor: "ONE_SHARED_UNSALTED_PROOF_PER_CORRELATED_OPERATION",
      divergence: "DETERMINISTIC_EVIDENCE_ERROR_TO_REPORT_TYPE_3",
      tee: "AWS_NITRO_US_WEST_2",
    },
    policy: {
      firstPendingComesFromSupabase: true,
      actorIdInsideDocumentIsNotCorrelationProof: true,
      noCounterpartMeansStayPending: true,
      deterministicBadEvidenceBecomesDivergent: true,
      technicalFailureNeverBecomesDivergent: true,
      pendingIsReconciledOnchainBeforeNewMatchTransaction: true,
      matchedEvidenceUsesLatestMassCheckpointWhenAvailable: true,
      oldMatchedHistoryIsNotRecalculatedWhenCheckpointExists: true,
      divergentNeverEntersMassCalculation: true,
      matchedAndVerifiedRemainReusableForFutureCorrelation: true,
      oneSharedMassProofForAllParticipants: true,
      perEvidenceSaltRemoved: true,
      reportType2ExposesNoActorOrEvidenceMembership: true,
    },
    divergenceErrors: [...snapshot.divergenceErrors.entries()].map(([evidenceId, error]) => ({ evidenceId, error })),
    bundleErrors: [...snapshot.bundleErrors.entries()].map(([evidenceId, error]) => ({ evidenceId, error })),
    ...stats,
  });
}

function canonicalFlowKey(stream: Stream): string {
  return stream.canonicalFlowKey ?? stream.streamId;
}

function validateBalanceGraph(input: WorkflowInput): void {
  const evidenceById = new Map<string, WorkflowInput["verifiedEvidences"][number]>();
  for (const evidence of input.verifiedEvidences) {
    const id = normalizeHex(evidence.evidenceId);
    if (evidenceById.has(id)) throw new Error(`evidenceId duplicado: ${evidence.evidenceId}`);
    evidenceById.set(id, evidence);
  }

  const streamIds = new Set<string>();
  const canonicalFlowKeys = new Set<string>();
  const nodeDirections = new Map<string, { inputs: number; outputs: number }>();
  for (const stream of input.streams) {
    if (streamIds.has(stream.streamId)) throw new Error(`streamId duplicado: ${stream.streamId}`);
    streamIds.add(stream.streamId);
    const flowKey = canonicalFlowKey(stream);
    if (canonicalFlowKeys.has(flowKey)) {
      throw new Error(`canonicalFlowKey duplicada no snapshot: ${flowKey}`);
    }
    canonicalFlowKeys.add(flowKey);
    const directions = nodeDirections.get(stream.measurementPoint) ?? { inputs: 0, outputs: 0 };
    if (stream.type === "ENTRADA") directions.inputs += 1;
    else directions.outputs += 1;
    nodeDirections.set(stream.measurementPoint, directions);
    const primary = evidenceById.get(normalizeHex(stream.evidenceId));
    if (!primary) throw new Error(`stream ${stream.streamId}: evidência primária não está em verifiedEvidences`);
    if (normalizeHex(primary.evidenceHash) !== normalizeHex(stream.evidenceHash)) {
      throw new Error(`stream ${stream.streamId}: evidenceHash diverge da evidência verificada`);
    }
    const expectedRole = stream.type === "ENTRADA" ? "PHYSICAL_INPUT" : "PHYSICAL_OUTPUT";
    if (primary.calculationRole !== expectedRole) {
      throw new Error(
        `stream ${stream.streamId}: ${stream.type} exige calculationRole ${expectedRole}; recebido ${primary.calculationRole}`,
      );
    }
    const supportSeen = new Set<string>();
    for (const supportId of stream.supportingEvidenceIds) {
      const supportKey = normalizeHex(supportId);
      if (supportSeen.has(supportKey)) {
        throw new Error(`stream ${stream.streamId}: supportingEvidenceId duplicado: ${supportId}`);
      }
      supportSeen.add(supportKey);
      if (!evidenceById.has(normalizeHex(supportId))) {
        throw new Error(`stream ${stream.streamId}: supportingEvidenceId não verificado: ${supportId}`);
      }
    }
    const elements = new Set(stream.analyses.map((item) => item.element));
    if (elements.size !== ELEMENTS.length || ELEMENTS.some((element) => !elements.has(element))) {
      throw new Error(`corrente ${stream.streamId}: informe ND, PR, DY e TB uma única vez`);
    }
    for (const analysis of stream.analyses) validateAnalysis(stream, analysis);
  }

  for (const [measurementPoint, directions] of nodeDirections) {
    if (directions.inputs === 0 || directions.outputs === 0) {
      throw new Error(
        `transformação ${measurementPoint}: exige ao menos uma ENTRADA e uma SAÍDA física`,
      );
    }
  }

  const adjacency = new Map<string, string[]>();
  const edgeKeys = new Set<string>();
  for (const id of evidenceById.keys()) adjacency.set(id, []);
  for (const edge of input.correlationEdges) {
    const from = normalizeHex(edge.fromEvidenceId);
    const to = normalizeHex(edge.toEvidenceId);
    if (from === to) throw new Error("correlationEdges não pode ligar uma evidência a ela mesma");
    if (!evidenceById.has(from) || !evidenceById.has(to)) {
      throw new Error("correlationEdges contém evidência fora de verifiedEvidences");
    }
    const key = edgeKey(edge);
    if (edgeKeys.has(key)) throw new Error(`correlationEdge duplicada: ${key}`);
    edgeKeys.add(key);
    adjacency.get(from)!.push(to);
    adjacency.get(to)!.push(from);
  }

  if (evidenceById.size > 1) {
    const start = normalizeHex(input.verifiedEvidences[0].evidenceId);
    const visited = new Set<string>([start]);
    const queue = [start];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const neighbor of adjacency.get(current) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    if (visited.size !== evidenceById.size) throw new Error("grafo verificado da cadeia está desconectado");
  }
}

function verifyBalanceEvidenceGraph(
  runtime: TeeRuntime<Config>,
  token: string,
  input: WorkflowInput,
  bundles: EvidenceBundle[],
): VerifiedBundle[] {
  const expectedById = new Map(
    input.verifiedEvidences.map((item) => [normalizeHex(item.evidenceId), item]),
  );
  const bundleById = new Map(bundles.map((item) => [normalizeHex(item.evidenceId), item]));

  if (bundleById.size !== expectedById.size) {
    throw new Error("contexto de balanço não contém exatamente as evidências verificadas da cadeia");
  }

  const verified: VerifiedBundle[] = [];
  for (const [id, expected] of expectedById) {
    const bundle = bundleById.get(id);
    if (!bundle) throw new Error(`${expected.evidenceId}: documento ausente no contexto de balanço`);
    const item = verifyBundle(runtime, token, bundle);
    if (item.onchain.status !== 2) {
      throw new Error(`${expected.evidenceId}: balanço exige evidência MATCHED on-chain`);
    }
    if (!validForBalance(item)) {
      throw new Error(`${expected.evidenceId}: integridade/extração/ator não validados para o balanço`);
    }
    if (normalizeHex(item.onchain.actorId) !== normalizeHex(expected.actorId)) {
      throw new Error(`${expected.evidenceId}: actorId diverge do contrato`);
    }
    if (normalizeHex(item.onchain.evidenceHash) !== normalizeHex(expected.evidenceHash)) {
      throw new Error(`${expected.evidenceId}: evidenceHash diverge do contrato`);
    }
    if (item.normalized.calculationRole !== expected.calculationRole) {
      throw new Error(
        `${expected.evidenceId}: calculationRole extraído (${item.normalized.calculationRole}) ` +
        `diverge do papel contábil verificado (${expected.calculationRole})`,
      );
    }
    verified.push(item);
  }

  const verifiedById = new Map(
    verified.map((item) => [normalizeHex(item.bundle.evidenceId), item]),
  );
  for (const edge of input.correlationEdges) {
    const from = verifiedById.get(normalizeHex(edge.fromEvidenceId));
    const to = verifiedById.get(normalizeHex(edge.toEvidenceId));
    if (!from || !to) throw new Error(`aresta ${edgeKey(edge)} sem documentos verificados`);

    const forward = validateDirectedRelationship(from, to);
    const reverse = validateDirectedRelationship(to, from);
    const accepted = [forward, reverse].some(
      (candidate) => candidate !== null && edgeKey(candidate) === edgeKey(edge),
    );
    if (!accepted) {
      throw new Error(`aresta privada não reproduzida no TEE: ${edgeKey(edge)}`);
    }
  }

  return verified;
}

type AssaySource = {
  evidenceId: Hex;
  measurement: AnalyticalMeasurement;
  actorType: z.infer<typeof actorTypeSchema>;
  eventAt: string | null;
  source:
    | "UPSTREAM_OUTGOING_LAB"
    | "UPSTREAM_OUTGOING_DECLARED"
    | "CURRENT_RECEIVING_LAB"
    | "CURRENT_OUTGOING_LAB"
    | "CURRENT_OUTGOING_DECLARED"
    | "STREAM_DECLARED";
};

type AnalyticalComparison = {
  targetEvidenceId: Hex;
  element: Element;
  previousEvidenceId: Hex;
  currentLabEvidenceId: Hex;
  previousValuePct: string;
  currentValuePct: string;
  differencePctPoints: string;
  tolerancePctPoints: string | null;
  status: "COMPATIBLE" | "DIVERGENT" | "NOT_EVALUATED" | "NOT_COMPARABLE";
};

function analysisFromMeasurement(measurement: AnalyticalMeasurement): Analysis {
  return analysisSchema.parse({
    element: measurement.element,
    oxideFormula: measurement.oxideFormula,
    reportedValue: measurement.reportedValue,
    unit: measurement.unit,
    basis: measurement.basis,
    denominatorPurity: measurement.denominatorPurity,
    factorTableVersion: measurement.factorTableVersion,
  });
}

function analysisBasisForStream(stream: Stream): (typeof BASES)[number] {
  return stream.basis === "LIQUIDO_TOTAL" ? "LIQUIDO_TOTAL" : "DRY_105C";
}

function measurementCompatibleWithStream(
  stream: Stream,
  measurement: AnalyticalMeasurement,
): boolean {
  return measurement.basis === analysisBasisForStream(stream);
}

function fractionAbs(value: Fraction): Fraction {
  return value.numerator < 0n
    ? { numerator: -value.numerator, denominator: value.denominator }
    : value;
}

function fractionLessThanOrEqual(left: Fraction, right: Fraction): boolean {
  return left.numerator * right.denominator <= right.numerator * left.denominator;
}

function fractionToDecimalString(value: Fraction, precision = 6): string {
  const scale = 10n ** BigInt(precision);
  const scaled = roundHalfUp(multiplyFractions(value, { numerator: scale, denominator: 1n }));
  const negative = scaled < 0n;
  const absoluteScaled = negative ? -scaled : scaled;
  const whole = absoluteScaled / scale;
  const fractional = (absoluteScaled % scale).toString().padStart(precision, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fractional ? `.${fractional}` : ""}`;
}

function pickLatestAssay(candidates: AssaySource[]): AssaySource | null {
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => {
    const byTime = String(b.eventAt ?? "").localeCompare(String(a.eventAt ?? ""));
    return byTime !== 0 ? byTime : a.evidenceId.localeCompare(b.evidenceId);
  })[0];
}

function physicalIncomingEdges(input: WorkflowInput, evidenceId: Hex): WorkflowInput["correlationEdges"] {
  const target = normalizeHex(evidenceId);
  return input.correlationEdges.filter((edge) =>
    normalizeHex(edge.toEvidenceId) === target &&
    edge.relationType !== "LAB_ANALYSIS" &&
    edge.relationType !== "DOCUMENT_SUPERSESSION"
  );
}

function inferredLabMeasurementRole(
  lab: VerifiedBundle,
  target: VerifiedBundle,
  measurement: AnalyticalMeasurement,
): "RECEIVING" | "OUTGOING" | "PROCESS" | "UNSPECIFIED" {
  if (measurement.measurementRole !== "UNSPECIFIED") return measurement.measurementRole;
  if (lab.normalized.eventAt === null || target.normalized.eventAt === null) return "UNSPECIFIED";
  return new Date(lab.normalized.eventAt).getTime() <= new Date(target.normalized.eventAt).getTime()
    ? "RECEIVING"
    : "OUTGOING";
}

function attachedLabAssay(
  input: WorkflowInput,
  verifiedById: Map<string, VerifiedBundle>,
  targetEvidenceId: Hex,
  element: Element,
  desiredRole: "RECEIVING" | "OUTGOING",
): AssaySource | null {
  const target = verifiedById.get(normalizeHex(targetEvidenceId));
  if (!target) return null;
  const labIds = new Set<string>();
  for (const edge of input.correlationEdges) {
    if (edge.relationType !== "LAB_ANALYSIS") continue;
    if (normalizeHex(edge.toEvidenceId) === normalizeHex(targetEvidenceId)) {
      labIds.add(normalizeHex(edge.fromEvidenceId));
    }
  }
  const candidates: AssaySource[] = [];
  for (const labId of labIds) {
    const lab = verifiedById.get(labId);
    if (!lab || lab.normalized.actorType !== "LABORATORY") continue;
    for (const measurement of lab.normalized.analyticalMeasurements) {
      if (measurement.element !== element || measurement.sourceKind !== "LAB_REPORT") continue;
      if (inferredLabMeasurementRole(lab, target, measurement) !== desiredRole) continue;
      candidates.push({
        evidenceId: lab.bundle.evidenceId,
        measurement,
        actorType: lab.normalized.actorType,
        eventAt: lab.normalized.eventAt,
        source: desiredRole === "RECEIVING" ? "CURRENT_RECEIVING_LAB" : "CURRENT_OUTGOING_LAB",
      });
    }
  }
  return pickLatestAssay(candidates);
}

function nearestUpstreamAssay(
  input: WorkflowInput,
  verifiedById: Map<string, VerifiedBundle>,
  startEvidenceId: Hex,
  element: Element,
  kind: "LAB" | "DECLARED",
): AssaySource | null {
  const visited = new Set<string>([normalizeHex(startEvidenceId)]);
  let frontier: Hex[] = [startEvidenceId];

  while (frontier.length > 0) {
    const next: Hex[] = [];
    const candidates: AssaySource[] = [];
    for (const current of frontier) {
      for (const edge of physicalIncomingEdges(input, current)) {
        const parentId = edge.fromEvidenceId;
        const key = normalizeHex(parentId);
        if (visited.has(key)) continue;
        visited.add(key);
        next.push(parentId);
        const parent = verifiedById.get(key);
        if (!parent) continue;

        if (kind === "LAB") {
          const lab = attachedLabAssay(input, verifiedById, parentId, element, "OUTGOING");
          if (lab) candidates.push({ ...lab, source: "UPSTREAM_OUTGOING_LAB" });
          continue;
        }

        for (const measurement of parent.normalized.analyticalMeasurements) {
          if (
            measurement.element !== element ||
            measurement.measurementRole !== "OUTGOING" ||
            measurement.sourceKind === "LAB_REPORT"
          ) continue;
          candidates.push({
            evidenceId: parent.bundle.evidenceId,
            measurement,
            actorType: parent.normalized.actorType,
            eventAt: parent.normalized.eventAt,
            source: "UPSTREAM_OUTGOING_DECLARED",
          });
        }
      }
    }
    const picked = pickLatestAssay(candidates);
    if (picked) return picked;
    frontier = next;
  }
  return null;
}

function currentReceivingLabAssay(
  input: WorkflowInput,
  verifiedById: Map<string, VerifiedBundle>,
  stream: Stream,
  element: Element,
): AssaySource | null {
  const direct = attachedLabAssay(input, verifiedById, stream.evidenceId, element, "RECEIVING");
  if (direct) return direct;

  // Backward compatibility: supportingEvidenceIds may explicitly bind a lab
  // even when a LAB_ANALYSIS edge has not yet been materialized in the input.
  const candidates: AssaySource[] = [];
  const target = verifiedById.get(normalizeHex(stream.evidenceId));
  if (!target) return null;
  for (const evidenceId of stream.supportingEvidenceIds) {
    const lab = verifiedById.get(normalizeHex(evidenceId));
    if (!lab || lab.normalized.actorType !== "LABORATORY") continue;
    for (const measurement of lab.normalized.analyticalMeasurements) {
      if (measurement.element !== element || measurement.sourceKind !== "LAB_REPORT") continue;
      if (inferredLabMeasurementRole(lab, target, measurement) !== "RECEIVING") continue;
      candidates.push({
        evidenceId: lab.bundle.evidenceId,
        measurement,
        actorType: lab.normalized.actorType,
        eventAt: lab.normalized.eventAt,
        source: "CURRENT_RECEIVING_LAB",
      });
    }
  }
  return pickLatestAssay(candidates);
}

function currentOutgoingAssay(
  input: WorkflowInput,
  verifiedById: Map<string, VerifiedBundle>,
  stream: Stream,
  element: Element,
): AssaySource | null {
  const lab = attachedLabAssay(input, verifiedById, stream.evidenceId, element, "OUTGOING");
  if (lab) return lab;

  const current = verifiedById.get(normalizeHex(stream.evidenceId));
  if (!current) return null;
  const candidates: AssaySource[] = current.normalized.analyticalMeasurements
    .filter((measurement) =>
      measurement.element === element &&
      measurement.measurementRole === "OUTGOING" &&
      measurement.sourceKind !== "LAB_REPORT"
    )
    .map((measurement) => ({
      evidenceId: current.bundle.evidenceId,
      measurement,
      actorType: current.normalized.actorType,
      eventAt: current.normalized.eventAt,
      source: "CURRENT_OUTGOING_DECLARED" as const,
    }));
  return pickLatestAssay(candidates);
}

function compareAssays(
  targetEvidenceId: Hex,
  previous: AssaySource,
  currentLab: AssaySource,
  tolerancePctPoints: string | undefined,
): AnalyticalComparison {
  const left = previous.measurement;
  const right = currentLab.measurement;
  if (
    left.unit !== "PERCENT" || right.unit !== "PERCENT" ||
    left.element !== right.element || left.oxideFormula !== right.oxideFormula
  ) {
    return {
      targetEvidenceId,
      element: left.element,
      previousEvidenceId: previous.evidenceId,
      currentLabEvidenceId: currentLab.evidenceId,
      previousValuePct: left.reportedValue,
      currentValuePct: right.reportedValue,
      differencePctPoints: "0",
      tolerancePctPoints: tolerancePctPoints ?? null,
      status: "NOT_COMPARABLE",
    };
  }

  const difference = fractionAbs(subtractFractions(
    parseDecimal(left.reportedValue),
    parseDecimal(right.reportedValue),
  ));
  let status: AnalyticalComparison["status"] = "NOT_EVALUATED";
  if (tolerancePctPoints !== undefined) {
    status = fractionLessThanOrEqual(difference, parseDecimal(tolerancePctPoints))
      ? "COMPATIBLE"
      : "DIVERGENT";
  }
  return {
    targetEvidenceId,
    element: left.element,
    previousEvidenceId: previous.evidenceId,
    currentLabEvidenceId: currentLab.evidenceId,
    previousValuePct: left.reportedValue,
    currentValuePct: right.reportedValue,
    differencePctPoints: fractionToDecimalString(difference),
    tolerancePctPoints: tolerancePctPoints ?? null,
    status,
  };
}

function applyAnalyticalEvidenceToBalanceInput(
  input: WorkflowInput,
  verified: VerifiedBundle[],
): {
  input: WorkflowInput;
  appliedAssays: Array<{
    streamId: string;
    element: Element;
    source: AssaySource["source"];
    sourceEvidenceId: Hex;
    reportedValue: string;
    unit: Analysis["unit"];
    oxideFormula: Analysis["oxideFormula"];
    basis: Analysis["basis"];
  }>;
  comparisons: AnalyticalComparison[];
  laboratoryReports: Array<{ evidenceId: Hex; report: z.infer<typeof laboratoryReportSchema> }>;
  evidenceIntegrity: Array<{
    evidenceId: Hex;
    status: "INTEGRO" | "DIVERGENTE";
    anchoredHash: Hex;
    recomputedHash: Hex;
  }>;
} {
  const verifiedById = new Map(verified.map((item) => [normalizeHex(item.bundle.evidenceId), item]));
  const appliedAssays: Array<{
    streamId: string;
    element: Element;
    source: AssaySource["source"];
    sourceEvidenceId: Hex;
    reportedValue: string;
    unit: Analysis["unit"];
    oxideFormula: Analysis["oxideFormula"];
    basis: Analysis["basis"];
  }> = [];
  const comparisonMap = new Map<string, AnalyticalComparison>();

  const streams = input.streams.map((stream) => {
    const analyses = stream.analyses.map((declared) => {
      let chosen: AssaySource | null = null;
      const upstreamLab = stream.type === "ENTRADA"
        ? nearestUpstreamAssay(input, verifiedById, stream.evidenceId, declared.element, "LAB")
        : null;
      const upstreamDeclared = stream.type === "ENTRADA"
        ? nearestUpstreamAssay(input, verifiedById, stream.evidenceId, declared.element, "DECLARED")
        : null;
      const currentLab = stream.type === "ENTRADA"
        ? currentReceivingLabAssay(input, verifiedById, stream, declared.element)
        : null;
      const ownOutgoing = stream.type === "ENTRADA"
        ? null
        : currentOutgoingAssay(input, verifiedById, stream, declared.element);

      // Business rule agreed for the MVP:
      // 1) previous physical actor's outgoing laboratory report;
      // 2) if absent, current actor's receiving laboratory report;
      // 3) if neither exists, previous actor's declared/process assay;
      // 4) finally, keep the analysis already carried by the stream.
      if (upstreamLab && measurementCompatibleWithStream(stream, upstreamLab.measurement)) chosen = upstreamLab;
      else if (currentLab && measurementCompatibleWithStream(stream, currentLab.measurement)) chosen = currentLab;
      else if (upstreamDeclared && measurementCompatibleWithStream(stream, upstreamDeclared.measurement)) chosen = upstreamDeclared;
      else if (ownOutgoing && measurementCompatibleWithStream(stream, ownOutgoing.measurement)) chosen = ownOutgoing;

      const previousForComparison = upstreamLab ?? upstreamDeclared;
      if (previousForComparison && currentLab) {
        const comparison = compareAssays(
          stream.evidenceId,
          previousForComparison,
          currentLab,
          input.parameters.analyticalTolerancePctPoints,
        );
        comparisonMap.set(`${normalizeHex(stream.evidenceId)}|${declared.element}`, comparison);
      }

      if (!chosen) {
        appliedAssays.push({
          streamId: stream.streamId,
          element: declared.element,
          source: "STREAM_DECLARED",
          sourceEvidenceId: stream.evidenceId,
          reportedValue: declared.reportedValue,
          unit: declared.unit,
          oxideFormula: declared.oxideFormula,
          basis: declared.basis,
        });
        return declared;
      }

      const effective = analysisFromMeasurement(chosen.measurement);
      appliedAssays.push({
        streamId: stream.streamId,
        element: effective.element,
        source: chosen.source,
        sourceEvidenceId: chosen.evidenceId,
        reportedValue: effective.reportedValue,
        unit: effective.unit,
        oxideFormula: effective.oxideFormula,
        basis: effective.basis,
      });
      return effective;
    });
    return { ...stream, analyses };
  });

  return {
    input: workflowInputSchema.parse({ ...input, streams }),
    appliedAssays,
    comparisons: [...comparisonMap.values()].sort((a, b) =>
      `${a.targetEvidenceId}|${a.element}`.localeCompare(`${b.targetEvidenceId}|${b.element}`),
    ),
    laboratoryReports: verified
      .filter((item) => item.normalized.laboratoryReport !== null)
      .map((item) => ({ evidenceId: item.bundle.evidenceId, report: item.normalized.laboratoryReport! })),
    evidenceIntegrity: verified.map((item) => ({
      evidenceId: item.bundle.evidenceId,
      status: item.integrity.hashMatches ? "INTEGRO" as const : "DIVERGENTE" as const,
      anchoredHash: item.integrity.anchoredHash,
      recomputedHash: item.integrity.recomputedHash,
    })),
  };
}

function getCommitmentMasterKey(runtime: TeeRuntime<Config>): string {
  const secrets = runtime
    .getSecrets([{ id: "COMMITMENT_MASTER_KEY", namespace: runtime.config.secretNamespace }])
    .result();
  const key = secrets.COMMITMENT_MASTER_KEY?.value;
  if (!key || key.length < 32) throw new Error("COMMITMENT_MASTER_KEY deve ter pelo menos 32 caracteres aleatórios");
  return key;
}

function persistBalanceResult(
  runtime: TeeRuntime<Config>,
  serviceRoleKey: string,
  input: WorkflowInput,
  result: {
    resultId: Hex;
    resultHash: Hex;
    aggregateInputHash: Hex;
    status: "CONFORME" | "DIVERGENTE" | "NAO_ATESTADO";
    statusByElement: Record<Element, BalanceVerdict>;
    aggregateStatusByElement: Record<Element, BalanceVerdict>;
    statusByNode: Record<string, Record<Element, BalanceVerdict>>;
    totals: Record<Element, ElementTotals>;
    streamValues: ReturnType<typeof calculateBalance>["streamValues"];
    summary: unknown;
    privateManifest: unknown;
    transactionHash: Hex;
    anchoredAt: string;
  },
): void {
  // The public result is written only after the chain anchor succeeds. The full
  // private manifest is used inside the TEE to derive resultHash and is not
  // exposed in this compatibility path.
  supabaseRequestRaw(
    runtime,
    serviceRoleKey,
    "/rest/v1/explorerchem_balance_results?on_conflict=result_id",
    "POST",
    {
      result_id: result.resultId,
      lot_db_id: input.chain.lotDbId,
      actor_db_id: input.chain.nodeActorDbId,
      result_hash: result.resultHash,
      previous_result_db_id: input.chain.previousResultDbId,
      status: result.status,
      calculation_version: input.chain.calculationVersion,
      summary: result.summary,
      anchor_tx_hash: result.transactionHash,
      anchored_at: result.anchoredAt,
    },
    { prefer: { values: ["resolution=merge-duplicates,return=representation"] } },
  );
}

function onHttpTrigger(runtime: TeeRuntime<Config>, payload: HTTPPayload): string {
  if (!payload.input || payload.input.length === 0) {
    return runCorrelationCycle(runtime, "IMMEDIATE_MATCH");
  }

  const decoded = decodeJson(payload.input);
  const action = actionRequestSchema.safeParse(decoded);
  if (!action.success) {
    throw new Error("payload inválido: use RUN_CORRELATION; o balanço compartilhado é automático após novos MATCHED");
  }

  // Backward compatibility: CALCULATE_CHAIN_BALANCE no longer accepts a
  // separate actor-scoped input. The unified cycle performs discovery,
  // correlation, evidence-state writes and ONE shared mass proof automatically.
  return runCorrelationCycle(runtime, "IMMEDIATE_MATCH");
}

function onCronTrigger(runtime: TeeRuntime<Config>, _payload: CronPayload): string {
  // Scheduled policy: weekly revalidation/recovery.
  // The simulator can invoke this trigger on demand, but the deployed schedule
  // remains weekly unless correlationSchedule explicitly overrides it.
  return runCorrelationCycle(runtime, "WEEKLY_REVALIDATION");
}

const initWorkflow = (config: Config) => {
  const http = new HTTPCapability();
  const cron = new CronCapability();
  return [
    handlerInTee(
      http.trigger({
        authorizedKeys: config.publicKey
          ? [{ type: "KEY_TYPE_ECDSA_EVM", publicKey: config.publicKey }]
          : [],
      }),
      onHttpTrigger,
      [{ tee: "nitro", regions: ["us-west-2"] }],
    ),
    handlerInTee(
      cron.trigger({ schedule: config.correlationSchedule ?? DEFAULT_SCHEDULE }),
      onCronTrigger,
      [{ tee: "nitro", regions: ["us-west-2"] }],
    ),
  ];
};

export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema });
  await runner.run(initWorkflow);
}

await main();
