import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';

const widthKey = 'workday.project-sidebar-width';

function readWidth(): number | null {
  try {
    const value = Number(window.localStorage.getItem(widthKey));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch { return null; }
}

export function ProjectSidebar({ children }: { children: ReactNode }) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const handle = useRef<HTMLDivElement>(null);
  const preferred = useRef<number | null | undefined>(undefined);
  if (preferred.current === undefined) preferred.current = readWidth();
  const drag = useRef<{ pointer: number; x: number; width: number; previous: number | null } | null>(null);
  const measured = useRef({ width: 0, min: 0, max: 0, step: 16 });
  const [values, setValues] = useState({ width: 0, min: 0, max: 0 });

  function update() {
    const workspace = root.current?.closest<HTMLElement>('.workspace.projects');
    if (!workspace || !workspace.clientWidth) return;
    const style = getComputedStyle(workspace);
    const px = (name: string) => parseFloat(style.getPropertyValue(name));
    const room = Math.max(0, workspace.clientWidth - px('--size-projectChatMin'));
    const min = Math.min(px('--size-projectSidebarMin'), room);
    const max = Math.max(min, Math.min(px('--size-projectSidebarMax'), room));
    const width = Math.round(Math.min(max, Math.max(min, preferred.current ?? px('--project-sidebar-default'))));
    measured.current = { width, min, max, step: px('--size-projectSidebarStep') };
    workspace.style.setProperty('--project-sidebar-width', `${width}px`);
    setValues(previous => previous.width === width && previous.min === min && previous.max === max ? previous : { width, min, max });
  }

  function save() {
    try {
      if (preferred.current === null) window.localStorage.removeItem(widthKey);
      else window.localStorage.setItem(widthKey, String(preferred.current));
    } catch { /* Resizing still works when preference storage is unavailable. */ }
  }

  function finish(commit: boolean) {
    const active = drag.current;
    if (!active) return;
    drag.current = null;
    const workspace = root.current?.closest<HTMLElement>('.workspace.projects');
    if (workspace) delete workspace.dataset.resizingSidebar;
    if (commit) save();
    else { preferred.current = active.previous; update(); }
    if (handle.current?.hasPointerCapture(active.pointer)) handle.current.releasePointerCapture(active.pointer);
  }

  useLayoutEffect(() => {
    const workspace = root.current!.closest<HTMLElement>('.workspace.projects')!;
    const observer = new ResizeObserver(update);
    observer.observe(workspace);
    const themeObserver = new MutationObserver(update);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-theme'] });
    const blur = () => finish(true);
    window.addEventListener('blur', blur);
    update();
    return () => {
      observer.disconnect(); themeObserver.disconnect(); window.removeEventListener('blur', blur);
      drag.current = null;
      workspace.style.removeProperty('--project-sidebar-width');
      delete workspace.dataset.resizingSidebar;
    };
  }, []);

  function start(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || drag.current) return;
    event.preventDefault();
    event.currentTarget.focus();
    update();
    drag.current = { pointer: event.pointerId, x: event.clientX, width: measured.current.width, previous: preferred.current ?? null };
    event.currentTarget.setPointerCapture(event.pointerId);
    root.current!.closest<HTMLElement>('.workspace.projects')!.dataset.resizingSidebar = 'true';
  }

  function move(event: PointerEvent<HTMLDivElement>) {
    const active = drag.current;
    if (!active || active.pointer !== event.pointerId) return;
    preferred.current = Math.min(measured.current.max, Math.max(measured.current.min, active.width + event.clientX - active.x));
    update();
  }

  function reset() {
    finish(false);
    preferred.current = null;
    update(); save();
  }

  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' && drag.current) { event.preventDefault(); finish(false); return; }
    if (drag.current) return;
    update();
    const { width, min, max, step } = measured.current;
    const next = event.key === 'ArrowLeft' ? width - step : event.key === 'ArrowRight' ? width + step : event.key === 'Home' ? min : event.key === 'End' ? max : null;
    if (next === null) return;
    event.preventDefault();
    preferred.current = Math.min(max, Math.max(min, next));
    update(); save();
  }

  return <div className="project-sidebar" ref={root}>
    <div className="project-sidebar-content" id={id}>{children}</div>
    <div ref={handle} className="project-sidebar-resizer" role="separator" tabIndex={0}
      aria-label="调整项目侧栏宽度" aria-orientation="vertical" aria-controls={id}
      aria-valuemin={values.min} aria-valuemax={values.max} aria-valuenow={values.width} aria-valuetext={`${values.width} 像素`}
      title="拖动调整宽度，双击恢复默认" onPointerDown={start} onPointerMove={move}
      onPointerUp={event => { if (drag.current?.pointer === event.pointerId) finish(true); }}
      onPointerCancel={event => { if (drag.current?.pointer === event.pointerId) finish(false); }}
      onLostPointerCapture={() => finish(true)} onDoubleClick={reset} onKeyDown={keyDown} />
  </div>;
}
