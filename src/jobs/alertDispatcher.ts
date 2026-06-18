import type{Env}from'../types';import{shouldAlert}from'../lib/classify';
export async function createAlertIfNeeded(env:Env,eventId:number,e:any){if(!shouldAlert(e))return false;await env.DB.prepare('insert or ignore into alerts(event_id,channel,status) values(?,?,?)').bind(eventId,'webhook','pending').run();return true}
