import { Clapperboard } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { sanitizeName, saveFile } from '../io/files';
import { renderVideo, videoSupported } from '../io/video';
import { timeline } from '../model/presentation';
import { set, toast, useStore, useViewDoc, vdoc } from '../store/store';
import { Field, Segmented, Toggle } from './controls';
import { Modal } from './Dialogs';
import { fmtTime } from './Timeline';

const SIZES = { 720: [1280, 720], 1080: [1920, 1080], 1440: [2560, 1440] } as const;

/** Renders the presentation timeline to an MP4 / WebM file. */
export function VideoDialog() {
  const doc = useViewDoc();
  const dark = useStore((s) => s.prefs.theme === 'dark');
  const [size, setSize] = useState<keyof typeof SIZES>(1080);
  const [fps, setFps] = useState(30);
  const [theme, setTheme] = useState<'light' | 'dark'>(dark ? 'dark' : 'light');
  const [captions, setCaptions] = useState(true);
  const [progress, setProgress] = useState<number | null>(null);
  const abort = useRef<AbortController | null>(null);
  const { entries, total } = useMemo(() => timeline(doc), [doc]);
  const busy = progress !== null;

  const close = () => {
    abort.current?.abort();
    set({ dialog: null });
  };

  const run = async () => {
    const ctl = new AbortController();
    abort.current = ctl;
    setProgress(0);
    try {
      const [width, height] = SIZES[size];
      const t0 = performance.now();
      const { blob, ext } = await renderVideo(vdoc(), { width, height, fps, theme, captions, signal: ctl.signal, onProgress: setProgress });
      const name = `${sanitizeName(vdoc().name)}.${ext}`;
      const res = await saveFile(blob, name, [{ name: ext === 'mp4' ? 'MP4 video' : 'WebM video', extensions: [ext] }]);
      if (res !== false) toast(`Video saved (${(blob.size / 1e6).toFixed(1)} MB, rendered in ${((performance.now() - t0) / 1000).toFixed(0)}s)`, 'success');
      set({ dialog: null });
    } catch (e) {
      if ((e as Error).name !== 'AbortError') toast(`Video export failed: ${(e as Error).message}`, 'error');
      setProgress(null);
    }
  };

  return (
    <Modal title="Export video" onClose={close} width={460}>
      <div className="export-opts">
        <Field label="Resolution">
          <Segmented
            value={size}
            options={[
              { value: 720, label: '720p' },
              { value: 1080, label: '1080p' },
              { value: 1440, label: '1440p' },
            ]}
            onChange={setSize}
          />
        </Field>
        <Field label="Frame rate">
          <Segmented
            value={fps}
            options={[
              { value: 24, label: '24' },
              { value: 30, label: '30' },
              { value: 60, label: '60' },
            ]}
            onChange={setFps}
          />
        </Field>
        <Field label="Theme">
          <Segmented
            value={theme}
            options={[
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
            onChange={setTheme}
          />
        </Field>
        <Field label="Captions" hint="Callout notes and frame titles, shown as each step arrives">
          <Toggle checked={captions} onChange={setCaptions} />
        </Field>
      </div>
      <div className="video-foot">
        <span className="muted small">
          {entries.length} step{entries.length === 1 ? '' : 's'} · {fmtTime(total)} · timing from the timeline
        </span>
        {busy ? (
          <div className="video-progress">
            <div>
              <i style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
            <span className="mono small">{Math.round(progress * 100)}%</span>
            <button className="secondary-btn" onClick={() => abort.current?.abort()}>
              Cancel
            </button>
          </div>
        ) : (
          <button className="primary-btn" onClick={run} disabled={!entries.length || !videoSupported()} title={videoSupported() ? '' : 'This browser cannot encode video (no WebCodecs)'}>
            <Clapperboard size={15} /> Render
          </button>
        )}
      </div>
    </Modal>
  );
}
