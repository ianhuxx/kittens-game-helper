create index if not exists idx_filings_activist_date on filings(activist_id, filing_date desc);
create index if not exists idx_filings_form_date on filings(form_type, filing_date desc);
create index if not exists idx_filings_accession on filings(accession_number);
create index if not exists idx_events_score on activism_events(score desc);
create index if not exists idx_events_status on activism_events(status);
create index if not exists idx_events_type_campaign on activism_events(event_type,campaign_type);
create index if not exists idx_positions_issuer_date on positions(issuer_id, as_of_date desc);
create index if not exists idx_issuers_ticker on issuers(ticker);
