<script lang="ts">
  import { addOutgoing } from "./outgoing.svelte";
  import { navigation, setSurface } from "./navigation.svelte";
  import { Button } from '$lib/components/ui/button/index.js';
  import { Textarea } from '$lib/components/ui/textarea/index.js';
  import { Plus, MessagesSquare, Hammer, Bug, ClipboardCheck, RotateCcw, Telescope, X, ArrowUp, Square, Sparkles, ListPlus, FileIcon, ImageIcon } from '@lucide/svelte';
  import { storagePrefix, readingCache, connection, reserveSubmission } from './api';
  import { Mic, LoaderCircle } from '@lucide/svelte';
  import { canCaptureVoice, VoiceRecordingController, type VoiceRecordingStatus } from './voice-input';
  import { getAttachmentDrafts, attachmentError, attachmentKind, discardAttachments, fileSize, imagePreview, uploadAttachments, type AttachmentDraft, type AttachmentDraftState, type AttachmentRefs } from './attachments';
  import { onMount, tick, untrack } from 'svelte';
  import { registerComposerDraft } from './question-state.svelte';
  import type { Delivery, Skill } from './contracts';
  import SkillSearch from './SkillSearch.svelte';
  import * as m from './paraglide/messages';
  let { agentId, project, centralSkills = false, allowFiles = true, skills, connected, suspended = false, working = false, stopping = false, followUps = [], paused = false, queueReady = false, onenqueue, oncheckqueue, onqueueaction, onstop, onsend, onbeginSend, onpositionSent }: { agentId: string; project: string; centralSkills?: boolean; allowFiles?: boolean; skills: Skill[]; connected: boolean; suspended?: boolean; working?: boolean; stopping?: boolean; followUps?: Delivery[]; paused?: boolean; queueReady?: boolean; onenqueue: (id:string,text:string,operationId:string,refs:AttachmentRefs) => Promise<{status:"accepted" | "rejected" | "unknown";error?:string}>; oncheckqueue: (id:string,operationId:string) => Promise<Delivery | null>; onqueueaction: (id:string,member:"cancelFollowUp" | "resumeFollowUps",operationId?:string) => Promise<void>; onstop?: () => Promise<boolean>; onsend: (agentId: string, text: string, requestId: string, refs: AttachmentRefs) => Promise<boolean>; onbeginSend?: () => number | undefined; onpositionSent?: (operation: string, generation: number) => void } = $props();
  let draftReadable = true;
  function readDraft(fallback = '') {
    try { return localStorage.getItem(`${storagePrefix}/composer/${agentId}`) ?? ''; }
    catch { draftReadable = false; return fallback; }
  }
  let text = $state(untrack(() => readDraft()));
  let composerDraft: ReturnType<typeof registerComposerDraft> | undefined;
  let input = $state<HTMLTextAreaElement | null>(null);
  let composing = false;
  const attachmentDrafts = getAttachmentDrafts();
  const draft = $derived(attachmentDrafts.get(agentId));
  const attachments = $derived(draft?.items ?? []);
  const transfer = $derived(draft?.transfer);
  const progress = $derived(transfer?.progress);
  const submitting = $derived(!!transfer);
  const attachmentNotice = $derived(draft?.notice ?? "");
  let previews = $state<Record<string, string>>({});
  const intaking = $derived(!!draft?.intaking);
  let picker: HTMLInputElement;
  let active = true;
  const preparing = $derived(intaking || submitting);
  function updateDraft(owner: string, change: Partial<AttachmentDraftState>) {
    const next = { ...attachmentDrafts.get(owner), ...change };
    if (next.items?.length || next.transfer || next.notice || next.intaking) attachmentDrafts.set(owner, next);
    else attachmentDrafts.delete(owner);
  }
  type PendingQueue = AttachmentRefs & { id: string; text: string; attachmentIds: string[]; error?: string };
  const pendingPrefix = untrack(() => `${storagePrefix}/follow-up/${encodeURIComponent(agentId)}/`);
  const pendingKey = (id: string) => `${pendingPrefix}${encodeURIComponent(id)}`;
  function readPending(): PendingQueue[] {
    try {
      return Object.keys(localStorage).filter(key => key.startsWith(pendingPrefix)).flatMap(key => {
        try {
          const value = JSON.parse(localStorage.getItem(key) ?? "null");
          const ids = value?.attachmentIds ?? value?.imageIds;
          if (!value || typeof value.id !== "string" || key !== pendingKey(value.id) ||
              typeof value.text !== "string" || !Array.isArray(ids) ||
              ids.some((id: unknown) => typeof id !== "string")) return [];
          return [{ ...value, attachmentIds: ids }];
        } catch { return []; }
      });
    } catch { return []; }
  }
  let pendingQueue = $state<PendingQueue[]>(untrack(readPending));
  let queueError = $state("");
  let queueBusy = $state(false);
  const queueing = $derived(queueBusy && submitting);
  const submissionText = (draftText: string, hasAttachments: boolean) =>
    hasAttachments ? draftText : draftText.trim();
  const matchesQueuedText = (draftText: string, pending: PendingQueue) =>
    submissionText(draftText, !!(pending.images?.length || pending.files?.length)) === pending.text;
  const unresolvedDraft = $derived(pendingQueue.some(pending =>
    !pending.error && matchesQueuedText(text, pending) &&
    attachments.every(item => pending.attachmentIds.includes(item.id)),
  ));
  const queueBlocked = $derived(followUps.some(item => ["failed", "sending", "uncertain", "sent"].includes(item.status)));
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
    if(voiceBusy || !voiceAvailable || !connected || stopping || preparing || composing || navigation.surfaces.length || !input)return;
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
    composerDraft = registerComposerDraft(agentId, text);
    const hidden=()=>{if(document.hidden)cancelVoice();else voiceSettingsRevision++;};
    const settingsChanged=()=>voiceSettingsRevision++;
    const navigating=(e:Event)=>{if(!(e as CustomEvent<{foreground:boolean}>).detail.foreground)cancelVoice();};
    const escape=(e:KeyboardEvent)=>{if(e.key==="Escape" && !e.isComposing && voiceBusy && !navigation.surfaces.length && !(e.target instanceof HTMLElement && e.target.closest(".title-editor"))){e.preventDefault();e.stopImmediatePropagation();cancelVoice();}};
    const timer=setInterval(()=>{voiceSeconds=Math.floor(voice.elapsedMs/1000);},500);
    window.addEventListener("keydown",escape,true);document.addEventListener("visibilitychange",hidden);window.addEventListener("focus",settingsChanged);window.addEventListener("pagehide",cancelVoice);window.addEventListener("grove-navigation-pop",navigating);window.addEventListener("grove-voice-settings-changed",settingsChanged);
    return()=>{composerDraft?.dispose();clearInterval(timer);voice.dispose();window.removeEventListener("keydown",escape,true);document.removeEventListener("visibilitychange",hidden);window.removeEventListener("focus",settingsChanged);window.removeEventListener("pagehide",cancelVoice);window.removeEventListener("grove-navigation-pop",navigating);window.removeEventListener("grove-voice-settings-changed",settingsChanged);};
  });
  let ordinarySelection: {start: number; end: number} | undefined;
  $effect(() => {
    const hidden = suspended;
    untrack(() => {
      if (hidden) { if (input) ordinarySelection = {start:input.selectionStart,end:input.selectionEnd}; cancelVoice(); }
      else if (ordinarySelection) { const saved = ordinarySelection; void tick().then(() => input?.setSelectionRange(saved.start,saved.end)); }
    });
  });
  onMount(() => {
    const sync = (event: Event) => {
      if ((event as CustomEvent).detail.agentId === agentId) pendingQueue = readPending();
    };
    const draftCleared = (event: Event) => {
      const changed = (event as CustomEvent<{ agentId: string; text: string }>).detail;
      if (changed.agentId === agentId && changed.text === text) text = "";
    };
    window.addEventListener("grove-queue-changed", sync);
    window.addEventListener("grove-composer-text-cleared", draftCleared);
    return () => {
      active = false;
      window.removeEventListener("grove-queue-changed", sync);
      window.removeEventListener("grove-composer-text-cleared", draftCleared);
    };
  });
  $effect(() => {
    const next: Record<string, string> = {};
    for (const item of attachments)
      if (item.preview) next[item.id] = URL.createObjectURL(item.preview);
    previews = next;
    return () => Object.values(next).forEach(url => URL.revokeObjectURL(url));
  });
  let intake = Promise.resolve();
  function addFiles(files: File[]) {
    if (voiceBusy || submitting || !files.length) return;
    const owner = agentId;
    intake = intake.then(() => performAdd(files, owner));
  }
  async function performAdd(files: File[], owner: string) {
    const selected = files.map(file => ({ id: crypto.randomUUID(), file, kind: attachmentKind(file) }));
    const added = allowFiles ? selected : selected.filter(item => item.kind === "image");
    const remoteNotice = added.length < selected.length
      ? "File attachments are available in local sessions."
      : "";
    if (!added.length) { updateDraft(owner, { notice: remoteNotice }); return; }
    const checked = attachmentError([...(attachmentDrafts.get(owner)?.items ?? []), ...added]);
    updateDraft(owner, { notice: checked });
    if (checked) return;
    updateDraft(owner, { intaking: true });
    try {
      const prepared: AttachmentDraft[] = [];
      for (const item of added) {
        const preview = item.kind === "image" ? await imagePreview(item.file) : undefined;
        prepared.push({ ...item, preview });
      }
      const current = attachmentDrafts.get(owner);
      if (current?.transfer) return;
      const next = [...(current?.items ?? []), ...prepared];
      const error = attachmentError(next);
      updateDraft(owner, error ? { notice: error } : { items: next, notice: remoteNotice });
    } catch (error) {
      updateDraft(owner, { notice: (error as Error).message });
    } finally {
      updateDraft(owner, { intaking: false });
    }
  }
  function removeAttachment(id: string) {
    if (voiceBusy || submitting) return;
    updateDraft(agentId, { items: attachments.filter(item => item.id !== id), notice: "" });
  }
  function paste(event: ClipboardEvent) {
    if (voiceBusy) { event.preventDefault(); return; }
    const files = Array.from(event.clipboardData?.items ?? [])
      .filter(item => item.kind === "file" && item.type.startsWith("image/"))
      .flatMap(item => item.getAsFile() ?? []);
    if (files.length) { event.preventDefault(); addFiles(files); }
  }

  const skillOpen = $derived(navigation.surfaces.includes("skill")); let insertion = {start:0,end:0};
  $effect(() => {
    const value = text;
    composerDraft?.update(value);
    if(!draftReadable)return; // Never overwrite an unreadable stored draft with the display fallback.
    try { readingCache.writeDevice(`${storagePrefix}/composer/${agentId}`, text); }
    catch(e) { untrack(() => updateDraft(agentId, { notice: (e as Error).message })); }
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
  async function prepare(
    owner: string, operation: string, value: string, mode: "direct" | "follow_up",
    items: AttachmentDraft[], controller: AbortController,
  ) {
    controller.signal.throwIfAborted();
    return uploadAttachments(connection(), owner, operation, value, mode, items,
      controller.signal, index => updateDraft(owner, { transfer: { controller, progress: { index, total: items.length } } }),
    );
  }
  function resetDraft(owner: string, value: string) {
    const textKey = `${storagePrefix}/composer/${owner}`;
    if ((localStorage.getItem(textKey) ?? "") === value)
      readingCache.writeDevice(textKey, "");
    updateDraft(owner, { items: [] });
    if (active) text = "";
    else window.dispatchEvent(new CustomEvent("grove-composer-text-cleared", { detail: { agentId: owner, text: value } }));
  }
  function startTransfer(owner: string, items: AttachmentDraft[]) {
    const notice = attachmentError(items);
    if (notice) { updateDraft(owner, { notice }); return; }
    const controller = new AbortController();
    updateDraft(owner, { notice: "", transfer: {
      controller, ...(items.length ? { progress: { index: 0, total: items.length } } : {}),
    } });
    return controller;
  }
  async function reclaimTransfer(owner: string, operation: string, controller: AbortController) {
    controller.abort();
    updateDraft(owner, { transfer: { controller } });
    try { await discardAttachments(connection(), owner, operation); }
    catch { /* The Peer reclaims unbound uploads after expiry if disconnected. */ }
  }
  async function send() {
    if (suspended || voiceBusy || composing || unresolvedDraft || (!text.trim() && !attachments.length) ||
        !connected || stopping || preparing) return;
    const draftText = text, frozen = [...attachments], owner = agentId;
    const value = submissionText(draftText, !!frozen.length);
    const controller = startTransfer(owner, frozen);
    if (!controller) return;
    const position = onbeginSend?.();
    input?.blur();
    let operation: string | undefined;
    let journalled = false;
    try {
      operation = await reserveSubmission(owner);
      const refs = await prepare(owner, operation, value, "direct", frozen, controller);
      if (controller.signal.aborted) return;
      addOutgoing(owner, value, operation, undefined, refs);
      journalled = true;
      if (active && position !== undefined) onpositionSent?.(operation, position);
      try { resetDraft(owner, draftText); }
      catch { updateDraft(owner, { items: [] }); if (active) text = ""; }
      void onsend(owner, value, operation, refs);
    } catch (error) {
      if (!controller.signal.aborted) updateDraft(owner, { notice: (error as Error).message });
    } finally {
      if (operation && frozen.length && !journalled) await reclaimTransfer(owner, operation, controller);
      updateDraft(owner, { transfer: undefined });
    }
  }
  function syncPending(owner: string) {
    window.dispatchEvent(new CustomEvent("grove-queue-changed", { detail: { agentId: owner } }));
  }
  function acceptPending(pending: PendingQueue, owner: string) {
    if (!active || agentId !== owner) return;
    // The old selection is gone after reload. Allow clearing its original text
    // only if the user has not attached a new file or changed either text copy.
    const textKey = `${storagePrefix}/composer/${owner}`;
    if (matchesQueuedText(text, pending) && matchesQueuedText(localStorage.getItem(textKey) ?? "", pending) &&
        (!attachments.length || JSON.stringify(attachments.map(item => item.id)) === JSON.stringify(pending.attachmentIds))) {
      resetDraft(owner, text);
    }
    localStorage.removeItem(pendingKey(pending.id));
    pendingQueue = pendingQueue.filter(item => item.id !== pending.id);
  }
  function failPending(pending: PendingQueue, error: string) {
    if (!localStorage.getItem(pendingKey(pending.id))) return;
    readingCache.writeDevice(pendingKey(pending.id), JSON.stringify({ ...pending, error }));
    syncPending(agentId);
  }
  function discardFailed(pending: PendingQueue) {
    localStorage.removeItem(pendingKey(pending.id));
    pendingQueue = readPending();
  }
  async function queue() {
    if (!working || !queueReady || suspended || voiceBusy || composing || (!text.trim() && !attachments.length) ||
        !connected || stopping || preparing || pendingQueue.some(item => !item.error) || queueBusy) return;
    const owner = agentId, frozen = [...attachments], id = crypto.randomUUID();
    const value = submissionText(text, !!frozen.length);
    const controller = startTransfer(owner, frozen);
    if (!controller) return;
    queueBusy = true;
    queueError = "";
    let journalled = false;
    try {
      const refs = await prepare(owner, id, value, "follow_up", frozen, controller);
      if (controller.signal.aborted) return;
      const pending: PendingQueue = { id, text: value, attachmentIds: frozen.map(item => item.id), ...refs };
      readingCache.writeDevice(pendingKey(id), JSON.stringify(pending));
      journalled = true;
      syncPending(owner);
      updateDraft(owner, { transfer: { controller } });
      const result = await onenqueue(owner, value, id, refs);
      if (result.status === "accepted") acceptPending(pending, owner);
      else if (result.status === "rejected") failPending(pending, result.error ?? "Could not queue message.");
    } catch (error) {
      if (!controller.signal.aborted) updateDraft(owner, { notice: (error as Error).message });
    } finally {
      if (frozen.length && !journalled) await reclaimTransfer(owner, id, controller);
      updateDraft(owner, { transfer: undefined });
      queueBusy = false;
    }
  }
  async function checkQueue(pending:PendingQueue) {
    const owner=agentId;
    try {
      const result=await oncheckqueue(owner,pending.id);
      if(!result)return;
      if(result.status === "cancelled")failPending(pending,result.error ?? m.queue_cancelled_draft());
      else acceptPending(pending,owner);
    } catch { /* Retry the original lookup after the connection recovers. */ }
  }
  $effect(()=>{
    const pending=pendingQueue.find(item=>!item.error);
    if(!pending || !connected || !queueReady)return;
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
        <div class="follow-up-item"><div class="follow-up-content"><div class="follow-up-text">{item.text || (item.files?.length ? "File attachment" : item.images?.length ? "Image message" : "Message")}</div>{#if item.status === "failed" && item.error}<span class="inline-error">{item.error}</span>{/if}</div><div class="follow-up-actions">{#if item.files?.length}<span>{item.files.length} file{item.files.length === 1 ? "" : "s"}</span>{/if}{#if item.images?.length}<span>{item.images.length} image{item.images.length===1 ? "" : "s"}</span>{/if}{#if item.status === "sending" || item.status === "uncertain"}<span>{m.sending()}</span>{:else if item.status === "sent"}<span>{m.queue_processing()}</span>{:else if item.status === "failed"}<span class="inline-error">{m.queue_failed()}</span>{/if}{#if item.status === "waiting" || item.status === "failed"}<Button variant="ghost" size="icon-sm" aria-label="Remove queued message" title="Remove queued message" disabled={!queueReady || queueBusy} onclick={()=>manageQueue("cancelFollowUp",item.id)}><X /></Button>{/if}</div></div>
      {/each}
      {#each pendingQueue.filter(pending=>!followUps.some(item=>item.id===pending.id)) as pending (pending.id)}<div class="follow-up-item"><div class="follow-up-content"><div class="follow-up-text">{pending.text || (pending.files?.length ? "File attachment" : "Image message")}</div>{#if pending.error}<span class="inline-error">{pending.error}</span>{/if}</div><div class="follow-up-actions">{#if pending.attachmentIds.length}<span>{pending.attachmentIds.length} attachment{pending.attachmentIds.length === 1 ? "" : "s"}</span>{/if}{#if pending.error}<span class="inline-error">{m.queue_failed()}</span><Button variant="ghost" size="icon-sm" aria-label={m.queue_remove_failed()} title={m.queue_remove_failed()} onclick={()=>void discardFailed(pending)}><X /></Button>{:else if !queueing}<span>{m.queue_processing()}</span>{/if}</div></div>{/each}
    </section>
  {/if}
  <form class="composer" ondragover={e=>{if(e.dataTransfer?.types.includes("Files"))e.preventDefault();}} ondrop={e=>{e.preventDefault();void addFiles(Array.from(e.dataTransfer?.files ?? []));}} onsubmit={e => {e.preventDefault();void send();}}>
    <input class="image-picker" bind:this={picker} type="file" accept={allowFiles ? undefined : "image/png,image/jpeg,image/webp,image/gif,image/heic,image/heif,.heic,.heif"} multiple aria-label="Choose message attachments" onchange={e=>{void addFiles(Array.from(e.currentTarget.files ?? []));e.currentTarget.value='';}} />
    {#if attachments.length}
      <div class="image-drafts">
        {#each attachments as item, index (item.id)}
          {#if previews[item.id]}
            <div class="image-draft">
              <img src={previews[item.id]} alt={item.file.name} />
              <Button variant="secondary" size="icon-sm" disabled={voiceBusy || submitting} aria-label={`Remove image ${index+1}`} onclick={() => removeAttachment(item.id)}><X /></Button>
            </div>
          {:else}
            <div class="attachment-card">
              {#if item.kind === "image"}<ImageIcon />{:else}<FileIcon />{/if}
              <div class="attachment-label"><span title={item.file.name}>{item.file.name}</span><small>{fileSize(item.file.size)}</small></div>
              <Button variant="ghost" size="icon-sm" disabled={voiceBusy || submitting} aria-label={`Remove ${item.file.name}`} onclick={() => removeAttachment(item.id)}><X /></Button>
            </div>
          {/if}
        {/each}
      </div>
    {/if}
    {#if attachmentNotice}<p class="inline-error" role="alert">{attachmentNotice}</p>{/if}
    {#if queueError}<p class="inline-error" role="alert">{queueError}</p>{/if}
    {#if progress}
      <div class="attachment-progress">
        <span role="status">{progress.index < progress.total ? `Uploading ${progress.index + 1} of ${progress.total}…` : "Preparing attachments…"}</span>
        <Button variant="ghost" size="sm" onclick={() => transfer?.controller.abort()}>Cancel upload</Button>
      </div>
    {:else if intaking}<p role="status">Preparing images…</p>{/if}
    <Textarea onpaste={paste} oninput={e => composerDraft?.update(e.currentTarget.value)} bind:ref={input} bind:value={text} aria-label={m.message_orc()} placeholder={m.message_placeholder()} readonly={voiceBusy} disabled={stopping || submitting} rows={2} oncompositionstart={() => { composing = true; }} oncompositionend={() => { composing = false; }} onkeydown={keydown} />
    {#if voiceError}<p class="inline-error" role="alert">{voiceError}</p>{/if}
    <div class="composer-bottom">
      <div class="composer-tools">
        {#if voiceBusy}<Button variant="ghost" size="icon-sm" aria-label="Cancel voice input" title="Cancel voice input" onclick={cancelVoice}><X /></Button>
        {:else}<Button variant="ghost" size="icon-sm" aria-label="Add attachments" title="Add attachments" disabled={preparing || stopping} onclick={()=>picker.click()}><Plus /></Button>{/if}
        <Button variant="ghost" size="icon-sm" aria-label={voiceBusy ? "Stop recording" : "Start voice input"} aria-describedby="composer-voice-reason" title={voiceBusy ? "Stop recording and recognize" : voiceReason} disabled={voiceBusy ? voiceStatus !== "recording" : !voiceAvailable || !connected || stopping || preparing} onclick={()=>voiceBusy ? stopVoice() : void startVoice()}>
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
        {#if working}<Button variant="ghost" size="sm" aria-label="Queue for next turn" title="Queue for next turn · Tab" disabled={!queueReady || queueBusy || pendingQueue.some(item=>!item.error) || voiceBusy || (!text.trim() && !attachments.length) || !connected || stopping || preparing} onclick={queue}><ListPlus />Queue</Button>{/if}
        <Button class="round-action" size="icon-sm" aria-label={m.send_message()} title={m.send_message()} disabled={voiceBusy || unresolvedDraft || (!text.trim() && !attachments.length) || !connected || stopping || preparing} type="submit"><ArrowUp /></Button>
      </div>
    </div>
    <div class="workflow-tools" aria-label="Built-in Skills">
      {#each [{name:"grove-grill-with-docs",label:"Discuss",icon:MessagesSquare},{name:"grove-prepare-impl",label:"Implement",icon:Hammer},{name:"grove-code-review",label:"Review",icon:ClipboardCheck},{name:"grove-review-again",label:"Re-review",icon:RotateCcw},{name:"grove-research",label:"Research",icon:Telescope},{name:"grove-diagnosing-bugs",label:"Diagnose",icon:Bug}] as action}
        <Button variant="ghost" size="sm" disabled={voiceBusy || preparing || stopping || !connected} onpointerdown={e => { if(composing)e.preventDefault(); }} onclick={() => workflow(action.name)}><action.icon />{action.label}</Button>
      {/each}
    </div>
  </form>
</div>
