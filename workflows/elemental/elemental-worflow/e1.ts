import { encodeAbiParameters, keccak256, parseAbiParameters, toHex, zeroHash, type Address, type Hex } from 'viem';

export type Opening = { lotId: Hex; materialMassMg: bigint; elements: {basisHash: Hex; massMg: bigint}[]; salt: Hex };
export type OutputLot = {lotId: Hex; commitment: Hex; recipient: Hex};
export type Operation = {kind: number; operationId: Hex; holder: Hex; inputLotIds: Hex[]; outputs: OutputLot[]};
export type ExpectedStream = {streamId: string; sourceLotId?: string; materialMassMg: bigint; elements: {basisHash: Hex; massMg: bigint}[]};
export type Context = {inputLotIds: readonly Hex[]; inputCommitments: readonly Hex[]; holders: readonly Hex[]; states: readonly number[]};
export const OP_TUPLE = '(uint8 kind,bytes32 operationId,bytes32 holder,bytes32[] inputLotIds,(bytes32 lotId,bytes32 commitment,bytes32 recipient)[] outputs)';
export const PROOF_TUPLE = '(uint8 proofType,bytes32 evidenceId,bytes32 evidenceHash,bytes32 proofId,bytes32 committedHash,bytes32 inputCommitmentHash,bytes32 methodologyHash,bytes32 previousProofId,uint8 status,uint32 revision)';
export const REPORT_V3_ABI = parseAbiParameters(`(uint8 version,uint256 chainId,address registry,${PROOF_TUPLE} proof,${OP_TUPLE} op)`);
const OPENING_ABI = parseAbiParameters('bytes32,uint256,address,(bytes32 lotId,uint96 materialMassMg,(bytes32 basisHash,uint96 massMg)[] elements,bytes32 salt)');
const HASH_ABI = parseAbiParameters(`bytes32,uint256,address,address,bytes32,bytes32,${OP_TUPLE},bytes32[]`);
export const emptyOperation = (): Operation => ({kind:0,operationId:zeroHash,holder:zeroHash,inputLotIds:[],outputs:[]});
export class E1Error extends Error {
  constructor(public readonly reason: string, public readonly status: 'NOT_ATTESTED'|'DIVERGENT' = 'NOT_ATTESTED') { super(reason); }
}
export function obj(x: unknown): Record<string,unknown> {
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw new E1Error('OPENING_UNAVAILABLE');
  return x as Record<string,unknown>;
}
export function id(x:unknown):Hex {
  if(typeof x!=='string'||!/^0x[0-9a-fA-F]{64}$/.test(x)||x.toLowerCase()===zeroHash) throw new E1Error('INVALID_IDENTIFIER');
  return x.toLowerCase() as Hex;
}
function mass(x:unknown):bigint {
  if(typeof x!=='string'||!/^\d+$/.test(x)) throw new E1Error('MASS_MUST_BE_INTEGER_STRING');
  const n=BigInt(x); if(n<=0n||n>=(1n<<96n))throw new E1Error('MASS_OUT_OF_RANGE'); return n;
}
export function parseOpening(raw: unknown):Opening {
  const x=obj(raw);
  if(!Array.isArray(x.elements)||x.elements.length>17)throw new E1Error('INVALID_ELEMENTS');
  const elements=x.elements.map(v=>{const e=obj(v);return {basisHash:id(e.basisHash),massMg:mass(e.massMg)};});
  for(let i=1;i<elements.length;i++) if(elements[i-1].basisHash>=elements[i].basisHash)throw new E1Error('ELEMENTS_NOT_SORTED_UNIQUE');
  const o={lotId:id(x.lotId),materialMassMg:mass(x.materialMassMg),elements,salt:id(x.salt)};
  if(elements.reduce((n,e)=>n+e.massMg,0n)>o.materialMassMg)throw new E1Error('ELEMENTS_EXCEED_MATERIAL','DIVERGENT');
  return o;
}
export function lotCommitment(chainId:bigint,lots:Address,o:Opening):Hex {
  return keccak256(encodeAbiParameters(OPENING_ABI,[keccak256(toHex('ExploreChem/LotCommitment/v1')),chainId,lots,o]));
}
export function operationHash(chainId:bigint,registry:Address,lots:Address,evidenceId:Hex,mufId:Hex,op:Operation,inputCommitments:readonly Hex[]):Hex {
  return keccak256(encodeAbiParameters(HASH_ABI,[keccak256(toHex('ExploreChem/OperationCommitment/v1')),chainId,registry,lots,evidenceId,mufId,op,inputCommitments]));
}
export function inputIds(spec:unknown):Hex[] {
  const raw=obj(spec).inputs;
  if(!Array.isArray(raw)||raw.length>32)throw new E1Error('INPUT_OPENINGS_UNAVAILABLE');
  const ids=raw.map(v=>id(obj(v).lotId));
  if(new Set(ids).size!==ids.length)throw new E1Error('DUPLICATE_INPUT_LOT','DIVERGENT'); return ids;
}
function sumStreams(streams:ExpectedStream[]): {mass:bigint; elements:Map<string,bigint>} {
 const elements=new Map<string,bigint>(); let mass=0n;
 for(const s of streams){mass+=s.materialMassMg;for(const e of s.elements)elements.set(e.basisHash.toLowerCase(),(elements.get(e.basisHash.toLowerCase())??0n)+e.massMg);}
 return {mass,elements};
}
function matches(o:Opening, streams:ExpectedStream[]) {
 const s=sumStreams(streams);
 if(!streams.length||s.mass!==o.materialMassMg)throw new E1Error('OPENING_EVIDENCE_MASS_MISMATCH','DIVERGENT');
 const nonzero=[...s.elements].filter(([,n])=>n>0n);
 if(nonzero.length!==o.elements.length||o.elements.some(e=>s.elements.get(e.basisHash)!==e.massMg))throw new E1Error('OPENING_EVIDENCE_ELEMENTS_MISMATCH','DIVERGENT');
}
export function buildOperation(args:{spec:unknown;holder:Hex;chainId:bigint;lots:Address;context:Context|null;available:ExpectedStream[];accounted:ExpectedStream[]}) {
 const {holder,chainId,lots,context,available,accounted}=args,spec=obj(args.spec);
 if(spec.mode!=='INITIAL'&&spec.mode!=='TRANSFORM')throw new E1Error('INVALID_OPERATION_MODE');
 const kind=spec.mode==='INITIAL'?1:2;
 const ids=inputIds(spec);
 if(kind===1&&ids.length||kind===2&&!ids.length)throw new E1Error('INVALID_INPUT_COUNT');
 const inputs=(spec.inputs as unknown[]).map(parseOpening);
 if(!Array.isArray(spec.outputs)||!spec.outputs.length||spec.outputs.length>32)throw new E1Error('OUTPUT_OPENINGS_UNAVAILABLE');
 const outputRecords=spec.outputs.map(v=>{const r=obj(v);return {streamId:String(r.streamId??''),recipient:id(r.recipient),opening:parseOpening(r.opening)};});
 const outputs=outputRecords.map(r=>r.opening);
 const all=[...inputs,...outputs];
 if(new Set(all.map(o=>o.lotId)).size!==all.length)throw new E1Error('DUPLICATE_LOT_ID','DIVERGENT');
 if(new Set(all.map(o=>o.salt)).size!==all.length)throw new E1Error('REUSED_LOT_SALT');
 const proofSalt=id(spec.proofSalt);
 if(all.some(o=>o.salt===proofSalt))throw new E1Error('REUSED_PROOF_SALT');
 const commitments=inputs.map(o=>lotCommitment(chainId,lots,o));
 if(kind===2){
  if(!context||context.inputLotIds.length!==ids.length||context.inputCommitments.length!==ids.length||context.holders.length!==ids.length||context.states.length!==ids.length)throw new E1Error('INPUT_CONTEXT_UNAVAILABLE');
  for(let i=0;i<inputs.length;i++){
   if(context.inputLotIds[i].toLowerCase()!==ids[i]||context.inputCommitments[i].toLowerCase()!==commitments[i])throw new E1Error('COMMITMENT_MISMATCH','DIVERGENT');
   if(context.holders[i].toLowerCase()!==holder.toLowerCase()||Number(context.states[i])!==1)throw new E1Error('INPUT_NOT_ACTIVE_OR_NOT_HELD','DIVERGENT');
  }
  const assignments=available.map(s=>({s,id:s.sourceLotId?id(s.sourceLotId):ids.length===1?ids[0]:null}));
  if(assignments.some(a=>!a.id||!ids.includes(a.id)))throw new E1Error('AVAILABLE_STREAM_SOURCE_REQUIRED');
  inputs.forEach(o=>matches(o,assignments.filter(a=>a.id===o.lotId).map(a=>a.s)));
 }
 const expected=(kind===1?available:accounted).filter(s=>s.materialMassMg>0n);
 if(new Set(expected.map(s=>s.streamId)).size!==expected.length||outputRecords.length!==expected.length||new Set(outputRecords.map(r=>r.streamId)).size!==expected.length)throw new E1Error('OUTPUT_STREAMS_MISMATCH','DIVERGENT');
 outputRecords.forEach(r=>{
  matches(r.opening,expected.filter(s=>s.streamId===r.streamId));
  if(kind===1&&r.recipient.toLowerCase()!==holder.toLowerCase())throw new E1Error('INITIAL_RECIPIENT_MISMATCH');
 });
 const ins=sumStreams(inputs.map(o=>({streamId:o.lotId,materialMassMg:o.materialMassMg,elements:o.elements})));
 const outs=sumStreams(outputs.map(o=>({streamId:o.lotId,materialMassMg:o.materialMassMg,elements:o.elements})));
 if(kind===2&&(outs.mass>ins.mass||[...outs.elements].some(([key,n])=>n>(ins.elements.get(key)??0n))))throw new E1Error('SUPPLY_EXCEEDED','DIVERGENT');
 const op:Operation={kind,operationId:id(spec.operationId),holder,inputLotIds:ids,outputs:outputRecords.map(r=>({lotId:r.opening.lotId,commitment:lotCommitment(chainId,lots,r.opening),recipient:r.recipient}))};
 return {op,inputCommitments:commitments,proofSalt,difference:kind===2?{materialMassMg:(ins.mass-outs.mass).toString(),elements:[...ins.elements].map(([basisHash,n])=>({basisHash,massMg:(n-(outs.elements.get(basisHash)??0n)).toString()}))}:null};
}
