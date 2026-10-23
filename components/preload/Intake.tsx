'use client';

import { useRef, useState } from 'react';
import { usePreload } from '@/lib/preloadStore';
import { ROLE_LABEL, SOURCE_ROLES, type SourceRole } from '@/lib/types';
import { UPLOAD_LIMIT } from '@/lib/limits';

/*
 * Screen 1. Files in, and one sentence about the project.
 *
 * The role dropdown next to each file is the only thing on this screen the
 * user has to think about, and it is the one that pays for itself: when two
 * documents disagree, the merge lists the stronger one first (R9).
 *
 * Nothing is spent until Build is pressed. What you see here — chunk counts,
 * a file that gave nothing — comes from parsing alone.
 */
export default function Intake() {
  const model = usePreload((s) => s.model);
  const busy = usePreload((s) => s.busy);
  const error = usePreload((s) => s.error);
  const create = usePreload((s) => s.create);
  const setRole = usePreload((s) => s.setRole);
  const build = usePreload((s) => s.build);
  const act = usePreload((s) => s.act);
  const reset = usePreload((s) => s.reset);
  const uploading = usePreload((s) => s.uploading);

  const [title, setTitle] = useState('');
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const take = (list: FileList | null) => {
    if (!list?.length) return;
    void create([...list], title || 'Untitled project');
  };

  const readable = model?.sources.filter((s) => s.parse === 'OK') ?? [];
  const chunks = readable.reduce((n, s) => n + s.chunkCount, 0);

  return (
    <div className="intake">
      <div className="intake-main">
        <div
          className={`drop ${over ? 'drop-over' : ''} ${busy ? 'drop-busy' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            take(e.dataTransfer.files);
          }}
          onClick={() => input.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') input.current?.click();
          }}
        >
          <strong>
            {busy
              ? uploading.total > 1
                ? `Reading the files… ${uploading.done} of ${uploading.total}`
                : 'Reading the files…'
              : 'Drop the project files here'}
          </strong>
          <span>PDF · DOCX · MD · TXT · CSV · transcripts · up to {UPLOAD_LIMIT} each</span>
          <input
            ref={input}
            type="file"
            multiple
            hidden
            onChange={(e) => take(e.target.files)}
            accept=".pdf,.docx,.md,.markdown,.txt,.csv,.tsv,.json,.log,.srt,.vtt,.html,.xml,.yaml,.yml"
          />
        </div>

        {error && <div className="error">{error}</div>}

        {model && model.sources.length > 0 && (
          <>
            <div className="intake-count">
              {model.sources.length} {model.sources.length === 1 ? 'file' : 'files'} · {chunks} sections to read
            </div>

            <ul className="file-list">
              {model.sources.map((s) => (
                <li key={s.id} className={`file-row file-${s.parse.toLowerCase()}`}>
                  <span className="file-name">{s.name}</span>

                  {s.parse === 'OK' ? (
                    <select
                      className="role-select"
                      value={s.role}
                      onChange={(e) => void setRole(s.id, e.target.value as SourceRole)}
                      title="What kind of document is this? Used when two documents disagree."
                    >
                      {SOURCE_ROLES.map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABEL[r]}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="role-select role-none">—</span>
                  )}

                  <span className="file-state">
                    {s.parse === 'OK' ? `${s.chunkCount} sections` : s.parseNote}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <aside className="intake-side">
        <label className="side-label" htmlFor="project-title">
          What is this project?
        </label>
        <textarea
          id="project-title"
          className="side-input"
          rows={3}
          value={title || model?.title === 'Untitled project' ? title : (model?.title ?? title)}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => {
            if (model && title.trim()) void act({ kind: 'title', title });
          }}
          placeholder="Replacing the manual booking process for a costume rental"
        />
        <p className="side-hint">One sentence. It becomes the title, and it frames the gap analysis at the end.</p>

        <div className="side-actions">
          <button className="primary" onClick={() => void build()} disabled={!readable.length || busy}>
            Build the map
          </button>
          {model && (
            <button onClick={reset} disabled={busy}>
              Start over
            </button>
          )}
        </div>

        {model && !readable.length && model.sources.length > 0 && (
          <p className="side-warn">None of these files produced readable text. Nothing to build from.</p>
        )}
      </aside>
    </div>
  );
}
