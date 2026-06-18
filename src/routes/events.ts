import type{Env}from'../types';import{json}from'../lib/db';import{isAuthed,unauthorized}from'../lib/auth';
export async function highScore(env:Env){const r=await env.DB.prepare('select * from activism_events where score>=60 order by score desc').all();return json({events:r.results})}
export async function markReviewed(req:Request,env:Env,id:string){if(!isAuthed(req,env))return unauthorized();const r=await env.DB.prepare("update activism_events set status='reviewed',reviewed_at=current_timestamp where id=?").bind(id).run();return r.meta.changes?json({ok:true}):json({error:'not found'},404)}
