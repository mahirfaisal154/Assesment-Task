import { useState } from "react"
import { History } from "lucide-react"
import { HISTORY_FILTERS } from "../../constants"
import { formatTime } from "../lib/utils"

const rowColor = (type) => {
  if(type.startsWith("EMERGENCY")) return "text-error"
  if(["FAILURE_DETECTED","CONTROLLER_TIMEOUT","STATE_MISMATCH","CONFLICT_DETECTED","COMMAND_FAILED"].includes(type)) return "text-warning"
  if(type.includes("REJECTED") || type.includes("DUPLICATE") || type==="STALE_ACK") return "text-base-content/60"
  if(type==="SIGNAL_CHANGED" || type==="STAGE_CHANGED") return "text-success"
  return ""
}

// recent activity from backend audit log (GET /api/junctions/:id/history + live socket pushes)
const ActivityList = ({history}) => {
  const [filter, setFilter] = useState("ALL")
  const types=HISTORY_FILTERS[filter]
  const list=(Array.isArray(history) ? history : []).filter(h=>!types || types.includes(h.event_type))

  return (
    <div className="card bg-base-100 shadow">
      <div className="card-body p-4">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold flex items-center gap-2"><History className="size-4"/> Recent activity</h3>
          <select className="select select-bordered select-xs" value={filter} onChange={(e)=>setFilter(e.target.value)}>
            {Object.keys(HISTORY_FILTERS).map((f)=><option key={f} value={f}>{f}</option>)}
          </select>
        </div>
        <div className="overflow-y-auto max-h-96">
          {list.length===0 ? (
            <p className="text-sm text-base-content/60">No activity yet.</p>
          ) : (
            <table className="table table-xs">
              <tbody>
                {list.map((h,i)=>(
                  <tr key={`${h.timestamp}-${h.event_type}-${i}`} className={rowColor(h.event_type)}>
                    <td className="font-mono whitespace-nowrap">{formatTime(h.timestamp)}</td>
                    <td className="font-semibold whitespace-nowrap">{h.event_type}</td>
                    <td>{h.direction || ""}</td>
                    <td className="w-full">
                      {h.previous_state || h.new_state ? <span>{h.previous_state ?? "-"} → {h.new_state ?? "-"} </span> : null}
                      {h.message}
                      {h.vehicle_id && <span className="opacity-60"> · {h.vehicle_id}</span>}
                      {h.command_id && <span className="opacity-60 font-mono"> · {h.command_id}</span>}
                      {h.details?.reason && <span className="opacity-60"> · {h.details.reason}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}

export default ActivityList
