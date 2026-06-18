export class RateLimit{private last=0;constructor(private ms=500){}async wait(){const d=this.last+this.ms-Date.now();if(d>0)await new Promise(r=>setTimeout(r,d));this.last=Date.now()}}
