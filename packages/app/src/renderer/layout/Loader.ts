/** receptionOS signet loader — 3-layer comet stroke animation.
 *
 *  Port of the production loader from the vault
 *  (_assets/loaders/receptionos-loader.html): a glowing head with a trailing
 *  body and tail oscillating along the signet path (cosine ease), built on
 *  strokeDasharray/strokeDashoffset. Self-contained: createRosLoader() returns
 *  the element + start/stop, no global state.
 */

const SIGNET_D = "M21.77,12.02c-.53-.83-1.09-1.6-1.68-2.33-.01-.02-.03-.03-.04-.05C15.85,4.37,10.21,1.34,4.3.38c-.4-.07-.8-.13-1.2-.18-.08,0-.15-.02-.23-.03C2.27.11,1.67.06,1.07.03.81.02.55,0,.3,0c-.1,0-.2,0-.3,0v1.03c1.07.02,2.15.1,3.23.27.26.05.51.1.77.16,2.87.83,5.58,2.49,7.8,5.1,2.46,2.92,3.66,6.32,3.82,9.69-2.49-2.67-5.69-4.76-9.42-5.92-2.07-.64-4.15-.95-6.19-.99v.96c1.93.08,3.9.42,5.87,1.07,4.02,1.33,7.33,3.86,9.71,7.03-.17,2.02-.69,3.99-1.54,5.81-3.04-4.28-8-7.26-14.03-7.3v1c5.9.18,10.57,3.4,13.22,7.83-2.65,4.43-7.31,7.65-13.22,7.83v1c6.04-.03,10.99-3.02,14.03-7.3.85,1.82,1.38,3.79,1.54,5.81-2.38,3.17-5.69,5.7-9.71,7.03-1.97.65-3.94.99-5.87,1.07v.96c2.04-.04,4.12-.34,6.19-.99,3.74-1.16,6.94-3.25,9.42-5.92-.16,3.37-1.36,6.77-3.82,9.69-2.22,2.62-4.93,4.28-7.8,5.1-.26.06-.51.11-.77.16-1.08.17-2.16.25-3.23.27v1.03c.1,0,.2,0,.3,0,.26,0,.52-.02.77-.03.6-.03,1.2-.07,1.8-.14.08,0,.15-.02.23-.03.4-.05.8-.1,1.2-.17,5.9-.96,11.55-3.99,15.75-9.25.01-.02.03-.03.04-.05.59-.74,1.15-1.51,1.68-2.33,2.76-4.19,4.02-8.97,3.98-13.73.04-4.76-1.23-9.54-3.98-13.73ZM13.74,6.82c.86.86,1.68,1.8,2.43,2.85,2.78,3.91,3.83,8.39,3.48,12.73-.63-1.46-1.43-2.85-2.37-4.14.26-3.88-.8-7.92-3.53-11.44ZM15.02,25.75c.92-1.62,1.58-3.39,1.95-5.22.94,1.64,1.66,3.4,2.12,5.22-.46,1.83-1.18,3.58-2.12,5.22-.37-1.83-1.03-3.6-1.95-5.22ZM13.74,44.67c2.74-3.52,3.8-7.55,3.53-11.44.95-1.29,1.74-2.68,2.37-4.14.35,4.33-.7,8.82-3.48,12.73-.75,1.05-1.57,1.99-2.43,2.85ZM16.4,43.71c.3-.35.6-.7.88-1.08,3.96-5.23,4.88-11.34,3.5-16.89,1.38-5.55.46-11.67-3.5-16.89-.28-.37-.58-.73-.88-1.08,4.87,4.63,7.55,11.29,7.64,17.97-.09,6.68-2.77,13.33-7.64,17.97Z";

export const ROS_SIGNET_PATH = SIGNET_D;

let glowIdCounter = 0;

export interface RosLoader {
  el: HTMLElement;
  start(): void;
  stop(): void;
  destroy(): void;
}

/** Create the animated signet loader. Width derives from height (1:2 ratio). */
export function createRosLoader(height = 96, stroke = "white"): RosLoader {
  const el = document.createElement("div");
  el.className = "mc-ros-loader";
  el.style.width = `${height / 2}px`;
  el.style.height = `${height}px`;

  const glowId = `mc-ros-glow-${++glowIdCounter}`;
  const svgNs = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNs, "svg");
  svg.setAttribute("viewBox", "-0.5 -0.5 26.75 52.49");
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "100%");
  svg.style.overflow = "visible";

  const defs = document.createElementNS(svgNs, "defs");
  defs.innerHTML = `
    <filter id="${glowId}" x="-100%" y="-100%" width="300%" height="300%">
      <feGaussianBlur in="SourceGraphic" stdDeviation="1.2" result="blur1"/>
      <feGaussianBlur in="SourceGraphic" stdDeviation="0.5" result="blur2"/>
      <feMerge>
        <feMergeNode in="blur1"/>
        <feMergeNode in="blur2"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>`;
  svg.appendChild(defs);

  const makePath = (strokeWidth: string, glow: boolean): SVGPathElement => {
    const p = document.createElementNS(svgNs, "path");
    p.setAttribute("d", SIGNET_D);
    p.setAttribute("fill", "none");
    p.setAttribute("stroke", stroke);
    p.setAttribute("stroke-width", strokeWidth);
    p.setAttribute("stroke-linecap", "round");
    p.setAttribute("stroke-linejoin", "round");
    if (glow) p.setAttribute("filter", `url(#${glowId})`);
    svg.appendChild(p);
    return p;
  };

  const tail = makePath("0.5", false);
  const body = makePath("0.5", false);
  const head = makePath("0.7", true);
  el.appendChild(svg);

  let rafId: number | null = null;
  let pathLength: number | null = null;

  const CYCLE = 5000;
  const PI2 = Math.PI * 2;

  const run = (ts: number) => {
    if (pathLength === null) {
      // getTotalLength needs a rendered path — first frame is the safe spot
      try {
        pathLength = tail.getTotalLength();
      } catch {
        rafId = requestAnimationFrame(run);
        return;
      }
    }
    const L = pathLength;
    const tailLen = L * 0.5;
    const bodyLen = L * 0.22;
    const headLen = L * 0.05;

    const t = (ts % CYCLE) / CYCLE;
    const a = PI2 * t;
    const hp = (L * (1 - Math.cos(a))) / 2;
    const sp = Math.abs(Math.sin(a)) / 2;
    const ss = 0.2 + 0.8 * (sp * 2);

    const tl = tailLen * ss;
    const bl = bodyLen * ss;
    const hl = headLen * (0.5 + 0.5 * ss);

    const tv = Math.min(tl, hp);
    tail.style.strokeDasharray = `${tv} ${L - tv}`;
    tail.style.strokeDashoffset = String(-Math.max(0, hp - tl));
    tail.style.opacity = String(0.08 + 0.12 * (sp * 2));

    const bs = Math.max(0, hp - bl);
    const bv = hp - bs;
    body.style.strokeDasharray = `${bv} ${L - bv}`;
    body.style.strokeDashoffset = String(-bs);
    body.style.opacity = String(0.15 + 0.4 * (sp * 2));

    const hs = Math.max(0, hp - hl);
    const hv = hp - hs;
    head.style.strokeDasharray = `${hv} ${L - hv}`;
    head.style.strokeDashoffset = String(-hs);
    head.style.opacity = String(0.5 + 0.5 * (sp * 2));

    rafId = requestAnimationFrame(run);
  };

  const hideAll = () => {
    for (const p of [tail, body, head]) {
      p.style.strokeDasharray = `0 1000`;
      p.style.strokeDashoffset = "0";
      p.style.opacity = "0";
    }
  };
  hideAll();

  return {
    el,
    start() {
      if (rafId === null) rafId = requestAnimationFrame(run);
    },
    stop() {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      hideAll();
    },
    destroy() {
      this.stop();
      el.remove();
    },
  };
}

/** Static signet mark (no animation) — for branding headers/footers. */
export function createSignetMark(height = 16, color = "currentColor"): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "mc-ros-signet";
  wrap.style.display = "inline-flex";
  wrap.style.height = `${height}px`;
  wrap.style.width = `${height / 2}px`;
  wrap.innerHTML = `<svg viewBox="-0.5 -0.5 26.75 52.49" width="100%" height="100%"><path d="${SIGNET_D}" fill="${color}"/></svg>`;
  return wrap;
}
