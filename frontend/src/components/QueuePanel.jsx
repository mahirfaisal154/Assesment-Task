import { X } from "lucide-react"
import { formatDuration, newEventId, nextSequenceNo } from "../lib/utils"
import { useJunctionStore } from "../store/useJunctionStore"

const typeBadge = (t) => ({
  EMERGENCY:"badge-error",
  TRUCK:"badge-primary",
  FORKLIFT:"badge-secondary",
  EMPLOYEE_VEHICLE:"badge-ghost",
}[t] || "badge-ghost")

// queue per direction, built ONLY from backend state. the X button sends a VEHICLE_CLEARED sensor event
const QueuePanel = ({status, now}) => {
  const {sendSensorEvent} = useJunctionStore()
  const details=status?.queue_details || {}
  const drift=now - (useJunctionStore.getState().statusReceivedAt || now) // time since snapshot

  const clearVehicle = async (direction, vehicleId) => {
    await sendSensorEvent({
      event_id:newEventId("clr"),
      junction_id:status.junction_id,
      direction,
      event_type:"VEHICLE_CLEARED",
      vehicle_id:vehicleId,
      sequence_no:nextSequenceNo(),
      timestamp:new Date().toISOString(),
    })
  }

  return (
    <div className="card bg-base-100 shadow">
      <div className="card-body p-4">
        <h3 className="font-semibold">Queues</h3>
        <div className="grid grid-cols-2 gap-3">
          {Object.entries(details).map(([dir, vehicles])=>(
            <div key={dir} className="bg-base-200 rounded-lg p-2">
              <div className="flex justify-between items-center mb-1">
                <span className="font-medium text-sm">{dir}</span>
                <span className="badge badge-neutral">{vehicles.length}</span>
              </div>
              {vehicles.length===0 ? (
                <p className="text-xs text-base-content/50">empty</p>
              ) : (
                <ul className="space-y-1 max-h-32 overflow-y-auto">
                  {vehicles.map((v)=>(
                    <li key={v.vehicle_id} className="flex items-center gap-1 text-xs">
                      <span className={`badge badge-xs ${typeBadge(v.vehicle_type)}`}>{v.vehicle_type}</span>
                      <span className="truncate flex-1">{v.vehicle_id}</span>
                      <span className="opacity-60">{formatDuration(v.waiting_ms + drift)}</span>
                      <button className="btn btn-ghost btn-xs px-1" title="Send VEHICLE_CLEARED" onClick={()=>clearVehicle(dir, v.vehicle_id)}>
                        <X className="size-3"/>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>

        {/*scheduler scores computed by backend*/}
        {Array.isArray(status?.phase_scores) && (
          <div className="mt-2">
            <h4 className="text-xs uppercase opacity-60 mb-1">Scheduler score (backend)</h4>
            <div className="flex gap-2 flex-wrap">
              {status.phase_scores.map((p)=>(
                <div key={p.phase} className={`badge badge-lg gap-2 ${p.phase===status.phase ? "badge-success" : "badge-outline"}`}>
                  {p.phase}: {p.score}
                  {p.sensorFallback && <span className="text-[10px]">(sensor fallback)</span>}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default QueuePanel
