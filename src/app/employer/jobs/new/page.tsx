'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

const inputClass='soft-input w-full px-3 py-2.5 text-sm';
const initial={title:'',description:'',responsibilities:'',employmentType:'Full-time',remoteType:'Remote',location:'Worldwide',eligibleCountries:'',salaryMin:'',salaryMax:'',salaryCurrency:'USD',requiredSkills:'',preferredSkills:'',experienceRequirement:'',applicationUrl:''};

export default function NewEmployerJobPage(){
  const router=useRouter();
  const [companyId,setCompanyId]=useState(''); const [jobId,setJobId]=useState<string|null>(null);
  useEffect(()=>{ const query=new URLSearchParams(window.location.search); setCompanyId(query.get('companyId')||''); setJobId(query.get('jobId')); },[]);
  const [form,setForm]=useState(initial); const [companyStatus,setCompanyStatus]=useState(''); const [busy,setBusy]=useState(false); const [error,setError]=useState(''); const [message,setMessage]=useState('');
  const set=(k:keyof typeof initial,v:string)=>setForm(p=>({...p,[k]:v}));
  useEffect(()=>{
    if(!companyId)return;
    fetch('/api/employer/companies/'+companyId).then(async r=>{const d=await r.json();if(!r.ok)throw new Error(d.error||'Could not load company');setCompanyStatus(d.company.verification_status);}).catch(e=>setError(e.message));
    if(jobId)fetch('/api/employer/companies/'+companyId+'/jobs/'+jobId).then(async r=>{const d=await r.json();if(!r.ok)throw new Error(d.error||'Could not load draft');const j=d.job;setForm({title:j.title,description:j.description,responsibilities:j.responsibilities||'',employmentType:j.employment_type,remoteType:j.remote_type,location:j.location,eligibleCountries:(j.eligible_countries||[]).join(', '),salaryMin:j.salary_min==null?'':String(j.salary_min),salaryMax:j.salary_max==null?'':String(j.salary_max),salaryCurrency:j.salary_currency,requiredSkills:(j.required_skills||[]).join(', '),preferredSkills:(j.preferred_skills||[]).join(', '),experienceRequirement:j.experience_requirement||'',applicationUrl:j.application_url});}).catch(e=>setError(e.message));
  },[companyId,jobId]);
  const save=async()=>{
    setBusy(true);setError('');setMessage('');
    try{
      if(!companyId)throw new Error('Select a company before creating a vacancy.');
      const payload={...form,eligibleCountries:form.eligibleCountries.split(',').map(x=>x.trim()).filter(Boolean),salaryMin:form.salaryMin===''?null:Number(form.salaryMin),salaryMax:form.salaryMax===''?null:Number(form.salaryMax),requiredSkills:form.requiredSkills.split(',').map(x=>x.trim()).filter(Boolean),preferredSkills:form.preferredSkills.split(',').map(x=>x.trim()).filter(Boolean)};
      const res=await fetch(jobId?'/api/employer/companies/'+companyId+'/jobs/'+jobId:'/api/employer/companies/'+companyId+'/jobs',{method:jobId?'PATCH':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      const data=await res.json();if(!res.ok)throw new Error(data.error||'Could not save vacancy.');
      if(companyStatus==='verified'){
        const submit=await fetch('/api/employer/companies/'+companyId+'/jobs/'+data.job.id,{method:'POST'});const sd=await submit.json();if(!submit.ok)throw new Error(sd.error||'Draft saved but submission failed.');
        setMessage('Vacancy submitted for review. It will appear publicly only after approval.');
      }else{
        setMessage('Draft saved. Company verification is required before you can submit this vacancy for review.');
      }
      if(!jobId && data.job.id)router.replace('/employer/jobs/new?companyId='+companyId+'&jobId='+data.job.id);
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  };
  const field=(label:string,key:keyof typeof initial,placeholder='',type='text')=><label className="block space-y-1.5"><span className="text-sm font-medium text-[var(--ink)]">{label}</span><input className={inputClass} type={type} value={form[key]} placeholder={placeholder} onChange={e=>set(key,e.target.value)}/></label>;
  if(!companyId)return <div className="p-8 text-sm">Missing company. <Link className="text-[var(--red)]" href="/employer">Return to employer workspace</Link></div>;
  return <div className="mx-auto max-w-3xl px-4 py-10 space-y-6">
    <div><Link href="/employer" className="text-sm text-[var(--red)]">← Employer workspace</Link><h1 className="mt-3 text-2xl font-bold text-[var(--ink)]">{jobId?'Edit job draft':'Create a job vacancy'}</h1><p className="text-sm text-[var(--muted)]">Provide accurate role details. RemoteMatch reviews each vacancy before publication.</p></div>
    {companyStatus!=='verified'&&<p className="rounded-xl border border-[var(--line)] p-3 text-sm text-[var(--muted)]">Company verification status: {companyStatus||'loading'}. You can save this vacancy as a draft now; submission is enabled after company verification.</p>}
    <div className="soft-card border border-[var(--line)] p-5 space-y-4">
      {field('Job title *','title','Senior Product Designer')}
      <label className="block space-y-1.5"><span className="text-sm font-medium text-[var(--ink)]">Job description *</span><textarea className={inputClass} rows={7} value={form.description} onChange={e=>set('description',e.target.value)} placeholder="Describe the role, team and expected outcomes."/></label>
      <label className="block space-y-1.5"><span className="text-sm font-medium text-[var(--ink)]">Responsibilities</span><textarea className={inputClass} rows={4} value={form.responsibilities} onChange={e=>set('responsibilities',e.target.value)}/></label>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block space-y-1.5"><span className="text-sm font-medium text-[var(--ink)]">Employment type</span><select className={inputClass} value={form.employmentType} onChange={e=>set('employmentType',e.target.value)}>{['Full-time','Part-time','Contract','Temporary','Internship'].map(x=><option key={x}>{x}</option>)}</select></label>
        <label className="block space-y-1.5"><span className="text-sm font-medium text-[var(--ink)]">Work arrangement</span><select className={inputClass} value={form.remoteType} onChange={e=>set('remoteType',e.target.value)}>{['Remote','Hybrid','On-site'].map(x=><option key={x}>{x}</option>)}</select></label>
      </div>
      {field('Location / eligible region *','location','Worldwide or city, country')}
      {field('Eligible countries (comma-separated)','eligibleCountries','India, Singapore, Worldwide')}
      <div className="grid gap-4 sm:grid-cols-3">{field('Minimum salary','salaryMin','e.g. 60000','number')}{field('Maximum salary','salaryMax','e.g. 90000','number')}{field('Currency (ISO code)','salaryCurrency','USD')}</div>
      {field('Required skills (comma-separated)','requiredSkills','Product strategy, Figma, UX')}
      {field('Preferred skills (comma-separated)','preferredSkills','SQL, analytics')}
      {field('Experience requirement','experienceRequirement','5+ years')}
      {field('Application URL *','applicationUrl','https://company.com/careers/role','url')}
      {error&&<p className="text-sm text-[var(--danger)]">{error}</p>}
      {message&&<p className="text-sm text-[var(--muted)]">{message}</p>}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--line)] pt-4"><Link href="/employer" className="text-sm text-[var(--muted)]">Cancel</Link><button disabled={busy} onClick={save} className="soft-button primary">{busy?'Saving…':companyStatus==='verified'?'Save and submit for review':'Save draft'}</button></div>
    </div>
  </div>;
}
