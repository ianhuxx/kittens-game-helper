import type{Env}from'../types';import{json}from'../lib/db';
export async function issuerDetail(env:Env,id:string){const issuer=await env.DB.prepare('select * from issuers where id=?').bind(id).first();return issuer?json({issuer}):json({error:'not found'},404)}
export async function issuerEvents(env:Env,id:string){return json({events:(await env.DB.prepare('select * from activism_events where issuer_id=? order by score desc').bind(id).all()).results})}
