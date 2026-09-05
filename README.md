# OpenCourse

Plays a `.maic.zip` classroom export **without an OpenMAIC install**.

OpenMAIC's classroom ZIP is a transfer format, not a playable one — the project's
own docs say an export "plays fully offline *after import into an air-gapped
instance*". That means every learner needs the whole app, a database, and model
keys just to watch a finished course. This plays the ZIP directly in a browser.

## Use

```bash
cd opencourse-player && python3 -m http.server 4174
```

Open <http://localhost:4174>, then drop a `.maic.zip` on the page.

Nothing is uploaded — the ZIP is read in the browser. The folder is static, so it
can also be published to any static host and shared as a link.

## How it works

Nothing here re-implements a scene. The player bundles OpenMAIC's **own**
components and dispatches on scene type exactly as
`components/stage/scene-renderer.tsx` does:

| Scene | Component used |
| --- | --- |
| `slide` | `SlideCanvas` from `@openmaic/renderer` |
| `quiz` | `QuizView` from `components/scene-renderers/quiz-view.tsx` |
| `interactive` | `InteractiveRenderer` **plus** `InteractiveIframeHost` |

They are wrapped in the app's `I18nProvider` (as its layout does) and styled
with the app's own Tailwind build, so the quiz cover, question flow, scoring and
result screen are the real ones — not a lookalike.

Two details the app handles implicitly and the player must reproduce:

- `InteractiveRenderer` is only a *placeholder*. It registers the scene in a
  keep-alive pool and reports its on-screen rect; the iframe itself is created by
  `InteractiveIframeHost`, which portals into `document.body`. The host resets
  the pool when it unmounts, so the player mounts it **once** in its own root —
  mounting it per scene tore down every iframe on each scene change.
- React must be deduplicated. pnpm gives nested packages their own `react` link,
  so an unpinned bundle contains two copies, two context registries, and every
  `useX must be used within XProvider` throws. `build.mjs` pins one.

## What it plays

Scope was set by measuring what real courses actually contain, not by the DSL's
full 21-verb surface:

| | |
| --- | --- |
| **Scenes** | `slide` (canvas JSON, laid out from its own coordinates), `interactive` (self-contained HTML in an iframe), `quiz` |
| **Actions** | `speech`, `spotlight`, `laser`, `widget_highlight`, `widget_setState`, `widget_annotation`, `widget_reveal`, `discussion` |

Those eight verbs are **100%** of the actions across the courses this was built
against (184 speech, 88 spotlight, 57 widget_highlight, 17 widget_setState,
12 widget_annotation, 7 laser, 3 widget_reveal, 2 discussion).

### Fidelity

- **Widget actions** are `postMessage`d into the scene iframe using the exact
  message names OpenMAIC sends (`HIGHLIGHT_ELEMENT`, `SET_WIDGET_STATE`,
  `ANNOTATE_ELEMENT`, `REVEAL_ELEMENT` — see `lib/action/engine.ts`). Exported
  interactive pages already listen for these, so they behave identically.
- **Speech** blocks the timeline until its audio ends, as the engine does. With
  no audio it falls back to a reading-time timer rather than racing ahead.
- **Slides use OpenMAIC's own renderer.** `@openmaic/renderer`'s `SlideCanvas`
  — the very component the classroom mounts — is bundled into
  `vendor/maic-renderer.js`, so tables, borders, theme fonts and text layout are
  identical rather than approximated.
- **Spotlight/laser are the renderer's own effects**, passed through its
  `effects` prop, so they look exactly as they do in the app. They address a
  canvas element by `elementId` (the DSL field); `target` is accepted too.

## What it does not do

Stated plainly rather than faked:

- **Whiteboard verbs** (`wb_*`) and `play_video` are recognised and skipped. No
  course this was built against used them; implementing them blind would be
  guesswork.
- **Discussion** is a live multi-agent exchange in OpenMAIC and needs an LLM at
  runtime. The player shows whatever scripted lines survived the export.
- **No text-to-speech.** Narration plays only if the ZIP carries audio. A ZIP
  exported before voice was generated is silent; the captions still show.
- This is a **player**, not an editor or generator.

## Requires a visible tab

The app's scenes animate with `motion/react`, and `AnimatePresence mode="wait"`
holds a transition until its exit animation finishes. Animation frames do not
run while a tab reports `document.visibilityState === 'hidden'`, so in a hidden
or headless tab a quiz stays on its cover and slides can appear unanimated.
This is browser behaviour, not player state — in a normal visible window it
plays through.

## Rebuilding the renderer bundle

```bash
node build.mjs            # OPENMAIC_DIR=... to point at another checkout
```

`build.mjs` bundles the components with esbuild. The scene components sit on the
same import graph as server-only code (provider config, Postgres stores,
undici), so every Node builtin resolves to `src/node-stub.js`; none of it runs
in the browser. A `process` shim is injected because app modules read
`process.env.*` at runtime.

The bundle is ~13 MB — it carries React, the components, and the renderer's
embedded KaTeX fonts. That is the cost of being the app rather than resembling it.

`vendor/maic-app.css` is the app's own Tailwind build, compiled from
`app/globals.css` with the same PostCSS plugin Next uses. The player sets
`class="dark"` on `<html>` because the app's theme tokens are scoped to `.dark`.

## Testing

`sample-course.maic.zip` is built from real course data for smoke-testing:

```bash
python3 make-sample.py <stage_id>   # rebuild from a local OpenMAIC Postgres
```

Verified against it: 5 scenes and 52 actions load, slides render, playback
advances, spotlight resolves to the right element, and all four widget messages
are received inside the interactive scene.
