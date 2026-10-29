import { useState } from "react"
import { Hand, RotateCcw, ShieldCheck, Siren, Loader2 } from "lucide-react"
import { useJunctionStore } from "../store/useJunctionStore"

// admin sends INTENTS (commands). backend decides the safe transition - nothing is forced from here
const ManualControl = ({status}) => {
  const {sendCommand, isSendingCommand} = useJunctionStore()
  const [operator, setOperator] = useState(localStorage.getItem("traffic-operator") || "admin")
  const [duration, setDuration] = useState(300)
  const directions=status?.config?.directions || []

  const run = (body) => {
    localStorage.setItem("traffic-operator", operator)
    // note: API also accepts expected_version (optimistic check) but the version moves on every ACK,
    // so the dashboard doesn't send it - last accepted command wins and every command is audited with operator
    return sendCommand(status.junction_id, {...body, operator})
  }

  return (
    <div className="card bg-base-100 shadow">
      <div className="card-body p-4 gap-3">
        <h3 className="font-semibold flex items-center gap-2"><Hand className="size-4"/> Manual control</h3>

        <div className="grid grid-cols-2 gap-2">
          <div className="form-control">
            <label className="label py-0"><span className="label-text text-xs">Operator</span></label>
            <input className="input input-bordered input-sm" value={operator} onChange={(e)=>setOperator(e.target.value)} />
          </div>
          <div className="form-control">
            <label className="label py-0"><span className="label-text text-xs">Duration</span></label>
            <select className="select select-bordered select-sm" value={duration} onChange={(e)=>setDuration(Number(e.target.value))}>
              <option value={60}>1 min</option>
              <option value={300}>5 min</option>
              <option value={600}>10 min</option>
              <option value={1800}>30 min</option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          {directions.map((d)=>(
            <button
              key={d}
              className={`btn btn-sm ${status?.manual?.direction===d ? "btn-info" : "btn-outline"}`}
              disabled={isSendingCommand}
              onClick={()=>run({command:"MANUAL_GREEN_REQUEST", direction:d, duration_sec:duration})}
            >
              GREEN request {d}
            </button>
          ))}
        </div>
        {(status?.emergency?.active || status?.failure) && (
          <p className="text-xs text-warning">
            {status.failure ? "Junction is in FAILURE - backend will refuse manual green." : "Emergency active - backend will refuse manual green until it clears."}
          </p>
        )}

        <div className="divider my-0"></div>
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-sm btn-success" disabled={isSendingCommand} onClick={()=>run({command:"RETURN_TO_AUTOMATIC"})}>
            {isSendingCommand ? <Loader2 className="size-4 animate-spin"/> : <RotateCcw className="size-4"/>} Return to automatic
          </button>
          <button className="btn btn-sm btn-error btn-outline" disabled={isSendingCommand || !status?.emergency?.requests?.length} onClick={()=>run({command:"CLEAR_EMERGENCY"})}>
            <Siren className="size-4"/> Clear emergency
          </button>
          <button className="btn btn-sm btn-warning btn-outline" disabled={isSendingCommand || !status?.failure} onClick={()=>run({command:"RESET_FAILURE"})}>
            <ShieldCheck className="size-4"/> Reset failure
          </button>
        </div>
      </div>
    </div>
  )
}

export default ManualControl
