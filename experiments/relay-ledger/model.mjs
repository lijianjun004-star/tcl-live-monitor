// Offline transition model ONLY. Not imported by the Worker; no storage or dispatch.
import {createHash} from 'node:crypto';
const ident=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,96}$/.test(x);
const time=x=>Number.isSafeInteger(x)&&x>=0&&x<=8640000000000000;
const modes=['READY','PENDING','REVIEW_REQUIRED','SOURCE_BACKOFF'];
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const fields=['schemaVersion','mode','revision','lastAt','attemptId','slotMs','failures','reviewNotBefore','events'];
function valid(s){
  if(!s||Object.keys(s).sort().join()!==fields.sort().join()||s.schemaVersion!==1||!modes.includes(s.mode)||!Number.isSafeInteger(s.revision)||s.revision<0||!time(s.lastAt)||!Number.isSafeInteger(s.failures)||s.failures<0||!Array.isArray(s.events)||s.events.length!==s.revision+1||s.events.length>1000)return false;
  if((s.attemptId!==null&&!ident(s.attemptId))||(s.slotMs!==null&&!time(s.slotMs))||(s.reviewNotBefore!==null&&!time(s.reviewNotBefore)))return false;
  let previous=null,last=-1;
  for(const e of s.events){
    if(!e||!ident(e.kind)||!time(e.at)||e.at<last||e.previous!==previous)return false;
    const {hash,...payload}=e;
    if(hash!==digest(payload))return false;
    previous=e.hash;last=e.at;
  }
  const {events,...payload}=s;
  return events.at(-1).stateDigest===digest(payload) && last===s.lastAt && (s.mode==='READY'||(ident(s.attemptId)&&time(s.slotMs))) &&
    (s.mode!=='SOURCE_BACKOFF'||(time(s.reviewNotBefore)&&s.reviewNotBefore>=s.lastAt&&s.failures>0));
}
function append(s,kind,now,meta={}){
  const {events,...payload}={...s,revision:s.revision+1,lastAt:now};
  const e={kind,at:now,previous:events.at(-1)?.hash??null,stateDigest:digest(payload),
    attemptId:payload.attemptId,runId:ident(meta.runId)?meta.runId:null,
    evidenceRef:ident(meta.evidenceRef)?meta.evidenceRef:null,reviewRef:ident(meta.reviewRef)?meta.reviewRef:null};
  return {...payload,events:[...events,{...e,hash:digest(e)}]};
}
export function bootstrapSimulation({now,reviewRef}={}){
  if(!time(now)||!ident(reviewRef))throw Error('SIMULATION_BOOTSTRAP_INVALID');
  return append({schemaVersion:1,mode:'READY',revision:-1,lastAt:now,attemptId:null,slotMs:null,failures:0,reviewNotBefore:null,events:[]},'BOOTSTRAP_REVIEWED_INPUT',now,{reviewRef});
}
export function transition(state,event){
  const deny=reason=>({dispatch:false,accepted:false,reason,state});
  if(!valid(state))return deny('PERSISTED_STATE_MISSING_OR_INVALID');
  if(!event||!time(event.now)||event.now<state.lastAt)return deny('INVALID_OR_REVERSED_TIME');
  if(state.events.length>=1000)return deny('AUDIT_CAPACITY_REVIEW_REQUIRED');
  let next=structuredClone(state),reason;
  if(event.type==='RESERVE'){
    if(state.mode!=='READY')return deny('OUTSTANDING_ATTEMPT_OR_REVIEW');
    if(!ident(event.attemptId)||!time(event.slotMs)||event.slotMs>event.now||(state.slotMs!==null&&event.slotMs<=state.slotMs)||event.attemptId===state.attemptId)return deny('INVALID_OR_REPLAYED_OPPORTUNITY');
    next={...next,mode:'PENDING',attemptId:event.attemptId,slotMs:event.slotMs};reason='SIMULATED_RESERVATION';
  }else if(event.type==='ACCEPTED'||event.type==='UNCERTAIN'){
    if(state.mode!=='PENDING'||event.attemptId!==state.attemptId)return deny('ATTEMPT_MISMATCH');
    // HTTP acceptance is still pending until correlated source feedback.
    next.mode=event.type==='ACCEPTED'?'PENDING':'REVIEW_REQUIRED';reason='SIMULATED_'+event.type;
  }else if(event.type==='SOURCE_RESULT'){
    if(!['PENDING','REVIEW_REQUIRED'].includes(state.mode)||event.attemptId!==state.attemptId||event.feedbackReviewed!==true||!ident(event.runId)||!ident(event.evidenceRef)||!['SUCCESS','FAILURE'].includes(event.outcome))return deny('SOURCE_FEEDBACK_UNVERIFIED');
    if(event.outcome==='FAILURE'){
      // Explicit simulation policy, never an invented production retry interval.
      if(!Number.isSafeInteger(event.reviewDelayMs)||event.reviewDelayMs<=0||!time(event.now+event.reviewDelayMs))return deny('BACKOFF_POLICY_UNSPECIFIED');
      next={...next,mode:'SOURCE_BACKOFF',failures:state.failures+1,reviewNotBefore:event.now+event.reviewDelayMs};
    }else next={...next,mode:'READY',failures:0,reviewNotBefore:null};
    reason='SIMULATED_SOURCE_'+event.outcome;
  }else if(event.type==='REVIEW_RELEASE'){
    if(state.mode!=='SOURCE_BACKOFF'||event.now<state.reviewNotBefore||event.expectedStateHash!==digest(state)||!ident(event.reviewRef))return deny('REVIEW_RELEASE_NOT_BOUND_OR_TOO_EARLY');
    next={...next,mode:'READY',reviewNotBefore:null};reason='SIMULATED_REVIEW_RELEASE';
  }else return deny('EVENT_UNSUPPORTED');
  next=append(next,reason,event.now,event);
  return {dispatch:false,accepted:true,reason,state:next};
}
export function stateHash(state){if(!valid(state))throw Error('STATE_INVALID');return digest(state);}
