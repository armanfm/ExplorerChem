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
  toHex,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
} from "viem";

import { z } from "zod";

/**
 * ExploreChem — Auditor independente do resultado bilateral de massa.
 *
 * Este workflow NAO procura PENDING, NAO correlaciona documentos e NAO cria
 * resultado de massa. Ele consome somente uma evidencia MATCHED que ja possui
 * BalanceResult ancorado pelo workflow primario.
 *
 * Fluxo:
 *   MATCHED + resultado CONFORME e integro   -> VERIFIED
 *   MATCHED + resultado DIVERGENTE           -> DIVERGENT
 *   MATCHED + falha de integridade/calculo   -> DIVERGENT
 *   MATCHED + resultado NAO_ATESTADO         -> DIVERGENT
 *   MATCHED ainda sem resultado              -> permanece MATCHED
 *
 * A blockchain e sempre a autoridade. O Supabase so e espelhado depois da
 * releitura do estado final on-chain.
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
});

type Config = z.infer<typeof configSchema>;

const evidenceRowSchema = z.object({
  evidence_id: bytes32Schema,
  state: z.string().min(1),
  storage_bucket: z.string().min(1),
});

type EvidenceRow = z.infer<typeof evidenceRowSchema>;

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
  deltaMg: z.string().regex(/^\d+$/).nullable(),
  status: massStatusSchema,
});

const privatePairwiseResultSchema = z.object({
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

type PrivatePairwiseResult = z.infer<typeof privatePairwiseResultSchema>;

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
    "?select=evidence_id,state,storage_bucket" +
    `&evidence_id=eq.${encodeURIComponent(evidenceId)}&limit=1`;

  const raw = text(request(runtime, key, path, "GET"));
  const rows = z.array(evidenceRowSchema).parse(JSON.parse(raw));

  if (rows.length !== 1) {
    throw new Error(`${evidenceId}: evidencia ausente no Supabase`);
  }

  return rows[0];
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

function recomputeManifestCommitments(manifest: PrivatePairwiseResult) {
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
    canonicalResultHash,
    resultId,
  };
}

function recomputeMassVerdict(manifest: PrivatePairwiseResult) {
  const errors: string[] = [];
  const statuses: MassStatus[] = [];

  for (const pair of manifest.massPairs) {
    let expectedStatus: MassStatus;
    let expectedDelta: string | null;

    if (pair.leftMassMg === null || pair.rightMassMg === null) {
      expectedStatus = "NAO_ATESTADO";
      expectedDelta = null;
    } else {
      const left = BigInt(pair.leftMassMg);
      const right = BigInt(pair.rightMassMg);
      expectedDelta = (left >= right ? left - right : right - left).toString();
      expectedStatus = left === right ? "CONFORME" : "DIVERGENTE";
    }

    statuses.push(expectedStatus);

    if (pair.status !== expectedStatus) {
      errors.push(
        `${pair.pairId}: status declarado=${pair.status} esperado=${expectedStatus}`,
      );
    }

    if (pair.deltaMg !== expectedDelta) {
      errors.push(
        `${pair.pairId}: deltaMg declarado=${String(pair.deltaMg)} esperado=${String(expectedDelta)}`,
      );
    }
  }

  let expectedOverallStatus: MassStatus;

  if (statuses.some((status) => status === "DIVERGENTE")) {
    expectedOverallStatus = "DIVERGENTE";
  } else if (
    statuses.length > 0 &&
    statuses.every((status) => status === "CONFORME")
  ) {
    expectedOverallStatus = "CONFORME";
  } else {
    expectedOverallStatus = "NAO_ATESTADO";
  }

  if (manifest.status !== expectedOverallStatus) {
    errors.push(
      `status global declarado=${manifest.status} esperado=${expectedOverallStatus}`,
    );
  }

  return { expectedOverallStatus, errors };
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

  const recomputed = recomputeManifestCommitments(manifest);

  if (!sameHex(recomputed.aggregateInputHash, manifest.aggregateInputHash)) {
    integrityErrors.push("aggregateInputHash privado nao e reproduzivel");
  }
  if (!sameHex(recomputed.aggregateInputHash, onchainResult.aggregateInputHash)) {
    integrityErrors.push("aggregateInputHash privado diverge do resultado on-chain");
  }
  if (!sameHex(recomputed.canonicalResultHash, manifest.canonicalResultHash)) {
    integrityErrors.push("canonicalResultHash privado nao e reproduzivel");
  }
  if (!sameHex(recomputed.canonicalResultHash, manifest.resultHash)) {
    integrityErrors.push("resultHash privado diverge do resultado canonico");
  }
  if (!sameHex(recomputed.canonicalResultHash, onchainResult.resultHash)) {
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
      recomputed.canonicalResultHash,
    )
  ) {
    integrityErrors.push("verifyResultHash retornou false");
  }

  const massAudit = recomputeMassVerdict(manifest);
  const allErrors = [...integrityErrors, ...massAudit.errors];

  const onchainExpectedMassStatus =
    onchainResult.status === 1
      ? "CONFORME"
      : onchainResult.status === 2
        ? "DIVERGENTE"
        : "NAO_ATESTADO";

  if (onchainExpectedMassStatus !== massAudit.expectedOverallStatus) {
    allErrors.push(
      `status on-chain=${onchainExpectedMassStatus} recalculado=${massAudit.expectedOverallStatus}`,
    );
  }

  const verdict: "VERIFIED" | "DIVERGENT" =
    allErrors.length === 0 &&
    massAudit.expectedOverallStatus === "CONFORME"
      ? "VERIFIED"
      : "DIVERGENT";

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
      schema: "ExploreChem/PairwiseMassAudit/v1",
      evidenceId,
      actorId: evidence.actorId,
      evidenceHash: evidence.evidenceHash,
      resultId,
      resultHash: onchainResult.resultHash,
      aggregateInputHash: onchainResult.aggregateInputHash,
      calculationVersion: onchainResult.calculationVersion,
      previousResultId: onchainResult.previousResultId,
      recalculatedMassStatus: massAudit.expectedOverallStatus,
      verdict,
      errors: allErrors,
      auditTxHash,
    },
  );

  mirrorFinalState(runtime, key, evidenceId, verdict);

  return JSON.stringify({
    workflow: "PAIRWISE_MASS_AUDITOR",
    discovery: "BLOCKCHAIN_GET_NEXT_MATCHED",
    authority: "BLOCKCHAIN",
    evidenceId,
    actorId: evidence.actorId,
    resultId,
    resultHash: onchainResult.resultHash,
    aggregateInputHash: onchainResult.aggregateInputHash,
    declaredMassStatus: manifest.status,
    recalculatedMassStatus: massAudit.expectedOverallStatus,
    auditErrorCount: allErrors.length,
    auditErrors: allErrors,
    finalEvidenceStatus: verdict,
    auditTxHash,
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
  return run(runtime);
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
