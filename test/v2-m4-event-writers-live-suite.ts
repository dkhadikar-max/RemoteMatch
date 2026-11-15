import { adminClient, anonKeyClient, hasRequiredEnv, newVerifiedSession, type TestSession } from './helpers/verified-session';
const APPROVED_REF='xyahktsgdigutxartafb',BASE_URL=process.env.TEST_BASE_URL??'',OPPORTUNITY='opp-curated-curated-001';
let passed=0,failed=0;
function assert(ok:boolean,label:string){if(ok){passed++;console.log('PASS '+label)}else{failed++;console.error('FAIL '+label)}}
function refuse(reason:string):never{console.error('REFUSING TO RUN: '+reason);process.exit(1)}
function request(token:string,path:string,body:unknown,method='POST'){
 return fetch(BASE_URL+path,{method,headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(body)});
}
async function appFor(userId:string){
 const {data,error}=await adminClient().from('applications').select('id,status,notes').eq('profile_id',userId).eq('opportunity_id',OPPORTUNITY).maybeSingle();
 if(error)throw new Error('application read failed: '+error.message);
 if(!data)throw new Error('test application missing for '+userId);
 return data as {id:string;status:string;notes:string|null};
}
async function eventsFor(id:string){
 const {data,error}=await adminClient().from('application_events').select('event_type,event_payload').eq('application_id',id);
 if(error)throw new Error('event read failed: '+error.message);
 return data??[];
}
async function createApp(created:TestSession[]){
 const session=await newVerifiedSession();created.push(session);
 const response=await request(session.token,'/api/opportunities/swipe',{opportunityId:OPPORTUNITY,action:'interested'});
 if(!response.ok)throw new Error('test application creation failed: '+response.status+' '+await response.text());
 return session;
}
async function main(){
 if(!hasRequiredEnv())refuse('Supabase environment is incomplete');
 const host=(()=>{try{return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL??'').hostname.split('.')[0]}catch{return ''}})();
 if(host!==APPROVED_REF)refuse('unexpected Supabase project '+(host||'unknown'));
 if(!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE_URL))refuse('TEST_BASE_URL must be a local HTTP server');
 const created:TestSession[]=[],applicationIds:string[]=[];
 try{
  const a=await createApp(created),appA=await appFor(a.userId);applicationIds.push(appA.id);
  let before=(await eventsFor(appA.id)).length;
  let response=await request(a.token,'/api/applications/notes',{opportunityId:OPPORTUNITY,notes:'follow up Friday'},'PATCH');
  assert(response.status===200,'notes route succeeds');
  let events=await eventsFor(appA.id);
  assert(events.length===before+1&&events.some(e=>e.event_type==='note_added'),'notes writer records note_added');
  assert((await appFor(a.userId)).notes==='follow up Friday','notes value persists');

  response=await request(a.token,'/api/applications/feedback',{opportunityId:OPPORTUNITY,didApply:'applied',notes:'applied externally'});
  assert(response.status===200,'feedback route succeeds');
  events=await eventsFor(appA.id);
  assert(events.some(e=>e.event_type==='feedback_submitted'),'feedback writer records feedback_submitted');
  assert(events.some(e=>e.event_type==='status_changed'&&(e.event_payload as any)?.toStatus==='applied'),'feedback writer records status_changed');

  response=await request(a.token,'/api/applications/status',{opportunityId:OPPORTUNITY,expectedStatus:'applied',status:'interview'},'PATCH');
  assert(response.status===200,'status route succeeds');
  events=await eventsFor(appA.id);
  assert(events.some(e=>e.event_type==='status_changed'&&(e.event_payload as any)?.toStatus==='interview'),'status writer records interview transition');

  before=(await eventsFor(appA.id)).length;
  const forged={application_id:appA.id,event_type:'note_added',event_payload:{forged:true}};
  const signed=await a.client.from('application_events').insert(forged);
  const anon=await anonKeyClient().from('application_events').insert(forged);
  assert(!!signed.error,'authenticated direct INSERT is rejected');
  assert(!!anon.error,'anon direct INSERT is rejected');
  assert((await eventsFor(appA.id)).length===before,'direct INSERT attempts leave no event');

  const b=await createApp(created),appB=await appFor(b.userId);applicationIds.push(appB.id);
  const aBefore=await appFor(a.userId),aEventsBefore=await eventsFor(appA.id);
  response=await request(b.token,'/api/applications/notes',{opportunityId:OPPORTUNITY,notes:'belongs only to B'},'PATCH');
  assert(response.status===200,'second user can update their own application for same opportunity');
  const aAfter=await appFor(a.userId),aEventsAfter=await eventsFor(appA.id),bAfter=await appFor(b.userId);
  assert(bAfter.notes==='belongs only to B','second user note is scoped to their own application');
  assert(aAfter.notes===aBefore.notes&&aAfter.status===aBefore.status,'second user cannot mutate first user application');
  assert(aEventsAfter.length===aEventsBefore.length,'second user cannot append events to first user application');
 }finally{
  const admin=adminClient(),cleanupErrors:string[]=[];
  for(const session of created){const {error}=await admin.auth.admin.deleteUser(session.userId);if(error)cleanupErrors.push(error.message)}
  const ids=created.map(s=>s.userId);
  const profiles=ids.length?await admin.from('profiles').select('id',{count:'exact',head:true}).in('id',ids):{count:0,error:null};
  const apps=ids.length?await admin.from('applications').select('id',{count:'exact',head:true}).in('profile_id',ids):{count:0,error:null};
  const events=applicationIds.length?await admin.from('application_events').select('id',{count:'exact',head:true}).in('application_id',applicationIds):{count:0,error:null};
  if(profiles.error)cleanupErrors.push(profiles.error.message);
  if(apps.error)cleanupErrors.push(apps.error.message);
  if(events.error)cleanupErrors.push(events.error.message);
  assert(cleanupErrors.length===0&&(profiles.count??0)===0&&(apps.count??0)===0&&(events.count??0)===0,'cleanup verified; errors='+cleanupErrors.length);
  cleanupErrors.forEach(e=>console.error('CLEANUP ERROR '+e));
 }
 console.log('M4 live suite: '+passed+' passed, '+failed+' failed');
 process.exit(failed?1:0);
}
main().catch(e=>{console.error('M4 live suite error',e);process.exit(1)});
