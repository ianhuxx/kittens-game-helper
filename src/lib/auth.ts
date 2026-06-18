import type{Env}from'../types';
export function isAuthed(req:Request,env:Env){const p=env.ADMIN_PASSWORD;if(!p)return true;const c=req.headers.get('cookie')||'', h=req.headers.get('authorization')||'';return c.includes(`act_auth=${p}`)||h===`Bearer ${p}`}
export function unauthorized(){return new Response('Unauthorized',{status:401})}
