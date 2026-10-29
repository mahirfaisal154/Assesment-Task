import { Siren, AlertOctagon, Hand, WifiOff } from "lucide-react"
import { formatTime } from "../lib/utils"

// big, obvious banners for the states an operator must not miss
const StatusBanners = ({status, backendOnline, onReturnToAutomatic, isSendingCommand}) => {
  return (
    <div className="space-y-2">
      {!backendOnline && (
        <div role="alert" className="alert alert-error">
          <WifiOff className="size-5"/>
          <span>Backend unreachable. Showing last known state - it may be outdated. Retrying automatically…</span>
        </div>
      )}

      {status?.emergency?.active && (
        <div role="alert" className="alert alert-error">
          <Siren className="size-6 animate-pulse"/>
          <div>
            <h3 className="font-bold">EMERGENCY PREEMPTION - Junction {status.junction_id}</h3>
            <div className="text-sm">
              Vehicle <b>{status.emergency.vehicle_id}</b> from <b>{status.emergency.direction}</b> → serving <b>{status.emergency.phase}</b>.
              {" "}Current: <b>{status.stage==="ALL_RED" ? "ALL RED" : `${status.phase} ${status.stage}`}</b>
              {status.target_phase && <> → next <b>{status.target_phase} GREEN</b></>}
              {status.emergency.requests.length>1 && <> · {status.emergency.requests.length-1} more emergency request(s) queued</>}
            </div>
          </div>
        </div>
      )}

      {status?.failure && (
        <div role="alert" className="alert alert-warning">
          <AlertOctagon className="size-6"/>
          <div>
            <h3 className="font-bold">FAILURE MODE - signals held ALL RED</h3>
            <div className="text-sm">Reason: {status.failure.reason} (since {formatTime(status.failure.since)}). Fix the device, then use “Reset failure”.</div>
          </div>
        </div>
      )}

      {status?.manual && (
        <div role="alert" className="alert alert-info">
          <Hand className="size-6"/>
          <div className="flex-1">
            <h3 className="font-bold">Manual override active{status.mode!=="MANUAL" ? ` (suspended - ${status.mode} has priority)` : ""}</h3>
            <div className="text-sm">
              {status.manual.operator} requested GREEN for {status.manual.direction} ({status.manual.phase}) · expires {formatTime(status.manual.expiresAt)}
            </div>
          </div>
          <button className="btn btn-sm" onClick={onReturnToAutomatic} disabled={isSendingCommand}>Return to automatic</button>
        </div>
      )}
    </div>
  )
}

export default StatusBanners
