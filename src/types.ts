export interface Env { DB: D1Database; FILINGS_BUCKET: R2Bucket; CONFIG_KV: KVNamespace; PARSE_QUEUE: Queue; ASSETS?: Fetcher; ADMIN_PASSWORD?: string; ALERT_WEBHOOK_URL?: string; SEC_USER_AGENT_EMAIL?: string }
export type CampaignType='tender'|'liquidation'|'open_end'|'board'|'discount'|'settlement'|'governance'|'portfolio_update'|'passive'|'unknown';
export type EventType='new_stake'|'increase'|'decrease'|'proxy'|'tender_offer'|'settlement'|'letter'|'quarterly_portfolio'|'passive_position'|'other';
export interface NormalizedFiling { accessionNumber:string; form:string; filingDate?:string; acceptanceDateTime?:string; reportDate?:string; primaryDocument?:string; primaryDocDescription?:string; }
export interface ParsedFiling { issuerName?:string; issuerCik?:string; titleOfClass?:string; cusip?:string; shares?:number; percentOwned?:number|null; priorPercentOwned?:number|null; positionChangePct?:number|null; item3Text?:string; item4Text?:string; item5Text?:string; item6Text?:string; item7Text?:string; }
export interface ClassificationInput { formType:string; text:string; percentOwned?:number|null; priorPercentOwned?:number|null; activistSlug?:string; issuerId?:number|null }
export interface Classification { event_type:EventType; campaign_type:CampaignType; summary:string; demands:string[] }
export interface ScoreInput extends ClassificationInput { event_type:EventType; campaign_type:CampaignType; hasIssuer?:boolean }
