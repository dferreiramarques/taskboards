/* nimbleUI behaviours — no dependencies, CSP-safe (external file; styling only through classes and
   CSS custom properties set with style.setProperty). Wiring is by attributes; results are CustomEvents.
   The kit never persists anything: listen to the events and save in your app.

   Sort      container [data-sortable][data-sortable-group="g"][data-sortable-axis="x"][data-sortable-handle]
             items     [data-sortable-item]  (direct children; handle = [data-handle]; skip drag with [data-no-drag])
             mouse/pen: drag after 5px · touch: hold 250ms then move · Esc cancels · autoscroll near edges
             keyboard (off with data-sortable-keyboard="off"; ignored if the app already handled the key): focus an item, Space/Enter grab, arrows move (←/→ also change container), Space/Enter drop, Esc cancel
             event:    nimble:sort {item, from, to, oldIndex, newIndex}   (dispatched on the target container)
             also:     nimble:sortstart {item, from} / nimble:sortend {item, committed} (UI state while dragging)
             options:  item [data-no-drag] = not draggable · zone/container [data-sortable-over="class"] = class toggled on the zone while hovered (default "over")
                       any element [data-sortable-drop="#container"] = hovering it drops at the END of that container (e.g. a collapsed shelf)
             API:      NimbleUI.sortable.cancel() aborts a drag in progress · .active() -> bool
   Edit      [data-editable][="multiline"][data-maxlength][data-allow-empty]  dblclick / Enter / F2, or [data-edit-trigger="#id"]
             Enter saves (multiline: Ctrl/Cmd+Enter) · Esc cancels · blur saves · event nimble:edit {value, oldValue} (cancelable)
   Dialog    [data-dialog-open="#id"], [data-dialog-close][data-dialog-result], overlay = .overlay[hidden] > .dialog
             (or your own classes: overlay[data-dialog-overlay][hidden] > [data-dialog-panel])
             focus trap, Esc / backdrop close ([data-static] disables), focus returns to opener; events nimble:dialogopen/-close
   Confirm   NimbleUI.confirm({title, message, confirmLabel, cancelLabel, danger}) -> Promise<boolean>
   Install   [data-install] (button, hidden until the browser says the app can be installed; shows a download-arrow icon, no text (in a menu row put <span class="install-ico"></span> next to the label); click = install prompt;
             hidden once installed or when already running as an installed app; needs a web app manifest; iOS has no install prompt, so it stays hidden there)
   Menu      [data-menu-toggle="#id"] + .menu[hidden] > [role=menuitem]; arrows/Home/End/Esc; event nimble:menuselect {item, value}
   Tabs      [data-tabs] > [role=tablist] > [role=tab][aria-controls]; panels [role=tabpanel]; event nimble:tab {tab, panel}
   Toast     NimbleUI.toast(text, {tone:'warn', duration:3200})                                                              */
(function () {
  'use strict';
  var NS = window.NimbleUI = window.NimbleUI || {};

  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function mk(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function emit(node, name, detail, cancelable) {
    var ev = new CustomEvent(name, { bubbles: true, cancelable: !!cancelable, detail: detail });
    node.dispatchEvent(ev); return ev;
  }
  var uid = 0;
  function ensureId(node, p) { if (!node.id) node.id = (p || 'nb') + (++uid); return node.id; }
  var FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  function focusables(root) { return $$(FOCUSABLE, root).filter(function (n) { return !n.hidden && n.offsetParent !== null; }); }

  /* live region for screen readers */
  var live;
  function announce(msg) {
    if (!live) { live = mk('div', 'sr-only'); live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'polite'); document.body.appendChild(live); }
    live.textContent = ''; setTimeout(function () { live.textContent = msg; }, 30);
  }
  NS.announce = announce;

  /* ═════════════ Sortable ═════════════ */
  var ITEM = '[data-sortable-item]', INTERACTIVE = 'button,a,input,select,textarea,label,[contenteditable],[data-no-drag]';
  var drag = null, kb = null, suppressClick = false;

  function groupOf(c) { return c.getAttribute('data-sortable-group') || 'default'; }
  function axisOf(c) { return c.getAttribute('data-sortable-axis') === 'x' ? 'x' : 'y'; }
  function itemsOf(c) { return Array.prototype.filter.call(c.children, function (n) { return n.matches(ITEM); }); }
  function containersOf(g) { return $$('[data-sortable]').filter(function (c) { return groupOf(c) === g; }); }
  function zoneOf(c) { return c.closest('[data-sortable-zone]') || c.closest('.col') || c; }

  function refreshSortable(root) {
    $$('[data-sortable] > ' + ITEM, root || document).forEach(function (it) {
      if (!it.hasAttribute('tabindex')) it.setAttribute('tabindex', '0');
      if (!it.hasAttribute('aria-roledescription')) it.setAttribute('aria-roledescription', 'sortable item');
    });
  }
  function overCls(c) { return c.getAttribute('data-sortable-over') || 'over'; }
  NS.sortable = { refresh: refreshSortable, cancel: function () { if (drag) finish(false); if (kb) kbEnd(false); }, active: function () { return !!(drag && drag.started) || !!kb; } };

  function rootScrolls(axis) {
    var de = document.documentElement, key = axis === 'y' ? 'overflowY' : 'overflowX', o = getComputedStyle(de)[key];
    if (o === 'visible') o = getComputedStyle(document.body)[key];   // body's overflow propagates to the viewport
    if (o === 'hidden' || o === 'clip') return false;
    return axis === 'y' ? de.scrollHeight > de.clientHeight + 1 : de.scrollWidth > de.clientWidth + 1;
  }
  function scrollParent(n) {
    while (n && n !== document.body && n !== document.documentElement) {
      var s = getComputedStyle(n);
      if (/(auto|scroll)/.test(s.overflowY + s.overflowX) && (n.scrollHeight > n.clientHeight || n.scrollWidth > n.clientWidth)) return n;
      n = n.parentElement;
    }
    return null;
  }

  document.addEventListener('pointerdown', function (e) {
    if (drag || kb) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    var item = e.target.closest && e.target.closest(ITEM);
    if (!item) return;
    var c = item.parentElement;
    if (!c || !c.hasAttribute('data-sortable') || item.hasAttribute('data-no-drag')) return;
    var inHandle = !!e.target.closest('[data-handle]');
    var ia = e.target.closest(INTERACTIVE), blocked = ia && ia !== item && item.contains(ia);
    if (c.hasAttribute('data-sortable-handle') ? !inHandle : (!inHandle && blocked)) return;
    drag = {
      item: item, from: c, fromIndex: itemsOf(c).indexOf(item), group: groupOf(c), axis: axisOf(c),
      x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, id: e.pointerId, type: e.pointerType,
      started: false, ready: e.pointerType !== 'touch', timer: 0, raf: 0, over: null, slot: null, ghost: null
    };
    if (e.pointerType === 'touch') drag.timer = setTimeout(function () { if (drag) drag.ready = true; }, 250);   // hold, then move: starts on the first move, so a longer still press stays free for the app (e.g. a context menu)
    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('pointerup', onUp, true);
    document.addEventListener('pointercancel', onCancel, true);
    document.addEventListener('keydown', onDragKey, true);
    document.addEventListener('touchmove', onTouchMove, { passive: false, capture: true });
    document.addEventListener('contextmenu', onCtx, true);
  });

  function onCtx(e) { if (drag) e.preventDefault(); }
  function onTouchMove(e) { if (drag && drag.started) e.preventDefault(); }

  function start() {
    var d = drag, r = d.item.getBoundingClientRect();
    d.dx = d.x - r.left; d.dy = d.y - r.top;
    var g = d.item.cloneNode(true);
    g.removeAttribute('id'); g.removeAttribute('tabindex'); g.removeAttribute('data-sortable-item');
    g.classList.add('drag-ghost'); g.setAttribute('aria-hidden', 'true');
    g.style.setProperty('--w', r.width + 'px');
    document.body.appendChild(g);
    d.ghost = g;
    d.slot = mk('div', 'drop-slot' + (d.axis === 'x' ? ' drop-slot--x' : ''));
    d.slot.setAttribute('aria-hidden', 'true');
    d.item.classList.add('is-dragging');
    document.documentElement.classList.add('is-sorting');
    d.started = true;
    try { d.item.setPointerCapture && d.item.setPointerCapture(d.id); } catch (err) {}
    emit(d.from, 'nimble:sortstart', { item: d.item, from: d.from });
    place(); loop();
  }

  function onMove(e) {
    var d = drag; if (!d || e.pointerId !== d.id) return;
    d.x = e.clientX; d.y = e.clientY;
    if (!d.started) {
      var moved = Math.abs(d.x - d.x0) + Math.abs(d.y - d.y0);
      if (d.type === 'touch') { if (!d.ready) { if (moved > 8) abort(); return; } if (moved < 4) return; start(); }
      else if (moved > 5) start();
      else return;
    }
    e.preventDefault();
    place();
  }

  function place() {
    var d = drag; if (!d || !d.started) return;
    d.ghost.style.setProperty('--x', (d.x - d.dx) + 'px');
    d.ghost.style.setProperty('--y', (d.y - d.dy) + 'px');
    var stack = document.elementsFromPoint(d.x, d.y), c = null, i, n, viaDrop = false;
    for (i = 0; i < stack.length && !c; i++) {
      n = stack[i].closest && stack[i].closest('[data-sortable]');
      if (n && groupOf(n) === d.group) c = n;
    }
    if (!c) {   // not over a list: maybe over a declared drop target (e.g. a collapsed shelf) -> end of its list
      for (i = 0; i < stack.length && !c; i++) {
        n = stack[i].closest && stack[i].closest('[data-sortable-drop]');
        var t = n && document.querySelector(n.getAttribute('data-sortable-drop'));
        if (t && t.hasAttribute('data-sortable') && groupOf(t) === d.group) { c = t; viaDrop = true; }
      }
    }
    if (c !== d.over) {
      if (d.over) zoneOf(d.over).classList.remove(overCls(d.over));
      d.over = c;
      if (c) zoneOf(c).classList.add(overCls(c));
    }
    if (!c) { if (d.slot.parentNode) d.slot.remove(); return; }
    var ax = axisOf(c), pos = ax === 'x' ? d.x : d.y, items = itemsOf(c).filter(function (it) { return it !== d.item; }), before = null;
    for (i = 0; i < items.length; i++) {
      var r = items[i].getBoundingClientRect(), mid = ax === 'x' ? r.left + r.width / 2 : r.top + r.height / 2;
      if (!viaDrop && pos < mid) { before = items[i]; break; }
    }
    d.slot.classList.toggle('drop-slot--x', ax === 'x');
    if (before) { if (d.slot.nextSibling !== before || d.slot.parentNode !== c) c.insertBefore(d.slot, before); }
    else if (items.length) { var last = items[items.length - 1]; if (last.nextSibling !== d.slot) last.after(d.slot); }
    else if (d.slot.parentNode !== c) c.insertBefore(d.slot, c.firstChild);
  }

  function loop() {
    var d = drag; if (!d || !d.started) return;
    var EDGE = 56, MAX = 18, sp = scrollParent(d.over || d.from), dx = 0, dy = 0;
    function speed(dist) { return Math.ceil(MAX * Math.min(1, (EDGE - dist) / EDGE)); }
    if (d.y < EDGE) dy = -speed(d.y); else if (innerHeight - d.y < EDGE) dy = speed(innerHeight - d.y);
    if (d.x < EDGE) dx = -speed(d.x); else if (innerWidth - d.x < EDGE) dx = speed(innerWidth - d.x);
    var moved = false;
    if (sp) {
      var r = sp.getBoundingClientRect(), sy = 0, sx = 0;
      if (d.y - r.top < EDGE) sy = -speed(Math.max(0, d.y - r.top)); else if (r.bottom - d.y < EDGE) sy = speed(Math.max(0, r.bottom - d.y));
      if (d.x - r.left < EDGE) sx = -speed(Math.max(0, d.x - r.left)); else if (r.right - d.x < EDGE) sx = speed(Math.max(0, r.right - d.x));
      if (sy || sx) { sp.scrollTop += sy; sp.scrollLeft += sx; moved = true; }
    }
    if (!moved && (dx || dy)) {   // the page itself scrolls only when it can (an app whose body is overflow:hidden is a fixed layout: never scroll it)
      var wx = dx && rootScrolls('x') ? dx : 0, wy = dy && rootScrolls('y') ? dy : 0;
      if (wx || wy) { scrollBy(wx, wy); moved = true; }
    }
    if (moved) place();
    d.raf = requestAnimationFrame(loop);
  }

  function cleanupDrag() {
    var d = drag; if (!d) return;
    clearTimeout(d.timer); cancelAnimationFrame(d.raf);
    document.removeEventListener('pointermove', onMove, true);
    document.removeEventListener('pointerup', onUp, true);
    document.removeEventListener('pointercancel', onCancel, true);
    document.removeEventListener('keydown', onDragKey, true);
    document.removeEventListener('touchmove', onTouchMove, { passive: false, capture: true });
    document.removeEventListener('contextmenu', onCtx, true);
  }
  function abort() { cleanupDrag(); drag = null; }
  function finish(commit) {
    var d = drag; if (!d) return;
    cleanupDrag(); drag = null;
    if (!d.started) return;
    var to = d.over;
    if (commit && to && d.slot.parentNode) to.insertBefore(d.item, d.slot);
    d.slot.remove(); d.ghost.remove();
    d.item.classList.remove('is-dragging');
    $$('[data-sortable]').forEach(function (n) { zoneOf(n).classList.remove(overCls(n)); });
    $$('.over').forEach(function (n) { n.classList.remove('over'); });
    document.documentElement.classList.remove('is-sorting');
    try { d.item.releasePointerCapture && d.item.releasePointerCapture(d.id); } catch (err) {}
    suppressClick = true; setTimeout(function () { suppressClick = false; }, 0);
    if (commit && to) {
      var ni = itemsOf(to).indexOf(d.item);
      if (to !== d.from || ni !== d.fromIndex) {
        emit(to, 'nimble:sort', { item: d.item, from: d.from, to: to, oldIndex: d.fromIndex, newIndex: ni });
        announce('Moved to position ' + (ni + 1));
      }
    }
    emit(d.from.isConnected ? d.from : document.body, 'nimble:sortend', { item: d.item, committed: !!(commit && to) });
  }
  function onUp(e) { if (drag && e.pointerId === drag.id) finish(true); }
  function onCancel(e) { if (drag && e.pointerId === drag.id) finish(false); }
  function onDragKey(e) { if (drag && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); } }
  document.addEventListener('click', function (e) { if (suppressClick) { e.preventDefault(); e.stopPropagation(); } }, true);

  /* keyboard sorting */
  function kbMoveTo(c, index) {
    var items = itemsOf(c).filter(function (n) { return n !== kb.item; });
    index = Math.max(0, Math.min(index, items.length));
    if (index < items.length) c.insertBefore(kb.item, items[index]);
    else if (items.length) items[items.length - 1].after(kb.item);
    else c.insertBefore(kb.item, c.firstChild);
    kb.item.focus();
    announce('Position ' + (index + 1) + ' of ' + (items.length + 1));
  }
  function kbEnd(commit) {
    var k = kb; if (!k) return; kb = null;
    k.item.removeAttribute('data-grabbed');
    var to = k.item.parentElement;
    if (!commit) { k.from.insertBefore(k.item, k.fromNext && k.fromNext.parentNode === k.from ? k.fromNext : null); k.item.focus(); announce('Move cancelled'); emit(k.from, 'nimble:sortend', { item: k.item, committed: false }); return; }
    var ni = itemsOf(to).indexOf(k.item);
    if (to !== k.from || ni !== k.fromIndex) emit(to, 'nimble:sort', { item: k.item, from: k.from, to: to, oldIndex: k.fromIndex, newIndex: ni });
    announce('Dropped at position ' + (ni + 1));
    emit(to, 'nimble:sortend', { item: k.item, committed: true });
  }
  document.addEventListener('keydown', function (e) {
    if (e.defaultPrevented) return;
    var item = e.target.closest && e.target.closest(ITEM);
    if (!item || e.target !== item) return;
    var c = item.parentElement; if (!c || !c.hasAttribute('data-sortable')) return;
    if (!kb) {
      if (c.getAttribute('data-sortable-keyboard') === 'off' || item.hasAttribute('data-no-drag')) return;
      if (e.key === ' ' || e.key === 'Enter') {
        if (e.key === 'Enter' && item.hasAttribute('data-editable')) return;
        e.preventDefault();
        kb = { item: item, from: c, fromIndex: itemsOf(c).indexOf(item), fromNext: item.nextElementSibling };
        item.setAttribute('data-grabbed', 'true');
        emit(c, 'nimble:sortstart', { item: item, from: c });
        announce('Grabbed. Use arrow keys to move, Space to drop, Escape to cancel.');
      }
      return;
    }
    if (kb.item !== item) return;
    var ax = axisOf(c), idx = itemsOf(c).indexOf(item), within = ax === 'x' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'], across = ax === 'x' ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight'];
    if (e.key === within[0]) { e.preventDefault(); kbMoveTo(c, idx - 1); }
    else if (e.key === within[1]) { e.preventDefault(); kbMoveTo(c, idx + 1); }
    else if (e.key === across[0] || e.key === across[1]) {
      var list = containersOf(groupOf(c)), at = list.indexOf(c), nx = list[at + (e.key === across[0] ? -1 : 1)];
      if (nx) { e.preventDefault(); kbMoveTo(nx, idx); }
    }
    else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); kbEnd(true); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); kbEnd(false); }
  });
  document.addEventListener('focusout', function (e) { if (kb && e.target === kb.item) setTimeout(function () { if (kb && document.activeElement !== kb.item) kbEnd(true); }, 0); });

  /* ═════════════ Inline edit ═════════════ */
  function edit(node) {
    if (!node || node.__nbEditing) return;
    var multi = node.getAttribute('data-editable') === 'multiline', old = node.textContent, done = false;
    var input = multi ? mk('textarea', 'textarea editable__input') : mk('input', 'input editable__input');
    if (!multi) input.type = 'text';
    input.value = old;
    input.setAttribute('aria-label', node.getAttribute('data-edit-label') || 'Edit text');
    if (node.hasAttribute('data-maxlength')) input.maxLength = +node.getAttribute('data-maxlength');
    node.__nbEditing = true;
    node.hidden = true;
    node.after(input);
    input.focus(); input.select();
    function end(save, refocus) {
      if (done) return; done = true;
      var v = input.value.replace(/\s+$/, ''), changed = v !== old;
      if (!multi) v = v.replace(/\s+/g, ' ').trim();
      input.remove(); node.hidden = false; node.__nbEditing = false;
      if (save && changed && (v || node.hasAttribute('data-allow-empty'))) {
        var ev = emit(node, 'nimble:edit', { value: v, oldValue: old }, true);
        if (!ev.defaultPrevented) node.textContent = v;
      }
      if (refocus && node.hasAttribute('tabindex')) node.focus();
    }
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); end(false, true); }
      else if (e.key === 'Enter' && (!multi || e.ctrlKey || e.metaKey)) { e.preventDefault(); end(true, true); }
    });
    input.addEventListener('blur', function () { end(true, false); });
  }
  NS.edit = edit;
  function refreshEditable(root) {
    $$('[data-editable]', root || document).forEach(function (n) { if (!n.hasAttribute('tabindex')) n.setAttribute('tabindex', '0'); });
  }
  document.addEventListener('dblclick', function (e) { var n = e.target.closest && e.target.closest('[data-editable]'); if (n) { e.preventDefault(); edit(n); } });
  document.addEventListener('keydown', function (e) {
    var n = e.target.closest && e.target.closest('[data-editable]');
    if (n && e.target === n && (e.key === 'F2' || (e.key === 'Enter' && !n.hasAttribute('data-sortable-item')))) { e.preventDefault(); edit(n); }
  });
  document.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('[data-edit-trigger]');
    if (t) edit($(t.getAttribute('data-edit-trigger')));
  });

  /* ═════════════ Dialog ═════════════ */
  var stack = [], OVERLAY = '.overlay,[data-dialog-overlay]', PANEL = '.dialog,[data-dialog-panel]';   // data-dialog-* = an app's own overlay/panel classes
  function openDialog(ov, opener) {
    if (!ov || !ov.hidden) return;
    var dlg = $(PANEL, ov) || ov, title = $('.dialog__title', dlg);
    dlg.setAttribute('role', dlg.getAttribute('role') || 'dialog');
    dlg.setAttribute('aria-modal', 'true');
    if (title) dlg.setAttribute('aria-labelledby', ensureId(title, 'dt'));
    if (!dlg.hasAttribute('tabindex')) dlg.setAttribute('tabindex', '-1');
    ov.__opener = opener || document.activeElement;
    ov.hidden = false;
    document.body.classList.add('has-dialog');
    stack.push(ov);
    var f = $('[autofocus]', dlg) || focusables(dlg)[0] || dlg;
    f.focus();
    emit(ov, 'nimble:dialogopen', {});
  }
  function closeDialog(ov, result) {
    if (!ov || ov.hidden) return;
    var ev = emit(ov, 'nimble:dialogclose', { result: result }, true);
    if (ev.defaultPrevented) return;
    ov.hidden = true;
    var i = stack.indexOf(ov); if (i >= 0) stack.splice(i, 1);
    if (!stack.length) document.body.classList.remove('has-dialog');
    var o = ov.__opener; ov.__opener = null;
    if (o && o.focus && document.contains(o)) o.focus();
  }
  NS.dialog = { open: openDialog, close: closeDialog };
  document.addEventListener('click', function (e) {
    var o = e.target.closest && e.target.closest('[data-dialog-open]');
    if (o) { openDialog($(o.getAttribute('data-dialog-open')), o); return; }
    var c = e.target.closest && e.target.closest('[data-dialog-close]');
    if (c) { var ov = c.closest(OVERLAY); if (ov) closeDialog(ov, c.getAttribute('data-dialog-result') || undefined); }
  });
  document.addEventListener('pointerdown', function (e) {
    var ov = stack[stack.length - 1];
    if (ov && e.target === ov && !ov.hasAttribute('data-static')) closeDialog(ov);
  });
  document.addEventListener('keydown', function (e) {
    var ov = stack[stack.length - 1]; if (!ov || drag) return;
    if (e.key === 'Escape') { if (!ov.hasAttribute('data-static') && !e.defaultPrevented) { e.preventDefault(); closeDialog(ov); } }
    else if (e.key === 'Tab') {
      var f = focusables($(PANEL, ov) || ov); if (!f.length) { e.preventDefault(); return; }
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || !ov.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  NS.confirm = function (o) {
    o = o || {};
    return new Promise(function (resolve) {
      var ov = mk('div', 'overlay'), d = mk('div', 'dialog'), cancel = mk('button', 'btn btn--outline', o.cancelLabel || 'Cancel'), ok = mk('button', 'btn ' + (o.danger ? 'btn--danger' : 'btn--primary'), o.confirmLabel || 'Confirm');
      ov.hidden = true;
      cancel.type = ok.type = 'button';
      cancel.setAttribute('data-dialog-close', ''); ok.setAttribute('data-dialog-close', ''); ok.setAttribute('data-dialog-result', 'true');
      var head = mk('div', 'dialog__head'); head.appendChild(mk('h2', 'dialog__title', o.title || 'Are you sure?'));
      var body = mk('div', 'dialog__body'); if (o.message) body.appendChild(mk('p', 'dialog__msg', o.message));
      var foot = mk('div', 'dialog__foot'); foot.append(cancel, ok);
      d.append(head, body, foot); ov.appendChild(d); document.body.appendChild(ov);
      if (o.danger) cancel.setAttribute('autofocus', ''); else ok.setAttribute('autofocus', '');
      ov.addEventListener('nimble:dialogclose', function (e) { resolve(e.detail.result === 'true'); setTimeout(function () { ov.remove(); }, 0); });
      openDialog(ov);
    });
  };

  /* ═════════════ Menu ═════════════ */
  function menuItems(m) { return $$('[role=menuitem]:not([disabled])', m).filter(function (n) { return !n.hidden && n.offsetParent !== null; }); }
  function closeMenus(except, refocus) {
    $$('.menu:not([hidden])').forEach(function (m) {
      if (m === except) return;
      m.hidden = true;
      var b = m.__btn; if (b) { b.setAttribute('aria-expanded', 'false'); if (refocus && (m.contains(document.activeElement) || document.activeElement === document.body)) b.focus(); }
    });
  }
  function openMenu(btn, m, focusFirst) {
    closeMenus(m);
    m.hidden = false; m.__btn = btn; btn.setAttribute('aria-expanded', 'true');
    if (!m.hasAttribute('role')) m.setAttribute('role', 'menu');
    if (focusFirst) { var it = menuItems(m)[0]; if (it) it.focus(); }
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-menu-toggle]');
    if (b) {
      var m = $(b.getAttribute('data-menu-toggle'));
      if (!m) return;
      if (m.hidden) openMenu(b, m, e.detail === 0); else closeMenus(null, e.detail === 0);
      return;
    }
    var it = e.target.closest && e.target.closest('.menu [role=menuitem]');
    if (it && !it.disabled) {
      var menu = it.closest('.menu');
      emit(menu, 'nimble:menuselect', { item: it, value: it.getAttribute('data-value') });
      if (!it.hasAttribute('data-menu-keep')) closeMenus(null, true);
    }
  });
  document.addEventListener('pointerdown', function (e) {
    $$('.menu:not([hidden])').forEach(function (m) { if (!m.contains(e.target) && !(m.__btn && m.__btn.contains(e.target))) closeMenus(); });
  });
  document.addEventListener('keydown', function (e) {
    var b = e.target.closest && e.target.closest('[data-menu-toggle]');
    if (b && e.key === 'ArrowDown') { var m0 = $(b.getAttribute('data-menu-toggle')); if (m0) { e.preventDefault(); openMenu(b, m0, true); } return; }
    var m = e.target.closest && e.target.closest('.menu'); if (!m) return;
    var items = menuItems(m), i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenus(null, true); }
    else if (e.key === 'Tab') closeMenus();
  });

  /* ═════════════ Tabs ═════════════ */
  function selectTab(tab, focus) {
    var list = tab.closest('[role=tablist]'); if (!list) return;
    $$('[role=tab]', list).forEach(function (t) {
      var on = t === tab, p = document.getElementById(t.getAttribute('aria-controls'));
      t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1;
      if (p) p.hidden = !on;
    });
    if (focus) tab.focus();
    emit(tab, 'nimble:tab', { tab: tab, panel: document.getElementById(tab.getAttribute('aria-controls')) });
  }
  document.addEventListener('click', function (e) { var t = e.target.closest && e.target.closest('[data-tabs] [role=tab]'); if (t) selectTab(t, false); });
  document.addEventListener('keydown', function (e) {
    var t = e.target.closest && e.target.closest('[data-tabs] [role=tab]'); if (!t) return;
    var tabs = $$('[role=tab]', t.closest('[role=tablist]')), i = tabs.indexOf(t), n = null;
    if (e.key === 'ArrowRight') n = tabs[(i + 1) % tabs.length];
    else if (e.key === 'ArrowLeft') n = tabs[(i - 1 + tabs.length) % tabs.length];
    else if (e.key === 'Home') n = tabs[0];
    else if (e.key === 'End') n = tabs[tabs.length - 1];
    if (n) { e.preventDefault(); selectTab(n, true); }
  });
  function initTabs(root) {
    $$('[data-tabs]', root || document).forEach(function (w) {
      var tabs = $$('[role=tab]', w), sel = tabs.filter(function (t) { return t.getAttribute('aria-selected') === 'true'; })[0] || tabs[0];
      tabs.forEach(function (t) {
        var on = t === sel, p = document.getElementById(t.getAttribute('aria-controls'));
        t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; if (p) p.hidden = !on;
      });
    });
  }

  /* ═════════════ Toast ═════════════ */
  var SVG = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
  var TOAST_ICONS = {
    success: SVG + '<path d="M5 12l4 4 10-10"/></svg>',
    error: SVG + '<path d="M6 6l12 12M18 6L6 18"/></svg>',
    info: SVG + '<circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v5h1"/></svg>',
    warn: SVG + '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18h.01"/></svg>'
  };
  var activeToasts = {};
  /* NimbleUI.toast(text, {tone: 'success'|'info'|'warn'|'error'|'loading', duration: 3200, sticky: false})
     The same text+tone while visible is not stacked: it shows (×n) and restarts its timer. Returns {el, dismiss()}. */
  NS.toast = function (text, o) {
    o = o || {};
    var tone = o.tone === 'error' || o.tone === 'info' || o.tone === 'warn' || o.tone === 'loading' ? o.tone : 'success', key = tone + '|' + text;
    var box = $('.toasts');
    if (!box) { box = mk('div', 'toasts'); box.setAttribute('role', 'status'); box.setAttribute('aria-live', 'polite'); document.body.appendChild(box); }
    var ex = activeToasts[key];
    if (ex) { ex.count++; ex.msg.textContent = text + ' (×' + ex.count + ')'; clearTimeout(ex.timer); if (!o.sticky && tone !== 'loading') ex.timer = setTimeout(ex.dismiss, o.duration || 3200); return ex; }
    var t = mk('div', 'toast toast--' + tone), icon = mk('span', 'toast__icon'), msg = mk('span', 'toast__message', text);
    if (tone === 'loading') icon.appendChild(mk('span', 'spinner')); else icon.innerHTML = TOAST_ICONS[tone];
    t.append(icon, msg);
    box.appendChild(t);
    var entry = { el: t, msg: msg, count: 1, timer: 0, dismiss: function () { clearTimeout(entry.timer); delete activeToasts[key]; t.remove(); } };
    if (!o.sticky && tone !== 'loading') entry.timer = setTimeout(entry.dismiss, o.duration || 3200);
    activeToasts[key] = entry;
    return entry;
  };

  /* ═════════════ install (PWA) ═════════════ */
  var installEvt = null, INSTALL_ICON = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="M7 11l5 5 5-5"/><path d="M5 21h14"/></svg>';
  function standalone() { return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true; }
  function refreshInstall() {
    var bs = document.querySelectorAll('[data-install]'), show = !!installEvt && !standalone();
    for (var i = 0; i < bs.length; i++) {
      var b = bs[i];
      var ic = b.querySelector('.install-ico') || (b.firstElementChild ? null : b); if (ic && !ic.firstElementChild) ic.innerHTML = INSTALL_ICON;
      if (!b.hasAttribute('aria-label')) b.setAttribute('aria-label', 'Install app');
      if (!b.hasAttribute('title')) b.setAttribute('title', 'Install app');
      b.hidden = !show;
    }
  }
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); installEvt = e; refreshInstall(); });
  window.addEventListener('appinstalled', function () { installEvt = null; refreshInstall(); document.dispatchEvent(new CustomEvent('nimble:install', { detail: { outcome: 'installed' } })); });
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-install]');
    if (!b || !installEvt) return;
    var ev = installEvt; installEvt = null; refreshInstall();
    ev.prompt();
    if (ev.userChoice) ev.userChoice.then(function (c) { document.dispatchEvent(new CustomEvent('nimble:install', { detail: { outcome: c && c.outcome } })); });
  });

  /* ═════════════ boot ═════════════ */
  function init(root) { refreshSortable(root); refreshEditable(root); initTabs(root); refreshInstall(); }
  NS.init = init;
  function boot() {
    init();
    if (window.MutationObserver) new MutationObserver(function (ms) {
      for (var i = 0; i < ms.length; i++) if (ms[i].addedNodes.length) { refreshSortable(); refreshEditable(); return; }
    }).observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
