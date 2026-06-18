export function normalizeCik(cik:string):string{const d=(cik||'').replace(/\D/g,'');return d.padStart(10,'0').slice(-10)}
export function cikNoLeadingZeros(cik:string):string{return String(Number(normalizeCik(cik)))}
export function accessionNoDashes(accession:string):string{return (accession||'').replace(/-/g,'')}
export function buildSecArchiveUrl(cik:string, accession:string, primaryDocument=''):string{return `https://www.sec.gov/Archives/edgar/data/${cikNoLeadingZeros(cik)}/${accessionNoDashes(accession)}/${primaryDocument||''}`}
