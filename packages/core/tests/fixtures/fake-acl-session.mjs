import fs from 'node:fs';import {createInterface} from 'node:readline';
const log=process.argv[2],mode=process.argv[3];fs.appendFileSync(log,JSON.stringify({kind:'start',pid:process.pid})+'\n');
const lines=createInterface({input:process.stdin});
lines.on('line',line=>{const r=JSON.parse(line);fs.appendFileSync(log,JSON.stringify({kind:'operation',...r})+'\n');
 if(r.path==='reject'){process.stderr.write('controlled rejection');process.exit(42);}
 if(r.path==='hang')return;
 if(r.path==='oversized'){process.stdout.write(' '.repeat(1024*1024)+JSON.stringify({sequence:r.sequence,ok:true})+'\n');return;}
 if(r.path==='mismatch'){process.stdout.write(JSON.stringify({sequence:r.sequence+1,ok:true})+'\n');return;}
 process.stdout.write(JSON.stringify({sequence:r.sequence,ok:true})+'\n');
});
if(mode==='hang-on-close')setInterval(()=>{},1000);
