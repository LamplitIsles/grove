<script lang="ts">
  import { addOutgoing, unknownOutgoing } from "./outgoing.svelte";
  import { navigation, setSurface } from "./navigation.svelte";
  import { Button } from '$lib/components/ui/button/index.js';
  import { Textarea } from '$lib/components/ui/textarea/index.js';
  import { Plus, MessagesSquare, Hammer, Bug, ClipboardCheck, RotateCcw, Telescope, X, ArrowUp, Square, Sparkles, ListPlus } from '@lucide/svelte';
  import { storagePrefix, readingCache, connection, reserveSubmission } from './api';
  import { Mic, LoaderCircle } from '@lucide/svelte';
  import { canCaptureVoice, VoiceRecordingController, type VoiceRecordingStatus } from './voice-input';
  import { imagePreview, loadImages, saveImages, draftKey, operationKey, intakeError, IMAGE_ACCEPT, type ImageDraft } from './image-drafts';
  import { onMount, tick, untrack } from 'svelte';
  import type { Delivery, Skill } from './contracts';
  import SkillSearch from './SkillSearch.svelte';
  import * as m from './paraglide/messages';
  let { agentId, project, centralSkills = false, skills, connected, suspended = false, working = false, stopping = false, followUps = [], paused = false, queueReady = false, onenqueue, oncheckqueue, onqueueaction, onstop, onsend, onbeginSend, onpositionSent }: { agentId: string; project: string; centralSkills?: boolean; skills: Skill[]; connected: boolean; suspended?: boolean; working?: boolean; stopping?: boolean; followUps?: Delivery[]; paused?: boolean; queueReady?: boolean; onenqueue: (id:string,text:string,operationId:string,images:ImageDraft[]) => Promise<{status:"accepted" | "rejected" | "unknown";error?:string}>; oncheckqueue: (id:string,operationId:string) => Promise<Delivery | null>; onqueueaction: (id:string,member:"cancelFollowUp" | "resumeFollowUps",operationId?:string) => Promise<void>; onstop?: () => Promise<boolean>; onsend: (agentId: string, text: string, requestId: string, images?: ImageDraft[]) => Promise<boolean>; onbeginSend?: () => number | undefined; onpositionSent?: (operation: string, generation: number) => void } = $props();
  let draftReadable = true;
  function readDraft(fallback = '') {
    try { return localStorage.getItem(`${storagePrefix}/composer/${agentId}`) ?? ''; }
    catch { draftReadable = false; return fallback; }
  }
  let text = $state(untrack(() => readDraft()));
  let input = $state<HTMLTextAreaElement | null>(null);
  let composing = false;
  let images = $state<ImageDraft[]>([]); let previews = $state<string[]>([]); let imageError=$state(""); let preparing=$state(false); let ready=$state(false); let imageStorage=$state(true); let picker: HTMLInputElement; let active=true;
  // Image intake may run while typing; submission still locks its frozen draft.
  let submitting = $state(false);
  type PendingQueue = { id:string; text:string; imageIds:string[]; imageRecoveryId?:string; error?:string };
  const pendingPrefix = untrack(() => `${storagePrefix}/follow-up/${encodeURIComponent(agentId)}/`);
  const pendingKey = (id:string) => `${pendingPrefix}${encodeURIComponent(id)}`;
  function readPending():PendingQueue[] {
    try { return Object.keys(localStorage).filter(key=>key.startsWith(pendingPrefix)).flatMap(key=>{
      try { const value=JSON.parse(localStorage.getItem(key) ?? "null"); return value && typeof value.id === "string" && key===pendingKey(value.id) && typeof value.text === "string" && Array.isArray(value.imageIds) && value.imageIds.every((id:unknown)=>typeof id === "string") ? [value] : []; }
      catch { return []; }
    }); } catch { return []; }
  }
  let pendingQueue = $state<PendingQueue[]>(untrack(readPending));
  let queueError = $state(""); let queueBusy = $state(false);
  const queueing = $derived(queueBusy && submitting);
  function matchesDraft(pending:PendingQueue) {
    return pending.text === text.trim() && JSON.stringify(pending.imageIds) === JSON.stringify(images.map(image=>image.id));
  }
  // Missing images may be an in-flight recovery. Keep the original text gated
  // when the remaining images are a subset of the pending operation's images.
  const unresolvedDraft = $derived(pendingQueue.some(pending=>!pending.error && pending.text===text.trim() && images.every(image=>pending.imageIds.includes(image.id))));
  const queueBlocked = $derived(followUps.some(item => ["failed", "sending", "uncertain", "sent"].includes(item.status)));
  let revision=0;
  let voiceStatus = $state<VoiceRecordingStatus>("idle");
  let voiceAvailable = $state(false); let voiceReason = $state("Checking voice availability…"); let voiceSettingsRevision = $state(0);
  let voiceError = $state(""); let voiceSeconds = $state(0);
  const voiceBusy = $derived(voiceStatus !== "idle");
  const voiceTarget = $derived(connected ? agentId : "");
  let takeDraft: {text:string;start:number;end:number} | undefined;
  const voice = new VoiceRecordingController({
    onStatus: status => { voiceStatus=status; },
    onError: error => { voiceError = error.code === "permission-denied" ? "Allow microphone access to use voice input." : error.code === "unsupported" ? "16 kHz voice capture is unavailable in this browser." : "Voice input failed. Try again or type your message."; },
    onResult: result => {
      const saved=takeDraft; takeDraft=undefined;
      if(!active || !saved || text!==saved.text)return;
      text=saved.text.slice(0,saved.start)+result.text+saved.text.slice(saved.end);
      const caret=saved.start+result.text.length;
      void tick().then(()=>{if(active){input?.focus();input?.setSelectionRange(caret,caret);}});
    },
  });
  function cancelVoice() { takeDraft=undefined; void voice.cancel(); voiceError=""; }
  async function startVoice() {
    if(voiceBusy || !voiceAvailable || !connected || stopping || preparing || !ready || composing || navigation.surfaces.length || !input)return;
    takeDraft={text,start:input.selectionStart,end:input.selectionEnd};voiceError="";voiceSeconds=0;
    try { await voice.start(()=>connection().voiceSocket(agentId),agentId.split(":")[0]); }
    catch { /* Controller reports non-cancel failures. */ }
  }
  function stopVoice() { void voice.stopAndGet().catch(()=>{}); }
  $effect(()=>{ const value=text; untrack(()=>{if(takeDraft && value!==takeDraft.text)cancelVoice();}); });
  $effect(()=>{
    const id=voiceTarget; const online=!!id; void voiceSettingsRevision;
    const abort=new AbortController();let retry: ReturnType<typeof setTimeout> | undefined;voiceAvailable=false;voiceReason="Checking voice availability…";
    const retryWhenVisible=()=>{ retry=setTimeout(()=>{if(!abort.signal.aborted && !document.hidden)voiceSettingsRevision++;},15000); };
    if(!online){cancelVoice();voiceReason="Execution Peer is offline";return;}
    if(!canCaptureVoice()){voiceReason="Voice requires HTTPS or localhost and a supported browser";return;}
    void connection().voiceCapability(id,abort.signal).then(value=>{
      if(abort.signal.aborted)return;voiceAvailable=value.available;
      voiceReason=value.available ? "Start voice input" : value.reason==="config_unavailable" ? "Voice configuration is unavailable on this Peer" : "Voice is not configured on this Peer";
      if(!value.available)retryWhenVisible();
    }).catch(()=>{if(!abort.signal.aborted){voiceReason="Voice is unavailable on this Peer";retryWhenVisible();}});
    return()=>{abort.abort();if(retry)clearTimeout(retry);};
  });
  onMount(()=>{
    const hidden=()=>{if(document.hidden)cancelVoice();else voiceSettingsRevision++;};
    const settingsChanged=()=>voiceSettingsRevision++;
    const navigating=(e:Event)=>{if(!(e as CustomEvent<{foreground:boolean}>).detail.foreground)cancelVoice();};
    const escape=(e:KeyboardEvent)=>{if(e.key==="Escape" && !e.isComposing && voiceBusy && !navigation.surfaces.length && !(e.target instanceof HTMLElement && e.target.closest(".title-editor"))){e.preventDefault();e.stopImmediatePropagation();cancelVoice();}};
    const timer=setInterval(()=>{voiceSeconds=Math.floor(voice.elapsedMs/1000);},500);
    window.addEventListener("keydown",escape,true);document.addEventListener("visibilitychange",hidden);window.addEventListener("focus",settingsChanged);window.addEventListener("pagehide",cancelVoice);window.addEventListener("grove-navigation-pop",navigating);window.addEventListener("grove-voice-settings-changed",settingsChanged);
    return()=>{clearInterval(timer);voice.dispose();window.removeEventListener("keydown",escape,true);document.removeEventListener("visibilitychange",hidden);window.removeEventListener("focus",settingsChanged);window.removeEventListener("pagehide",cancelVoice);window.removeEventListener("grove-navigation-pop",navigating);window.removeEventListener("grove-voice-settings-changed",settingsChanged);};
  });
  let ordinarySelection: {start: number; end: number} | undefined;
  $effect(() => {
    const hidden = suspended;
    untrack(() => {
      if (hidden) { if (input) ordinarySelection = {start:input.selectionStart,end:input.selectionEnd}; cancelVoice(); }
      else if (ordinarySelection) { const saved = ordinarySelection; void tick().then(() => input?.setSelectionRange(saved.start,saved.end)); }
    });
  });
  let draftLoad=0;
  async function refreshDraft(applyRecovery=false) {
    const owner=agentId;
    const load=++draftLoad;ready=false;
    const current=()=>active && agentId===owner && load===draftLoad;
    if(applyRecovery)cancelVoice();
    if(applyRecovery)text=readDraft(text);
    try {
      // Finish any accepted image edits before taking a recovery snapshot.
      await intake.catch(()=>{});
      if(!current())return;
      let restored=(await loadImages(draftKey(owner)))?.images ?? [];
      if(!current())return;
      const recoveries=readPending().filter(item=>item.imageRecoveryId);
      // A page may disappear after the image transaction commits but before
      // draft reconciliation completes. The operation copy remains durable.
      for(const pending of recoveries) {
        if(!current())return;
        if(!pending.imageIds.every(id=>restored.some(image=>image.id===id))) {
          const operation=await loadImages(operationKey(owner,pending.id));
          if(!current())return;
          if(!operation || !pending.imageIds.every(id=>operation.images.some(image=>image.id===id)))throw new Error("Could not restore the queued draft images.");
          restored=await saveImages(draftKey(owner),stored=>{
            const latest=readPending().find(item=>item.id===pending.id);
            if(!current() || latest?.imageRecoveryId!==pending.imageRecoveryId)return stored;
            return [...stored,...operation.images.filter(image=>!stored.some(item=>item.id===image.id))];
          });
          if(!current())return;
        }
        const latest=readPending().find(item=>item.id===pending.id);
        if(current() && latest && latest.imageRecoveryId===pending.imageRecoveryId) {
          const {imageRecoveryId: _recovered,...remaining}=latest;
          readingCache.writeDevice(pendingKey(pending.id),JSON.stringify(remaining));
        }
      }
      if(active && agentId===owner && load===draftLoad) { images=restored; imageStorage=true; }
    }
    catch(e) { if(active && agentId===owner && load===draftLoad){imageStorage=false;imageError=`Image storage unavailable. Text messages still work. ${(e as Error).message}`;} }
    finally {if(active && agentId===owner && load===draftLoad)ready=true;}
  }
  onMount(()=>{
    const recover=(e:Event)=>{if((e as CustomEvent).detail===agentId)void refreshDraft(true);};
    const rejected=(e:Event)=>{
      const result=(e as CustomEvent<{agentId:string;operationId:string;error:string}>).detail;
      if(result.agentId===agentId && pendingQueue.some(item=>item.id===result.operationId)) {
        pendingQueue=readPending();
      }
    };
    window.addEventListener("grove-image-recovery",recover);
    window.addEventListener("grove-queue-rejected",rejected);
    pendingQueue=readPending();
    void refreshDraft();
    return()=>{active=false;window.removeEventListener("grove-image-recovery",recover);window.removeEventListener("grove-queue-rejected",rejected);};
  });
  $effect(()=>{
    const snapshot=images; const urls:string[]=[];let disposed=false;
    void Promise.all(snapshot.map(i=>imagePreview(i.file))).then(blobs=>{
      if(disposed)return;for(const blob of blobs)urls.push(URL.createObjectURL(blob));previews=urls;
    }).catch(e=>{if(!disposed)imageError=(e as Error).message;});
    return()=>{disposed=true;urls.forEach(url=>URL.revokeObjectURL(url));};
  });
  let intake=Promise.resolve();
  function addFiles(files:File[]) { if(voiceBusy)return Promise.resolve(); if(!ready){imageError="Wait for images to finish loading, then try again.";return Promise.resolve();} const key=draftKey(agentId); const task=intake.catch(()=>{}).then(()=>performAdd(files,key));intake=task;return task; }
  async function performAdd(files: File[], key: string) {
    if(voiceBusy || !files.length)return;
    imageError=intakeError(images,files);if(imageError)return;
    preparing=true;
    try {
      for(const file of files){ const bitmap=await createImageBitmap(file); const valid=bitmap.width*bitmap.height<=40_000_000 && bitmap.width<=16383 && bitmap.height<=16383;bitmap.close();if(!valid)throw new Error("Image exceeds 40 megapixels or 16383 pixels per side."); }
      const added=files.map(file=>({id:crypto.randomUUID(),file}));
      const next=await saveImages(key,current=>[...current,...added]); if(active){images=next;revision++;}
    }catch(e){imageError=(e as Error).message;}finally{if(active)preparing=false;}
  }
  function removeImage(id:string) {
    if(voiceBusy || !ready)return;
    intake=intake.catch(()=>{}).then(async()=>{preparing=true;try{const next=await saveImages(draftKey(agentId),current=>current.filter(i=>i.id!==id));if(active){images=next;revision++;}}catch(e){imageError=(e as Error).message;}finally{preparing=false;}});
  }
  function paste(e:ClipboardEvent) { if(voiceBusy){e.preventDefault();return;} const files=Array.from(e.clipboardData?.items ?? []).filter(i=>i.kind==='file' && i.type.startsWith('image/')).map(i=>i.getAsFile()).filter((i):i is File=>!!i);if(files.length){e.preventDefault();void addFiles(files);} }

  const skillOpen = $derived(navigation.surfaces.includes("skill")); let insertion = {start:0,end:0};
  $effect(() => {
    if(!draftReadable)return; // Never overwrite an unreadable stored draft with the display fallback.
    try { readingCache.writeDevice(`${storagePrefix}/composer/${agentId}`, text); }
    catch(e) { imageError=(e as Error).message; }
  });
  async function restoreInput() { await tick(); input?.focus(); input?.setSelectionRange(insertion.start,insertion.end); }
  async function insertSkill(skill:Skill) {
    if(voiceBusy || composing || stopping || preparing || !connected) return;
    const before = text.slice(0,insertion.start); const after = text.slice(insertion.end);
    const value = `${before && !/\s$/.test(before) ? ' ' : ''}$${skill.name}${!after || !/^\s/.test(after) ? ' ' : ''}`;
    text = before+value+after; insertion = {start:before.length+value.length,end:before.length+value.length};
    setSurface("skill", false); await restoreInput();
  }
  function workflow(name:string) {
    if(voiceBusy || !input || composing || stopping || preparing || !connected || navigation.surfaces.length) return;
    insertion={start:input.selectionStart,end:input.selectionEnd};
    void insertSkill({name, description:""});
  }
  async function send() {
    if(suspended || voiceBusy || composing || unresolvedDraft || (!text.trim() && !images.length) || !connected || stopping || preparing || !ready) return;
    if(images.length){imageError=intakeError([],images.map(i=>i.file));if(imageError)return;}
    const value=text.trim(); const frozen=$state.snapshot(images);const version=revision;const owner=agentId;
    const position = onbeginSend?.();
    input?.blur();
    submitting=true;preparing=true;
    try {
      const id=await reserveSubmission(owner);
      if(!active || agentId!==owner)return;
      if(frozen.length) await saveImages(operationKey(agentId,id),frozen,value);
      addOutgoing(agentId,value,id,undefined,undefined,frozen.map(i=>i.id));
      if (position !== undefined) onpositionSent?.(id, position);
      if(frozen.length){
        try { await saveImages(draftKey(agentId),current=>JSON.stringify(current.map(i=>i.id))===JSON.stringify(frozen.map(i=>i.id)) ? [] : current); }
        catch (error) {
          // Keep the journal pending until the issuing host closes its reservation.
          unknownOutgoing(agentId,id,(error as Error).message);
          throw error;
        }
      }
      try {
        if(localStorage.getItem(`${storagePrefix}/composer/${agentId}`)?.trim()===value)readingCache.writeDevice(`${storagePrefix}/composer/${agentId}`,'');
      } catch { /* The submission is already journalled; draft cleanup cannot block sending. */ }
      if(active && version===revision){ images=[];text='';revision++; }
      void onsend(agentId,value,id,frozen);
    } catch(e){imageError=(e as Error).message;}finally{if(active){submitting=false;preparing=false;}}
  }
  async function clearPending(pending:PendingQueue,owner:string) {
    const current=()=>active && agentId===owner;
    const textKey=`${storagePrefix}/composer/${owner}`;
    // An unmounted composer cannot reconcile its draft; retain the operation
    // identity for the next visit instead of leaving accepted content unsent.
    if(!current())return;
    if(matchesDraft(pending) && (localStorage.getItem(textKey) ?? '').trim()!==pending.text)return;
    if(current() && matchesDraft(pending) && (localStorage.getItem(textKey) ?? '').trim()===pending.text) {
      let imagesMatch=true;
      let removed:ImageDraft[]=[];
      if(pending.imageIds.length){
        await saveImages(draftKey(owner),stored=>{
          imagesMatch=current() && matchesDraft(pending) && (localStorage.getItem(textKey) ?? '').trim()===pending.text && JSON.stringify(stored.map(i=>i.id))===JSON.stringify(pending.imageIds);
          if(imagesMatch){
            readingCache.writeDevice(pendingKey(pending.id),JSON.stringify({...pending,imageRecoveryId:crypto.randomUUID()}));
            removed=stored;
          }
          return imagesMatch ? [] : stored;
        });
      }
      else if(imageStorage)imagesMatch=!((await loadImages(draftKey(owner)))?.images.length);
      const unchanged=current() && matchesDraft(pending) && (localStorage.getItem(textKey) ?? '').trim()===pending.text;
      if(removed.length && !unchanged)await saveImages(draftKey(owner),stored=>[...stored,...removed.filter(image=>!stored.some(item=>item.id===image.id))]);
      if(!current())return;
      if(imagesMatch && unchanged){
        readingCache.writeDevice(textKey,'');
        text='';images=[];revision++;
      }else if(active && matchesDraft(pending))await refreshDraft(true);
      if(!current() || matchesDraft(pending))return;
    }
    localStorage.removeItem(pendingKey(pending.id));pendingQueue=pendingQueue.filter(item=>item.id!==pending.id);
    if(pending.imageIds.length)await saveImages(operationKey(owner,pending.id),[]);
  }
  const clearingPending = new Map<string,Promise<void>>();
  function acceptPending(pending:PendingQueue, owner:string) {
    const existing=clearingPending.get(pending.id);
    if(existing)return existing;
    const task=clearPending(pending,owner).finally(()=>clearingPending.delete(pending.id));
    clearingPending.set(pending.id,task);
    return task;
  }
  function failPending(pending:PendingQueue, error:string) {
    if(clearingPending.has(pending.id) || !localStorage.getItem(pendingKey(pending.id)))return;
    const failed={...pending,error};
    readingCache.writeDevice(pendingKey(pending.id),JSON.stringify(failed));
    if(active) pendingQueue=readPending();
  }
  async function discardFailed(pending:PendingQueue) {
    localStorage.removeItem(pendingKey(pending.id));
    pendingQueue=readPending();
    if(pending.imageIds.length)await saveImages(operationKey(agentId,pending.id),[]);
  }
  async function queue() {
    if(!working || !queueReady || suspended || voiceBusy || composing || (!text.trim() && !images.length) || !connected || stopping || preparing || !ready || pendingQueue.some(item=>!item.error) || queueBusy)return;
    if(images.length){imageError=intakeError([],images.map(i=>i.file));if(imageError)return;}
    const owner=agentId;const frozen=$state.snapshot(images);const pending={id:crypto.randomUUID(),text:text.trim(),imageIds:frozen.map(i=>i.id)};
    queueBusy=true;submitting=true;queueError="";
    try {
      if(frozen.length)await saveImages(operationKey(owner,pending.id),frozen,pending.text);
      readingCache.writeDevice(pendingKey(pending.id),JSON.stringify(pending));pendingQueue=[...pendingQueue,pending];
      const result=await onenqueue(owner,pending.text,pending.id,frozen);
      if(result.status === "accepted")await acceptPending(pending,owner);
      else if(result.status === "rejected"){const reason=result.error ?? "Could not queue message.";failPending(pending,reason);if(!active)window.dispatchEvent(new CustomEvent("grove-queue-rejected",{detail:{agentId:owner,operationId:pending.id,error:reason}}));}
    } catch(e) {queueError=(e as Error).message;}
    finally {queueBusy=false;submitting=false;}
  }
  async function checkQueue(pending:PendingQueue) {
    if(!ready)return;
    const owner=agentId;
    try {
      const result=await oncheckqueue(owner,pending.id);
      if(!result)return;
      if(result.status === "cancelled")failPending(pending,result.error ?? m.queue_cancelled_draft());
      else await acceptPending(pending,owner);
    } catch { /* Retry the original lookup after the connection recovers. */ }
  }
  $effect(()=>{
    const pending=pendingQueue.find(item=>!item.error);
    if(!pending || !connected || !queueReady || !ready)return;
    let cancelled=false;let delay=1000;let timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{
      await checkQueue(pending);
      if(!cancelled){delay=Math.min(delay*2,30000);timer=setTimeout(poll,delay);}
    };
    timer=setTimeout(poll,delay);
    return()=>{cancelled=true;clearTimeout(timer);};
  });
  async function manageQueue(member:"cancelFollowUp" | "resumeFollowUps",operationId?:string) {
    if(queueBusy || !queueReady)return;queueBusy=true;queueError="";
    try{await onqueueaction(agentId,member,operationId);}catch(e){queueError=(e as Error).message;}finally{queueBusy=false;}
  }
  function openSkills() {
    if(voiceBusy || navigation.surfaces.length || !input || composing || stopping || preparing || !connected) return false;
    insertion={start:input.selectionStart,end:input.selectionEnd}; setSurface("skill", true); return true;
  }
  function skillShortcut(e:KeyboardEvent) {
    if(e.defaultPrevented || e.isComposing || e.keyCode === 229 || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.code !== "KeyS") return;
    if(e.target instanceof HTMLElement && e.target.closest("input, textarea, [contenteditable=true]") && !e.target.closest(".composer")) return;
    if(openSkills()) { e.preventDefault(); e.stopPropagation(); }
  }
  async function keydown(e:KeyboardEvent) {
    // WebKit may end composition before the confirming Enter keydown.
    if(composing || e.isComposing || e.keyCode === 229 || e.ctrlKey || e.metaKey || e.altKey) return;
    // The window reserves Tab from focus traversal; the composer owns its action.
    if(e.key === 'Tab' && !e.shiftKey && !navigation.surfaces.length) { e.preventDefault(); e.stopPropagation(); await queue(); return; }
    if(e.defaultPrevented) return;
    if(e.key === "Escape" && !e.shiftKey && !navigation.surfaces.length) { e.preventDefault(); e.stopPropagation(); input?.blur(); return; }
    if(e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); return; }
    if(e.key==='Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); await send(); }
  }
</script>
<svelte:window onkeydown={skillShortcut} oncompositionstart={() => { composing = true; }} oncompositionend={() => { composing = false; }} />
<div class="composer-wrap">
  <SkillSearch bind:open={() => skillOpen, value => setSurface("skill", value)} {skills} {project} central={centralSkills} onselect={skill => void insertSkill(skill)} onclose={() => void restoreInput()} />
  {#if followUps.length || pendingQueue.length}
    <section class="follow-up-queue" aria-label="Queued messages">
      <div class="follow-up-heading"><span>Queued{!queueReady ? " · reconnect to update" : paused ? " · paused" : ""}</span>{#if paused && queueReady}<Button variant="ghost" size="sm" disabled={queueBusy || working || stopping || queueBlocked} onclick={()=>manageQueue("resumeFollowUps")}>Continue</Button>{/if}</div>
      {#each followUps as item (item.id)}
        <div class="follow-up-item"><div class="follow-up-content"><div class="follow-up-text">{item.text || (item.images?.length ? "Image message" : "Message")}</div>{#if item.status === "failed" && item.error}<span class="inline-error">{item.error}</span>{/if}</div><div class="follow-up-actions">{#if item.images?.length}<span>{item.images.length} image{item.images.length===1 ? "" : "s"}</span>{/if}{#if item.status === "sending" || item.status === "uncertain"}<span>{m.sending()}</span>{:else if item.status === "sent"}<span>{m.queue_processing()}</span>{:else if item.status === "failed"}<span class="inline-error">{m.queue_failed()}</span>{/if}{#if item.status === "waiting" || item.status === "failed"}<Button variant="ghost" size="icon-sm" aria-label="Remove queued message" title="Remove queued message" disabled={!queueReady || queueBusy} onclick={()=>manageQueue("cancelFollowUp",item.id)}><X /></Button>{/if}</div></div>
      {/each}
      {#each pendingQueue.filter(pending=>!followUps.some(item=>item.id===pending.id)) as pending (pending.id)}<div class="follow-up-item"><div class="follow-up-content"><div class="follow-up-text">{pending.text || "Image message"}</div>{#if pending.error}<span class="inline-error">{pending.error}</span>{/if}</div><div class="follow-up-actions">{#if pending.imageIds.length}<span>{pending.imageIds.length} image{pending.imageIds.length===1 ? "" : "s"}</span>{/if}{#if pending.error}<span class="inline-error">{m.queue_failed()}</span><Button variant="ghost" size="icon-sm" aria-label={m.queue_remove_failed()} title={m.queue_remove_failed()} onclick={()=>void discardFailed(pending)}><X /></Button>{:else if !queueing}<span>{m.queue_processing()}</span>{/if}</div></div>{/each}
    </section>
  {/if}
  <form class="composer" ondragover={e=>{if(e.dataTransfer?.types.includes("Files"))e.preventDefault();}} ondrop={e=>{e.preventDefault();void addFiles(Array.from(e.dataTransfer?.files ?? []));}} onsubmit={e => {e.preventDefault();void send();}}>
    <input class="image-picker" bind:this={picker} type="file" accept={IMAGE_ACCEPT} multiple aria-label="Choose message images" onchange={e=>{void addFiles(Array.from(e.currentTarget.files ?? []));e.currentTarget.value='';}} />
    {#if images.length}<div class="image-drafts">{#each images as image,index (image.id)}<div class="image-draft"><img src={previews[index]} alt={image.file.name} /><Button variant="secondary" size="icon-sm" disabled={voiceBusy || !ready} aria-label={`Remove image ${index+1}`} onclick={()=>removeImage(image.id)}><X /></Button></div>{/each}</div>{/if}
    {#if imageError}<p class="inline-error" role="alert">{imageError}</p>{/if}
    {#if queueError}<p class="inline-error" role="alert">{queueError}</p>{/if}
    {#if preparing}<p role="status">Preparing images…</p>{/if}
    <Textarea onpaste={paste} bind:ref={input} bind:value={text} aria-label={m.message_orc()} placeholder={m.message_placeholder()} readonly={voiceBusy} disabled={stopping || submitting} rows={2} oncompositionstart={() => { composing = true; }} oncompositionend={() => { composing = false; }} onkeydown={keydown} />
    {#if voiceError}<p class="inline-error" role="alert">{voiceError}</p>{/if}
    <div class="composer-bottom">
      <div class="composer-tools">
        {#if voiceBusy}<Button variant="ghost" size="icon-sm" aria-label="Cancel voice input" title="Cancel voice input" onclick={cancelVoice}><X /></Button>
        {:else}<Button variant="ghost" size="icon-sm" aria-label="Add images" title="Add images" disabled={preparing || !ready || !imageStorage || stopping} onclick={()=>picker.click()}><Plus /></Button>{/if}
        <Button variant="ghost" size="icon-sm" aria-label={voiceBusy ? "Stop recording" : "Start voice input"} aria-describedby="composer-voice-reason" title={voiceBusy ? "Stop recording and recognize" : voiceReason} disabled={voiceBusy ? voiceStatus !== "recording" : !voiceAvailable || !connected || stopping || preparing || !ready} onclick={()=>voiceBusy ? stopVoice() : void startVoice()}>
          {#if voiceStatus === "recording"}<Square />{:else if voiceBusy}<LoaderCircle class="voice-spinner" />{:else}<Mic />{/if}
        </Button>
        <span id="composer-voice-reason" class="sr-only">{voiceBusy ? "Stop recording and recognize" : voiceReason}</span>
        {#if voiceBusy}<span class="voice-status" role="status" aria-live="polite">{voiceStatus === "starting" ? "Starting microphone…" : voiceStatus === "recording" ? `Recording ${Math.floor(voiceSeconds/60)}:${String(voiceSeconds%60).padStart(2,"0")}` : "Recognizing…"}</span>
        {:else}
          <Button variant="ghost" size="icon-sm" aria-label={m.search_skills()} title={m.search_skills()} disabled={preparing || stopping || !connected} onclick={openSkills}><Sparkles /></Button>
        {/if}
      </div>
      <div class="composer-actions">
        {#if working || stopping}<Button variant="secondary" class="round-action" size="icon-sm" title={m.stop_orc()} aria-label={m.stop_orc()} disabled={!connected || stopping} onclick={onstop}><Square /></Button>{/if}
        {#if working}<Button variant="ghost" size="sm" aria-label="Queue for next turn" title="Queue for next turn · Tab" disabled={!queueReady || queueBusy || pendingQueue.some(item=>!item.error) || voiceBusy || (!text.trim() && !images.length) || !connected || stopping || preparing || !ready} onclick={queue}><ListPlus />Queue</Button>{/if}
        <Button class="round-action" size="icon-sm" aria-label={m.send_message()} title={m.send_message()} disabled={voiceBusy || unresolvedDraft || (!text.trim() && !images.length) || !connected || stopping || preparing || !ready} type="submit"><ArrowUp /></Button>
      </div>
    </div>
    <div class="workflow-tools" aria-label="Built-in Skills">
      {#each [{name:"grove-grill-with-docs",label:"Discuss",icon:MessagesSquare},{name:"grove-to-orc-impl",label:"Implement",icon:Hammer},{name:"grove-code-review",label:"Review",icon:ClipboardCheck},{name:"grove-review-again",label:"Re-review",icon:RotateCcw},{name:"grove-research",label:"Research",icon:Telescope},{name:"grove-diagnosing-bugs",label:"Diagnose",icon:Bug}] as action}
        <Button variant="ghost" size="sm" disabled={voiceBusy || preparing || stopping || !connected} onpointerdown={e => { if(composing)e.preventDefault(); }} onclick={() => workflow(action.name)}><action.icon />{action.label}</Button>
      {/each}
    </div>
  </form>
</div>
