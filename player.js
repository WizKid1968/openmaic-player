/**
 * OpenCourse — plays a `.maic.zip` classroom export with no OpenMAIC install.
 *
 * The export is a transfer format: OpenMAIC's own docs say it "plays fully
 * offline after import into an air-gapped instance", i.e. it needs the app.
 * This replays it directly.
 *
 * Scope is set by what real courses contain, not by the full 21-verb DSL:
 *   scenes  — slide (canvas JSON), interactive (self-contained HTML), quiz
 *   actions — speech, spotlight, laser, widget_{highlight,setState,annotation,reveal},
 *             discussion
 * Whiteboard verbs (wb_*) and play_video are recognised and skipped rather than
 * faked; they appear in no course this was built against. See README.
 *
 * Fidelity notes, matched to OpenMAIC's own implementation:
 *   - Widget actions are postMessage to the scene iframe using the exact message
 *     names OpenMAIC sends (lib/action/engine.ts): HIGHLIGHT_ELEMENT,
 *     SET_WIDGET_STATE, ANNOTATE_ELEMENT, REVEAL_ELEMENT. Exported interactive
 *     pages already listen for these, so they respond identically.
 *   - Speech blocks the timeline until its audio ends, exactly as the engine does;
 *     with no audio it falls back to a reading-time timer.
 *   - Slides are laid out from their own canvas coordinates and scaled with a
 *     transform, so the authored design is preserved rather than reflowed.
 */

const WIDGET_MS = 400; // matches ActionEngine's post-widget settle delay
const EFFECT_MS = 2000; // spotlight / laser dwell
const READING_CPS = 14; // fallback pace when a speech action has no audio

const $ = (sel) => document.querySelector(sel);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Player {
  constructor() {
    this.manifest = null;
    this.files = new Map(); // zip path -> Blob
    this.urls = new Map(); // zip path -> object URL
    this.scene = 0;
    this.action = -1;
    this.mode = 'idle'; // idle | playing | paused
    this.generation = 0; // cancels an in-flight scene when the user navigates
    this.audio = new Audio();
  }

  // ---------------------------------------------------------------- loading

  async load(file) {
    const zip = await JSZip.loadAsync(file);
    const manifestEntry = zip.file('manifest.json');
    if (!manifestEntry) throw new Error('Not a classroom export: manifest.json is missing.');
    this.manifest = JSON.parse(await manifestEntry.async('string'));

    const entries = Object.values(zip.files).filter((f) => !f.dir && f.name !== 'manifest.json');
    for (const entry of entries) {
      this.files.set(entry.name, await entry.async('blob'));
    }
    this.scenes = (this.manifest.scenes || []).slice().sort((a, b) => a.order - b.order);
  }

  /** Resolve a manifest media ref to a playable URL, lazily. */
  url(ref) {
    if (!ref) return null;
    const entry = (this.manifest.mediaIndex || {})[ref];
    const path = entry && !entry.missing ? entry.zipPath || ref : ref;
    if (!this.files.has(path)) return null;
    if (!this.urls.has(path)) this.urls.set(path, URL.createObjectURL(this.files.get(path)));
    return this.urls.get(path);
  }

  // ---------------------------------------------------------------- scenes

  renderSceneList() {
    $('#scenes').innerHTML = this.scenes
      .map(
        (s, i) =>
          `<li><button data-scene="${i}" class="${i === this.scene ? 'on' : ''}">` +
          `<span class="n">${i + 1}</span><span class="t">${esc(s.title || 'Untitled')}</span>` +
          `<span class="k">${esc(s.type || '')}</span></button></li>`,
      )
      .join('');
    $('#scenes')
      .querySelectorAll('button')
      .forEach((b) => b.addEventListener('click', () => this.goto(Number(b.dataset.scene))));
  }

  goto(index) {
    this.generation += 1;
    this.gestureAudio = null;
    this.stopAudio();
    this.scene = Math.max(0, Math.min(index, this.scenes.length - 1));
    this.action = -1;
    this.mount();
    this.renderSceneList();
    this.status();
  }

  /**
   * Put the current scene on screen, dispatching on scene type exactly as the
   * app's `components/stage/scene-renderer.tsx` does — same components, same
   * branches. Nothing here re-implements a scene.
   */
  mount() {
    const scene = this.scenes[this.scene];
    const stage = $('#stage');
    if (this.host) window.MaicRenderer.unmount(this.host);
    this.host = null;
    this.slideData = null;
    clearTimeout(this.effectTimer);
    stage.innerHTML = '';
    this.frame = null;

    const content = scene.content || {};
    const host = document.createElement('div');
    host.className = 'scene-host';
    stage.appendChild(host);
    this.host = host;
    // Mount synchronously: requestAnimationFrame never fires in a hidden tab,
    // which would leave the scene blank until it is focused.
    const sceneId = scene.id || `scene-${scene.order}`;
    const stageId = this.manifest.stage?.id || 'player';

    if (scene.type === 'quiz' && content.questions) {
      window.MaicRenderer.renderQuiz(host, content, sceneId, stageId);
      this.sceneReady = true;
      this.frameReady = Promise.resolve();
    } else if (scene.type === 'interactive' && (content.html || content.url)) {
      window.MaicRenderer.renderInteractive(host, content, sceneId);
      // The app's renderer builds the iframe; wait for it, then keep a handle
      // so widget actions can be posted into the scene.
      this.sceneReady = false;
      this.frameReady = this.waitForFrame().then(() => {
        this.sceneReady = true;
      });
    } else if (content.canvas) {
      this.slideData = content.canvas;
      window.MaicRenderer.renderSlide(host, content.canvas);
      this.sceneReady = true;
      this.frameReady = Promise.resolve();
    } else {
      host.className = 'empty';
      host.textContent = `This ${scene.type || 'scene'} has no displayable content.`;
      this.sceneReady = true;
      this.frameReady = Promise.resolve();
    }
    $('#sceneTitle').textContent = scene.title || '';
  }

  /**
   * Resolve once the app's iframe pool has created this scene's iframe.
   *
   * The pool portals iframes into `document.body` (not into the scene slot), so
   * look there — `InteractiveIframeHost` positions them over the slot. The
   * handle is kept so widget actions can be posted into the live scene.
   */
  waitForFrame() {
    return new Promise((resolve) => {
      const deadline = Date.now() + 15000;
      const look = () => {
        const frames = [...document.querySelectorAll('iframe')];
        const frame = frames[frames.length - 1];
        if (frame) {
          this.frame = frame;
          // The pool sandboxes without `allow-same-origin`, so `contentDocument`
          // is null by design; wait on `load` and fall through on timeout.
          return frame.addEventListener('load', () => resolve(), { once: true });
        }
        if (Date.now() > deadline) return resolve();
        setTimeout(look, 60);
      };
      look();
    });
  }

  /**
   * Paint a slide with OpenMAIC's own renderer (`@openmaic/renderer`), the same
   * `SlideCanvas` the classroom mounts. A hand-written approximation drifts —
   * tables, borders and font stacks were all wrong — so the app's component is
   * bundled into `vendor/maic-renderer.js` and used verbatim.
   */
  /** Re-render the current slide with a play-time effect applied. */
  applyEffects(effects) {
    if (this.host && this.slideData) {
      window.MaicRenderer.renderSlide(this.host, this.slideData, effects);
    }
  }

  // ---------------------------------------------------------------- playback

  async play() {
    if (this.mode === 'playing') return;
    this.mode = 'playing';
    this.status();
    const gen = ++this.generation;
    await this.frameReady;
    while (this.mode === 'playing' && gen === this.generation) {
      const scene = this.scenes[this.scene];
      const actions = scene.actions || [];
      if (this.action + 1 >= actions.length) {
        if (this.scene + 1 >= this.scenes.length) break; // end of course
        this.scene += 1;
        this.action = -1;
        this.mount();
        this.renderSceneList();
        await this.frameReady;
        continue;
      }
      this.action += 1;
      this.status();
      await this.run(actions[this.action], gen);
    }
    if (gen === this.generation) {
      this.mode = 'idle';
      this.status();
    }
  }

  pause() {
    this.mode = 'paused';
    this.generation += 1;
    this.gestureAudio = null;
    this.stopAudio();
    this.status();
  }

  /** Execute one action, blocking for as long as OpenMAIC's engine would. */
  async run(action, gen) {
    switch (action.type) {
      case 'speech':
        return this.speak(action, gen);

      case 'spotlight':
      case 'laser':
        // Fire-and-forget in OpenMAIC; here it draws a brief ring on the target.
        this.effect(action);
        return sleep(300);

      case 'widget_highlight':
        return this.widget('HIGHLIGHT_ELEMENT', {
          target: action.target,
          content: action.content,
        });
      case 'widget_setState':
        return this.widget('SET_WIDGET_STATE', { state: action.state, content: action.content });
      case 'widget_annotation':
        return this.widget('ANNOTATE_ELEMENT', {
          target: action.target,
          content: action.content,
        });
      case 'widget_reveal':
        return this.widget('REVEAL_ELEMENT', { target: action.target, content: action.content });

      case 'discussion':
        // Discussion is a live multi-agent exchange in OpenMAIC and needs an LLM.
        // Show the scripted lines that survived the export instead of pretending.
        return this.discussion(action);

      default:
        return; // wb_* / play_video — recognised, not faked
    }
  }

  /**
   * Prime the audio element inside a real user gesture.
   *
   * iOS Safari refuses programmatic `play()` unless the element has already
   * played during a user interaction. Without this the first narration is
   * rejected, every speech action resolves instantly, and the course races
   * through in silence — which is exactly what an iPad shows. Playing a short
   * silent clip on the Play click satisfies the gesture requirement for every
   * later `play()` on the same element.
   */
  /**
   * Start the next narration clip synchronously, inside the Play tap.
   *
   * iOS only permits audio that a person started, and a gesture does not
   * survive an `await` — by the time the timeline reaches the first clip the
   * permission is gone, so playback is refused and the course runs silently.
   * Starting that clip in the tap itself is not a workaround for the rule; it
   * is the rule. Every later clip on the same element is then allowed.
   *
   * Only runs when the scene is already on screen, so narration can never lead
   * a slide that has not painted. On desktop this simply starts the same clip a
   * fraction of a second earlier than the timeline would have.
   */
  startFirstSpeechOnGesture() {
    if (!this.sceneReady || this.mode === 'playing') return;
    const actions = this.scenes[this.scene]?.actions || [];
    // Scenes usually open with a visual (spotlight) before the first line, so
    // look forward for the first narration rather than only the next action.
    const next = actions.slice(this.action + 1).find((a) => a.type === 'speech');
    if (!next) return;
    const src = this.url(next.audioRef);
    if (!src) return;

    // Start it here — this tap is the only moment iOS grants audio — then hold
    // it at the start so it is still heard at its own place in the timeline.
    // Holding is what keeps ordering exact; the permission itself is real,
    // earned by playing this course's own clip from a real tap.
    this.audio.src = src;
    this.audio.playbackRate = Number($('#speed').value) || 1;
    const started = this.audio
      .play()
      .then(() => {
        this.audio.pause();
        this.audio.currentTime = 0;
        return true;
      })
      .catch(() => false);
    this.gestureAudio = { action: next, started };
  }

  /**
   * Play `src` on the shared element. Resolves true when it finishes, false if
   * playback was refused or the file failed — the caller paces accordingly.
   */
  startClip(src, alreadyLoaded = false) {
    return new Promise((resolve) => {
      const done = (ok) => resolve(ok);
      this.audio.onended = () => done(true);
      this.audio.onerror = () => done(false);
      // Re-assigning src would discard the gesture-granted permission.
      if (!alreadyLoaded) this.audio.src = src;
      this.audio.playbackRate = Number($('#speed').value) || 1;
      this.audio.play().catch(() => done(false));
      this.cancelAudio = () => done(true); // a deliberate stop is not a failure
    });
  }

  /** How long a speech action should hold when its audio cannot play. */
  readingMs(text) {
    return Math.min(20000, Math.max(1200, (text.length / READING_CPS) * 1000));
  }

  async speak(action, gen) {
    const text = action.text || '';
    $('#caption').textContent = text;
    const src = this.url(action.audioRef);
    if (!src) {
      // No narration in this export: hold for a readable beat, as the engine does.
      await sleep(this.readingMs(text));
      return;
    }
    // Resume the clip the tap already primed, rather than starting a fresh one
    // outside the gesture — a fresh start is exactly what iOS refuses.
    const primed = this.gestureAudio && this.gestureAudio.action === action;
    if (primed) await this.gestureAudio.started;
    this.gestureAudio = null;
    const played = await this.startClip(src, primed);
    if (gen !== this.generation) return;
    if (played) $('#audioNote').hidden = true;
    if (!played) {
      // Playback was refused or the file failed. Pace by reading time instead of
      // advancing immediately, so the deck does not fly past in silence.
      $('#audioNote').hidden = false;
      await sleep(this.readingMs(text));
    }
  }

  widget(type, payload) {
    if (this.frame && this.frame.contentWindow) {
      this.frame.contentWindow.postMessage({ type, ...payload }, '*');
    }
    return sleep(WIDGET_MS);
  }

  effect(action) {
    // Slide effects address a canvas element by `elementId` (the DSL field);
    // `target` is the widget/interactive addressing scheme. Accept either.
    const elementId = action.elementId || action.target;
    if (!elementId || !this.slideData) return;
    const duration = action.duration || EFFECT_MS;
    this.applyEffects(
      action.type === 'laser'
        ? { laser: { elementId, ...(action.color ? { color: action.color } : {}) } }
        : { spotlight: { elementId } },
    );
    clearTimeout(this.effectTimer);
    this.effectTimer = setTimeout(() => this.applyEffects(undefined), duration);
  }

  async discussion(action) {
    const lines = action.messages || action.script || [];
    if (!lines.length) return;
    for (const line of lines) {
      $('#caption').textContent =
        typeof line === 'string' ? line : `${line.speaker || ''}: ${line.text || ''}`;
      await sleep(1800);
    }
  }

  stopAudio() {
    try {
      this.audio.pause();
      this.audio.currentTime = 0;
    } catch {
      /* a never-played element throws on seek; nothing to reset */
    }
    if (this.cancelAudio) {
      this.cancelAudio();
      this.cancelAudio = null;
    }
  }

  status() {
    const total = (this.scenes[this.scene]?.actions || []).length;
    $('#pos').textContent =
      `Scene ${this.scene + 1}/${this.scenes.length}` +
      (total ? ` · step ${Math.max(this.action + 1, 0)}/${total}` : '');
    $('#play').textContent = this.mode === 'playing' ? '❚❚ Pause' : '▶ Play';
  }
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const cssEsc = (s) => String(s).replace(/["\\]/g, '\\$&');

// ------------------------------------------------------------------ wiring

const player = new Player();

async function open(file) {
  $('#drop').classList.add('busy');
  $('#dropText').textContent = 'Reading course…';
  try {
    await player.load(file);
    $('#drop').hidden = true;
    $('#app').hidden = false;
    $('#courseTitle').textContent = player.manifest.stage?.name || 'Course';
    player.goto(0);
  } catch (err) {
    $('#dropText').textContent = String(err.message || err);
    $('#drop').classList.remove('busy');
  }
}

$('#file').addEventListener('change', (e) => e.target.files[0] && open(e.target.files[0]));
$('#drop').addEventListener('dragover', (e) => {
  e.preventDefault();
  $('#drop').classList.add('over');
});
$('#drop').addEventListener('dragleave', () => $('#drop').classList.remove('over'));
$('#drop').addEventListener('drop', (e) => {
  e.preventDefault();
  $('#drop').classList.remove('over');
  const f = e.dataTransfer.files[0];
  if (f) open(f);
});
$('#play').addEventListener('click', () => {
  // Synchronously, before any await: this is the only moment iOS grants audio.
  player.startFirstSpeechOnGesture();
  return player.mode === 'playing' ? player.pause() : player.play();
});
$('#prev').addEventListener('click', () => player.goto(player.scene - 1));
$('#next').addEventListener('click', () => player.goto(player.scene + 1));
$('#speed').addEventListener('change', () => {
  player.audio.playbackRate = Number($('#speed').value) || 1;
});
