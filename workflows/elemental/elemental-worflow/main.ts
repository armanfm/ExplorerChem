import {
  CronCapability,
  EVMClient,
  HTTPClient,
  LATEST_BLOCK_NUMBER,
  Runner,
  TxStatus,
  bytesToHex,
  bigintToProtoBigInt,
  protoBigIntToBigint,
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
  decodeAbiParameters,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbiParameters,
  parseAbi,
  sha256,
  toHex,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
} from "viem";

import { z } from "zod";

/**
 * ExploreChem — specialized ELEMENTAL workflow.
 *
 * Eligibility is deliberately sequential:
 *   mufStatus       === COMPLIANT
 *   elementalStatus === PENDING
 *
 * The workflow verifies both the original evidence and the private MUF result.
 * Masses come from the verified MUF result; assays come from the original order.
 */

const DEFAULT_SCHEDULE = "0 0 0 * * 0";


const PROOF_TYPE_MUF = 1;
const PROOF_TYPE_ELEMENTAL = 3;
const CHECK_STATUS_PENDING = 1;
const CHECK_STATUS_COMPLIANT = 2;
const CHECK_STATUS_DIVERGENT = 3;
const CHECK_STATUS_NOT_ATTESTED = 4;

type ElementalStatus = "COMPLIANT" | "DIVERGENT" | "NOT_ATTESTED";

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
  onchainFromBlock: z.string().regex(/^\d+$/).optional(),
  onchainToBlock: z.string().regex(/^\d+$/).optional(),
  onchainCandidateOffset: z.number().int().nonnegative().optional(),
  tokenActionMode: z.enum(["INITIAL", "TRANSFORM"]).optional(),
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

type CurrentElementalState = {
  mufHash: Hex;
  mufStatus: number;
  elementalHash: Hex;
  elementalStatus: number;
};

type SelectedEvidence = {
  row: EvidenceRow;
  actor: ActorRow;
  onchain: OnchainEvidence;
  current: CurrentElementalState;
  latestMufProofId: Hex;
};

type MufCalculation = {
  inputMassMg: string | null;
  openingInventoryMassMg: string | null;
  productMassMg: string | null;
  scrapMassMg: string | null;
  otherOutputMassMg: string | null;
  closingInventoryMassMg: string | null;
  referenceInputMassMg: string | null;
  accountedOutputMassMg: string | null;
};

type MufPrivateResult = {
  schema: string;
  result: {
    status: string;
    calculation: MufCalculation | null;
  };
};

type ElementalStreamResult = {
  streamId: string;
  streamType: string;
  side: "AVAILABLE" | "ACCOUNTED";
  dryMassMg: string;
  dryMassSource: "MUF" | "ORDER_STREAM";
  sourceLotId?: string;
  element: string;
  assayBasis: "ELEMENT_PCT" | "COMPOUND_PCT";
  assayValuePctScaled6: string;
  compound: string | null;
  elementalFractionScaled12: string;
  containedElementMassMg: string;
  massExpandedUncertaintyMg: string;
  assayRelativeExpandedUncertaintyPctScaled6: string;
  containedElementExpandedUncertaintyMg: string;
};

type ElementalCalculation = {
  element: string;
  formula: string;
  mufProofId: Hex;
  mufHash: Hex;
  mufReferenceInputMassMg: string;
  mufAccountedOutputMassMg: string;
  availableElementMassMg: string;
  accountedElementMassMg: string;
  signedElementalDifferenceMg: string;
  absoluteElementalDifferenceMg: string;
  absoluteElementalDifferencePercentScaled6: string;
  elementalRecoveryPercentScaled6: string;
  balanceExpandedUncertaintyMg: string;
  streams: ElementalStreamResult[];
};

type ElementAssessment = { element: string; status: ElementalStatus; reasonCodes: string[]; calculation: ElementalCalculation | null };

type ElementalResult = {
  schema: "ExploreChem/ElementalResult/v1";
  calculationVersion: 1;
  evidenceId: Hex;
  actorId: Hex;
  lotReference: string | null;
  expectedEvidenceHash: Hex;
  indexedEvidenceHash: Hex;
  downloadedDocumentHash: Hex | null;
  integrityMatches: boolean;
  mufProofId: Hex;
  expectedMufHash: Hex;
  downloadedMufResultHash: Hex | null;
  mufIntegrityMatches: boolean;
  status: ElementalStatus;
  statusCode: number;
  reasonCodes: string[];
  calculation: ElementalCalculation | null;
  interpretation: string;
  elements?: ElementAssessment[];
  supportedElements?: readonly string[];
};

type ProofCommitment = {
  proofType: 3;
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
    name: "expectedWorkflowId",
    stateMutability: "view",
    inputs: [{ name: "proofType", type: "uint8" }],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "getProof",
    stateMutability: "view",
    inputs: [{ name: "proofId", type: "bytes32" }],
    outputs: [{ name: "", type: "tuple", components: [
      { name: "proofId", type: "bytes32" },
      { name: "evidenceId", type: "bytes32" },
      { name: "evidenceHash", type: "bytes32" },
      { name: "proofType", type: "uint8" },
      { name: "committedHash", type: "bytes32" },
      { name: "inputCommitmentHash", type: "bytes32" },
      { name: "methodologyHash", type: "bytes32" },
      { name: "previousProofId", type: "bytes32" },
      { name: "status", type: "uint8" },
      { name: "revision", type: "uint32" },
      { name: "workflowId", type: "bytes32" },
      { name: "createdAt", type: "uint64" },
    ] }],
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
          { name: "elementalHash", type: "bytes32" },
          { name: "mufStatus", type: "uint8" },
          { name: "elementalStatus", type: "uint8" },
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

function decimalToScaled(value: unknown, decimals: number): bigint | null {
  const parsed = decimalString(value);
  if (parsed === null) return null;
  const [whole, fractional = ""] = parsed.split(".");
  const kept = fractional.slice(0, decimals).padEnd(decimals, "0");
  let scaled = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(kept || "0");
  if (fractional.length > decimals && Number(fractional[decimals]) >= 5) {
    scaled += 1n;
  }
  return scaled;
}

function roundedDivide(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error("denominador invalido");
  return (numerator + denominator / 2n) / denominator;
}

function integerSqrt(value: bigint): bigint {
  if (value < 0n) throw new Error("raiz de valor negativo");
  if (value < 2n) return value;
  let x0 = value;
  let x1 = (x0 + value / x0) / 2n;
  while (x1 < x0) {
    x0 = x1;
    x1 = (x0 + value / x0) / 2n;
  }
  return x0;
}

function bigintOrNull(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  return BigInt(value);
}

function statusCode(status: ElementalStatus): number {
  if (status === "COMPLIANT") return CHECK_STATUS_COMPLIANT;
  if (status === "DIVERGENT") return CHECK_STATUS_DIVERGENT;
  return CHECK_STATUS_NOT_ATTESTED;
}

const ELEMENTAL_METHODOLOGY = {
  domain: "ExploreChem/ElementalMethodology/v1",
  calculationVersion: 1,
  massUnit: "mg",
  percentScale: 6,
  elementalFractionScale: 12,
  rounding: "HALF_UP_INTEGER",
  streamFormula:
    "dryMassMg * assayPct / 100 * elementalFractionOfCompound",
  balanceFormula:
    "availableElementMassMg - accountedElementMassMg",
  validityRules: [
    "documentHashMustMatchEvidenceHash",
    "privateMufHashMustMatchOnchainMufHash",
    "mufMustContainAValidCalculation",
    "elementAndAssayMustBePresentForEveryCountedStream",
    "streamMassTotalsMustMatchMufMassTotals",
    "compoundFormulaMustBeSupportedAndContainTrackedElement",
  ],
  toleranceEvaluation: "NOT_PERFORMED",
  multiElementVersion: 2,
  missingAssay: "NOT_ATTESTED_NOT_ZERO",
  issuancePolicy: "ALL_DECLARED_ELEMENTS_MUST_PASS",
  promethiumCompoundPolicy: "REQUIRE_ELEMENT_PCT_NO_ASSUMED_ATOMIC_WEIGHT",
} as const;

const ELEMENTAL_METHODOLOGY_HASH = hashObject(ELEMENTAL_METHODOLOGY);

const PERCENT_SCALE = 1_000_000n;
const FRACTION_SCALE = 1_000_000_000_000n;

// Standard atomic weights scaled by 1e6. The parser accepts simple formulae
// such as Nd2O3, Pr6O11 and Dy2O3 (no parentheses or hydration dots).
const ATOMIC_WEIGHT_1E6: Readonly<Record<string, bigint>> = {
  O: 15_999_000n,
  Sc: 44_955_908n,
  Y: 88_905_840n,
  La: 138_905_470n,
  Ce: 140_116_000n,
  Pr: 140_907_660n,
  Nd: 144_242_000n,
  Sm: 150_360_000n,
  Eu: 151_964_000n,
  Gd: 157_250_000n,
  Tb: 158_925_350n,
  Dy: 162_500_000n,
  Ho: 164_930_330n,
  Er: 167_259_000n,
  Tm: 168_934_220n,
  Yb: 173_045_000n,
  Lu: 174_966_800n,
};

function compoundElementFractionScaled12(
  formula: string,
  trackedElement: string,
): bigint | null {
  const tokens = formula.match(/[A-Z][a-z]?\d*/g);
  if (!tokens || tokens.join("") !== formula) return null;

  let total = 0n;
  let tracked = 0n;
  for (const token of tokens) {
    const match = /^([A-Z][a-z]?)(\d*)$/.exec(token);
    if (!match) return null;
    const symbol = match[1];
    const weight = ATOMIC_WEIGHT_1E6[symbol];
    if (weight === undefined) return null;
    const count = BigInt(match[2] || "1");
    const contribution = weight * count;
    total += contribution;
    if (symbol === trackedElement) tracked += contribution;
  }

  if (total === 0n || tracked === 0n) return null;
  return roundedDivide(tracked * FRACTION_SCALE, total);
}

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

function loadActorByActorId(
  runtime: TeeRuntime<Config>,
  key: string,
  actorId: Hex,
): ActorRow | null {
  const path =
    "/rest/v1/explorerchem_actors?select=id,actor_id,actor_type" +
    `&actor_id=eq.${encodeURIComponent(actorId)}` +
    "&active=eq.true&limit=1";

  const rows = z.array(actorRowSchema).parse(
    getJson<unknown>(runtime, key, path),
  );

  return rows[0] ?? null;
}

// Discovery is exclusively on-chain. Off-chain state never controls eligibility.
const PROOF_EVENT_TOPIC = keccak256(toHex(
  "ProofAnchored(bytes32,bytes32,uint8,bytes32,uint8,uint32,bytes32,bytes32,bytes32,bytes32,uint64)",
));
const PROOF_EVENT_DATA = parseAbiParameters(
  "bytes32 committedHash, uint8 status, uint32 revision, bytes32 previousProofId, bytes32 inputCommitmentHash, bytes32 methodologyHash, bytes32 workflowId, uint64 createdAt",
);
const CHAIN_READ_LIMIT = 15;
const chainReads = new WeakMap<object, number>();
function reserveChainReads(runtime: TeeRuntime<Config>, count: number) {
  const used = chainReads.get(runtime) ?? 0;
  if (used + count > CHAIN_READ_LIMIT) {
    throw new Error(`CHAIN_READ_BUDGET: ${used} usadas; ${count} necessarias; limite 15. Nenhuma nova escrita autorizada por esta verificacao.`);
  }
}
function countChainRead(runtime: TeeRuntime<Config>) {
  reserveChainReads(runtime, 1);
  chainReads.set(runtime, (chainReads.get(runtime) ?? 0) + 1);
}
function discoverEvidenceIds(runtime: TeeRuntime<Config>) {
  const client = new EVMClient(network(runtime).chainSelector.selector);
  const don = runtime.usingTheDons();
  const header = client.headerByNumber(don, {blockNumber: LATEST_BLOCK_NUMBER}).result().header;
  if (!header?.blockNumber) throw new Error("Cabecalho on-chain indisponivel");
  const head = protoBigIntToBigint(header.blockNumber);
  const to = runtime.config.onchainToBlock === undefined ? head : BigInt(runtime.config.onchainToBlock);
  const from = runtime.config.onchainFromBlock === undefined
    ? (to >= 49_999n ? to - 49_999n : 0n) : BigInt(runtime.config.onchainFromBlock);
  if (from > to || to > head || to - from >= 50_000n) {
    throw new Error("Intervalo on-chain invalido: use no maximo 50000 blocos, ate o bloco atual.");
  }
  const reply = client.filterLogs(don, {filterQuery: {
    fromBlock: bigintToProtoBigInt(from), toBlock: bigintToProtoBigInt(to),
    addresses: [hexToBase64(runtime.config.contractAddress as Hex)],
    topics: [{topic: [hexToBase64(PROOF_EVENT_TOPIC)]}],
  }}).result();
  const logs = reply.logs.filter(log => !log.removed).sort((a,b) => {
    if (!a.blockNumber || !b.blockNumber) throw new Error("Evento sem numero de bloco");
    const an = protoBigIntToBigint(a.blockNumber), bn = protoBigIntToBigint(b.blockNumber);
    return an === bn ? b.txIndex - a.txIndex || b.index - a.index : an > bn ? -1 : 1;
  });
  // Newest proof event for each evidence/type wins within this interval.
  // An ELEMENTAL proof already anchored is not a pending root proof.
  const muf = new Map<string, {id: Hex; status: number}>();
  const elemental = new Set<string>();
  for (const log of logs) {
    if (lower(bytesToHex(log.address)) !== lower(runtime.config.contractAddress) ||
        log.topics.length !== 4 || lower(bytesToHex(log.topics[0])) !== lower(PROOF_EVENT_TOPIC) ||
        log.topics.some(topic => topic.length !== 32)) throw new Error("Evento ProofAnchored invalido");
    const id = bytesToHex(log.topics[2]) as Hex;
    const proofType = BigInt(bytesToHex(log.topics[3]));
    if (proofType === BigInt(PROOF_TYPE_ELEMENTAL)) elemental.add(lower(id));
    if (proofType === BigInt(PROOF_TYPE_MUF) && !muf.has(lower(id))) {
      const decoded = decodeAbiParameters(PROOF_EVENT_DATA, bytesToHex(log.data) as Hex);
      muf.set(lower(id), {id, status: Number(decoded[1])});
    }
  }
  const ids = [...muf.values()]
    .filter(item => !elemental.has(lower(item.id)) && item.status === CHECK_STATUS_COMPLIANT)
    .map(item => item.id);
  const offset = runtime.config.onchainCandidateOffset ?? 0;
  runtime.log(`ONCHAIN_FIRST: Registry=${runtime.config.contractAddress}; blocos=${from}-${to}; candidatosElemental=${ids.length}; offset=${offset}; origem=PROOF_ANCHORED`);
  return {ids: ids.slice(offset), offset, from: from.toString(), to: to.toString()};
}
function loadEvidenceById(runtime: TeeRuntime<Config>, key: string, evidenceId: Hex): EvidenceRow | null {
  const path = `/rest/v1/explorerchem_evidences?select=${EVIDENCE_SELECT}` +
    `&evidence_id=eq.${encodeURIComponent(evidenceId)}&limit=2`;
  const rows = z.array(evidenceRowSchema).parse(getJson<unknown>(runtime,key,path));
  if (rows.length !== 1 || lower(rows[0].evidence_id) !== lower(evidenceId)) {
    runtime.log(`ONCHAIN_SKIP: evidenceId=${evidenceId}; motivo=METADADOS_PRIVADOS_AUSENTES_OU_AMBIGUOS; nenhuma prova calculada ou enviada`);
    return null;
  }
  return rows[0];
}

function downloadEvidenceDocument(
  runtime: TeeRuntime<Config>,
  key: string,
  row: EvidenceRow,
): Uint8Array {
  return downloadStorageObject(
    runtime,
    key,
    row.storage_bucket,
    row.storage_path,
    row.mime_type,
  );
}

function downloadStorageObject(
  runtime: TeeRuntime<Config>,
  key: string,
  bucket: string,
  objectPath: string,
  mimeType = "application/json",
): Uint8Array {
  const path =
    `/storage/v1/object/authenticated/${encodeURIComponent(bucket)}/` +
    encPath(objectPath);

  const response = request(runtime, key, path, "GET", undefined, {
    accept: { values: [mimeType] },
  });

  return new Uint8Array(response.body);
}

function savePrivateResult(
  runtime: TeeRuntime<Config>,
  key: string,
  bucket: string,
  path: string,
  canonicalJson: string,
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
      body: Buffer.from(canonicalJson).toString("base64"),
    })
    .result();

  if (!ok(response)) {
    throw new Error(
      `falha ao salvar resultado ELEMENTAL privado: ${response.statusCode} ${text(response)}`,
    );
  }
}

/* ============================================================
 * Blockchain reads
 * ============================================================
 */

function callContract(
  runtime: TeeRuntime<Config>,
  functionName: "getEvidence" | "getCurrentProofState" | "latestProofId" | "getProof" | "expectedWorkflowId",
  args: readonly unknown[],
) {
  countChainRead(runtime);
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

function readCurrentElementalState(
  runtime: TeeRuntime<Config>,
  evidenceId: Hex,
): CurrentElementalState {
  const decoded = callContract(runtime, "getCurrentProofState", [evidenceId]) as {
    mufHash: Hex;
    mufStatus: number | bigint;
    elementalHash: Hex;
    elementalStatus: number | bigint;
  };

  return {
    mufHash: decoded.mufHash,
    mufStatus: Number(decoded.mufStatus),
    elementalHash: decoded.elementalHash,
    elementalStatus: Number(decoded.elementalStatus),
  };
}

function readLatestMufProofId(
  runtime: TeeRuntime<Config>,
  evidenceId: Hex,
): Hex {
  return callContract(runtime, "latestProofId", [evidenceId, PROOF_TYPE_MUF]) as Hex;
}

function readLatestElementalProofId(
  runtime: TeeRuntime<Config>,
  evidenceId: Hex,
): Hex {
  return callContract(
    runtime,
    "latestProofId",
    [evidenceId, PROOF_TYPE_ELEMENTAL],
  ) as Hex;
}

function selectEligibleEvidence(runtime: TeeRuntime<Config>, key: string): SelectedEvidence | null {
  chainReads.set(runtime, 0);
  const scan = discoverEvidenceIds(runtime);
  let checked = 0;
  for (const evidenceId of scan.ids) {
    // Leave enough reads to process and confirm the next eligible evidence.
    if ((chainReads.get(runtime) ?? 0) + 12 > CHAIN_READ_LIMIT) break;
    const current = readCurrentElementalState(runtime, evidenceId);
    checked += 1;
    if (current.elementalStatus !== CHECK_STATUS_PENDING) {
      runtime.log(`ONCHAIN_SKIP: evidenceId=${evidenceId}; motivo=ELEMENTAL_NAO_PENDENTE`);
      continue;
    }
    if (current.mufStatus !== CHECK_STATUS_COMPLIANT) {
      runtime.log(`ONCHAIN_SKIP: evidenceId=${evidenceId}; motivo=MUF_NAO_COMPLIANT`);
      continue;
    }
    const onchain = readEvidence(runtime, evidenceId);
    if (lower(onchain.evidenceId) !== lower(evidenceId)) throw new Error("getEvidence retornou outro ID");
    // Only now consult private metadata, by the exact on-chain evidence ID.
    const row = loadEvidenceById(runtime, key, evidenceId);
    if (row === null) continue;
    const actor = loadActorByActorId(runtime, key, onchain.actorId);
    if (!actor || actor.id !== row.actor_db_id || lower(actor.actor_id) !== lower(onchain.actorId)) {
      runtime.log(`ONCHAIN_SKIP: evidenceId=${evidenceId}; motivo=ATOR_PRIVADO_AUSENTE_INATIVO_OU_DIVERGENTE; nenhuma prova calculada ou enviada`);
      continue;
    }
    const latestMufProofId = readLatestMufProofId(runtime, evidenceId);
    if (lower(latestMufProofId) === lower(zeroHash)) throw new Error(`${evidenceId}: MUF finalizado sem prova`);
    runtime.log(`ONCHAIN_SELECTED: evidenceId=${evidenceId}; mufStatus=${current.mufStatus}`);
    return {row, actor, onchain, current, latestMufProofId};
  }
  if (scan.ids.length > checked) {
    throw new Error(JSON.stringify({message:"ONCHAIN_SCAN_PARTIAL: orcamento de leituras reservado para executar e confirmar a prova; ha candidatos restantes",onchainFromBlock:scan.from,onchainToBlock:scan.to,onchainCandidateOffset:scan.offset+checked}));
  }
  runtime.log(`Consulta concluida apenas no intervalo ${scan.from}-${scan.to}; blocos anteriores nao foram examinados.`);
  return null;
}

/* ============================================================
 * Integrity and ELEMENTAL calculation
 * ============================================================
 */

function recomputeEvidenceHash(row: EvidenceRow, bytes: Uint8Array): Hex {
  if (row.hash_algorithm === "SHA-256" || row.hash_algorithm === "SHA256") {
    return sha256(bytes);
  }
  return keccak256(bytes);
}

const AVAILABLE_TYPES = new Set(["INPUT", "COLLECTED", "OPENING_INVENTORY"]);
const ACCOUNTED_TYPES = new Set([
  "OUTPUT", "PRODUCT", "DELIVERED", "SCRAP", "REJECT", "EFFLUENT",
  "OTHER_OUTPUT", "CLOSING_INVENTORY",
]);

function normalizeElement(value: unknown): string | null {
  if (typeof value !== "string" || !/^[A-Za-z]{1,2}$/.test(value.trim())) return null;
  const clean = value.trim();
  return clean[0].toUpperCase() + clean.slice(1).toLowerCase();
}

function dryMassFromStream(stream: Record<string, unknown>): bigint | null {
  const measured = kgToMg(decimalString(stream.measuredMassKg));
  if (measured === null) return null;
  const basis = String(stream.massBasis ?? "").toUpperCase();
  if (basis === "DRY_105C" || basis === "DRY") return measured;
  if (basis !== "WET" && basis !== "AS_RECEIVED") return null;
  const moistureScaled6 = decimalToScaled(stream.moisturePct, 6);
  if (moistureScaled6 === null || moistureScaled6 > 100n * PERCENT_SCALE) return null;
  return roundedDivide(
    measured * (100n * PERCENT_SCALE - moistureScaled6),
    100n * PERCENT_SCALE,
  );
}

function mufResultPath(evidenceId: Hex, mufProofId: Hex): string {
  return `muf-results/${evidenceId.slice(2)}/${mufProofId.slice(2)}.json`;
}

const RARE_EARTH_ELEMENTS: readonly string[] = ['Sc','Y','La','Ce','Pr','Nd','Pm','Sm','Eu','Gd','Tb','Dy','Ho','Er','Tm','Yb','Lu'];
function calculateAllElements(document: Record<string,unknown>, muf:MufCalculation, selected:SelectedEvidence): {status:ElementalStatus;reasonCodes:string[];elements:ElementAssessment[]} {
 const streams=Array.isArray(document.streams)?document.streams.map(recordOf):[];
 const counted=streams.filter(s=>AVAILABLE_TYPES.has(String(s.streamType).toUpperCase())||ACCOUNTED_TYPES.has(String(s.streamType).toUpperCase()));
 const errors:string[]=[];const wanted=new Set<string>();
 for(const context of [recordOf(document.calculationContext),recordOf(document.workflowRequest)]){
  const raw=context.trackedElements??(context.trackedElement?[context.trackedElement]:[]);
  if(!Array.isArray(raw)){errors.push('TRACKED_ELEMENTS_MUST_BE_ARRAY');continue;}
  for(const value of raw){const e=normalizeElement(value);if(!e||!RARE_EARTH_ELEMENTS.includes(e))errors.push('UNSUPPORTED_TRACKED_ELEMENT:'+String(value));else wanted.add(e);}
 }
 const assaysByStream:Map<string,Record<string,unknown>>[]=[];
 const streamIds=new Set<string>();
 for(const stream of counted){
  const id=String(stream.streamId??'');if(!id||streamIds.has(id))errors.push('MISSING_OR_DUPLICATE_STREAM_ID:'+id);streamIds.add(id);
  if(stream.assays!==undefined&&stream.assay!==undefined)errors.push('AMBIGUOUS_ASSAY_FORMAT:'+id);
  const raw=stream.assays??(stream.assay?[stream.assay]:[]);
  const map=new Map<string,Record<string,unknown>>();let fractionSum=0n;
  if(!Array.isArray(raw)){errors.push('ASSAYS_MUST_BE_ARRAY:'+id);assaysByStream.push(map);continue;}
  for(const item of raw){
   const assay=recordOf(item),e=normalizeElement(assay.element);
   if(!e||!RARE_EARTH_ELEMENTS.includes(e)){errors.push('UNSUPPORTED_ASSAY_ELEMENT:'+id+':'+String(assay.element));continue;}
   wanted.add(e);if(map.has(e))errors.push('DUPLICATE_ELEMENT_ASSAY:'+id+':'+e);map.set(e,assay);
   const v=decimalToScaled(assay.value,6),basis=String(assay.basis).toUpperCase();
   const fraction=basis==='ELEMENT_PCT'?FRACTION_SCALE:basis==='COMPOUND_PCT'&&typeof assay.compound==='string'?compoundElementFractionScaled12(assay.compound,e):null;
   if(v===null||v>100n*PERCENT_SCALE||fraction===null)errors.push('INVALID_ASSAY:'+id+':'+e);
   else fractionSum+=v*fraction;
  }
  if(fractionSum>100n*PERCENT_SCALE*FRACTION_SCALE)errors.push('SUM_ELEMENT_FRACTIONS_EXCEEDS_100_PERCENT:'+id);
  assaysByStream.push(map);
 }
 if(!counted.length)errors.push('STREAMS_UNAVAILABLE');if(!wanted.size)errors.push('NO_DECLARED_RARE_EARTH');
 const elements:ElementAssessment[]=[];
 for(const element of RARE_EARTH_ELEMENTS.filter(e=>wanted.has(e))){
  const reasons:string[]=[];
  for(let i=0;i<counted.length;i++)if(!assaysByStream[i].has(element))reasons.push('MISSING_ASSAY:'+String(counted[i].streamId)+':'+element);
  if(reasons.length){elements.push({element,status:'NOT_ATTESTED',reasonCodes:reasons,calculation:null});continue;}
  const projected={...document,calculationContext:{...recordOf(document.calculationContext),trackedElement:element},streams:counted.map((s,i)=>({...s,assay:assaysByStream[i].get(element)}))};
  const result=calculateElemental(projected,muf,selected);
  // Explicit zero in every counted stream is absence, not a missing measurement.
  const allZero=assaysByStream.every(m=>decimalToScaled(m.get(element)?.value,6)===0n);
  if(allZero&&result.reasonCodes.length===1&&result.reasonCodes[0]==='ZERO_AVAILABLE_ELEMENT_MASS')elements.push({element,status:'COMPLIANT',reasonCodes:['EXPLICIT_ZERO_NO_ISSUANCE'],calculation:null});
  else elements.push({element,...result});
 }
 // Rounding cannot create more elemental mass than the carrier stream.
 for(const stream of counted){const results=elements.flatMap(e=>e.calculation?.streams.filter(s=>s.streamId===stream.streamId)??[]);if(results.length&&results.reduce((sum,s)=>sum+BigInt(s.containedElementMassMg),0n)>BigInt(results[0].dryMassMg))errors.push('ROUNDED_ELEMENTS_EXCEED_STREAM_MASS:'+String(stream.streamId));}
 const reasonCodes=[...errors,...elements.filter(e=>e.status!=='COMPLIANT').flatMap(e=>e.reasonCodes.map(r=>e.element+':'+r))];
 return {status:reasonCodes.length?'NOT_ATTESTED':'COMPLIANT',reasonCodes,elements};
}

function calculateElemental(
  document: Record<string, unknown>,
  muf: MufCalculation,
  selected: SelectedEvidence,
): { status: ElementalStatus; reasonCodes: string[]; calculation: ElementalCalculation | null } {
  const mufInput = bigintOrNull(muf.referenceInputMassMg);
  const mufOutput = bigintOrNull(muf.accountedOutputMassMg);
  if (mufInput === null || mufOutput === null || mufInput === 0n) {
    return { status: "NOT_ATTESTED", reasonCodes: ["MUF_MASS_RESULT_UNAVAILABLE"], calculation: null };
  }

  const streamsRaw = document.streams;
  if (!Array.isArray(streamsRaw) || streamsRaw.length === 0) {
    return { status: "NOT_ATTESTED", reasonCodes: ["STREAMS_UNAVAILABLE"], calculation: null };
  }

  const context = recordOf(document.calculationContext);
  const requestContext = recordOf(document.workflowRequest);
  let element = normalizeElement(context.trackedElement ?? requestContext.trackedElement);
  if (element === null) {
    for (const raw of streamsRaw) {
      const candidate = normalizeElement(recordOf(recordOf(raw).assay).element);
      if (candidate !== null) { element = candidate; break; }
    }
  }
  if (element === null || !RARE_EARTH_ELEMENTS.includes(element)) {
    return { status: "NOT_ATTESTED", reasonCodes: ["TRACKED_ELEMENT_UNSUPPORTED"], calculation: null };
  }

  type Prepared = {
    stream: Record<string, unknown>;
    streamId: string;
    streamType: string;
    side: "AVAILABLE" | "ACCOUNTED";
    dryMassMg: bigint;
    massSource: "MUF" | "ORDER_STREAM";
  };

  const prepared: Prepared[] = [];
  const reasonCodes: string[] = [];
  for (let index = 0; index < streamsRaw.length; index += 1) {
    const stream = recordOf(streamsRaw[index]);
    const streamType = String(stream.streamType ?? "").toUpperCase();
    const side = AVAILABLE_TYPES.has(streamType)
      ? "AVAILABLE"
      : ACCOUNTED_TYPES.has(streamType)
        ? "ACCOUNTED"
        : null;
    if (side === null) continue;
    const streamId = typeof stream.streamId === "string" && stream.streamId.length > 0
      ? stream.streamId
      : `STREAM-${index + 1}`;
    const dryMassMg = dryMassFromStream(stream);
    if (dryMassMg === null) {
      reasonCodes.push(`INVALID_DRY_MASS:${streamId}`);
      continue;
    }
    prepared.push({ stream, streamId, streamType, side, dryMassMg, massSource: "ORDER_STREAM" });
  }

  const available = prepared.filter((item) => item.side === "AVAILABLE");
  const accounted = prepared.filter((item) => item.side === "ACCOUNTED");
  if (available.length === 0) reasonCodes.push("NO_AVAILABLE_STREAM");
  if (accounted.length === 0) reasonCodes.push("NO_ACCOUNTED_STREAM");
  if (reasonCodes.length > 0) return { status: "NOT_ATTESTED", reasonCodes, calculation: null };

  // A single stream receives the exact mass already attested by MUF. With
  // multiple streams, their dry-mass sum must reproduce that MUF aggregate.
  if (available.length === 1) {
    available[0].dryMassMg = mufInput;
    available[0].massSource = "MUF";
  } else if (available.reduce((sum, item) => sum + item.dryMassMg, 0n) !== mufInput) {
    reasonCodes.push("AVAILABLE_STREAM_MASS_DOES_NOT_MATCH_MUF");
  }
  if (accounted.length === 1) {
    accounted[0].dryMassMg = mufOutput;
    accounted[0].massSource = "MUF";
  } else if (accounted.reduce((sum, item) => sum + item.dryMassMg, 0n) !== mufOutput) {
    reasonCodes.push("ACCOUNTED_STREAM_MASS_DOES_NOT_MATCH_MUF");
  }
  if (reasonCodes.length > 0) return { status: "NOT_ATTESTED", reasonCodes, calculation: null };

  const streamResults: ElementalStreamResult[] = [];
  for (const item of prepared) {
    const assay = recordOf(item.stream.assay);
    const assayElement = normalizeElement(assay.element);
    if (assayElement !== element) {
      reasonCodes.push(`ASSAY_ELEMENT_MISMATCH:${item.streamId}`);
      continue;
    }
    const assayBasis = String(assay.basis ?? "").toUpperCase();
    if (assayBasis !== "ELEMENT_PCT" && assayBasis !== "COMPOUND_PCT") {
      reasonCodes.push(`INVALID_ASSAY_BASIS:${item.streamId}`);
      continue;
    }
    const assayPctScaled6 = decimalToScaled(assay.value, 6);
    if (assayPctScaled6 === null || assayPctScaled6 > 100n * PERCENT_SCALE) {
      reasonCodes.push(`INVALID_ASSAY_VALUE:${item.streamId}`);
      continue;
    }
    const compound = assayBasis === "COMPOUND_PCT" && typeof assay.compound === "string"
      ? assay.compound.trim()
      : null;
    const fraction = assayBasis === "ELEMENT_PCT"
      ? FRACTION_SCALE
      : compound === null ? null : compoundElementFractionScaled12(compound, element);
    if (fraction === null) {
      reasonCodes.push(`UNSUPPORTED_COMPOUND:${item.streamId}`);
      continue;
    }
    const contained = roundedDivide(
      item.dryMassMg * assayPctScaled6 * fraction,
      100n * PERCENT_SCALE * FRACTION_SCALE,
    );
    const massMeasurement = recordOf(item.stream.massMeasurement);
    const massUncertaintyMg =
      kgToMg(decimalString(massMeasurement.expandedUncertaintyKg)) ?? 0n;
    const assayUncertaintyScaled6 =
      decimalToScaled(assay.relativeExpandedUncertaintyPct, 6) ?? 0n;
    const fromMass = item.dryMassMg === 0n
      ? 0n
      : roundedDivide(contained * massUncertaintyMg, item.dryMassMg);
    const fromAssay = roundedDivide(
      contained * assayUncertaintyScaled6,
      100n * PERCENT_SCALE,
    );
    const containedUncertainty = integerSqrt(
      fromMass * fromMass + fromAssay * fromAssay,
    );
    streamResults.push({
      streamId: item.streamId,
      streamType: item.streamType,
      side: item.side,
      dryMassMg: item.dryMassMg.toString(),
      dryMassSource: item.massSource,
      ...(item.stream.sourceLotId===undefined?{}:{sourceLotId:String(item.stream.sourceLotId)}),
      element,
      assayBasis,
      assayValuePctScaled6: assayPctScaled6.toString(),
      compound,
      elementalFractionScaled12: fraction.toString(),
      containedElementMassMg: contained.toString(),
      massExpandedUncertaintyMg: massUncertaintyMg.toString(),
      assayRelativeExpandedUncertaintyPctScaled6: assayUncertaintyScaled6.toString(),
      containedElementExpandedUncertaintyMg: containedUncertainty.toString(),
    });
  }
  if (reasonCodes.length > 0 || streamResults.length !== prepared.length) {
    return { status: "NOT_ATTESTED", reasonCodes, calculation: null };
  }

  const availableElement = streamResults
    .filter((item) => item.side === "AVAILABLE")
    .reduce((sum, item) => sum + BigInt(item.containedElementMassMg), 0n);
  const accountedElement = streamResults
    .filter((item) => item.side === "ACCOUNTED")
    .reduce((sum, item) => sum + BigInt(item.containedElementMassMg), 0n);
  if (availableElement === 0n) {
    return { status: "NOT_ATTESTED", reasonCodes: ["ZERO_AVAILABLE_ELEMENT_MASS"], calculation: null };
  }
  const signed = availableElement - accountedElement;
  const abs = absolute(signed);
  const differencePct = roundedDivide(abs * 100n * PERCENT_SCALE, availableElement);
  const recoveryPct = roundedDivide(accountedElement * 100n * PERCENT_SCALE, availableElement);
  const balanceUncertainty = integerSqrt(
    streamResults.reduce(
      (sum, item) => {
        const uncertainty = BigInt(item.containedElementExpandedUncertaintyMg);
        return sum + uncertainty * uncertainty;
      },
      0n,
    ),
  );

  return {
    status: "COMPLIANT",
    reasonCodes: [],
    calculation: {
      element,
      formula: "sum(available dryMass * assay * elementalFraction) - sum(accounted dryMass * assay * elementalFraction)",
      mufProofId: selected.latestMufProofId,
      mufHash: selected.current.mufHash,
      mufReferenceInputMassMg: mufInput.toString(),
      mufAccountedOutputMassMg: mufOutput.toString(),
      availableElementMassMg: availableElement.toString(),
      accountedElementMassMg: accountedElement.toString(),
      signedElementalDifferenceMg: signed.toString(),
      absoluteElementalDifferenceMg: abs.toString(),
      absoluteElementalDifferencePercentScaled6: differencePct.toString(),
      elementalRecoveryPercentScaled6: recoveryPct.toString(),
      balanceExpandedUncertaintyMg: balanceUncertainty.toString(),
      streams: streamResults,
    },
  };
}

function resultBase(selected: SelectedEvidence): Omit<ElementalResult, "status" | "statusCode" | "reasonCodes" | "calculation" | "interpretation"> {
  return {
    schema: "ExploreChem/ElementalResult/v1",
    calculationVersion: 1,
    evidenceId: selected.onchain.evidenceId,
    actorId: selected.onchain.actorId,
    lotReference: selected.row.lot_reference,
    expectedEvidenceHash: selected.onchain.evidenceHash,
    indexedEvidenceHash: selected.row.evidence_hash,
    downloadedDocumentHash: null,
    integrityMatches: false,
    mufProofId: selected.latestMufProofId,
    expectedMufHash: selected.current.mufHash,
    downloadedMufResultHash: null,
    mufIntegrityMatches: false,
  };
}

function finish(
  base: ReturnType<typeof resultBase>, status: ElementalStatus,
  reasonCodes: string[], calculation: ElementalCalculation | null,
  interpretation: string,
): ElementalResult {
  return { ...base, status, statusCode: statusCode(status), reasonCodes, calculation, interpretation };
}

const verifiedDocuments = new WeakMap<object, Record<string,unknown>>();
function buildResult(
  runtime: TeeRuntime<Config>, key: string, selected: SelectedEvidence,
): ElementalResult {
  const base = resultBase(selected);
  let evidenceBytes: Uint8Array;
  try {
    evidenceBytes = downloadEvidenceDocument(runtime, key, selected.row);
  } catch {
    return finish(base, "NOT_ATTESTED", ["DOCUMENT_UNAVAILABLE"], null, "ELEMENTAL_NOT_ATTESTED");
  }
  const evidenceHash = recomputeEvidenceHash(selected.row, evidenceBytes);
  base.downloadedDocumentHash = evidenceHash;
  base.integrityMatches =
    lower(selected.row.evidence_hash) === lower(selected.onchain.evidenceHash) &&
    lower(evidenceHash) === lower(selected.onchain.evidenceHash);
  if (!base.integrityMatches) {
    return finish(base, "DIVERGENT", ["EVIDENCE_HASH_MISMATCH"], null, "UNTRUSTED_EVIDENCE");
  }

  let document: Record<string, unknown>;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(evidenceBytes));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    document = parsed as Record<string, unknown>;
    verifiedDocuments.set(selected, document);
  } catch {
    return finish(base, "NOT_ATTESTED", ["INVALID_EVIDENCE_JSON"], null, "ELEMENTAL_NOT_ATTESTED");
  }

  let mufBytes: Uint8Array;
  try {
    mufBytes = downloadStorageObject(
      runtime, key, selected.row.storage_bucket,
      mufResultPath(selected.onchain.evidenceId, selected.latestMufProofId),
    );
  } catch {
    return finish(base, "NOT_ATTESTED", ["PRIVATE_MUF_RESULT_UNAVAILABLE"], null, "ELEMENTAL_NOT_ATTESTED");
  }
  const downloadedMufHash = keccak256(mufBytes);
  base.downloadedMufResultHash = downloadedMufHash;
  base.mufIntegrityMatches = lower(downloadedMufHash) === lower(selected.current.mufHash);
  if (!base.mufIntegrityMatches) {
    return finish(base, "DIVERGENT", ["PRIVATE_MUF_HASH_MISMATCH"], null, "UNTRUSTED_MUF_RESULT");
  }

  let privateMuf: MufPrivateResult;
  try {
    privateMuf = JSON.parse(new TextDecoder().decode(mufBytes)) as MufPrivateResult;
  } catch {
    return finish(base, "NOT_ATTESTED", ["INVALID_PRIVATE_MUF_JSON"], null, "ELEMENTAL_NOT_ATTESTED");
  }
  if (privateMuf?.result?.status !== "COMPLIANT" || !privateMuf.result.calculation) {
    return finish(base, "NOT_ATTESTED", ["MUF_CALCULATION_NOT_ATTESTED"], null, "ELEMENTAL_NOT_ATTESTED");
  }

  const multi = calculateAllElements(document, privateMuf.result.calculation, selected);
  const calculated = {status:multi.status,reasonCodes:multi.reasonCodes,calculation:multi.elements.length===1?multi.elements[0].calculation:null};
  const completed = finish(
    base, calculated.status, calculated.reasonCodes, calculated.calculation,
    calculated.status === "COMPLIANT"
      ? "ELEMENTAL_CALCULATION_ATTESTED_NO_TOLERANCE_APPLIED"
      : "ELEMENTAL_NOT_ATTESTED",
  );
  return {...completed, elements:multi.elements, supportedElements:RARE_EARTH_ELEMENTS};
}

/* ============================================================
 * Proof report
 * ============================================================
 */

function buildProofCommitment(
  selected: SelectedEvidence,
  result: ElementalResult,
  committedHash: Hex,
): ProofCommitment {
  const inputCommitmentHash = hashObject({
    domain: "ExploreChem/ElementalInputCommitment/v1",
    evidenceId: selected.onchain.evidenceId,
    expectedEvidenceHash: selected.onchain.evidenceHash,
    indexedEvidenceHash: result.indexedEvidenceHash,
    downloadedDocumentHash: result.downloadedDocumentHash,
    mufProofId: result.mufProofId,
    expectedMufHash: result.expectedMufHash,
    downloadedMufResultHash: result.downloadedMufResultHash,
    calculationInputs: result.elements ?? result.calculation,
  });

  const proofSeed = {
    domain: "ExploreChem/ElementalProofId/v1",
    proofType: PROOF_TYPE_ELEMENTAL,
    evidenceId: selected.onchain.evidenceId,
    evidenceHash: selected.onchain.evidenceHash,
    committedHash,
    inputCommitmentHash,
    methodologyHash: ELEMENTAL_METHODOLOGY_HASH,
    previousProofId: zeroHash,
    status: result.statusCode,
    revision: 1,
  };

  return {
    proofType: PROOF_TYPE_ELEMENTAL,
    evidenceId: selected.onchain.evidenceId,
    evidenceHash: selected.onchain.evidenceHash,
    proofId: hashObject(proofSeed),
    committedHash,
    inputCommitmentHash,
    methodologyHash: ELEMENTAL_METHODOLOGY_HASH,
    previousProofId: zeroHash,
    status: result.statusCode,
    revision: 1,
  };
}

type TokenInput = { lotId: bigint; quantity: bigint };
type TokenOutput = { streamId: Hex; basisHash: Hex; metadataHash: Hex; quantity: bigint; components:{basisHash:Hex;quantity:bigint}[]; recipientActorId:Hex };
type TokenAction = { kind: number; operationId: Hex; mufProofId: Hex; inputs: TokenInput[]; outputs: TokenOutput[]; consumedComponents:{basisHash:Hex;quantity:bigint}[][] };
const ACTION_ABI = parseAbiParameters('(uint8 kind,bytes32 operationId,bytes32 mufProofId,(uint256 lotId,uint256 quantity)[] inputs,(bytes32 streamId,bytes32 basisHash,bytes32 metadataHash,uint256 quantity,(bytes32 basisHash,uint256 quantity)[] components,bytes32 recipientActorId)[] outputs,(bytes32 basisHash,uint256 quantity)[][] consumedComponents)' as string);
const REPORT_V2_ABI = parseAbiParameters('(uint8 version,uint256 chainId,address registry,(uint8 proofType,bytes32 evidenceId,bytes32 evidenceHash,bytes32 proofId,bytes32 committedHash,bytes32 inputCommitmentHash,bytes32 methodologyHash,bytes32 previousProofId,uint8 status,uint32 revision) proof,(uint8 kind,bytes32 operationId,bytes32 mufProofId,(uint256 lotId,uint256 quantity)[] inputs,(bytes32 streamId,bytes32 basisHash,bytes32 metadataHash,uint256 quantity,(bytes32 basisHash,uint256 quantity)[] components,bytes32 recipientActorId)[] outputs,(bytes32 basisHash,uint256 quantity)[][] consumedComponents) action)' as string);
const TOKEN_READ_ABI = parseAbi([
 'function lotsContract() view returns (address)',
 'function registry() view returns (address)',
 'function evidenceTokenized(bytes32) view returns (bool)',
 'function balanceOf(bytes32,uint256) view returns (uint256)',
 'function getLot(uint256) view returns ((bytes32 evidenceId,bytes32 elementalProofId,bytes32 mufProofId,bytes32 basisHash,bytes32 metadataHash,bytes32 streamId,bytes32 operationId,uint256 issued,uint256 supply))',
 'function getConsumptionContext(bytes32 actorId,(uint256 lotId,uint256 quantity)[] inputs) view returns (((uint256 lotId,uint256 quantity)[] inputs,bytes32[] inputBases,(bytes32 basisHash,uint256 quantity)[][] inputComponents,uint256[] inputIssued,uint256[] inputBalances))',
 'function getOperationLots(bytes32) view returns (uint256[])',
]);
function tokenRead(runtime: TeeRuntime<Config>, address: Address, functionName: string, args: readonly unknown[]): any {
 countChainRead(runtime);
 const data=encodeFunctionData({abi:TOKEN_READ_ABI,functionName,args} as any);
 const response=new EVMClient(network(runtime).chainSelector.selector).callContract(runtime.usingTheDons(),{call:encodeCallMsg({from:zeroAddress,to:address,data}),blockNumber:LATEST_BLOCK_NUMBER}).result();
 return decodeFunctionResult({abi:TOKEN_READ_ABI,functionName,data:bytesToHex(response.data)} as any);
}
function uintToken(v: unknown): bigint {
 if(typeof v!=='string'||!/^\d+$/.test(v)||BigInt(v)<=0n||BigInt(v)>=(1n<<256n))throw Error('Token: quantidade e lotId devem ser strings inteiras positivas uint256.');
 return BigInt(v);
}
function serialAction(action: TokenAction) {
 return {...action,consumedComponents:action.consumedComponents.map(cs=>cs.map(c=>({...c,quantity:c.quantity.toString()}))),inputs:action.inputs.map(x=>({lotId:x.lotId.toString(),quantity:x.quantity.toString()})),outputs:action.outputs.map(x=>({...x,quantity:x.quantity.toString(),components:x.components.map(c=>({...c,quantity:c.quantity.toString()}))}))};
}
const MATERIAL_BASIS=keccak256(toHex('ExploreChem/MaterialMass/dry/mg/v1'));
const MAX_MATERIAL_MASS=(1n<<96n)-1n;
function buildTokenAction(selected: SelectedEvidence, result: ElementalResult, spec: Record<string,unknown>): TokenAction {
 if(result.status!=='COMPLIANT')return {kind:0,operationId:zeroHash,mufProofId:zeroHash,inputs:[],outputs:[],consumedComponents:[]};
 if(selected.current.mufStatus!==CHECK_STATUS_COMPLIANT)throw Error('MUF vigente deve estar COMPLIANT.');
 if(spec.mode!=='INITIAL'&&spec.mode!=='TRANSFORM')throw Error('Modo de material inválido.');
 const kind=spec.mode==='INITIAL'?1:2;
 const calculations=result.elements?.map(e=>e.calculation).filter((c):c is ElementalCalculation=>!!c)??(result.calculation?[result.calculation]:[]);
 if(!calculations.length||calculations.length>17)throw Error('Análise elemental ausente ou acima de 17 elementos.');
 const symbols=new Set(calculations.map(c=>c.element));if(symbols.size!==calculations.length)throw Error('Elemento duplicado.');
 const raw=spec.inputs??[];if(!Array.isArray(raw))throw Error('Entradas inválidas.');
 const inputs=raw.map(v=>{const x=recordOf(v);return {lotId:uintToken(x.lotId),quantity:uintToken(x.quantity)};});
 if(inputs.length>32||new Set(inputs.map(i=>String(i.lotId))).size!==inputs.length||kind===1&&inputs.length||kind===2&&!inputs.length)throw Error('Entradas materiais inválidas.');
 const allowed=new Set(kind===1?['INPUT','COLLECTED','OPENING_INVENTORY']:['OUTPUT','PRODUCT','SCRAP','REJECT','OTHER_OUTPUT','CLOSING_INVENTORY','DELIVERED']);
 const side=kind===1?'AVAILABLE':'ACCOUNTED';
 const streams=calculations[0].streams.filter(x=>x.side===side&&allowed.has(x.streamType)&&BigInt(x.dryMassMg)>0n);
 if(!streams.length||streams.length>32||new Set(streams.map(x=>x.streamId)).size!==streams.length)throw Error('Correntes materiais ausentes, duplicadas ou acima de 32.');
 const outputs:TokenOutput[]=streams.map(stream=>{
  const quantity=uintToken(stream.dryMassMg);if(quantity>MAX_MATERIAL_MASS)throw Error('Massa acima do limite uint96.');
  const assays=calculations.map(calc=>{
   const matches=calc.streams.filter(x=>x.streamId===stream.streamId);
   if(matches.length!==1||matches[0].dryMassMg!==stream.dryMassMg||matches[0].side!==side)throw Error('Corrente material incompatível entre análises.');
   return {element:calc.element,stream:matches[0]};
  });
  const components=assays.filter(a=>BigInt(a.stream.containedElementMassMg)>0n).map(a=>({basisHash:hashObject({domain:'ExploreChem/ElementMassBasis/v1',element:a.element,unit:'mg'}),quantity:uintToken(a.stream.containedElementMassMg)}));
  if(components.reduce((n,c)=>n+c.quantity,0n)>quantity)throw Error('Composição excede a massa do material.');
  const destinations=recordOf(spec.recipients??{});
  const recipientActorId=(destinations[stream.streamId]??spec.recipientActorId??selected.onchain.actorId) as Hex;
  if(typeof recipientActorId!=='string'||!/^0x[0-9a-fA-F]{64}$/.test(recipientActorId)||lower(recipientActorId)===lower(zeroHash))throw Error('Destinatário deve ser actorId bytes32 válido.');
  if(kind===1&&lower(recipientActorId)!==lower(selected.onchain.actorId))throw Error('Emissão inicial pertence à empresa da evidência.');
  return {recipientActorId,streamId:hashObject({domain:'ExploreChem/MaterialStream/v1',evidenceId:result.evidenceId,streamId:stream.streamId}),basisHash:MATERIAL_BASIS,metadataHash:hashObject({domain:'ExploreChem/MaterialMetadata/v1',evidenceId:result.evidenceId,evidenceHash:result.expectedEvidenceHash,unit:'mg',massBasis:'DRY',streamId:stream.streamId,assays}),quantity,components};
 });
 const action={kind,operationId:hashObject({domain:'ExploreChem/MaterialOperation/v1',evidenceId:result.evidenceId,evidenceHash:result.expectedEvidenceHash}),mufProofId:selected.latestMufProofId,inputs,outputs,consumedComponents:[] as {basisHash:Hex;quantity:bigint}[][]};
 if(kind===2){
  const ctx=spec.context as any;if(!ctx)throw Error('Contexto on-chain das origens obrigatório.');
  // Each measured AVAILABLE stream belongs to an exact source lot.
  // A single input is unambiguous; multiple lots require sourceLotId in the signed document.
  const sourceOf=(stream:ElementalStreamResult)=>{
   if(stream.sourceLotId!==undefined)return uintToken(stream.sourceLotId).toString();
   if(inputs.length===1)return inputs[0].lotId.toString();
   throw Error('Cada corrente de entrada exige sourceLotId quando há vários lotes de origem.');
  };
  const known=new Set(inputs.map(i=>String(i.lotId)));
  for(const calc of calculations)for(const stream of calc.streams.filter(x=>x.side==='AVAILABLE'))
   if(!known.has(sourceOf(stream)))throw Error('Corrente aponta para lote não declarado.');
  action.consumedComponents=inputs.map(input=>{
   const measured: {basisHash:Hex;quantity:bigint}[]=[];
   for(const calc of calculations){
    const streams=calc.streams.filter(x=>x.side==='AVAILABLE'&&sourceOf(x)===String(input.lotId));
    if(!streams.length||streams.reduce((n,x)=>n+BigInt(x.dryMassMg),0n)!==input.quantity)throw Error('Massa analisada não corresponde à quantidade declarada do lote '+input.lotId);
    const quantity=streams.reduce((n,x)=>n+BigInt(x.containedElementMassMg),0n);
    if(quantity>0n)measured.push({basisHash:hashObject({domain:'ExploreChem/ElementMassBasis/v1',element:calc.element,unit:'mg'}),quantity});
   }
   return measured;
  });
  // An omitted analysis is not a measured zero: all recorded source bases must be assessed.
  const declared=new Set(calculations.map(calc=>lower(hashObject({domain:'ExploreChem/ElementMassBasis/v1',element:calc.element,unit:'mg'}))));
  for(const cs of ctx.inputComponents)for(const c of cs)if(BigInt(c.quantity)>0n&&!declared.has(lower(c.basisHash)))throw Error('Falta análise de um elemento registrado no lote de origem.');
  validateMaterialConsumption(ctx,action);
 }
 return action;
}
function materialInputComponents(ctx:any):Map<string,bigint> {
 const totals=new Map<string,bigint>();
 if(ctx.inputComponents?.length!==ctx.inputs.length||ctx.inputIssued?.length!==ctx.inputs.length)throw Error('Composição on-chain incompleta.');
 for(let i=0;i<ctx.inputs.length;i++){
  if(lower(ctx.inputBases[i])!==lower(MATERIAL_BASIS))throw Error('Lote de origem não usa massa material seca.');
  for(const c of ctx.inputComponents[i]){const key=lower(c.basisHash);totals.set(key,(totals.get(key)??0n)+BigInt(c.quantity));}
 }
 return totals;
}
function validateMaterialConsumption(ctx:any,action:TokenAction) {
 if(ctx.inputs.length!==action.inputs.length||ctx.inputs.some((x:any,i:number)=>BigInt(x.lotId)!==action.inputs[i].lotId||BigInt(x.quantity)!==action.inputs[i].quantity))throw Error('Entradas diferem do documento.');
 materialInputComponents(ctx);
 if(action.consumedComponents.length!==action.inputs.length)throw Error('Composição medida de cada entrada obrigatória.');
 const consumed=new Map<string,bigint>(),produced=new Map<string,bigint>();let mass=0n;
 for(let i=0;i<action.inputs.length;i++){
  const available=new Map<string,bigint>(ctx.inputComponents[i].map((c:any)=>[lower(c.basisHash),BigInt(c.quantity)]));
  const q=action.inputs[i].quantity,supply=BigInt(ctx.inputIssued[i]),seen=new Set<string>();let removed=0n;
  if(q<=0n||q>supply||q>BigInt(ctx.inputBalances[i])||action.consumedComponents[i].length>17)throw Error('Consumo material inválido.');
  for(const c of action.consumedComponents[i]){
   const basis=lower(c.basisHash);
   if(seen.has(basis)||c.quantity<=0n||c.quantity>(available.get(basis)??0n))throw Error('Consumo elemental excede o saldo atual da origem ou repete elemento.');
   seen.add(basis);removed+=c.quantity;consumed.set(basis,(consumed.get(basis)??0n)+c.quantity);
  }
  const stock=[...available.values()].reduce((n,q)=>n+q,0n);
  if(removed>q||stock-removed>supply-q)throw Error('Composição medida ou saldo remanescente incompatível com a massa.');
 }
 for(const out of action.outputs){
  if(lower(out.basisHash)!==lower(MATERIAL_BASIS)||out.quantity<=0n||out.quantity>MAX_MATERIAL_MASS||out.components.length>17)throw Error('Saída material inválida.');
  const seen=new Set<string>();let contained=0n;mass+=out.quantity;
  for(const c of out.components){const key=lower(c.basisHash);if(seen.has(key)||c.quantity<=0n)throw Error('Componente inválido ou repetido.');seen.add(key);contained+=c.quantity;produced.set(key,(produced.get(key)??0n)+c.quantity);}
  if(contained>out.quantity)throw Error('Elementos excedem a massa do produto.');
 }
 if(mass>ctx.inputs.reduce((n:bigint,x:any)=>n+BigInt(x.quantity),0n))throw Error('Massa produzida excede a massa consumida.');
 for(const [basis,q]of produced)if(q>(consumed.get(basis)??0n))throw Error('Elemento produzido excede o conteúdo medido consumido.');
}

function checkTokenAction(runtime:TeeRuntime<Config>,selected:SelectedEvidence,action:TokenAction,prepared?:{lots:Address,ctx:any}):Address|null {
 if(action.kind===0)return null;
 const registry=runtime.config.contractAddress as Address;
 const lots=prepared?.lots??tokenRead(runtime,registry,'lotsContract',[]) as Address;
 if(lower(lots)===lower(zeroAddress))throw Error('Registry ainda não vinculado ao Lots.');
 if(!prepared&&lower(tokenRead(runtime,lots,'registry',[]))!==lower(registry))throw Error('Vínculo Registry/Lots inválido.');
 // The final root-proof gate and Lots.processTokenAction reject repeated issuance.
 // Keep the post-write evidenceTokenized confirmation; avoid a duplicate pre-read.
 if(action.kind===2){
  const ctx=prepared?.ctx??tokenRead(runtime,registry,'getConsumptionContext',[selected.onchain.actorId,action.inputs]);
  validateMaterialConsumption(ctx,action);
 }

 return lots;
}

function encodeProofReport(runtime:TeeRuntime<Config>,proof:ProofCommitment,action:TokenAction):Hex {
 return encodeAbiParameters(REPORT_V2_ABI,[{version:2,chainId:BigInt(network(runtime).chainId),registry:runtime.config.contractAddress as Address,proof,action}]);
}

function writeProof(runtime: TeeRuntime<Config>, proof: ProofCommitment, action: TokenAction): Hex {
  const don = runtime.usingTheDons();
  const report = don
    .report({
      encodedPayload: hexToBase64(encodeProofReport(runtime, proof, action)),
      encoderName: "evm",
      signingAlgo: "ecdsa",
      hashingAlgo: "keccak256",
    })
    .result();

  // Compare the actual signed report identity, not the MUF workflow identity.
  // These are read-only checks; authorization can only be changed by the owner.
  const configuredWorkflowId = callContract(
    runtime, "expectedWorkflowId", [proof.proofType],
  ) as Hex;
  const actualId = report.workflowId();
  const actualWorkflowId = actualId.startsWith("0x") ? actualId : `0x${actualId}`;
  if (lower(configuredWorkflowId) === lower(zeroHash)) {
    throw new Error(JSON.stringify({
      message: "WorkflowNotConfigured: ELEMENTAL nao autorizado no contrato; nenhuma transacao enviada",
      contract: runtime.config.contractAddress,
      proofType: proof.proofType,
      configuredWorkflowId,
      actualWorkflowId,
    }));
  }
  if (lower(configuredWorkflowId) !== lower(actualWorkflowId)) {
    throw new Error(JSON.stringify({
      message: "InvalidWorkflowId: ID do relatorio ELEMENTAL difere do autorizado; nenhuma transacao enviada",
      contract: runtime.config.contractAddress,
      proofType: proof.proofType,
      configuredWorkflowId,
      actualWorkflowId,
    }));
  }
  runtime.log(`ELEMENTAL: workflowId autorizado=${actualWorkflowId}; proofType=${proof.proofType}`);

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
  return `elemental-results/${evidenceId.slice(2)}/${proofId.slice(2)}.json`;
}

function confirmWrittenProof(
  runtime: TeeRuntime<Config>, proof: ProofCommitment, txHash: Hex,
) {
  // This immutable proof-specific query was not made before writeReport.
  // Do not reuse the pre-write latestProofId/getCurrentProofState reads:
  // a repeated capability response may still describe the pre-write state.
  const anchored = callContract(runtime, "getProof", [proof.proofId]) as
    ProofCommitment & { workflowId: Hex; createdAt: bigint };
  const hashFields = [
    "proofId", "evidenceId", "evidenceHash", "committedHash",
    "inputCommitmentHash", "methodologyHash", "previousProofId",
  ] as const;
  const mismatches: string[] = [];
  for (const field of hashFields) {
    if (lower(anchored[field]) !== lower(proof[field])) mismatches.push(field);
  }
  if (Number(anchored.proofType) !== proof.proofType) mismatches.push("proofType");
  if (Number(anchored.status) !== proof.status) mismatches.push("status");
  if (Number(anchored.revision) !== proof.revision) mismatches.push("revision");
  if (mismatches.length > 0) {
    throw new Error(JSON.stringify({
      message: "ELEMENTAL: getProof nao confirmou a prova enviada; causa da rejeicao ou atraso ainda nao determinada",
      contract: runtime.config.contractAddress,
      txHash,
      expectedProofId: proof.proofId,
      observedProofId: anchored.proofId,
      expectedHash: proof.committedHash,
      observedHash: anchored.committedHash,
      expectedStatus: proof.status,
      observedStatus: Number(anchored.status),
      mismatches,
    }));
  }
  return anchored;
}

/* ============================================================
 * Run
 * ============================================================
 */

function run(runtime: TeeRuntime<Config>): string {
  const { key } = secrets(runtime);
  const selected = selectEligibleEvidence(runtime, key);

  if (selected === null) {
    return JSON.stringify({
      workflow: "ELEMENTAL_WORKFLOW",
      proofType: "ELEMENTAL",
      selectionSource: "ONCHAIN_EVENTS_CHAIN_STATUS",
      message:
        "nenhuma evidencia utilizavel com ELEMENTAL PENDING e MUF COMPLIANT entre as provas on-chain do intervalo consultado",
    });
  }

  const result = buildResult(runtime, key, selected);
  let configuredLots:Address|null=null;
  const document=verifiedDocuments.get(selected);
  let actionSpec:Record<string,unknown>={mode:'INITIAL'};
  let processingContext:any=null;
  if(result.status==='COMPLIANT'){
    if(!document)throw Error('Documento verificado ausente.');
    configuredLots=tokenRead(runtime,runtime.config.contractAddress as Address,'lotsContract',[]) as Address;
    if(lower(configuredLots)===lower(zeroAddress))throw Error('Registry ainda não vinculado ao Lots.');
    if(lower(tokenRead(runtime,configuredLots,'registry',[]))!==lower(runtime.config.contractAddress))throw Error('Vínculo Registry/Lots inválido.');
    if(document.tokenization!==undefined)actionSpec=recordOf(document.tokenization);
    else if(JSON.stringify(document).includes('"sourceLotId"'))throw Error('Documento com origem exige tokenization.mode TRANSFORM e inputs.');
    if(runtime.config.tokenActionMode!==undefined && runtime.config.tokenActionMode!==actionSpec.mode)throw Error('tokenActionMode da configuração difere do modo declarado no documento verificado.');
    if(actionSpec.mode==='TRANSFORM'){
      if(!Array.isArray(actionSpec.inputs)||!actionSpec.inputs.length||actionSpec.inputs.length>32)throw Error('Informe de 1 a 32 lotes de origem em tokenization.inputs.');
      const inputs=actionSpec.inputs.map((raw:any)=>({lotId:uintToken(raw.lotId),quantity:uintToken(raw.quantity)}));
      processingContext=tokenRead(runtime,runtime.config.contractAddress as Address,'getConsumptionContext',[selected.onchain.actorId,inputs]);
      actionSpec={...actionSpec,context:processingContext};
    }
  }

  const action = buildTokenAction(selected,result,actionSpec);
  const privateResultDocument = {
    evidenceId: selected.onchain.evidenceId,
    action: serialAction(action),
    materialAccounting: { unit:'mg', massBasis:'DRY', componentsAreContained:true },
    schema: "ExploreChem/PrivateElementalResult/v1",
    calculationVersion: 1,
    result,
    methodology: ELEMENTAL_METHODOLOGY,
  } as const;
  const canonicalResultJson = stableJson(privateResultDocument);
  const elementalHash = keccak256(toHex(canonicalResultJson));
  const proof = buildProofCommitment(selected, result, elementalHash);
  const resultPath = privateResultPath(proof.evidenceId, proof.proofId);

  // Remaining reads: final proof gates (3), workflow authorization (1),
  // proof confirmation (1), and token confirmation (2 when applicable).
  // Registry/Lots linkage and consumption context have already been read.
  reserveChainReads(runtime, action.kind === 0 ? 5 : 7);

  // Persist the immutable canonical ELEMENTAL JSON before anchoring. The exact bytes
  // saved here are the bytes whose keccak256 is sent as committedHash/elementalHash.
  savePrivateResult(
    runtime,
    key,
    selected.row.storage_bucket,
    resultPath,
    canonicalResultJson,
  );

  // Final state gate: another execution may have anchored the ELEMENTAL meanwhile.
  const beforeWrite = readCurrentElementalState(runtime, proof.evidenceId);
  const mufProofBeforeWrite = readLatestMufProofId(runtime, proof.evidenceId);
  const latestBeforeWrite = readLatestElementalProofId(runtime, proof.evidenceId);
  if (
    beforeWrite.mufStatus !== CHECK_STATUS_COMPLIANT ||
    beforeWrite.elementalStatus !== CHECK_STATUS_PENDING ||
    lower(beforeWrite.mufHash) !== lower(selected.current.mufHash) ||
    lower(mufProofBeforeWrite) !== lower(selected.latestMufProofId) ||
    lower(latestBeforeWrite) !== lower(zeroHash)
  ) {
    return JSON.stringify({
      workflow: "ELEMENTAL_WORKFLOW",
      proofType: "ELEMENTAL",
      evidenceId: proof.evidenceId,
      message: "ELEMENTAL deixou de estar PENDING antes da escrita; nenhuma transacao enviada",
      currentMufStatus: beforeWrite.mufStatus,
      currentElementalStatus: beforeWrite.elementalStatus,
      latestElementalProofId: latestBeforeWrite,
    });
  }

  const lotsAddress = checkTokenAction(runtime, selected, action,configuredLots?{lots:configuredLots,ctx:processingContext}:undefined);
  const txHash = writeProof(runtime, proof, action);
  const anchoredProof = confirmWrittenProof(runtime, proof, txHash);
  const mintedLotIds = lotsAddress ? tokenRead(runtime,lotsAddress,"getOperationLots",[action.operationId]) as bigint[] : [];
  if(lotsAddress && (!tokenRead(runtime,lotsAddress,"evidenceTokenized",[proof.evidenceId]) || mintedLotIds.length!==action.outputs.length))throw Error("Prova enviada; confirmação de mint pendente. Consulte on-chain antes de reexecutar.");

  return JSON.stringify({
    workflow: "ELEMENTAL_WORKFLOW",
    proofType: "ELEMENTAL",
    evidenceId: proof.evidenceId,
    actorId: result.actorId,
    lotReference: result.lotReference,
    status: result.status,
    reasonCodes: result.reasonCodes,
    // Commercial calculations remain in the private JSON, not execution output.
    tokenization: { operationId: action.operationId, lotsAddress, lotIds: mintedLotIds.map(String), executedAtomically:true },
    integrity: {
      expectedEvidenceHash: result.expectedEvidenceHash,
      indexedEvidenceHash: result.indexedEvidenceHash,
      downloadedDocumentHash: result.downloadedDocumentHash,
      matches: result.integrityMatches,
      mufProofId: result.mufProofId,
      expectedMufHash: result.expectedMufHash,
      downloadedMufResultHash: result.downloadedMufResultHash,
      mufMatches: result.mufIntegrityMatches,
    },
    commitment: {
      elementalHash: proof.committedHash,
      privateResultJsonHash: elementalHash,
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
      confirmationSource: "GET_PROOF",
      confirmedProofId: anchoredProof.proofId,
      confirmedElementalStatus: Number(anchoredProof.status),
      confirmedElementalHash: anchoredProof.committedHash,
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