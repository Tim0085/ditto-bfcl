import test from "node:test";
import assert from "node:assert/strict";
import { STAGES, createGraphs, graphManifest, graphFingerprint, MessageCursor, selectedMessages, legacyMessages, checkContext, checkSuccess } from "../src/ts/graphs.ts";
import { createBindings, cleanupOwners } from "../src/ts/bindings.ts";
import { taskGraphLimit } from "../src/ts/task-loop.ts";
test("T4 seven fixed DAGs, dependencies, synchronous validators and source fingerprint",()=>{
  const graphs=createGraphs();assert.equal(Object.keys(graphs).length,7);
  const expected={open:["init","load"],turn:["user"],missingTurn:["turn","user"],think:["select","sample","note"],action:["act","observe","note"],save:["save"],close:["release"]};
  for(const [id,steps] of Object.entries(STAGES)) {
    assert.deepEqual(steps.map(s=>s.id),expected[id as keyof typeof expected]);
    steps.forEach((s,i)=>{assert.deepEqual(s.dependencies,i?[steps[i-1].id]:[]);assert.notEqual(s.validateOutput.constructor.name,"AsyncFunction");});
  }
  assert.equal(graphFingerprint(),graphFingerprint());
  const changed={...STAGES,turn:[{...STAGES.turn[0],id:"User"}]};
  assert.notEqual(graphFingerprint(changed),graphFingerprint());
  const changedFunction={...STAGES,turn:[{...STAGES.turn[0],bind:()=>({a:1})}]};
  assert.notEqual(graphFingerprint(changedFunction),graphFingerprint());
  console.log(JSON.stringify({manifest:graphManifest(),fingerprint:graphFingerprint()}));
});
test("T4 cursor is immutable, duplicate text survives, tools use ingress and order restored",()=>{
  const cursor=new MessageCursor();const items=cursor.messages([{role:"system",content:"s"}]);
  cursor.nextTurn();items.push(...cursor.messages([{role:"user",content:"yes"},{role:"user",content:"yes"}]));
  const calls=[{id:"a",name:"toolA",arguments:{}},{id:"b",name:"toolB",arguments:{}}];
  items.push(...cursor.messages([{role:"assistant",content:"",metadata:{actionRequests:calls}}]));
  for(const call of calls)items.push(cursor.observation({callId:call.id,source:call.name,status:"success",message:{role:"tool",name:call.name,content:"obs"}},"a"));
  cursor.nextTurn();items.push(...cursor.messages([{role:"user",content:"next"}]));
  assert.throws(()=>Object.assign(cursor,{turn:9}));assert(Object.isFrozen(cursor));
  assert.equal(new Set(items.map(i=>i.id)).size,7);assert.deepEqual(items.map(i=>i.metadata.sequence),[0,1,2,3,4,5,6]);
  const reordered=selectedMessages({context:{items:[...items].reverse()},selectedItemIds:items.map(i=>i.id)},7);
  assert.deepEqual(reordered,legacyMessages(items));assert.equal(reordered.filter(m=>m.content==="yes").length,2);
  assert.deepEqual(reordered[5],{role:"tool",content:"obs",metadata:{actionRequestId:"b",name:"toolB"}});
  assert.throws(()=>selectedMessages({context:{items:items.slice(0,3)},selectedItemIds:items.slice(0,3).map(i=>i.id)},7),/丢失/);
  assert.throws(()=>checkContext({items:[items[0],items[0]]}),/重复/);
  console.log("7 distinct message IDs and sequences; two tool ingresses; reversed SELECT restored; deliberately selecting 3 of 7 rejected");
});
test("T4 bindings cover every stateful step and leave stateless nodes unbound",()=>{
  for(const group of ["Monolithic","Uniform","Targeted"] as const){
    const table=createBindings(group,group==="Monolithic"?{worker:"all"}:{context:"c",interaction:"a",memory:"m"});
    for(const g of graphManifest())for(const step of g.steps){
      if(group==="Monolithic")assert.equal(table[g.id][step.id],"all");
      else if(step.node.startsWith("CONTEXT."))assert.equal(table[g.id][step.id],"c");
      else if(step.node==="INTERACTION.ACT.TOOL")assert.equal(table[g.id][step.id],"a");
      else if(step.node.startsWith("MEMORY."))assert.equal(table[g.id][step.id],"m");
      else assert.equal(table[g.id][step.id],undefined);
    }
    assert.equal(Object.keys(table).length,7);assert.deepEqual(cleanupOwners(table),group==="Monolithic"?["all"]:["c","a","m"]);
    console.log(JSON.stringify({group,bindings:table,cleanupOwners:cleanupOwners(table)}));
  }
});
test("T4 Loop ceiling derived without imposing a new model tool-count limit",()=>{
  assert.equal(taskGraphLimit(4),429496729610);assert(taskGraphLimit(5)>100*(1+10001));
  for(const status of ["failed","timeout","cancelled",undefined])assert.throws(()=>checkSuccess({status}));
  assert.doesNotThrow(()=>checkSuccess({status:"success"}));
});
