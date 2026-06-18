import type{Env,NormalizedFiling}from'../types';import{buildSecArchiveUrl,normalizeCik}from'./accession';
const forms=new Set(['SC 13D','SC 13D/A','SC 13G','SC 13G/A','13F-HR','13F-HR/A','DFAN14A','DEFA14A','DEFC14A','PREC14A','PRE 14A','DEF 14A','PX14A6G','SC TO-I','SC TO-T','SC 14D9','8-K']);
export function isRelevantForm(form:string):boolean{return forms.has((form||'').trim().toUpperCase())}
export function normalizeSubmissionsRecent(json:any):NormalizedFiling[]{const r=json?.filings?.recent;if(!r)return[];if(r.accessionNumber==null)return[];if(!Array.isArray(r.accessionNumber))throw new Error('Malformed SEC submissions recent arrays');return r.accessionNumber.map((a:string,i:number)=>({accessionNumber:a,form:r.form?.[i]||'',filingDate:r.filingDate?.[i],acceptanceDateTime:r.acceptanceDateTime?.[i],reportDate:r.reportDate?.[i],primaryDocument:r.primaryDocument?.[i]||'',primaryDocDescription:r.primaryDocDescription?.[i]||''}))}
let last=0;async function wait(){const now=Date.now(),delta=last+550-now;if(delta>0)await new Promise(r=>setTimeout(r,delta));last=Date.now()}
async function secFetch(url:string,env:Env){await wait();const email=env.SEC_USER_AGENT_EMAIL||'ianyibohuxx@gmail.com';for(let i=0;i<3;i++){const res=await fetch(url,{headers:{'User-Agent':`activist-cef-tracker/0.1 (${email})`,'Accept-Encoding':'gzip, deflate','Accept':'application/json,text/html,text/plain'}});if(res.ok)return res;if(res.status===429||res.status>=500){await new Promise(r=>setTimeout(r,500*(i+1)));continue}throw new Error(`SEC request failed ${res.status} ${url}`)}throw new Error(`SEC request failed after retries ${url}`)}
export async function secFetchJson(url:string,env:Env):Promise<any>{return(await secFetch(url,env)).json()}
export async function secFetchText(url:string,env:Env):Promise<string>{return(await secFetch(url,env)).text()}
export const FILERS=[{name:'Saba Capital Management, L.P.',slug:'saba',cik:'0001510281'},{name:'Bulldog Investors, LLP',slug:'bulldog',cik:'0001504304'}];
export function submissionsUrl(cik:string){return`https://data.sec.gov/submissions/CIK${normalizeCik(cik)}.json`}
export {buildSecArchiveUrl};
