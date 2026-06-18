import type{Env}from'../types';import{json}from'../lib/db';
export async function listActivists(env:Env){return json({activists:(await env.DB.prepare('select * from activists order by name').all()).results})}
export async function activistFilings(env:Env,slug:string){const r=await env.DB.prepare('select f.* from filings f join activists a on a.id=f.activist_id where a.slug=? order by filing_date desc').bind(slug).all();return json({filings:r.results})}
