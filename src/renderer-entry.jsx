/**
 * Bundle entry: exposes OpenMAIC's own scene components to the plain-JS player.
 *
 * Nothing here re-implements the app. `SlideCanvas`, `QuizView` and
 * `InteractiveRenderer` are the exact components the classroom mounts (see
 * `components/stage/scene-renderer.tsx`, which dispatches on scene type the
 * same way `mountScene` below does). Bundling them is what makes the player
 * look identical rather than approximate.
 *
 * Built to `vendor/maic-renderer.js`; sets `window.MaicRenderer`.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { SlideCanvas } from '@openmaic/renderer';
import { I18nProvider } from '@/lib/hooks/use-i18n';
import { QuizView } from '@/components/scene-renderers/quiz-view';
import { InteractiveRenderer } from '@/components/scene-renderers/interactive-renderer';
import { InteractiveIframeHost } from '@/components/scene-renderers/InteractiveIframeHost';

const roots = new WeakMap();

/**
 * The app's scene components read translations through `useI18n`, which throws
 * outside `I18nProvider`. Wrapping here is what the app's layout does, so the
 * components run unmodified.
 */
const withProviders = (node) => React.createElement(I18nProvider, null, node);

function rootFor(container) {
  let root = roots.get(container);
  if (!root) {
    root = createRoot(container);
    roots.set(container, root);
  }
  return root;
}

/** Slide scene — the app's renderer, with its own play-time effects. */
function renderSlide(container, slide, effects) {
  rootFor(container).render(
    withProviders(React.createElement(SlideCanvas, {
      slide,
      canvasPercentage: 100,
      ...(effects ? { effects } : {}),
    })),
  );
}

/**
 * Quiz scene — the app's `QuizView`, so the cover card, question flow, scoring
 * and result screen are the real ones.
 *
 * `sceneId`/`stageId` are what QuizView uses to key its own attempt state; the
 * player passes the scene's ids straight through.
 */
function renderQuiz(container, content, sceneId, stageId) {
  rootFor(container).render(
    withProviders(
      React.createElement(QuizView, {
        key: sceneId,
        questions: content.questions,
        sceneId,
        stageId,
      }),
    ),
  );
}

/**
 * The iframe host is mounted exactly once, in its own root — the app does the
 * same in `components/stage.tsx`. It portals its iframes into `document.body`
 * and resets the keep-alive pool when it unmounts, so mounting it per scene
 * would tear down every iframe on each scene change.
 */
let hostRoot = null;
function ensureInteractiveHost() {
  if (hostRoot) return;
  const holder = document.createElement('div');
  holder.id = 'maic-iframe-host';
  document.body.appendChild(holder);
  hostRoot = createRoot(holder);
  hostRoot.render(withProviders(React.createElement(InteractiveIframeHost, null)));
}

/**
 * Interactive scene.
 *
 * `InteractiveRenderer` is only a placeholder: it registers the scene in the
 * keep-alive pool, marks it active, and reports its on-screen rect. The real
 * iframe is created by the host above and positioned over this slot.
 */
function renderInteractive(container, content, sceneId) {
  ensureInteractiveHost();
  rootFor(container).render(
    withProviders(React.createElement(InteractiveRenderer, { content, sceneId })),
  );
}

function unmount(container) {
  const root = roots.get(container);
  if (root) {
    root.unmount();
    roots.delete(container);
  }
}

window.MaicRenderer = { renderSlide, renderQuiz, renderInteractive, unmount };
