import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {json,now} from './io.ts';
import type {Plan} from './plan.ts';
export interface LiveRun {keyFile:string;authorization:string}
export const isLivePlan=(plan:Plan)=>plan.stage.egress.backend==='live'&&plan.stage.egress.mode==='live';
// T9 C3: characters a reader cannot see. T9 C2 had spaces of every kind, control characters and invisible format
// characters (zero-width space and joiners, BOM, soft hyphen, direction marks); now also the Hangul fillers U+115F,
// U+1160, U+3164 and U+FFA0, the Braille blank U+2800, every combining mark \p{M}, and the variation selectors U+FE00-FE0F
// and U+E0100-E01EF (marks already; listed to be explicit). The ranges confirm-fee.ts used before are kept in the set too.
// T10: also private use \p{Co}, unassigned code points \p{Cn} (this includes the noncharacters U+FDD0-FDEF and U+xFFFE/xFFFF),
// U+FFFC (object replacement) and U+1D159 (musical null notehead), which show nothing. Unassigned means unassigned in
// this Node's Unicode version.
const invisibleText=/[\s\p{Z}\p{Cc}\p{Cf}\p{M}\p{Co}\p{Cn}\u115F\u1160\u3164\uFFA0\u2800\uFFFC\u{1D159}\uFE00-\uFE0F\u{E0100}-\u{E01EF}\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF]/gu;
/** How many characters of the text a reader can see. Used here and by scripts/confirm-fee.ts. */
export const visibleCount=(text:string)=>[...text.replace(invisibleText,'')].length;
/** Each real run carries the three items itself; the text must name this exact plan and say why. */
export function checkLiveRun(plan:Plan,live?:Partial<LiveRun>):asserts live is LiveRun{
  if(!live)throw new Error('A real plan needs --live --key-file <key file> --live-authorization "live:<plan hash> explanation"');
  if(!live.keyFile?.trim())throw new Error('--key-file is required for a real run');
  const text=live.authorization??'',ids=[...text.matchAll(/\blive:([a-f0-9]{64})\b/g)].map(m=>m[1]);
  if(ids.length!==1||ids[0]!==plan.hash)throw new Error('--live-authorization must name the full hash of this plan: live:'+plan.hash);
  if(!text.replace(/\blive:[a-f0-9]{64}\b/g,'').trim())throw new Error('--live-authorization needs a nonempty explanation');
  // T9 C2: and a real one: at least 2 visible characters must remain (T9 C3: what counts as invisible, see visibleCount).
  if(visibleCount(text.replace(/\blive:[a-f0-9]{64}\b/g,''))<2)throw new Error('--live-authorization needs an explanation of at least 2 visible characters');
}
/** The key file's path is recorded; its content and hash are not, and this process never opens it. */
export function recordLiveRun(root:string,plan:Plan,live:LiveRun){
  const {budget}=plan.stage.egress.settings,{perTaskRequests,dispatchPolicy,searchMaxRequests,searchCny,searchDispatch}=plan.stage.egress,at=now();
  json(join(root,'scheduler','live-authorizations',`${at.replace(/[:.]/g,'-')}-${process.pid}-${randomUUID()}.json`),{at,pid:process.pid,planHash:plan.hash,runId:plan.runId,limits:{referenceUsd:budget.referenceUsd,referenceCny:budget.referenceCny,peakCnyPerMillion:budget.peakCnyPerMillion,maxRequests:budget.maxRequests,perTaskRequests,maxInFlight:dispatchPolicy.maxInFlight,dispatchPolicy,searchMaxRequests,searchCny,searchDispatch},authorization:live.authorization,keyFile:live.keyFile},true);
}
