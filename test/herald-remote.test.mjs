import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatchRemoteRequest, startRemoteHeraldSession } from '../src/herald/remote-session.mjs';

const deviceId = `phone_${'a'.repeat(16)}`;
const context = { project:{id:'project-1',name:'Demo',path:'E:\\secret'},session:{id:'session-1',name:'Build'},agent:{id:'maestro',name:'Maestro'},guard:{state:'unknown'},outputs:[],approvals:[],voice:{available:false} };

test('remote dispatcher is closed, sanitized, and preserves explicit confirmation', async () => {
  const instructions=[];
  const bridge={isAvailable:async()=>true,getSessionContext:async()=>context,submitInstruction:async value=>(instructions.push(value),{accepted:true,state:'queued',message:'Queued'}),decideApproval:async()=>({accepted:true})};
  let result=await dispatchRemoteRequest({v:1,product:'helmian-herald',kind:'request',requestId:'r1',deviceId,action:'session.read',payload:{}},bridge);
  assert.equal(result.state,'ok'); assert.equal(JSON.stringify(result).includes('secret'),false);
  result=await dispatchRemoteRequest({v:1,product:'helmian-herald',kind:'request',requestId:'r2',deviceId,action:'instruction.submit',payload:{projectId:'project-1',sessionId:'session-1',text:'Continue.',confirmed:true}},bridge);
  assert.equal(result.state,'ok'); assert.equal(instructions[0].confirmed,true);
  result=await dispatchRemoteRequest({v:1,product:'helmian-herald',kind:'request',requestId:'r3',deviceId,action:'shell.exec',payload:{}},bridge);
  assert.equal(result.state,'refused');
});

test('desktop opens outbound session, polls, answers, and stops without a listener', async () => {
  const calls=[]; let scheduled;
  const fetchImpl=async(url,options={})=>{calls.push({url:String(url),method:options.method??'GET',body:options.body&&JSON.parse(options.body)});const n=calls.length;
    const body=n===1?{channel:`herald_${'c'.repeat(24)}`,desktopToken:'d'.repeat(43),pairingCode:'12345678',phoneUrl:'https://helmian.test/herald',pairingExpiresAt:'soon',expiresAt:'later'}:
      n===2?{messages:[{id:1,body:{v:1,product:'helmian-herald',kind:'request',requestId:'read-1',deviceId,action:'session.read',payload:{}}}],cursor:1,devices:[]}:{accepted:true};
    return {ok:true,status:200,json:async()=>body};};
  const remote=await startRemoteHeraldSession({origin:'https://helmian.test',ownerSecret:'o'.repeat(40),desktopBridge:{isAvailable:async()=>true,getSessionContext:async()=>context},fetchImpl,setTimer:fn=>(scheduled=fn,1),clearTimer:()=>{}});
  await scheduled();
  assert.equal(calls[0].body.action,'start'); assert.equal(calls[1].method,'GET'); assert.equal(calls[2].body.result.state,'ok');
  await remote.stop(); assert.equal(calls.at(-1).method,'DELETE');
});
