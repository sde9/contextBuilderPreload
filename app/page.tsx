'use client';

import Link from 'next/link';
import Canvas from '@/components/Canvas';
import Composer from '@/components/Composer';
import GapBar from '@/components/GapBar';
import { useSession } from '@/lib/store';
import { visibleConcepts } from '@/lib/reducer';

export default function Page() {
  const model = useSession((s) => s.model);
  const suggestions = useSession((s) => s.suggestions);
  const toggle = useSession((s) => s.toggleSuggestions);
  const autoTidy = useSession((s) => s.autoTidy);
  const toggleAutoTidy = useSession((s) => s.toggleAutoTidy);
  const download = useSession((s) => s.download);
  const exportDrawio = useSession((s) => s.exportDrawio);
  const exportMermaid = useSession((s) => s.exportMermaid);
  const reset = useSession((s) => s.reset);
  const lastMs = useSession((s) => s.lastMs);

  const concepts = visibleConcepts(model);
  const green = concepts.filter((c) => c.status === 'VALIDATED').length;
  const orange = concepts.length - green;

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
          <button onClick={download} disabled={model.turn === 0}>
            Download
          </button>
          <button onClick={exportDrawio} disabled={model.turn === 0} title="Open in draw.io / diagrams.net">
            draw.io
          </button>
          <button onClick={exportMermaid} disabled={model.turn === 0} title="Mermaid flowchart source (.mmd)">
            Mermaid
          </button>
          <button
            onClick={() => {
              if (model.turn === 0 || confirm('Start a new session? The current one is not saved.')) reset();
            }}
          >
            New
          </button>
        </div>
      </header>

      <div className="workspace">
        <section className="canvas">
          {model.turn === 0 && (
            <div className="empty">
              <h1>Say something and watch it take shape.</h1>
              <p>
                Paste a piece of what someone just said, then press Continue.
                <br />
                <span className="k-green">Green</span> is what they said.{' '}
                <span className="k-orange">Orange</span> is what the AI guessed.
              </p>
              <p className="hint">
                Try: <em>&ldquo;I am working on the payment process for my Unison choir.&rdquo;</em>
              </p>
            </div>
          )}
          <Canvas />
        </section>
        <GapBar />
      </div>

      <footer className="bottom">
        <div className="legend">
          <span className="k-green">■</span> said &nbsp;
          <span className="k-orange">■</span> guessed, needs a yes or no
        </div>
        <div className="kind-legend">
          <span className="kind-legend-item"><span className="kind-swatch kind-swatch-entity" /> Entity</span>
          <span className="kind-legend-item"><span className="kind-swatch kind-swatch-attribute" /> Attribute</span>
          <span className="kind-legend-item"><span className="kind-swatch kind-swatch-actor" /> Actor</span>
          <span className="kind-legend-item"><span className="kind-swatch kind-swatch-step" /> Step</span>
          <span className="kind-legend-item"><span className="kind-swatch kind-swatch-rule" /> Rule</span>
          <span className="kind-legend-item"><span className="kind-swatch kind-swatch-question" /> Question</span>
          <span className="kind-legend-item"><span className="kind-swatch kind-swatch-problem" /> Problem</span>
        </div>
        <Composer />
      </footer>
    </main>
  );
}
