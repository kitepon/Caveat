import * as childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:http';

const originalSpawn = childProcess.spawnSync;
const context = {
  schema: 'throughline.caveat_context.v1', status: 'ready', thinkingAvailable: false,
  turns: [1,2,3].map(turnNumber=>({originSessionId:'fixture',turnNumber,user:'Check npm installation',assistant:'The check completed',thinking:'',truncated:false})),
};
childProcess.default.spawnSync = (command,args,...rest)=> {
  const encoded = command==='pwsh.exe' && args?.includes('-EncodedCommand') ? Buffer.from(args.at(-1),'base64').toString('utf16le') : '';
  if (command==='throughline' || encoded.includes('throughline.cmd')) return {status:0,stdout:JSON.stringify(context),stderr:''};
  return originalSpawn(command,args,...rest);
};
syncBuiltinESMExports();
let called=false;
const server=createServer((req,res)=> {
  req.socket.unref();
  req.resume();
  req.on('end',()=> {
    called=true;
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({answers:{repeated_problem:{type:'noul',noul:0.1},clearly_stuck:{type:'noul',noul:0.1},search_term:{type:'choice',choice:'none',probabilities:{none:1},confidence:1}}}));
  });
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
server.unref();
const nativeFetch=globalThis.fetch;
globalThis.fetch = async (url,options)=> {
  if (url!=='https://api.typesafe.ai/v1/systemone') throw Error('unexpected_external_request');
  const response=await nativeFetch(`http://127.0.0.1:${server.address().port}/`,options);
  // Give each search option a valid zero probability, without an external API.
  const payload=JSON.parse(options.body);
  const body=await response.json();
  for (const name of Object.keys(payload.questions.search_term?.criteria||{})) body.answers.search_term.probabilities[name]=name==='none'?1:0;
  return new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});
};
process.once('beforeExit',()=> {
  if (called) process.stderr.write('hook-http-cleanup-drained\n');
});
