import { useEffect } from "react";

export function EnjoyTransition({ onDone }: { onDone: () => void }) {
  useEffect(() => {
    const timer = window.setTimeout(onDone, 1_650);
    return () => window.clearTimeout(timer);
  }, [onDone]);

  return (
    <div className="enjoy-warp" aria-hidden="true">
      <div className="warp-vignette" />
      <div className="warp-tunnel">
        {Array.from({ length: 10 }, (_, index) => <span key={index} style={{ "--ring": index } as React.CSSProperties} />)}
      </div>
      <div className="warp-streaks">
        {Array.from({ length: 24 }, (_, index) => <i key={index} style={{ "--streak": index } as React.CSSProperties} />)}
      </div>
      <div className="warp-core"><b>ENJOY</b><small>entering KenULTRABIOS brain</small></div>
    </div>
  );
}
