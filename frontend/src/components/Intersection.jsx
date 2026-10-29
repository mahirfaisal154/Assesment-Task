import { Siren } from "lucide-react"
import { SIGNAL_COLORS } from "../lib/utils"

const LAMPS=["RED","YELLOW","GREEN"]

const SignalHead = ({direction, actual, desired, queue, isEmergency, compact}) => {
  const unknown = !actual || actual==="UNKNOWN"
  return (
    <div className="flex flex-col items-center gap-1">
      <span className="text-xs font-bold flex items-center gap-1">
        {isEmergency && <Siren className="size-3 text-error animate-pulse"/>}
        {direction}
      </span>
      <div className={`bg-neutral rounded-lg p-1 flex ${compact ? "flex-row" : "flex-col"} gap-1`}>
        {LAMPS.map((c)=>(
          <div
            key={c}
            className={`${compact ? "size-3" : "size-4"} rounded-full ${actual===c ? SIGNAL_COLORS[c] : "bg-neutral-content/20"} ${unknown ? "animate-pulse" : ""}`}
          />
        ))}
      </div>
      {!compact && (
        <>
          <span className={`text-[10px] font-semibold ${unknown ? "text-warning" : ""}`}>{unknown ? "UNKNOWN" : actual}</span>
          {desired && desired!==actual && (
            <span className="text-[10px] text-info">wants {desired}</span>
          )}
          <span className="badge badge-sm badge-outline">{queue ?? 0} waiting</span>
        </>
      )}
    </div>
  )
}

// signal colours shown = CONFIRMED (actual) state from backend. desired shown underneath when different
const Intersection = ({status, compact=false}) => {
  if(!status) return null
  const actual=status.actual_signals || {}
  const desired=status.desired_signals || {}
  const queues=status.queues || {}
  const emDir=status.emergency?.active ? status.emergency.direction : null
  const head=(d)=>(
    <SignalHead direction={d} actual={actual[d]} desired={desired[d]} queue={queues[d]} isEmergency={emDir===d} compact={compact}/>
  )
  const road="bg-base-300"
  const cell=compact ? "h-16" : "h-36"

  return (
    <div className="grid grid-cols-3 gap-0 w-full max-w-sm mx-auto select-none">
      <div className={cell}/>
      <div className={`${cell} ${road} flex items-center justify-center border-x-2 border-dashed border-base-content/20`}>{head("NORTH")}</div>
      <div className={cell}/>

      <div className={`${cell} ${road} flex items-center justify-center border-y-2 border-dashed border-base-content/20`}>{head("WEST")}</div>
      <div className={`${cell} ${road} flex flex-col items-center justify-center text-center`}>
        <span className="text-[10px] uppercase opacity-60">stage</span>
        <span className="text-xs font-bold">{status.stage==="ALL_RED" ? "ALL RED" : status.stage}</span>
        {status.target_phase && !compact && <span className="text-[10px] opacity-70">→ {status.target_phase}</span>}
      </div>
      <div className={`${cell} ${road} flex items-center justify-center border-y-2 border-dashed border-base-content/20`}>{head("EAST")}</div>

      <div className={cell}/>
      <div className={`${cell} ${road} flex items-center justify-center border-x-2 border-dashed border-base-content/20`}>{head("SOUTH")}</div>
      <div className={cell}/>
    </div>
  )
}

export default Intersection
