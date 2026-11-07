import { expect, test } from "bun:test";
import { compileModule } from "svelte/compiler";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("pending lookup preserves identity and accepted results are monotonic", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grove-outgoing-"));
  try {
    const sourcePath = import.meta.dir + "/../src/outgoing.svelte.ts";
    const source = new Bun.Transpiler({ loader: "ts" })
      .transformSync(readFileSync(sourcePath, "utf8"))
      .replace(
        '"./image-drafts"',
        JSON.stringify(import.meta.dir + "/../src/image-drafts.ts"),
      )
      .replace(
        '"./chord-contract"',
        JSON.stringify(import.meta.dir + "/../src/chord-contract.ts"),
      )
      .replace('"./api"', JSON.stringify(import.meta.dir + "/../src/api.ts"));
    const compiled = compileModule(source, {
      filename: sourcePath,
      generate: "client",
    })
      .js.code.replaceAll(
        'from "zod"',
        `from ${JSON.stringify(import.meta.resolve("zod"))}`,
      )
      .replaceAll(
        '"svelte/internal/client"',
        JSON.stringify(import.meta.resolve("svelte/internal/client")),
      );
    writeFileSync(
      join(directory, "outgoing.mjs"),
      compiled.replaceAll(
        "'svelte/internal/client'",
        JSON.stringify(import.meta.resolve("svelte/internal/client")),
      ),
    );
    writeFileSync(
      join(directory, "check.ts"),
      `
      import { strict as assert } from "node:assert";
      const records = new Map();
      let rejectAccepted = false, rejectAll = false;
      const prefix = "flickgrove/http://fixture.invalid/outgoing/peer%3Aorc/";
      const images = [{id:"a".repeat(64),name:"kept.png",width:8,height:8,bytes:80,mediaType:"image/png"}];
      for (const [id,status] of [["held","sending"],["unknown","uncertain"],["confirmed","sent"],["refused","failed"]])
        records.set(prefix+id,JSON.stringify({agentId:"peer:orc",id,text:"kept "+id,at:123,status,images,localImageIds:["local-image"],answers:[{questionId:"original",answer:"kept answer"}]}));
      Object.assign(globalThis, {location: {origin: "http://fixture.invalid"}, window: {addEventListener() {}}, localStorage: new Proxy({
        getItem: key => records.get(key) ?? null, setItem: (key, value) => {
          if(rejectAll || (rejectAccepted && key.includes('/accepted/')))throw new DOMException('full','QuotaExceededError');
          records.set(key, value);
        }, removeItem: key => records.delete(key)
      }, {ownKeys:()=>[...records.keys()],getOwnPropertyDescriptor:()=>({enumerable:true,configurable:true})})});
      const {addOutgoing, acceptReceipt, observeOutgoing, outgoing, receiptAlreadyAccepted, withOutgoing, submissionResult, deleteRejectedOutgoing, forgetLegacyPending, setOutgoingImages} = await import("./outgoing.mjs");
      assert.deepEqual(outgoing.entries.map(o=>[o.id,o.status]),[["held","pending"],["unknown","pending"],["confirmed","accepted"],["refused","rejected"]]);
      assert.equal(JSON.stringify(outgoing.entries[0].images),JSON.stringify(images));
      assert.equal(JSON.stringify(outgoing.entries[0].answers),JSON.stringify([{questionId:"original",answer:"kept answer"}]));
      assert.equal(JSON.stringify(outgoing.entries[0].localImageIds),JSON.stringify(["local-image"]));
      assert.equal(outgoing.entries[0].at,123);
      rejectAll = true;
      assert.throws(()=>forgetLegacyPending("peer:orc", "held"), /full/);
      assert.equal(records.has(prefix+"held"),true);
      assert.equal(outgoing.entries.some(o=>o.id==="held"),true);
      rejectAll = false;
      // Local dismissal hides only this device's unresolved presentation.
      forgetLegacyPending("peer:orc", "unknown");
      assert.equal(records.has(prefix+"unknown"), false);
      assert.equal(outgoing.entries.some(o=>o.id==="unknown"), false);
      const serverPending = {id:"unknown",status:"uncertain",source:"question",questionIds:["original"],text:"server input",at:123};
      const stillUncertain = withOutgoing({id:"peer:orc",messages:[],questions:[{id:"original",state:"unanswered"}],deliveries:[serverPending]});
      assert.equal(stillUncertain.deliveries.some(d=>d.id==="unknown"),false);
      assert.equal(stillUncertain.messages.some(m=>m.id==="unknown"),false);
      assert.equal(stillUncertain.questions[0].state,"unanswered");
      const reloaded = await import("./outgoing.mjs?reload");
      assert.equal(reloaded.hasDismissedAnswer("peer:orc",["original"]),true);
      assert.equal(reloaded.hasDismissedAnswer("peer:orc",["different"]),false);
      assert.equal(reloaded.hasDismissedAnswer("other:orc",["original"]),false);
      reloaded.acceptReceipt("peer:orc",null);
      assert.equal(reloaded.hasDismissedAnswer("peer:orc",["original"]),true);
      assert.equal(reloaded.withOutgoing({id:"peer:orc",messages:[],questions:[],deliveries:[serverPending]}).deliveries.some(d=>d.id==="unknown"),false);
      assert.equal(reloaded.withOutgoing({id:"other:orc",messages:[],questions:[],deliveries:[serverPending]}).deliveries.some(d=>d.id==="unknown"),true);
      const later = reloaded.withOutgoing({id:"peer:orc",messages:[{id:"native-item",clientId:"unknown",role:"user",text:"confirmed"}],questions:[],deliveries:[{...serverPending,status:"sent"}]});
      assert.equal(later.messages.find(m=>m.clientId==="unknown").text,"confirmed");
      assert.equal(later.deliveries.find(d=>d.id==="unknown").status,"sent");
      assert.equal(reloaded.withOutgoing({id:"peer:orc",messages:[],questions:[],deliveries:[{...serverPending,status:"failed"}]}).deliveries.find(d=>d.id==="unknown").status,"failed");
      reloaded.acceptReceipt("peer:orc",{operationId:"unknown",state:"rejected",turnId:null,error:"confirmed rejection"});
      assert.equal(reloaded.hasDismissedAnswer("peer:orc",["original"]),false);
      const maybeAccepted = {agentId:"peer:orc",id:"maybe-accepted",text:"answer",at:123,status:"uncertain",answers:[{questionId:"accepted-question",answer:"answer"}]};
      records.set(prefix+maybeAccepted.id,JSON.stringify(maybeAccepted));
      reloaded.outgoing.entries.push({...maybeAccepted,status:"pending"});
      reloaded.forgetLegacyPending("peer:orc",maybeAccepted.id);
      reloaded.acceptReceipt("peer:orc",{operationId:maybeAccepted.id,state:"accepted",turnId:null,error:null});
      assert.equal(reloaded.hasDismissedAnswer("peer:orc",["accepted-question"]),true);
      reloaded.acceptReceipt("peer:orc",{operationId:maybeAccepted.id,state:"rejected",turnId:null,error:"late conflict"});
      assert.equal(reloaded.hasDismissedAnswer("peer:orc",["accepted-question"]),true);
      assert.throws(()=>forgetLegacyPending("peer:orc", "confirmed"), /no longer awaiting/);
      assert.throws(()=>forgetLegacyPending("peer:orc", "refused"), /no longer awaiting/);
      const newRecord = {agentId:"peer:orc",id:"new",text:"new input",at:123,status:"sending",admissionVersion:1};
      records.set(prefix+"new",JSON.stringify(newRecord));
      outgoing.entries.push({...newRecord,status:"pending"});
      assert.throws(()=>forgetLegacyPending("peer:orc", "new"), /no longer awaiting/);
      assert.equal(records.has(prefix+"new"),true);
      outgoing.entries = [];
      records.clear();
      const failed = {id:"recovered",status:"failed",source:"user",text:"original",at:123,questionIds:[]};
      const owner = {id:"peer:orc",messages:[],questions:[],deliveries:[failed]};
      addOutgoing(owner.id,failed.text,failed.id);
      acceptReceipt(owner.id,{operationId:failed.id,state:"rejected",turnId:null,error:"refused"});
      acceptReceipt(owner.id,null);
      deleteRejectedOutgoing(owner.id,failed.id);
      assert.equal(records.has(prefix+failed.id),false);
      assert.equal(outgoing.entries.length,0);
      assert.equal(withOutgoing({...owner,deliveries:[]}).messages.length,0);
      addOutgoing(owner.id,"pending","pending");
      assert.throws(()=>deleteRejectedOutgoing(owner.id,"pending"), /Only a rejected/);
      acceptReceipt(owner.id,{operationId:"pending",state:"accepted",turnId:"turn",error:null});
      assert.throws(()=>deleteRejectedOutgoing(owner.id,"pending"), /Accepted/);
      outgoing.entries=[];
      // No device-owned operation exists: owner observations still confirm its identity.
      for (const source of ["user", "question"]) {
        const id = "server-" + source;
        const delivery = {id,status:"sent",source,text:"server content",at:123,questionIds:source === "question" ? ["q"] : [],...(source === "question" ? {answers:[{questionId:"q",answer:"confirmed answer"}]} : {})};
        observeOutgoing({id:"peer:orc",messages:[{id,role:"user",text:delivery.text,at:123}],deliveries:[delivery]});
        assert.equal(receiptAlreadyAccepted("peer:orc",id),true);
        assert.equal(outgoing.entries.length,0);
        acceptReceipt("peer:orc",null);
        acceptReceipt("peer:orc",{operationId:id,state:"rejected",turnId:null,error:"late failure"});
        const late = withOutgoing({id:"peer:orc",messages:[],questions:[{id:"q",state:"unanswered"}],deliveries:[{...delivery,status:"uncertain",error:"late unknown"}]});
        assert.equal(submissionResult(late.deliveries[0]),"accepted");
        assert.equal(late.deliveries[0].error,undefined);
        assert.equal(late.deliveries[0].source,source);
        assert.equal(late.messages.length,0);
        if(source === "question") {
          assert.equal(late.questions[0].state,"answered");
          assert.equal(late.questions[0].answer,"confirmed answer");
        }
      }
      // A matching observed user message is confirmation even beside a stale delivery.
      observeOutgoing({id:"peer:orc",messages:[{id:"seen-user",role:"user"}],deliveries:[{id:"seen-user",status:"uncertain",source:"user"}]});
      assert.equal(receiptAlreadyAccepted("peer:orc","seen-user"),true);
      // Saved sent is authoritative without a local journal or visible message.
      observeOutgoing({id:"peer:orc",messages:[],deliveries:[{id:"sent-only",status:"sent",source:"user"}]});
      assert.equal(receiptAlreadyAccepted("peer:orc","sent-only"),true);
      observeOutgoing({id:"peer:orc",messages:[{id:"assistant",role:"assistant"},{id:"history",role:"user"}],deliveries:[{id:"assistant",status:"sending",source:"user"}]});
      assert.equal(receiptAlreadyAccepted("peer:orc","assistant"),false);
      assert.equal(receiptAlreadyAccepted("peer:orc","history"),false);
      assert.equal(receiptAlreadyAccepted("other:orc","server-user"),false);
      addOutgoing("peer:orc", "draft", "op");
      assert.throws(()=>addOutgoing("peer:orc","changed","op"),/bound/);
      acceptReceipt("peer:orc", null);
      assert.equal(outgoing.entries[0].status, "pending");
      const detail = status => ({id: "peer:orc", messages: [], deliveries: [{id: "op", status}]});
      observeOutgoing(detail("uncertain"));
      assert.equal(outgoing.entries[0].status, "pending");
      observeOutgoing(detail("queued"));
      assert.equal(outgoing.entries[0].status, "pending");
      observeOutgoing(detail("sent"));
      assert.equal(outgoing.entries.length, 0);
      assert.equal(receiptAlreadyAccepted('peer:orc','op'),true);
      assert.equal(records.has(prefix+'op'),false);
      acceptReceipt("peer:orc", null);
      observeOutgoing(detail("queued"));
      observeOutgoing(detail("uncertain"));
      acceptReceipt('peer:orc',{operationId:'op',state:'rejected',turnId:null,error:'late'});
      assert.equal(outgoing.entries.length, 0);
      observeOutgoing({id:'peer:orc',messages:[{id:'op',role:'user'}],deliveries:[]});
      assert.equal(outgoing.entries.length,0);
      const stale = withOutgoing({id:'peer:orc',messages:[],questions:[],deliveries:[{id:'op',status:'uncertain',source:'user',text:'draft',at:1,questionIds:[]}]});
      assert.equal(stale.deliveries[0].status,'sent');
      assert.equal(stale.messages.length,0);
      assert.equal(receiptAlreadyAccepted('peer:orc','op'),true);
      acceptReceipt('peer:orc',{operationId:'op',state:'rejected',turnId:null,error:'late'});
      assert.equal(outgoing.entries.length,0);
      addOutgoing('peer:orc','second','second');
      observeOutgoing({id:'peer:orc',messages:[],deliveries:[{id:'second',status:'sent'}]});

      assert.equal(outgoing.entries.length, 0);
      const mutableImages = structuredClone(images);
      addOutgoing("peer:orc","image","image",undefined,mutableImages,["local-image"]);
      mutableImages[0].name = "changed outside";
      assert.equal(outgoing.entries.find(o=>o.id==="image").images[0].name,"kept.png");
      assert.throws(()=>addOutgoing("peer:orc","image","image",undefined,[...mutableImages],["local-image"]),/bound/);
      // A full device can retain the owner-confirmed result in this page without
      // pretending that a new unjournalled submission was saved successfully.
      rejectAccepted = true;
      addOutgoing('peer:orc','quota confirmation','quota-confirmed');
      observeOutgoing({id:'peer:orc',messages:[{id:'quota-confirmed',role:'user'}],deliveries:[]});
      assert.equal(receiptAlreadyAccepted('peer:orc','quota-confirmed'),true);
      assert.equal(outgoing.entries.some(o=>o.id==='quota-confirmed'),false);
      assert.equal(localStorage.getItem('flickgrove/http://fixture.invalid/accepted/peer%3Aorc/quota-confirmed'),null);
      addOutgoing('peer:orc','durable image','quota-image',undefined,undefined,['local-image']);
      rejectAll = true;
      assert.throws(()=>setOutgoingImages('peer:orc','quota-image',images),/full/);
      assert.equal(outgoing.entries.find(o=>o.id==='quota-image').images,undefined);
      assert.equal(JSON.parse(records.get(prefix+'quota-image')).images,undefined);
      assert.throws(()=>addOutgoing('peer:orc','must journal first','quota-new'),/full/);
      assert.equal(outgoing.entries.some(o=>o.id==='quota-new'),false);
    `,
    );
    const child = Bun.spawn([process.execPath, join(directory, "check.ts")], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const error = await new Response(child.stderr).text();
    expect(await child.exited, error).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
