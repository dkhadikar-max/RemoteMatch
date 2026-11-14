import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { PGlite } from '@electric-sql/pglite';

let passed=0,failed=0;
function assert(ok:boolean,label:string){if(ok){passed++;console.log('PASS '+label)}else{failed++;console.error('FAIL '+label)}}
const root=join(__dirname,'..'),dir=join(root,'supabase','migrations');
const files=readdirSync(dir).filter(f=>f.endsWith('.sql')).sort();
const read=(p:string)=>readFileSync(join(root,p),'utf8');
const migrationName='20261114200000_v2_p0_m4_event_writer_tripwire.sql';
const migration=read('supabase/migrations/'+migrationName),preflight=read('docs/v2-m4-event-writer-preflight.sql'),preflightBefore=read('docs/v2-m4-event-writer-preflight-before.sql');
const block=(s:string)=>{const i=s.indexOf('DO $m4$'),j=s.indexOf('$m4$;',i);return i<0||j<0?'':s.slice(i,j+5)};
const check=block(migration),beforeCheck=block(preflightBefore),m3=files.find(f=>f.includes('20261114190000_v2_p0_m3_idempotency_payload_binding'));
assert(files.includes(migrationName),'M4 tripwire exists');
assert(!!m3&&files.indexOf(migrationName)>files.indexOf(m3),'M4 sorts after the current M3 migration');
assert(check.length>1000&&block(preflight)===check,'postflight and tripwire contain the identical post-drop check block');
assert(beforeCheck.replace('v_post := false','v_post := true')===check,'preflight-before uses the same canonical check with explicit pre-drop mode');
assert(check.includes('v_post OR p.polname <> \'events_insert_own\''),'post-drop mode checks even if the legacy policy is recreated');
assert(check.includes('relforcerowsecurity')&&check.includes('pg_has_role'),'check enforces FORCE RLS and inherited policy membership');
assert(check.includes("v_post OR p.polname <> 'events_insert_own'")&&!check.includes('IF v_post THEN\n    IF EXISTS'),'preflight checks other client policies and INSERT grants before the legacy policy is dropped');
assert(!check.includes('current_user'),'read-only operator is not required to bypass RLS');
const writers=['record_application_feedback','update_application_notes','transition_application_status','set_application_archived','apply_to_employer_job','transition_employer_application'];
assert(writers.every(n=>check.includes('public.'+n+'(')),'all six known writer signatures are checked');
assert(/DROP POLICY IF EXISTS events_insert_own/.test(read('supabase/migrations/20261112190030_v2_p0_m3_event_writer_rls_and_fk_indexes.sql')),'the M3 policy drop is the guarded change');

async function main(){
 const db=new PGlite();
 const run=async(sql:string):Promise<string|null>=>{try{await db.exec(sql);return null}catch(e){return String((e as Error).message)}};
 const must=async(sql:string)=>{const e=await run(sql);if(e)throw new Error('setup/revert failed: '+e)};
 const sigs:[string,string,boolean][]=[
 ['record_application_feedback','text,text,text',true],['update_application_notes','text,text',true],
 ['transition_application_status','text,text,text,text',true],['set_application_archived','text,boolean',true],
 ['apply_to_employer_job','uuid,text',true],['transition_employer_application','uuid,uuid,uuid,text,text,text,text',false]
 ];
 const args=(types:string)=>types.split(',').map((t,i)=>'a'+i+' '+t).join(', ');
 const sig=(name:string)=>{const x=sigs.find(x=>x[0]===name)!;return 'public.'+name+'('+x[1]+')'};
 await must("CREATE ROLE authenticated NOLOGIN; CREATE ROLE anon NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS; CREATE ROLE owner_bypass NOLOGIN BYPASSRLS; CREATE ROLE owner_plain NOLOGIN; CREATE TABLE public.application_events(id serial primary key,application_id int,event_type text); ALTER TABLE public.application_events ENABLE ROW LEVEL SECURITY; ALTER TABLE public.application_events FORCE ROW LEVEL SECURITY; CREATE POLICY events_insert_own ON public.application_events FOR INSERT TO authenticated WITH CHECK(true); GRANT USAGE ON SCHEMA public TO authenticated,anon,service_role,owner_bypass,owner_plain; GRANT ALL ON public.application_events TO owner_bypass,owner_plain,service_role; GRANT USAGE ON SEQUENCE public.application_events_id_seq TO owner_bypass,owner_plain;");
 for(const [name,types,definer] of sigs){
  const security=definer?'SECURITY DEFINER SET search_path=public,pg_temp':'SECURITY INVOKER';
  await must('CREATE FUNCTION '+sig(name)+' RETURNS jsonb LANGUAGE plpgsql '+security+" AS $$ BEGIN RETURN '{}'::jsonb; END $$; ALTER FUNCTION "+sig(name)+" OWNER TO owner_bypass; REVOKE ALL ON FUNCTION "+sig(name)+" FROM PUBLIC; GRANT EXECUTE ON FUNCTION "+sig(name)+" TO "+(definer?'authenticated':'service_role')+";");
 }
 assert(await run(check)===null,'pre-drop schema passes when only the soon-to-be-dropped legacy policy exists');
 await must('CREATE POLICY unexpected_client_insert ON public.application_events FOR INSERT TO authenticated WITH CHECK(true);');
 const extraPolicyError=await run(beforeCheck);
 assert(!!extraPolicyError&&/client INSERT policy exists/.test(extraPolicyError),'preflight catches a second client INSERT policy before the legacy drop');
 await must('DROP POLICY unexpected_client_insert ON public.application_events; GRANT INSERT ON public.application_events TO authenticated;');
 const preGrantError=await run(beforeCheck);
 assert(!!preGrantError&&/authenticated still has INSERT/.test(preGrantError),'preflight catches a client INSERT grant before the legacy drop');
 await must('REVOKE INSERT ON public.application_events FROM authenticated;');
 await must('DROP FUNCTION '+sig('apply_to_employer_job')+'; DROP FUNCTION '+sig('set_application_archived')+';');
 assert(await run(beforeCheck)===null,'pre-drop check tolerates later writers not installed yet');
 await must("CREATE FUNCTION public.apply_to_employer_job(a0 uuid,a1 text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$ BEGIN RETURN '{}'::jsonb; END $$; ALTER FUNCTION "+sig('apply_to_employer_job')+" OWNER TO owner_bypass; REVOKE ALL ON FUNCTION "+sig('apply_to_employer_job')+" FROM PUBLIC; GRANT EXECUTE ON FUNCTION "+sig('apply_to_employer_job')+" TO authenticated; CREATE FUNCTION public.set_application_archived(a0 text,a1 boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$ BEGIN RETURN '{}'::jsonb; END $$; ALTER FUNCTION "+sig('set_application_archived')+" OWNER TO owner_bypass; REVOKE ALL ON FUNCTION "+sig('set_application_archived')+" FROM PUBLIC; GRANT EXECUTE ON FUNCTION "+sig('set_application_archived')+" TO authenticated;");
 await must('DROP POLICY events_insert_own ON public.application_events; REVOKE INSERT ON public.application_events FROM authenticated,anon;');
 assert(await run('BEGIN READ ONLY; '+check+' COMMIT;')===null,'post-drop check succeeds inside READ ONLY transaction');

 // Demonstrate the exact FORCE RLS dependency with real PostgreSQL roles and function owners.
 await must("CREATE FUNCTION public.demo_bypass() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$ BEGIN INSERT INTO public.application_events(application_id,event_type) VALUES(1,'valid'); END $$; CREATE FUNCTION public.demo_plain() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$ BEGIN INSERT INTO public.application_events(application_id,event_type) VALUES(2,'blocked'); END $$; ALTER FUNCTION public.demo_bypass() OWNER TO owner_bypass; ALTER FUNCTION public.demo_plain() OWNER TO owner_plain; GRANT EXECUTE ON FUNCTION public.demo_bypass(),public.demo_plain() TO authenticated;");
 await must('SET ROLE authenticated');
 const good=await run('SELECT public.demo_bypass()'),bad=await run('SELECT public.demo_plain()'),direct=await run("INSERT INTO public.application_events(application_id,event_type) VALUES(3,'forged')");
 await must('RESET ROLE');
 assert(good===null,'BYPASSRLS definer owner can write after policy drop');
 assert(!!bad&&/row-level security/i.test(bad),'non-BYPASSRLS definer owner is blocked by FORCE RLS');
 assert(!!direct&&/permission denied/i.test(direct),'client direct INSERT is denied');
 const rows=await db.query('SELECT count(*)::int AS n FROM public.application_events');
 assert(rows.rows[0].n===1,'only the trusted definer write landed');
 await must('DROP FUNCTION public.demo_bypass(); DROP FUNCTION public.demo_plain();');

 const expect=async(label:string,mutate:string,revert:string,pattern:RegExp)=>{
  await must(mutate);const e=await run(check);await must(revert);assert(!!e&&pattern.test(e),label);
 };
 await expect('detects definer owner without BYPASSRLS','ALTER FUNCTION '+sig('update_application_notes')+' OWNER TO owner_plain;','ALTER FUNCTION '+sig('update_application_notes')+' OWNER TO owner_bypass;',/update_application_notes.*does not bypass/);
 await expect('detects SECURITY INVOKER drift','ALTER FUNCTION '+sig('transition_application_status')+' SECURITY INVOKER;','ALTER FUNCTION '+sig('transition_application_status')+' SECURITY DEFINER;',/transition_application_status.*not SECURITY DEFINER/);
 await expect('detects missing writer','ALTER FUNCTION '+sig('update_application_notes')+' RENAME TO notes_missing;','ALTER FUNCTION public.notes_missing(text,text) RENAME TO update_application_notes;',/update_application_notes.*does not exist/);
 await expect('detects disabled RLS','ALTER TABLE public.application_events DISABLE ROW LEVEL SECURITY;','ALTER TABLE public.application_events ENABLE ROW LEVEL SECURITY;',/not enabled and forced/);
 await expect('detects unforced RLS','ALTER TABLE public.application_events NO FORCE ROW LEVEL SECURITY;','ALTER TABLE public.application_events FORCE ROW LEVEL SECURITY;',/not enabled and forced/);
 await expect('detects authenticated INSERT privilege','GRANT INSERT ON public.application_events TO authenticated;','REVOKE INSERT ON public.application_events FROM authenticated;',/authenticated still has INSERT/);
 await expect('detects anon INSERT privilege','GRANT INSERT ON public.application_events TO anon;','REVOKE INSERT ON public.application_events FROM anon;',/anon still has INSERT/);
 await expect('detects authenticated INSERT policy','CREATE POLICY client_insert ON public.application_events FOR INSERT TO authenticated WITH CHECK(true);','DROP POLICY client_insert ON public.application_events;',/client INSERT policy exists/);
 await expect('detects PUBLIC FOR ALL policy','CREATE POLICY public_all ON public.application_events FOR ALL TO PUBLIC USING(true) WITH CHECK(true);','DROP POLICY public_all ON public.application_events;',/client INSERT policy exists/);
 await must('CREATE ROLE client_parent NOLOGIN; GRANT client_parent TO authenticated;');
 await expect('detects inherited-role INSERT policy','CREATE POLICY parent_insert ON public.application_events FOR INSERT TO client_parent WITH CHECK(true);','DROP POLICY parent_insert ON public.application_events;',/inherited roles/);
 await expect('detects inherited INSERT privilege','GRANT INSERT ON public.application_events TO client_parent;','REVOKE INSERT ON public.application_events FROM client_parent;',/authenticated still has INSERT/);
 await must('REVOKE client_parent FROM authenticated; DROP ROLE client_parent;');
 await expect('detects service_role BYPASSRLS loss','ALTER ROLE service_role NOBYPASSRLS;','ALTER ROLE service_role BYPASSRLS;',/service_role.*does not bypass/);
 await expect('detects missing service_role EXECUTE','REVOKE EXECUTE ON FUNCTION '+sig('transition_employer_application')+' FROM service_role;','GRANT EXECUTE ON FUNCTION '+sig('transition_employer_application')+' TO service_role;',/not executable by service_role/);
 await expect('detects employer RPC client EXECUTE','GRANT EXECUTE ON FUNCTION '+sig('transition_employer_application')+' TO authenticated;','REVOKE EXECUTE ON FUNCTION '+sig('transition_employer_application')+' FROM authenticated;',/executable by a client role/);
 await must('CREATE POLICY service_only ON public.application_events FOR INSERT TO service_role WITH CHECK(true);');
 assert(await run(check)===null,'service_role-only policy is harmless');
 await must('DROP POLICY service_only ON public.application_events; CREATE POLICY select_only ON public.application_events FOR SELECT TO authenticated USING(true);');
 assert(await run(check)===null,'SELECT-only policy is harmless');
 console.log('M4 PGlite suite: '+passed+' passed, '+failed+' failed');
 process.exit(failed?1:0);
}
main().catch(e=>{console.error('M4 PGlite suite error',e);process.exit(1)});
