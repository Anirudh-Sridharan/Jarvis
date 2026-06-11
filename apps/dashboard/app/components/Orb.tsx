/**
 * Orb — the JARVIS "arc reactor": concentric spinning dashed rings around a
 * pulsing radial core. Pure SVG + CSS animations (see .orb* in globals.css),
 * so it renders server-side and animates without JS.
 *
 * `id` must be unique per instance on a page (SVG gradient ids are global).
 */

interface OrbProps {
  size: number;
  id: string;
}

export default function Orb({ size, id }: OrbProps) {
  const gradId = `orb-core-${id}`;
  return (
    <div className="orb" style={{ width: size, height: size }} aria-hidden="true">
      <div className="orb__halo" />
      <svg className="orb__svg" viewBox="0 0 200 200" width={size} height={size}>
        <defs>
          <radialGradient id={gradId}>
            <stop offset="0%" stopColor="#d8f6ff" stopOpacity={0.95} />
            <stop offset="38%" stopColor="#5fd4ff" stopOpacity={0.8} />
            <stop offset="100%" stopColor="#0a64a0" stopOpacity={0} />
          </radialGradient>
        </defs>
        <g className="orb__ring--outer">
          <circle cx={100} cy={100} r={94} fill="none" stroke="rgba(127,220,255,0.35)" strokeWidth={1} strokeDasharray="3 7" />
        </g>
        <g className="orb__ring--mid">
          <circle cx={100} cy={100} r={84} fill="none" stroke="rgba(56,198,255,0.5)" strokeWidth={5} strokeDasharray="1 11" />
        </g>
        <g className="orb__ring--fast">
          <circle cx={100} cy={100} r={70} fill="none" stroke="#38c6ff" strokeWidth={1.5} strokeDasharray="80 140" strokeLinecap="round" opacity={0.85} />
          <circle cx={100} cy={100} r={70} fill="none" stroke="rgba(127,220,255,0.5)" strokeWidth={1.5} strokeDasharray="30 190" strokeDashoffset={-110} strokeLinecap="round" />
        </g>
        <circle cx={100} cy={100} r={58} fill="none" stroke="rgba(99,201,255,0.18)" strokeWidth={1} />
        <circle className="orb__core" cx={100} cy={100} r={40} fill={`url(#${gradId})`} />
        <circle cx={100} cy={100} r={7} fill="#eaffff" style={{ filter: "drop-shadow(0 0 10px #7fdcff)" }} />
      </svg>
    </div>
  );
}
