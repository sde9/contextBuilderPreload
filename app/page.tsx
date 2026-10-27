'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import Canvas from '@/components/Canvas';
import Composer from '@/components/Composer';
import OpenQuestionsPanel from '@/components/OpenQuestionsPanel';
import FinishPanel from '@/components/FinishPanel';
import GoalBadge from '@/components/GoalBadge';
import GoalStart from '@/components/GoalStart';
import RestoreBar from '@/components/RestoreBar';
import { useSession } from '@/lib/store';
import { visibleConcepts } from '@/lib/reducer';
import { saveSession } from '@/lib/persist';
import ShapeLegend, { LIVE_SHAPES } from '@/components/ShapeLegend';

/** How long the model must sit still before it is written to the browser. */
const AUTOSAVE_MS = 800;

/** RT-US-18. How a session goes, in four steps, and what the colours mean. */
function StartSteps() {
  return (
    <div className="start-steps">
      <ol>
        <li>Set a goal: what you want to get out of the conversation.</li>
        <li>Talk, or paste what was just said, and press Continue.</li>
        <li>Answer the questions under the map, or put them off with Later.</li>
        <li>Press Finish to keep the questions that matter and get a report.</li>
      </ol>
      <p className="start-colours">
        <span className="k-green">Green</span> is what was said. <span className="k-orange">Orange</span> is a guess to
        confirm or reject. A <span className="k-question">question</span> gets an answer.
      </p>
    </div>
  );
}

export default function Page() {
  const model = useSession((s) => s.model);
  const suggestions = useSession((s) => s.suggestions);
  const toggle = useSession((s) => s.toggleSuggestions);
  const autoTidy = useSession((s) => s.autoTidy);
  const toggleAutoTidy = useSession((s) => s.toggleAutoTidy);
  const download = useSession((s) => s.download);
  const exportDrawio = useSession((s) => s.exportDrawio);
  const exportMermaid = useSession((s) => s.exportMermaid);
  const openFile = useSession((s) => s.openFile);
  const reset = useSession((s) => s.reset);
  const showLinks = useSession((s) => s.showLinks);
  const toggleLinks = useSession((s) => s.toggleLinks);
  const openFinish = useSession((s) => s.openFinish);
  const lastMs = useSession((s) => s.lastMs);
  const fileInput = useRef<HTMLInputElement>(null);

  const concepts = visibleConcepts(model);
  const green = concepts.filter((c) => c.status === 'VALIDATED').length;
  const orange = concepts.length - green;
  const started = model.turn > 0;

  // RT-US-16. Keep the session in this browser. Debounced, because the layout
  // animation changes the model on every frame.
  useEffect(() => {
    let timer: number | undefined;
    const unsubscribe = useSession.subscribe((s, prev) => {
      if (s.model === prev.model) return;
      if (s.model.turn === 0 && !s.model.goal) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => saveSession(useSession.getState().model), AUTOSAVE_MS);
    });
    return () => {
      unsubscribe();
      window.clearTimeout(timer);
    };
  }, []);

  // RT-US-16. Ask before the tab closes once there is something to lose.
  useEffect(() => {
    if (!started) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [started]);

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <strong>Context Builder</strong>
          <span className="sub">
            Enabler · V0 prototype
            {process.env.NEXT_PUBLIC_APP_VERSION && ` · v${process.env.NEXT_PUBLIC_APP_VERSION}`}
            {process.env.NEXT_PUBLIC_GIT_SHA && ` (${process.env.NEXT_PUBLIC_GIT_SHA})`}
          </span>
        </div>

        <nav className="mode-switch">
          <span className="mode-on">Real-time</span>
          <Link className="mode-off" href="/preload">
            Preload
          </Link>
        </nav>

        <GoalBadge />

        <div className="counts">
          <span className="pill pill-green">{green} said</span>
          <span className="pill pill-orange">{orange} guessed</span>
          <span className="pill pill-plain">turn {model.turn}</span>
          {lastMs.extract > 0 && <span className="pill pill-plain">{(lastMs.extract / 1000).toFixed(1)}s</span>}
        </div>

        <div className="tools">
          {/* The escape hatch. If proposals go bad live, switch them off and keep going. */}
          <label className="toggle" title="Turn off if the AI's guesses stop being useful">
            <input type="checkbox" checked={suggestions} onChange={toggle} />
            AI suggestions
          </label>
          {/* Off means the map holds still between turns and only Tidy up re-arranges it. */}
          <label className="toggle" title="Re-arrange the whole map after every turn">
            <input type="checkbox" checked={autoTidy} onChange={toggleAutoTidy} />
            Auto-layout
          </label>
          {/* RT-US-19. Hides the links on screen only. Boxes stay where they are; the file keeps every link. */}
          <label className="toggle" title="Show or hide the links between boxes">
            <input type="checkbox" checked={showLinks} onChange={toggleLinks} />
            Links
          </label>
          <button className="btn-finish" onClick={openFinish} disabled={!started} title="Review open questions, get topics for next time and a report">
            Finish
          </button>
          <button onClick={download} disabled={!started}>
            Download
          </button>
          <button onClick={exportDrawio} disabled={!started} title="Open in draw.io / diagrams.net">
            draw.io
          </button>
          <button onClick={exportMermaid} disabled={!started} title="Mermaid flowchart source (.mmd)">
            Mermaid
          </button>
          <button onClick={() => fileInput.current?.click()} title="Open a downloaded .context.json session">
            Open
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              if (started && !confirm('Open this file? It replaces the session on screen.')) return;
              void openFile(file);
            }}
          />
          <button
            onClick={() => {
              const empty = !started && !model.goal;
              if (
                empty ||
                confirm('Start a new session? The current one is cleared from this browser. Download it first to keep it.')
              )
                reset();
            }}
          >
            New
          </button>
        </div>
      </header>

      <RestoreBar />

      <div className="workspace">
        <section className="canvas">
          {model.turn === 0 && !model.goal && (
            <div className="empty">
              <h1>Start with the goal.</h1>
              <p>Say what you want to get out of the conversation. The AI uses it to choose what to ask.</p>
              <GoalStart />
              <StartSteps />
            </div>
          )}
          {model.turn === 0 && model.goal && (
            <div className="empty">
              <h1>Say something and watch it take shape.</h1>
              <StartSteps />
              <p className="hint">
                Try: <em>&ldquo;I am working on the payment process for my Unison choir.&rdquo;</em>
              </p>
            </div>
          )}
          <Canvas />
        </section>
        <OpenQuestionsPanel />
      </div>

      <FinishPanel />

      <footer className="bottom">
        <div className="legend">
          <span className="k-green">■</span> said &nbsp;
          <span className="k-orange">■</span> a guess: confirm or reject &nbsp;
          <span className="k-question">■</span> a question: answer it, put it off with Later, or dismiss it
        </div>
        <ShapeLegend kinds={LIVE_SHAPES} sizeNote={false} />
        <Composer />
      </footer>
    </main>
  );
}
