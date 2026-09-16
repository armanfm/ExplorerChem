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
 * ExploreChem — specialized MUF workflow for ExploreChemProofRegistry.
 *
 * Final status policy:
 * - DIVERGENT: the downloaded JSON does not match the evidence hash anchored
 *   on-chain. No MUF is calculated from untrusted data.
 * - NOT_ATTESTED: integrity matches, but the MUF cannot be validly attested
 *   because the calculation is not applicable, an operand is absent/invalid,
 *   the reference input is zero, or |MUF| exceeds 100% of input + opening
 *   inventory.
 * - COMPLIANT: integrity matches and the MUF calculation is valid. This does
 *   not mean that the value is within a regulatory tolerance. Tolerance is
 *   evaluated by its own separately authorized workflow.
 */

const DEFAULT_SCHEDULE = "0 0 0 * * 0";
const CANDIDATE_LIMIT = 64;

const PROOF_TYPE_MUF = 1;
const CHECK_STATUS_PENDING = 1;
const CHECK_STATUS_COMPLIANT = 2;
const CHECK_STATUS_DIVERGENT = 3;
const CHECK_STATUS_NOT_ATTESTED = 4;

type MufStatus = "COMPLIANT" | "DIVERGENT" | "NOT_ATTESTED";

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
  actor_type: actorTypeSchema,
});

type ActorRow = z.infer<typeof actorRowSchema>;

const evidenceRowSchema = z.object({
  evidence_id: bytes32Schema,
  actor_db_id: z.string().uuid(),
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

type OnchainEvidence = {
  evidenceId: Hex;
  actorId: Hex;
  submittedBy: Address;
  evidenceHash: Hex;
  createdAt: bigint;
};

type CurrentMufState = {
  mufHash: Hex;
  mufStatus: number;
};

type SelectedEvidence = {
  row: EvidenceRow;
  actor: ActorRow;
  onchain: OnchainEvidence;
  current: CurrentMufState;
};

type MassOperand = {
  label: string;
  field: string | null;
  present: boolean;
  massMg: bigint | null;
};

type MufCalculation = {
  actorType: ActorType;
  formula: string;
  inputMassMg: string | null;
  openingInventoryMassMg: string | null;
  productMassMg: string | null;
  scrapMassMg: string | null;
  otherOutputMassMg: string | null;
  closingInventoryMassMg: string | null;
  referenceInputMassMg: string | null;
  accountedOutputMassMg: string | null;
  signedMufMg: string | null;
  absoluteMufMg: string | null;
  absoluteMufPercentScaled6: string | null;
  sourceFields: Record<string, string | null>;
};

type MufResult = {
  schema: "ExploreChem/MUFResult/v1";
  calculationVersion: 1;
  evidenceId: Hex;
  actorId: Hex;
  lotReference: string | null;
  expectedEvidenceHash: Hex;
  indexedEvidenceHash: Hex;
  downloadedDocumentHash: Hex | null;
  integrityMatches: boolean;
  status: MufStatus;
  statusCode: number;
  reasonCodes: string[];
  calculation: MufCalculation | null;
  interpretation: string;
};

type ProofCommitment = {
  proofType: 1;
  evidenceId: Hex;
  evidenceHash: Hex;
  proofId: Hex;
  committedHash: Hex;
  inputCommitmentHash: Hex;
  methodologyHash: Hex;
  previousProofId: Hex;
  status: number;
  revision: 1;
};

/* ============================================================
 * Contract ABI — ExploreChemProofRegistry
 * ============================================================
 */

const ABI = [
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
          { name: "createdAt", type: "uint64" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getCurrentProofState",
    stateMutability: "view",
    inputs: [{ name: "evidenceId", type: "bytes32" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "mufHash", type: "bytes32" },
          { name: "toleranceHash", type: "bytes32" },
          { name: "elementalHash", type: "bytes32" },
          { name: "yieldHash", type: "bytes32" },
          { name: "multiStreamHash", type: "bytes32" },
          { name: "auditHash", type: "bytes32" },
          { name: "mufStatus", type: "uint8" },
          { name: "toleranceStatus", type: "uint8" },
          { name: "elementalStatus", type: "uint8" },
          { name: "yieldStatus", type: "uint8" },
          { name: "multiStreamStatus", type: "uint8" },
          { name: "auditStatus", type: "uint8" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "latestProofId",
    stateMutability: "view",
    inputs: [
      { name: "evidenceId", type: "bytes32" },
      { name: "proofType", type: "uint8" },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
] as const;

const EVIDENCE_SELECT = [
  "evidence_id",
  "actor_db_id",
  "evidence_hash",
  "hash_algorithm",
  "storage_bucket",
  "storage_path",
  "mime_type",
  "lot_reference",
  "chain_created_at",
].join(",");

/* ============================================================
 * Deterministic helpers
 * ============================================================
 */

function lower(value: string): string {
  return value.toLowerCase();
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

function hashObject(value: unknown): Hex {
  return keccak256(toHex(stableJson(value)));
}

function recordOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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

/** Converts kg to integer milligrams with half-up rounding at 6 decimals. */
function kgToMg(value: string | null): bigint | null {
  if (value === null) return null;

  const [whole, fractional = ""] = value.split(".");
  const firstSix = fractional.slice(0, 6).padEnd(6, "0");
  let result = BigInt(whole) * 1_000_000n + BigInt(firstSix);

  if (fractional.length > 6 && Number(fractional[6]) >= 5) result += 1n;
  return result;
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function getPath(document: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>(
    (parent, key) => recordOf(parent)[key],
    document,
  );
}

function readMassOperand(
  document: Record<string, unknown>,
  label: string,
  paths: string[],
): MassOperand {
  for (const path of paths) {
    const raw = getPath(document, path);
    if (raw !== undefined && raw !== null) {
      return {
        label,
        field: path,
        present: true,
        massMg: kgToMg(decimalString(raw)),
      };
    }
  }

  return { label, field: null, present: false, massMg: null };
}

function operandValue(value: MassOperand): string | null {
  return value.massMg?.toString() ?? null;
}

function statusCode(status: MufStatus): number {
  if (status === "COMPLIANT") return CHECK_STATUS_COMPLIANT;
  if (status === "DIVERGENT") return CHECK_STATUS_DIVERGENT;
  return CHECK_STATUS_NOT_ATTESTED;
}

const MUF_METHODOLOGY = {
  domain: "ExploreChem/MUFMethodology/v1",
  calculationVersion: 1,
  unit: "mg",
  rounding: "KG_TO_MG_HALF_UP_6_DECIMALS",
  generalFormula:
    "(input + openingInventory) - (product + scrap + otherOutputs + closingInventory)",
  carrierFormula: "collectedMass - deliveredMass",
  validityRules: [
    "documentHashMustMatchEvidenceHash",
    "requiredOperandsMustBePresentAndNonNegative",
    "referenceInputMustBeGreaterThanZero",
    "absoluteMufMustNotExceedReferenceInput",
  ],
  toleranceEvaluation: "SEPARATE_TOLERANCE_WORKFLOW",
} as const;

const MUF_METHODOLOGY_HASH = hashObject(MUF_METHODOLOGY);

function encPath(path: string): string {
  return path
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

/* ============================================================
 * CRE network, secrets and HTTP
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
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY ausente");
  return { key };
}

type Method = "GET" | "POST";

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

function loadActors(runtime: TeeRuntime<Config>, key: string): Map<string, ActorRow> {
  const rows = z.array(actorRowSchema).parse(
    getJson<unknown>(
      runtime,
      key,
      "/rest/v1/explorerchem_actors?select=id,actor_id,actor_type&active=eq.true",
    ),
  );

  return new Map(rows.map((row) => [row.id, row]));
}

function loadCandidateRows(runtime: TeeRuntime<Config>, key: string): EvidenceRow[] {
  const path =
    `/rest/v1/explorerchem_evidences?select=${EVIDENCE_SELECT}` +
    "&order=chain_created_at.desc.nullslast,evidence_id.desc" +
    `&limit=${CANDIDATE_LIMIT}`;

  return z.array(evidenceRowSchema).parse(getJson<unknown>(runtime, key, path));
}

function downloadEvidenceDocument(
  runtime: TeeRuntime<Config>,
  key: string,
  row: EvidenceRow,
): Uint8Array {
  const path =
    `/storage/v1/object/authenticated/${encodeURIComponent(row.storage_bucket)}/` +
    encPath(row.storage_path);

  const response = request(runtime, key, path, "GET", undefined, {
    accept: { values: [row.mime_type] },
  });

  return new Uint8Array(response.body);
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
      `falha ao salvar resultado MUF privado: ${response.statusCode} ${text(response)}`,
    );
  }
}

/* ============================================================
 * Blockchain reads
 * ============================================================
 */

function callContract(
  runtime: TeeRuntime<Config>,
  functionName: "getEvidence" | "getCurrentProofState" | "latestProofId",
  args: readonly unknown[],
) {
  const callData = encodeFunctionData({
    abi: ABI,
    functionName,
    args: args as never,
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
    functionName,
    data: bytesToHex(response.data),
  });
}

function readEvidence(
  runtime: TeeRuntime<Config>,
  evidenceId: Hex,
): OnchainEvidence {
  const decoded = callContract(runtime, "getEvidence", [evidenceId]) as {
    evidenceId: Hex;
    actorId: Hex;
    submittedBy: Address;
    evidenceHash: Hex;
    createdAt: bigint;
  };

  return decoded;
}

function readCurrentMufState(
  runtime: TeeRuntime<Config>,
  evidenceId: Hex,
): CurrentMufState {
  const decoded = callContract(runtime, "getCurrentProofState", [evidenceId]) as {
    mufHash: Hex;
    mufStatus: number | bigint;
  };

  return {
    mufHash: decoded.mufHash,
    mufStatus: Number(decoded.mufStatus),
  };
}

function readLatestMufProofId(
  runtime: TeeRuntime<Config>,
  evidenceId: Hex,
): Hex {
  return callContract(
    runtime,
    "latestProofId",
    [evidenceId, PROOF_TYPE_MUF],
  ) as Hex;
}

function selectPendingEvidence(
  runtime: TeeRuntime<Config>,
  key: string,
): SelectedEvidence | null {
  const actors = loadActors(runtime, key);
  const candidates = loadCandidateRows(runtime, key);

  for (const row of candidates) {
    const actor = actors.get(row.actor_db_id);
    if (!actor) continue;

    try {
      const onchain = readEvidence(runtime, row.evidence_id);
      const current = readCurrentMufState(runtime, row.evidence_id);

      if (
        lower(onchain.evidenceId) === lower(row.evidence_id) &&
        lower(onchain.actorId) === lower(actor.actor_id) &&
        current.mufStatus === CHECK_STATUS_PENDING
      ) {
        return { row, actor, onchain, current };
      }
    } catch {
      // The Supabase row may exist before its evidence transaction is final.
      // It is not selected until the contract confirms it.
    }
  }

  return null;
}

/* ============================================================
 * Integrity and MUF calculation
 * ============================================================
 */

function recomputeEvidenceHash(row: EvidenceRow, bytes: Uint8Array): Hex {
  if (row.hash_algorithm === "SHA-256" || row.hash_algorithm === "SHA256") {
    return sha256(bytes);
  }
  return keccak256(bytes);
}

function emptyCalculation(actorType: ActorType): MufCalculation {
  return {
    actorType,
    formula:
      actorType === "CARRIER"
        ? "collectedMass - deliveredMass"
        : "(input + openingInventory) - (product + scrap + otherOutputs + closingInventory)",
    inputMassMg: null,
    openingInventoryMassMg: null,
    productMassMg: null,
    scrapMassMg: null,
    otherOutputMassMg: null,
    closingInventoryMassMg: null,
    referenceInputMassMg: null,
    accountedOutputMassMg: null,
    signedMufMg: null,
    absoluteMufMg: null,
    absoluteMufPercentScaled6: null,
    sourceFields: {},
  };
}

function calculateMuf(
  actorType: ActorType,
  document: Record<string, unknown>,
): { status: MufStatus; reasonCodes: string[]; calculation: MufCalculation } {
  if (actorType === "LABORATORY") {
    return {
      status: "NOT_ATTESTED",
      reasonCodes: ["MUF_NOT_APPLICABLE_TO_LABORATORY"],
      calculation: emptyCalculation(actorType),
    };
  }

  const carrier = actorType === "CARRIER";
  const input = readMassOperand(
    document,
    carrier ? "collectedMass" : "inputMass",
    carrier
      ? ["custody.massCollectedKg", "collectedMassKg", "inputMassKg"]
      : [
          "transformation.inputMassKg",
          "transformation.inputProductMassKg",
          "recovery.inputMassKg",
          "massBalance.inputMassKg",
          "inputMassKg",
        ],
  );
  const product = readMassOperand(
    document,
    carrier ? "deliveredMass" : "productMass",
    carrier
      ? ["custody.massDeliveredKg", "deliveredMassKg", "outputMassKg"]
      : [
          "transformation.outputMassKg",
          "transformation.outputProductMassKg",
          "transformation.finishedProductMassKg",
          "recovery.recoveredProductMassKg",
          "massBalance.outputMassKg",
          "outputMassKg",
          "recoveredMassKg",
        ],
  );
  const opening = readMassOperand(document, "openingInventoryMass", [
    "massBalance.openingInventoryMassKg",
    "transformation.openingInventoryMassKg",
    "openingInventoryMassKg",
  ]);
  const scrap = readMassOperand(document, "scrapMass", [
    "transformation.scrapMassKg",
    "massBalance.scrapMassKg",
    "scrapMassKg",
  ]);
  const otherOutput = readMassOperand(document, "otherOutputMass", [
    "massBalance.otherOutputMassKg",
    "massBalance.otherOutputsMassKg",
    "transformation.otherOutputMassKg",
    "transformation.otherOutputsMassKg",
    "otherOutputMassKg",
    "otherOutputsMassKg",
  ]);
  const closing = readMassOperand(document, "closingInventoryMass", [
    "massBalance.closingInventoryMassKg",
    "transformation.closingInventoryMassKg",
    "closingInventoryMassKg",
  ]);

  const optional = carrier ? [] : [opening, scrap, otherOutput, closing];
  const reasonCodes: string[] = [];

  if (!input.present || input.massMg === null) {
    reasonCodes.push("MISSING_OR_INVALID_INPUT_MASS");
  }
  if (!product.present || product.massMg === null) {
    reasonCodes.push("MISSING_OR_INVALID_PRODUCT_MASS");
  }
  for (const operand of optional) {
    if (operand.present && operand.massMg === null) {
      reasonCodes.push(`INVALID_${operand.label.toUpperCase()}`);
    }
  }

  const calculation: MufCalculation = {
    actorType,
    formula: carrier
      ? "collectedMass - deliveredMass"
      : "(input + openingInventory) - (product + scrap + otherOutputs + closingInventory)",
    inputMassMg: operandValue(input),
    openingInventoryMassMg: carrier ? null : operandValue(opening),
    productMassMg: operandValue(product),
    scrapMassMg: carrier ? null : operandValue(scrap),
    otherOutputMassMg: carrier ? null : operandValue(otherOutput),
    closingInventoryMassMg: carrier ? null : operandValue(closing),
    referenceInputMassMg: null,
    accountedOutputMassMg: null,
    signedMufMg: null,
    absoluteMufMg: null,
    absoluteMufPercentScaled6: null,
    sourceFields: {
      inputMass: input.field,
      openingInventoryMass: carrier ? null : opening.field,
      productMass: product.field,
      scrapMass: carrier ? null : scrap.field,
      otherOutputMass: carrier ? null : otherOutput.field,
      closingInventoryMass: carrier ? null : closing.field,
    },
  };

  if (reasonCodes.length > 0 || input.massMg === null || product.massMg === null) {
    return { status: "NOT_ATTESTED", reasonCodes, calculation };
  }

  const referenceInput = carrier
    ? input.massMg
    : input.massMg + (opening.massMg ?? 0n);
  const accountedOutput = carrier
    ? product.massMg
    : product.massMg +
      (scrap.massMg ?? 0n) +
      (otherOutput.massMg ?? 0n) +
      (closing.massMg ?? 0n);

  calculation.referenceInputMassMg = referenceInput.toString();
  calculation.accountedOutputMassMg = accountedOutput.toString();

  if (referenceInput === 0n) {
    return {
      status: "NOT_ATTESTED",
      reasonCodes: ["ZERO_REFERENCE_INPUT_MASS"],
      calculation,
    };
  }

  const signedMuf = referenceInput - accountedOutput;
  const absoluteMuf = absolute(signedMuf);
  const percentScaled6 =
    (absoluteMuf * 100_000_000n + referenceInput / 2n) / referenceInput;

  calculation.signedMufMg = signedMuf.toString();
  calculation.absoluteMufMg = absoluteMuf.toString();
  calculation.absoluteMufPercentScaled6 = percentScaled6.toString();

  if (absoluteMuf > referenceInput) {
    return {
      status: "NOT_ATTESTED",
      reasonCodes: ["ABSOLUTE_MUF_EXCEEDS_100_PERCENT"],
      calculation,
    };
  }

  return {
    status: "COMPLIANT",
    reasonCodes: [],
    calculation,
  };
}

function buildResult(
  runtime: TeeRuntime<Config>,
  key: string,
  selected: SelectedEvidence,
): MufResult {
  const { row, actor, onchain } = selected;

  let bytes: Uint8Array;
  try {
    bytes = downloadEvidenceDocument(runtime, key, row);
  } catch {
    const status: MufStatus = "NOT_ATTESTED";
    return {
      schema: "ExploreChem/MUFResult/v1",
      calculationVersion: 1,
      evidenceId: onchain.evidenceId,
      actorId: onchain.actorId,
      lotReference: row.lot_reference,
      expectedEvidenceHash: onchain.evidenceHash,
      indexedEvidenceHash: row.evidence_hash,
      downloadedDocumentHash: null,
      integrityMatches: false,
      status,
      statusCode: statusCode(status),
      reasonCodes: ["DOCUMENT_UNAVAILABLE"],
      calculation: null,
      interpretation: "MUF_NOT_ATTESTED",
    };
  }

  const documentHash = recomputeEvidenceHash(row, bytes);
  const integrityMatches =
    lower(row.evidence_hash) === lower(onchain.evidenceHash) &&
    lower(documentHash) === lower(onchain.evidenceHash);

  if (!integrityMatches) {
    const status: MufStatus = "DIVERGENT";
    return {
      schema: "ExploreChem/MUFResult/v1",
      calculationVersion: 1,
      evidenceId: onchain.evidenceId,
      actorId: onchain.actorId,
      lotReference: row.lot_reference,
      expectedEvidenceHash: onchain.evidenceHash,
      indexedEvidenceHash: row.evidence_hash,
      downloadedDocumentHash: documentHash,
      integrityMatches: false,
      status,
      statusCode: statusCode(status),
      reasonCodes: ["EVIDENCE_HASH_MISMATCH"],
      calculation: null,
      interpretation: "UNTRUSTED_INPUT_MUF_NOT_CALCULATED",
    };
  }

  if (!row.mime_type.toLowerCase().includes("json")) {
    const status: MufStatus = "NOT_ATTESTED";
    return {
      schema: "ExploreChem/MUFResult/v1",
      calculationVersion: 1,
      evidenceId: onchain.evidenceId,
      actorId: onchain.actorId,
      lotReference: row.lot_reference,
      expectedEvidenceHash: onchain.evidenceHash,
      indexedEvidenceHash: row.evidence_hash,
      downloadedDocumentHash: documentHash,
      integrityMatches: true,
      status,
      statusCode: statusCode(status),
      reasonCodes: ["UNSUPPORTED_DOCUMENT_TYPE"],
      calculation: null,
      interpretation: "MUF_NOT_ATTESTED",
    };
  }

  let document: Record<string, unknown>;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("JSON root must be an object");
    }
    document = parsed as Record<string, unknown>;
  } catch {
    const status: MufStatus = "NOT_ATTESTED";
    return {
      schema: "ExploreChem/MUFResult/v1",
      calculationVersion: 1,
      evidenceId: onchain.evidenceId,
      actorId: onchain.actorId,
      lotReference: row.lot_reference,
      expectedEvidenceHash: onchain.evidenceHash,
      indexedEvidenceHash: row.evidence_hash,
      downloadedDocumentHash: documentHash,
      integrityMatches: true,
      status,
      statusCode: statusCode(status),
      reasonCodes: ["INVALID_JSON"],
      calculation: null,
      interpretation: "MUF_NOT_ATTESTED",
    };
  }

  const calculated = calculateMuf(actor.actor_type, document);
  return {
    schema: "ExploreChem/MUFResult/v1",
    calculationVersion: 1,
    evidenceId: onchain.evidenceId,
    actorId: onchain.actorId,
    lotReference: row.lot_reference,
    expectedEvidenceHash: onchain.evidenceHash,
    indexedEvidenceHash: row.evidence_hash,
    downloadedDocumentHash: documentHash,
    integrityMatches: true,
    status: calculated.status,
    statusCode: statusCode(calculated.status),
    reasonCodes: calculated.reasonCodes,
    calculation: calculated.calculation,
    interpretation:
      calculated.status === "COMPLIANT"
        ? "MUF_CALCULATION_ATTESTED_TOLERANCE_NOT_EVALUATED"
        : "MUF_NOT_ATTESTED",
  };
}

/* ============================================================
 * Proof report
 * ============================================================
 */

function buildProofCommitment(
  selected: SelectedEvidence,
  result: MufResult,
): ProofCommitment {
  const inputCommitmentHash = hashObject({
    domain: "ExploreChem/MUFInputCommitment/v1",
    evidenceId: selected.onchain.evidenceId,
    expectedEvidenceHash: selected.onchain.evidenceHash,
    indexedEvidenceHash: result.indexedEvidenceHash,
    downloadedDocumentHash: result.downloadedDocumentHash,
    calculationInputs: result.calculation,
  });

  const committedHash = hashObject({
    domain: "ExploreChem/MUFCommitment/v1",
    result,
  });

  const proofSeed = {
    domain: "ExploreChem/MUFProofId/v1",
    proofType: PROOF_TYPE_MUF,
    evidenceId: selected.onchain.evidenceId,
    evidenceHash: selected.onchain.evidenceHash,
    committedHash,
    inputCommitmentHash,
    methodologyHash: MUF_METHODOLOGY_HASH,
    previousProofId: zeroHash,
    status: result.statusCode,
    revision: 1,
  };

  return {
    proofType: PROOF_TYPE_MUF,
    evidenceId: selected.onchain.evidenceId,
    evidenceHash: selected.onchain.evidenceHash,
    proofId: hashObject(proofSeed),
    committedHash,
    inputCommitmentHash,
    methodologyHash: MUF_METHODOLOGY_HASH,
    previousProofId: zeroHash,
    status: result.statusCode,
    revision: 1,
  };
}

function encodeProofReport(proof: ProofCommitment): Hex {
  return encodeAbiParameters(
    parseAbiParameters(
      "uint8 proofType, bytes32 evidenceId, bytes32 evidenceHash, bytes32 proofId, bytes32 committedHash, bytes32 inputCommitmentHash, bytes32 methodologyHash, bytes32 previousProofId, uint8 status, uint32 revision",
    ),
    [
      proof.proofType,
      proof.evidenceId,
      proof.evidenceHash,
      proof.proofId,
      proof.committedHash,
      proof.inputCommitmentHash,
      proof.methodologyHash,
      proof.previousProofId,
      proof.status,
      proof.revision,
    ],
  );
}

function writeProof(runtime: TeeRuntime<Config>, proof: ProofCommitment): Hex {
  const don = runtime.usingTheDons();
  const report = don
    .report({
      encodedPayload: hexToBase64(encodeProofReport(proof)),
      encoderName: "evm",
      signingAlgo: "ecdsa",
      hashingAlgo: "keccak256",
    })
    .result();

  const result = new EVMClient(network(runtime).chainSelector.selector)
    .writeReport(don, {
      receiver: runtime.config.contractAddress as Address,
      report,
      gasConfig: { gasLimit: runtime.config.gasLimit },
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
    throw new Error("writeReport nao retornou hash de transacao valido");
  }

  return bytesToHex(result.txHash) as Hex;
}

function privateResultPath(evidenceId: Hex, proofId: Hex): string {
  return `muf-results/${evidenceId.slice(2)}/${proofId.slice(2)}.json`;
}

/* ============================================================
 * Run
 * ============================================================
 */

function run(runtime: TeeRuntime<Config>): string {
  const { key } = secrets(runtime);
  const selected = selectPendingEvidence(runtime, key);

  if (selected === null) {
    return JSON.stringify({
      workflow: "MUF_WORKFLOW",
      proofType: "MUF",
      message:
        `nenhuma evidencia com mufStatus=PENDING encontrada entre as ${CANDIDATE_LIMIT} evidencias mais recentes`,
    });
  }

  const result = buildResult(runtime, key, selected);
  const proof = buildProofCommitment(selected, result);
  const resultPath = privateResultPath(proof.evidenceId, proof.proofId);

  const privateBase = {
    result,
    proof,
    methodology: MUF_METHODOLOGY,
    onchain: {
      contractAddress: runtime.config.contractAddress,
      txHash: null as Hex | null,
    },
  };

  savePrivateResult(
    runtime,
    key,
    selected.row.storage_bucket,
    resultPath,
    privateBase,
  );

  // Final state gate: another execution may have anchored the MUF meanwhile.
  const beforeWrite = readCurrentMufState(runtime, proof.evidenceId);
  const latestBeforeWrite = readLatestMufProofId(runtime, proof.evidenceId);
  if (
    beforeWrite.mufStatus !== CHECK_STATUS_PENDING ||
    lower(latestBeforeWrite) !== lower(zeroHash)
  ) {
    return JSON.stringify({
      workflow: "MUF_WORKFLOW",
      proofType: "MUF",
      evidenceId: proof.evidenceId,
      message: "MUF deixou de estar PENDING antes da escrita; nenhuma transacao enviada",
      currentMufStatus: beforeWrite.mufStatus,
      latestMufProofId: latestBeforeWrite,
    });
  }

  const txHash = writeProof(runtime, proof);
  const afterWrite = readCurrentMufState(runtime, proof.evidenceId);
  const anchoredProofId = readLatestMufProofId(runtime, proof.evidenceId);

  if (
    lower(anchoredProofId) !== lower(proof.proofId) ||
    lower(afterWrite.mufHash) !== lower(proof.committedHash) ||
    afterWrite.mufStatus !== proof.status
  ) {
    throw new Error(
      `${proof.evidenceId}: prova MUF nao confirmada apos ${txHash}`,
    );
  }

  const finalPrivateResult = {
    ...privateBase,
    onchain: {
      contractAddress: runtime.config.contractAddress,
      txHash,
    },
  };

  savePrivateResult(
    runtime,
    key,
    selected.row.storage_bucket,
    resultPath,
    finalPrivateResult,
  );

  return JSON.stringify({
    workflow: "MUF_WORKFLOW",
    proofType: "MUF",
    evidenceId: proof.evidenceId,
    actorId: result.actorId,
    lotReference: result.lotReference,
    status: result.status,
    reasonCodes: result.reasonCodes,
    calculation: result.calculation,
    integrity: {
      expectedEvidenceHash: result.expectedEvidenceHash,
      indexedEvidenceHash: result.indexedEvidenceHash,
      downloadedDocumentHash: result.downloadedDocumentHash,
      matches: result.integrityMatches,
    },
    commitment: {
      mufHash: proof.committedHash,
      inputCommitmentHash: proof.inputCommitmentHash,
      methodologyHash: proof.methodologyHash,
      proofId: proof.proofId,
      revision: proof.revision,
    },
    privateResult: {
      bucket: selected.row.storage_bucket,
      path: resultPath,
    },
    onchain: {
      contractAddress: runtime.config.contractAddress,
      txHash,
      confirmedMufStatus: afterWrite.mufStatus,
      confirmedMufHash: afterWrite.mufHash,
    },
  });
}

function onCron(runtime: TeeRuntime<Config>, _payload: CronPayload): string {
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
      [{ tee: "nitro", regions: ["us-west-2"] }],
    ),
  ];
};

export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema });
  await runner.run(initWorkflow);
}
