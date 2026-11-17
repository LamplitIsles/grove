<script lang="ts">
  import { createVirtualizer, defaultRangeExtractor, observeElementRect, measureElement as measureSize, type Virtualizer } from "@tanstack/svelte-virtual";
  import { onMount, tick, untrack, type Snippet } from "svelte";
  import { LoaderCircle } from "@lucide/svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import MessageGroup from "./MessageGroup.svelte";
  import { projectConversation } from "./conversation-projection";
  import type { Delivery, HistoryMessages, Message, MessageWindow } from "./contracts";
  import { reading, readingCache } from "./api";
  import { historyCache, type LoadedHistory } from "./history-cache";
  import { transcriptPositions, saveTranscriptPosition } from "./transcript-state";
  import * as m from "./paraglide/messages";
  let { syncRevision = 0, agentId, boundary, live, deliveries, ready, connected, detailError = "", renderMessage, header, footer, onfollow, onanchor = () => {}, reports, closedReports, pinned }: {
    agentId: string; boundary?: string; syncRevision?: number; live: Message[]; deliveries: Delivery[]; ready: boolean; connected: boolean; detailError?: string;
    renderMessage: Snippet<[Message, boolean?]>; header: Snippet; footer: Snippet<[boolean]>; onfollow: (follow: boolean) => void; onanchor?: (operation:string) => void; reports: Set<string>; closedReports: Set<string>; pinned?: string;
  } = $props();
  const id = untrack(() => agentId);
  const initiallyReady = untrack(() => ready);
  const saved = untrack(() => transcriptPositions.get(id));
  let sendSpace = $state(untrack(() => saved?.sendSpace?.size ?? 0));
  let spaceOperation = $state<string | undefined>(untrack(() => saved?.sendSpace?.operation));
  let positioningGeneration: number | undefined;
  let answerHolding = $state(false);
  let history = $state.raw<LoadedHistory | null>(untrack(() => boundary ? historyCache.get(id, boundary) : null));
  let historyLoaded = $state(untrack(() => !!history?.loaded));
  let historical = $state.raw(untrack(() => history?.messages ?? []));
  let cursor = $state(untrack(() => history?.cursor ?? null)), error = $state(untrack(() => history?.error ?? "")), loading = $state(false);
  let windowState = $state<LoadedHistory["window"]>(untrack(()=>history?.window));
  let errorDirection=$state<"older"|"newer">("older");
  let locating: AbortController | undefined;
  let locationGeneration = 0;
  const request = new AbortController();
  function cancelLocation() { locationGeneration++; positioningGeneration=undefined; locating?.abort(); locating=undefined; }
  function userReading() { answerHolding = false; cancelLocation(); }
  export function cancelNavigation() { cancelLocation(); }
  $effect(()=>{if(!connected) untrack(cancelLocation);});
  export async function locate(operation:string) {
    cancelLocation();
    const generation = locationGeneration;
    let target = messages.find(m=>m.clientId===operation || (m.provisional && m.id===operation))?.id;
    if (!target) {
      if (!connected) throw new Error(m.outline_offline());
      locating = new AbortController();
      const page = await reading<MessageWindow>(`/window?${new URLSearchParams({agent:id,operation})}`,id,locating.signal);
      if (!active || generation!==locationGeneration) return false;
      if (!page.target || !page.messages.some(m=>m.id===page.target)) throw new Error(m.outline_unavailable());
      target=page.target;
      if(!history) return false;
      historyCache.replaceWindow(id,history,page,syncRevision);
      windowState=history.window;
      historical=history.messages; historyLoaded=true; error="";
    }
    lastFollow=false; onfollow(false);
    await tick();
    // The virtualizer mounts by index, then measurements refine the coordinates.
    // Limit correction to a few frames; any deliberate reading cancels it.
    for(let attempt=0;attempt<6;attempt++) {
      if(!active || generation!==locationGeneration || !transcript?.isConnected) return false;
      const index=rows.findIndex(row=>row.type === "message" && row.id===target)+1;
      if(index<1) return false;
      const item=$virtualizer.getVirtualItems().find(item=>item.index===index);
      const tall=!!item && item.size>transcript.clientHeight;
      $virtualizer.scrollToIndex(index,{align:tall?"start":"center"});
      if(tall && item) $virtualizer.scrollToOffset(Math.max(0,item.start-transcript.clientHeight*0.35));
      await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
      await tick();
    }
    if(generation!==locationGeneration) return false;
    onanchor(operation); return true;
  }
  async function loadWindow(direction:"older"|"newer") {
    const position=windowState?.[direction==="older"?"olderCursor":"newerCursor"];
    if(!position || !connected || loading) return;
    const generation=locationGeneration;
    loading=true; error="";
    try {
      const page=await reading<MessageWindow>(`/window?${new URLSearchParams({agent:id,cursor:position,direction})}`,id,request.signal);
      if(!active || generation!==locationGeneration) return;
      if(!history) return;
      historyCache.extendWindow(id,history,page,direction);
      historical=history.messages; windowState=history.window;
      // Join the live tail only after a real native overlap, never by adjacency.
      if(windowState && !windowState.newerCursor && historical.some(m=>live.some(l=>l.id===m.id))) windowState.joined=true;
    } catch(e) { if(active && generation===locationGeneration) {errorDirection=direction;error=(e as Error).message;} }
    finally { if(active) loading=false; }
  }
  let active = true, attempted: LoadedHistory | null = null;
  let retained = $state.raw<Message[]>([]);
  // Server recovery metadata can refer to native items outside the recent
  // window. Check the first page before presenting those as pending rows.
  const readingSettled = $derived(!boundary || historyLoaded || !!error || !connected);
  const initialLoading = $derived(connected && !detailError && !live.length && !historical.length && !retained.length && (!ready || !readingSettled));
  $effect.pre(() => {
    const current = live, revision = syncRevision;
    untrack(() => {
      const ids = new Set(current.map(m => m.id)), clients = new Set(current.filter(m => !m.provisional).map(m => m.clientId));
      historical = historical.filter(m => !m.provisional || ids.has(m.id));
      retained = [...retained.filter(m => !ids.has(m.id) && !clients.has(m.id) && !m.provisional), ...current];
      let bytes = retained.reduce((sum, m) => sum + JSON.stringify(m).length * 2, 0);
      while (bytes > 8 * 1024 * 1024 && retained.length > 1) bytes -= JSON.stringify(retained.shift()).length * 2;
      if (!windowState && history && history.synchronized === revision) historyCache.remember(id, history, retained);
    });
  });
  const messages = $derived.by(() => {
    // A recent HTTP page may overlap only the suffix of the already-read live
    // window. Keep its known earlier prefix before that native overlap, rather
    // than appending it after the page and rotating the conversation order.
    const overlap = historical.length ? retained.findIndex(m => m.id === historical[0].id) : -1;
    const prefix = overlap > 0 ? retained.slice(0, overlap) : [];
    const rows = windowState && !windowState.joined ? historical : [...prefix, ...historical, ...retained, ...live];
    const clients = new Set(rows.filter(m => !m.provisional && m.clientId).map(m => m.clientId));
    const visible = [...new Map(rows.filter(m => (!m.provisional || !clients.has(m.clientId)) && (readingSettled || !m.provisional || !m.delivery?.recoveryRef || m.delivery.status === "sent")).map(m => [m.id, m])).values()];
    const confirmed = new Set(visible.filter(m => m.role === "user" && !m.provisional && m.clientId).map(m => m.clientId));
    const byId = new Map(deliveries.map(d => [d.id, d]));
    const visibleIds = new Set(visible.map(m => m.clientId ?? m.id));
    function hasConfirmedSuccessor(delivery: Delivery) {
      const seen = new Set([delivery.id]);
      let next = delivery.supersededBy;
      while (next && !seen.has(next)) {
        if (confirmed.has(next)) return true;
        seen.add(next);
        const successor = visibleIds.has(next) ? byId.get(next) : undefined;
        next = successor?.source === "user" && successor.status === "failed" ? successor.supersededBy : undefined;
      }
      return false;
    }
    return visible.filter(m => {
      const delivery = byId.get(m.clientId ?? m.id) ?? m.delivery;
      return !(m.provisional && delivery?.source === "user" && delivery.status === "failed" && hasConfirmedSuccessor(delivery));
    });
  });
  const rows = $derived(projectConversation(messages, deliveries));
  const expandedGroups = untrack(() => saved?.groups ?? new Set<string>());
  let transcript = $state<HTMLDivElement>();
  let tail: HTMLDivElement;
  const headerKey = "timeline-header";
  let footerHeight = $state(0);
  let lastWidth = saved?.width ?? 800, lastHeight = saved?.height ?? 600;
  const estimate = 320;
  const initialMessages = untrack(() => rows);
  // Map a retained message anchor into newly prepended data while away. The
  // virtualizer's measured sizes seed the coordinates; ongoing compensation is
  // handled by dynamic measurement and explicit prepend anchoring.
  function initialOffset() {
    if (!saved) return initialMessages.length * estimate;
    const index = initialMessages.findIndex(row => row.id === saved.anchor?.id || (row.type === "group" && row.messages.some(message => message.id === saved.anchor?.id)));
    if (index < 0) return saved.scroll;
    const sizes = new Map(saved.measurements.map(item => [item.key, item.size]));
    const offset = initialMessages[index].id === saved.anchor?.id ? saved.anchor.offset : 0;
    return (sizes.get(headerKey) ?? saved.headerHeight) + 24 + initialMessages.slice(0, index).reduce((sum, message) => sum + (sizes.get(message.id) ?? estimate), 0) + offset;
  }
  // Published core 3.17.11 takeSnapshot contains only actually measured items.
  const measuredKeys = new Set(saved?.measurements.map(item => item.key));
  let firstMeasurement: string | number | bigint | undefined;
  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: initialMessages.length + 1, getScrollElement: () => transcript ?? null,
    getItemKey: index => index === 0 ? headerKey : initialMessages[index - 1].id,
    estimateSize: index => index === 0 ? (saved?.headerHeight ?? 0) : estimate,
    measureElement: (node, entry, instance) => {
      const key = instance.options.getItemKey(Number(node.dataset.index));
      firstMeasurement = measuredKeys.has(key) ? undefined : key;
      measuredKeys.add(key); // The independent flag is consumed by resizeItem's predicate.
      return measureSize(node, entry, instance);
    },
    overscan: 4, anchorTo: "start", followOnAppend: false, scrollEndThreshold: 80,
    initialOffset, initialRect: { width: saved?.width ?? 800, height: saved?.height ?? 600 },
    initialMeasurementsCache: saved?.measurements ?? [],
    // Rect callbacks may not publish when the virtual range is unchanged.
    // Wrap the documented observer, retaining its one subscription/cleanup.
    observeElementRect: (instance, changed) => observeElementRect(instance, rect => {
      if (rect.width && rect.height) { lastWidth = rect.width; lastHeight = rect.height; }
      changed(rect);
    }),
    paddingStart: 24, paddingEnd: 24 + untrack(() => sendSpace),
  });
  // Preserve the reading point when an item entirely above it changes size,
  // including while scrolling backward. Growth spanning the fold stays below
  // the reading point; measurements never pin the viewport to the end.
  const instance = $virtualizer;
  instance.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
    const first = firstMeasurement === item.key;
    firstMeasurement = undefined;
    return active && (first ? item.start < (instance.scrollOffset ?? 0) : item.end <= (instance.scrollOffset ?? 0));
  };
  let prependCommit = false;
  let leadingMessageAnchor: { key: string | number | bigint; offset: number } | undefined;
  let previousRows = untrack(() => rows);
  let foldingGroups = $state.raw(new Map<string, Message[]>());
  let foldingHold = $state(false);
  let foldingGeneration = 0;
  $effect.pre(() => {
    const current = rows, element = transcript, pin = pinned, end = footerHeight + 24 + sendSpace;
    untrack(() => {
      const previous = $virtualizer.options;
      const scroll = $virtualizer.scrollOffset ?? 0;
      // A result may replace a large measured progress row with a short group.
      // Reserve its current height before that removal can clamp scrollTop.
      if (element && spaceOperation) {
        const sentIndex = previousRows.findIndex(row => row.type === "message" && (row.message.clientId === spaceOperation || row.message.id === spaceOperation));
        const oldIds = new Set(previousRows.map(row => row.id));
        const folded = new Set(current.filter(row => row.type === "group" && !oldIds.has(row.id)).flatMap(row => row.type === "group" ? row.messages.map(message => message.id) : []));
        const sizes = new Map($virtualizer.takeSnapshot().map(item => [item.key, item.size]));
        const reserve = sentIndex < 0 ? 0 : previousRows.slice(sentIndex + 1).reduce((sum, row) => sum + (folded.has(row.id) ? sizes.get(row.id) ?? 0 : 0), 0);
        if (reserve) {
          sendSpace += reserve;
          foldingHold = true;
          const generation = ++foldingGeneration;
          setTimeout(() => { if (active && generation === foldingGeneration) foldingHold = false; }, 350);
        }
      }
      // Only animate live work that was actually in view before a new result.
      // History loading and virtual row remounts must not replay the transition.
      if (element && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        const oldIds = new Set(previousRows.map(row => row.id));
        const virtualItems = $virtualizer.getVirtualItems();
        const reading = virtualItems.find(item => item.index > 0 && item.end > scroll);
        const visible = new Set(virtualItems.filter(item => item.index > 0 && item.start >= scroll && item.start < scroll + element.clientHeight).map(item => item.key));
        const next = new Map(foldingGroups);
        for (const row of current) {
          if (row.type !== "group" || oldIds.has(row.id) || expandedGroups.has(row.id)) continue;
          // A partially read message needs immediate anchoring, not a shrinking row.
          if (reading && reading.start < scroll && row.messages.some(message => message.id === reading.key)) continue;
          const resultId = row.id.slice("group:".length);
          if (oldIds.has(resultId) || !live.some(message => message.id === resultId && message.kind === "result")) continue;
          const shown = row.messages.filter(message => oldIds.has(message.id) && visible.has(message.id));
          if (shown.length) {
            next.set(row.id, shown);
            // A group outside the new virtual range must not animate later on scroll.
            setTimeout(() => {
              if (!active || foldingGroups.get(row.id) !== shown) return;
              const pending = new Map(foldingGroups); pending.delete(row.id); foldingGroups = pending;
            }, 500);
          }
        }
        if (next.size !== foldingGroups.size) foldingGroups = next;
      }
      const visible = $virtualizer.getVirtualItems().find(item => item.index > 0 && item.end > scroll);
      const replacement = visible && !current.some(row => row.id === visible.key)
        ? current.find(row => row.type === "group" && row.messages.some(message => message.id === visible.key))
        : undefined;
      // A result may replace the message currently being read with its group.
      // Keep the disclosure at the reading point, unless the user navigates.
      if (replacement) {
        const generation = locationGeneration, key = replacement.id;
        void tick().then(() => {
          if (!active || generation !== locationGeneration) return;
          const index = rows.findIndex(row => row.id === key);
          if (index >= 0) $virtualizer.scrollToIndex(index + 1, { align: "start" });
        });
      }
      const prepending = previous.count > 1 && current.length + 1 > previous.count && current[0]?.id !== previous.getItemKey(1);
      const currentIds = new Set(current.map(row => row.id));
      const groupedIds = new Set(current.flatMap(row => row.type === "group" ? row.messages.map(message => message.id) : []));
      const anchor = $virtualizer.getVirtualItems().find(item => item.index > 0 && item.end > scroll && currentIds.has(String(item.key)));
      const oldIndex = anchor ? previousRows.findIndex(row => row.id === anchor.key) : -1;
      const removedAbove = oldIndex > 0 && previousRows.slice(0, oldIndex).some(row => row.type === "message" && !currentIds.has(row.id) && !groupedIds.has(row.id));
      // The message being folded takes precedence over another surviving row.
      if (element && anchor && removedAbove && !prepending && !replacement) {
        const generation = locationGeneration, key = String(anchor.key), offset = anchor.start - scroll;
        // A previously visible delivery can disappear after native confirmation.
        // Keep a different message below it at the reader's current position.
        void tick().then(async () => {
          for (let attempt = 0; attempt < 3; attempt++) {
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
            if (!active || generation !== locationGeneration || !transcript?.isConnected) return;
            const index = rows.findIndex(row => row.id === key);
            if (index < 0) return;
            const node = [...transcript.querySelectorAll<HTMLElement>("[data-message-id]")].find(item => item.dataset.messageId === key);
            if (!node) { $virtualizer.scrollToIndex(index + 1, { align: "start" }); continue; }
            const delta = node.getBoundingClientRect().top - transcript.getBoundingClientRect().top - offset;
            if (Math.abs(delta) > 0.5) transcript.scrollTop += delta;
          }
        });
      }
      previousRows = current;
      if (prepending) {
        // At the top the library would retain the persistent header. Retain
        // the first message identity/relative offset, as on route restoration.
        // Capture at data commit, after any reading during the fetch.
        const snapshot = $virtualizer.takeSnapshot();
        const scroll = $virtualizer.scrollOffset ?? 0;
        const first = snapshot.find(item => item.key !== headerKey && item.end > scroll);
        if (first) leadingMessageAnchor = { key: first.key, offset: scroll - first.start };
      }
      prependCommit ||= prepending;
      $virtualizer.setOptions({
        count: current.length + 1, getItemKey: index => index === 0 ? headerKey : current[index - 1].id,
        getScrollElement: () => element ?? null, paddingEnd: Math.max(end, footerHeight + 24 + sendSpace),
        rangeExtractor: range => {
          const indexes = defaultRangeExtractor(range), messageIndex = current.findIndex(row => row.id === pin || (row.type === "group" && row.messages.some(message => message.id === pin)));
          const index = messageIndex < 0 ? -1 : messageIndex + 1;
          return index < 0 || indexes.includes(index) ? indexes : [...indexes, index].sort((a, b) => a - b);
        },
        onChange: virtualChanged,
      });
    });
  });
  function virtualChanged(instance: Virtualizer<HTMLDivElement, HTMLDivElement>) {
    if (active && transcript?.isConnected && transcript.clientHeight) onfollow(windowState && !windowState.joined ? false : instance.isAtEnd());
  }
  // Reserve only the unfilled part of the viewport beneath the sent input.
  // Ignore estimated rows: their eventual measurement may be much smaller.
  $effect(() => {
    const operation = spaceOperation, current = rows, total = $virtualizer.getTotalSize(), element = transcript, space = sendSpace, end = footerHeight, holding = foldingHold || answerHolding;
    if (!operation || !element || !space || !total || holding) return;
    untrack(() => {
      const index = current.findIndex(row => row.type === "message" && (row.message.clientId === operation || row.message.id === operation));
      if (index < 0) return;
      const measured = new Map($virtualizer.takeSnapshot().map(item => [item.key, item.size]));
      if (!measured.has(current[index].id)) return;
      const occupied = current.slice(index).reduce((height, row) => height + (measured.get(row.id) ?? 0), 0);
      const slack = Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop);
      const needed = Math.max(0, space - slack, element.clientHeight - 24 - end - 24 - occupied);
      if (needed < space - 0.5) sendSpace = needed;
    });
  });
  // The published Svelte adapter applies options before Svelte commits the
  // sizer. A public options refresh after a size commit lets the adapter retry
  // a scroll clamped against the previous DOM height. Guard the store update
  // and retain the same user callback (not its adapter wrapper). See published
  // @tanstack/svelte-virtual 3.13.39 src/index.ts; no lifecycle hook/subscription.
  let committedSize = -1;
  $effect(() => {
    const size = $virtualizer.getTotalSize();
    if (size === committedSize) return;
    committedSize = size;
    untrack(() => {
      $virtualizer.setOptions({ onChange: virtualChanged });
      // Prepend anchoring can write against the old sizer. After commit,
      // retain a leading message by index: an absolute estimated offset would
      // be retried after short preceding rows are measured, losing the anchor.
      if (prependCommit && active && transcript?.isConnected) {
        prependCommit = false;
        const item = leadingMessageAnchor && $virtualizer.takeSnapshot().find(item => item.key === leadingMessageAnchor!.key);
        if (item) {
          $virtualizer.setOptions({ onChange: virtualChanged, scrollPaddingStart: -leadingMessageAnchor!.offset });
          $virtualizer.scrollToIndex(item.index, { align: "start" });
        } else $virtualizer.scrollToOffset($virtualizer.scrollOffset ?? 0);
        leadingMessageAnchor = undefined;
      }
    });
  });
  $effect.pre(() => {
    const b = boundary;
    if (b !== history?.boundary) untrack(() => {
      history = b ? historyCache.get(id, b) : null;
      historyLoaded = !!history?.loaded;
      historical = history?.messages ?? []; cursor = history?.cursor ?? null; error = history?.error ?? "";
    });
  });
  async function load() {
    const entry = history;
    if(windowState) { await loadWindow("older"); return; }
    if (!entry || !connected || loading) return;
    const initial = !entry.loaded;
    const revision = syncRevision, generation=locationGeneration, cacheGeneration=entry.generation ?? 0;
    loading = true; error = "";
    const fetchPage = async (cursor?: string) => {
      const params = new URLSearchParams(); if (cursor) params.set("cursor", cursor);
      params.set("agent", id);
      return reading<HistoryMessages>(`/messages?${params}`, id, request.signal);
    };
    if (entry.loaded && entry.synchronized !== revision) await historyCache.refresh(id, entry, revision, () => fetchPage());
    else await historyCache.load(id, entry, fetchPage, revision);
    if (!active || entry !== history) return;
    loading = false;
    // A target window replaces this read even when the cache rejects its page.
    // Do not publish or remember the retained live tail into that window.
    if ((entry.generation ?? 0) !== cacheGeneration) return;
    historical = entry.messages; cursor = entry.cursor; error = entry.error; historyLoaded = entry.loaded;
    // The page may arrive after the last live publication. Cache the retained
    // native prefix now as well, so its reading anchor survives a revisit.
    historyCache.remember(id, entry, retained);
    if (!entry.error) {
      const copy = readingCache.readDetail(id);
      if (copy) readingCache.saveDetail({ ...copy, messages: entry.messages.slice(-100) });
    }
    if (generation===locationGeneration && initial && !saved) { await tick(); if (active && generation===locationGeneration && (entry.generation ?? 0)===cacheGeneration) $virtualizer.scrollToEnd(); }
  }
  $effect(() => {
    const entry = history;
    if (!windowState && ready && connected && entry && !loading && (attempted !== entry || entry.synchronized !== syncRevision) && (!entry.loaded || entry.pending || entry.synchronized !== syncRevision) && !entry.error) {
      attempted = entry; untrack(() => { void load(); });
    }
  });
  let lastScroll = initialOffset(), lastFollow = false;
  function saveReading() {
    if (!transcript?.isConnected || !transcript.clientHeight || !ready) return;
    lastScroll = transcript.scrollTop;
    // Remove only space that is already above the physical scroll limit, so
    // a reader moving upward never sees the browser clamp the viewport back.
    if (positioningGeneration === undefined && !foldingHold && !answerHolding && sendSpace > 0) {
      const slack = Math.max(0, transcript.scrollHeight - transcript.clientHeight - lastScroll);
      if (slack > 0.5) {
        sendSpace = Math.max(0, sendSpace - slack);
        if (!sendSpace) spaceOperation = undefined;
      }
    }
    lastFollow = transcript.scrollHeight - lastScroll - transcript.clientHeight < 80;
    if(windowState && !windowState.joined) lastFollow=false;
    onfollow(lastFollow);
    const measurements=$virtualizer.getVirtualItems();
    const midpoint=lastScroll+transcript.clientHeight/2;
    const current=measurements.find(item=>item.index>0 && item.end>=midpoint);
    const index=current ? current.index-1 : rows.length-1;
    const visibleRows=rows.slice(0,index+1).flatMap(row=>row.type === "message" ? [row.message] : row.messages);
    const user=visibleRows.reverse().find(m=>m.role==="user" && m.delivery?.source==="user");
    if(user?.clientId) onanchor(user.clientId);
  }
  function measure(node: HTMLDivElement) {
    $virtualizer.measureElement(node);
    return { destroy: () => $virtualizer.measureElement(null) };
  }
  export function beginSend() {
    cancelLocation();
    return locationGeneration;
  }
  export async function positionSent(operation: string, generation: number, answer = false) {
    if (!active || generation !== locationGeneration || !transcript?.isConnected) return;
    if (windowState) {
      windowState = undefined; historical = [];
      if (history) { history.window = undefined; history.messages = []; history.loaded = false; history.cursor = null; history.synchronized = undefined; }
    }
    // The caller has journalled the provisional row. Wait for it to enter the
    // projection without letting an intervening reading action steal focus.
    for (let attempt = 0; attempt < 6; attempt++) {
      await tick();
      if (!active || generation !== locationGeneration || !transcript?.isConnected) return;
      if (rows.some(row => row.type === "message" && (row.message.clientId === operation || row.message.id === operation))) break;
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    }
    if (!rows.some(row => row.type === "message" && (row.message.clientId === operation || row.message.id === operation))) return;
    positioningGeneration = generation;
    answerHolding = answer;
    spaceOperation = operation;
    sendSpace = Math.max(0, (answer ? Math.max(transcript.clientHeight, window.innerHeight) : transcript.clientHeight) - 24);
    try {
      await tick();
      let requestedRow = false;
      for (let attempt = 0; attempt < 6; attempt++) {
        if (!active || generation !== locationGeneration || !transcript?.isConnected) return;
        const index = rows.findIndex(row => row.type === "message" && (row.message.clientId === operation || row.message.id === operation));
        if (index < 0) return;
        const row = transcript.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(rows[index].id)}"]`);
        if (row) {
          const delta = row.getBoundingClientRect().top - transcript.getBoundingClientRect().top - 24;
          if (Math.abs(delta) > 0.5) transcript.scrollTop += delta;
        } else if (!requestedRow) {
          requestedRow = true;
          $virtualizer.scrollToIndex(index + 1, { align: "start" });
        }
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        await tick();
      }
    } finally { if (positioningGeneration === generation) positioningGeneration = undefined; }
  }
  export function releaseAnswerSpace() { answerHolding = false; }
  export async function jumpToBottom() {
    cancelLocation();
    answerHolding = false; sendSpace = 0; spaceOperation = undefined;
    if(windowState) {
      windowState=undefined; historical=[];
      if(history) {history.window=undefined; history.messages=[];history.loaded=false;history.cursor=null;history.synchronized=undefined;}
      await load(); await tick();
    }
    await tick(); $virtualizer.scrollToEnd();
  }
  onMount(() => {
    footerHeight = tail.getBoundingClientRect().height;
    const readingKey=(event:KeyboardEvent)=>{
      if(!["PageUp","PageDown","Home","End","ArrowUp","ArrowDown"," "].includes(event.key) || event.isComposing) return;
      if(event.target===document.body || (event.target instanceof Node && transcript?.contains(event.target))) userReading();
    };
    window.addEventListener("keydown",readingKey,true);
    const observer = new ResizeObserver(() => {
      if (!active) return;
      footerHeight = tail.getBoundingClientRect().height;
    });
    observer.observe(tail);
    if (!saved) void tick().then(() => { if (active) $virtualizer.scrollToEnd(); });
    return () => {
      active = false; cancelLocation(); request.abort(); observer.disconnect(); window.removeEventListener("keydown",readingKey,true);
      if (!transcript || !initiallyReady) return;
      const scroll = lastScroll;
      const measurements = $virtualizer.takeSnapshot();
      const item = measurements.find(item => item.key !== headerKey && item.end > scroll);
      saveTranscriptPosition(id, {
        scroll, follow: lastFollow,
        anchor: item ? { id: String(item.key), offset: scroll - item.start } : undefined,
        measurements, headerHeight: measurements.find(item => item.key === headerKey)?.size ?? 0,
        width: lastWidth, height: lastHeight,
        ...(spaceOperation ? { sendSpace: { operation: spaceOperation, size: sendSpace } } : {}),
        reports, closedReports, groups: expandedGroups,
      });
    };
  });
</script>
<div class="conversation-region" aria-busy={initialLoading}>
<div class="conversation" role="region" aria-label={m.conversation_region()} bind:this={transcript} onscroll={saveReading} onwheel={userReading} ontouchstart={userReading} onpointerdown={userReading}>
  <div class="message-timeline" class:historical-messages={!!boundary} style:height={`${$virtualizer.getTotalSize()}px`}>
    <!-- Always mounted, but measured as the leading item so header changes
         use the same library anchoring as messages, rather than padding. -->
    <div class="timeline-header" data-index="0" use:measure>
      {@render header()}
      {#if boundary}<div class="history-controls">
        {#if error}<span class="inline-error" role="alert">{error}</span><Button variant="ghost" size="sm" disabled={!connected || loading} onclick={()=>windowState?loadWindow(errorDirection):load()}>{m.retry()}</Button>
        {:else}{#if windowState ? windowState.olderCursor : cursor}<Button variant="ghost" size="sm" disabled={loading || !connected} onclick={load}>{m.earlier_messages()}</Button>{/if}
        {#if loading && readingSettled}<span role="status">{m.loading_history()}</span>{/if}{/if}
      </div>{/if}
    </div>
    {#each $virtualizer.getVirtualItems() as row (row.key)}
      {#if row.index > 0}{@const entry = rows[row.index - 1]}<div class="timeline-message" data-index={row.index} data-message-id={row.key} style:transform={`translateY(${row.start}px)`} use:measure>
        {#if entry.type === "message"}{@render renderMessage(entry.message)}
        {:else}<MessageGroup messages={entry.messages} {renderMessage} initiallyExpanded={expandedGroups.has(entry.id)} folding={foldingGroups.get(entry.id)} onfolding={() => { const next = new Map(foldingGroups); next.delete(entry.id); foldingGroups = next; }} onexpanded={value => { if (value) expandedGroups.add(entry.id); else expandedGroups.delete(entry.id); }} />{/if}
      </div>{/if}
    {/each}
    <div class="timeline-footer" bind:this={tail} style:top={`${$virtualizer.getTotalSize() - footerHeight - 24 - sendSpace}px`}>{#if windowState}<div class="history-controls">{#if windowState.newerCursor}<Button variant="ghost" size="sm" disabled={loading || !connected} onclick={()=>loadWindow("newer")}>{m.later_messages()}</Button>{/if}{#if error}<span class="inline-error" role="alert">{error}</span><Button variant="ghost" size="sm" disabled={loading || !connected} onclick={()=>loadWindow(errorDirection)}>{m.retry()}</Button>{/if}</div>{/if}{@render footer(readingSettled)}</div>
  </div>
</div>
{#if initialLoading}<div class="conversation-loading" role="status" aria-label={m.loading_conversation()}><LoaderCircle size={28} aria-hidden="true" class="conversation-spinner" /></div>{/if}
</div>
<style>
  .conversation-region { position: relative; display: flex; flex: 1; min-width: 0; min-height: 0; }
  .conversation-loading { position: absolute; inset: 0; z-index: 2; display: grid; place-items: center; background: color-mix(in srgb, var(--background) 65%, transparent); color: var(--muted-foreground); }
  .conversation-loading :global(.conversation-spinner) { animation: conversation-spin 1s linear infinite; }
  @keyframes conversation-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .conversation-loading :global(.conversation-spinner) { animation: none; } }
  .conversation { padding: 0; overflow-anchor: none; }
  .message-timeline { position: relative; width: 100%; }
  .timeline-message, .timeline-header, .timeline-footer { position: absolute; left: 24px; right: 24px; display: flow-root; }
  .timeline-message { top: 0; }
  .timeline-header { top: 24px; }
  .history-controls { min-height: 32px; display: flex; align-items: center; gap: 8px; }
  @media (max-width: 700px) { .timeline-message, .timeline-header, .timeline-footer { left: 16px; right: 16px; } }
</style>
