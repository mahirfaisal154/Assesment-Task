import { useState } from "react"
import { Cpu } from "lucide-react"
import { useJunctionStore } from "../store/useJunctionStore"
import { formatDuration, formatTime } from "../lib/utils"

// shows the pending controller command and lets the evaluator play the physical controller
const ControllerPanel = ({status, now}) => {
  const {simulator, updateSimulator, sendControllerEvent} = useJunctionStore()
  const [lastAnswered, setLastAnswered] = useState(null)
  const pending=status?.pending_command
  const settings=simulator?.settings

  const answer = async (statusValue, mismatch=false) => {
    if(!pending) return
    const body={command_id:pending.command_id, junction_id:status.junction_id, status:statusValue}
    if(statusValue==="ACK"){
      body.actual_signals={...pending.requested_signals}
      if(mismatch){
        const d=Object.keys(body.actual_signals)[0]
        body.actual_signals[d]=body.actual_signals[d]==="RED" ? "YELLOW" : "RED"
      }
    }
    const res=await sendControllerEvent(body)
    if(res) setLastAnswered(body)
  }

  return (
    <div className="card bg-base-100 shadow">
      <div className="card-body p-4 gap-3">
        <h3 className="font-semibold flex items-center gap-2"><Cpu className="size-4"/> Controller (simulated)</h3>

        {pending ? (
          <div className="bg-base-200 rounded-lg p-3 text-sm space-y-1">
            <div className="flex justify-between">
              <span className="font-mono text-xs">{pending.command_id}</span>
              <span className={`badge badge-sm ${pending.attempt>1 ? "badge-warning" : "badge-info"}`}>attempt {pending.attempt}</span>
            </div>
            <div>Purpose: <b>{pending.purpose}</b></div>
            <div className="text-xs">
              {Object.entries(pending.requested_signals || {}).map(([d,s])=>`${d}=${s}`).join("  ")}
            </div>
            <div className="text-xs opacity-70">
              sent {formatTime(pending.sent_at)} · timeout in {formatDuration(new Date(pending.deadline).getTime() - now)}
            </div>
            <div className="flex flex-wrap gap-2 pt-1">
              <button className="btn btn-xs btn-success" onClick={()=>answer("ACK")}>ACK</button>
              <button className="btn btn-xs btn-error" onClick={()=>answer("NACK")}>NACK</button>
              <button className="btn btn-xs btn-warning" onClick={()=>answer("ACK", true)}>ACK w/ wrong state</button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-base-content/60">No command waiting for acknowledgement.</p>
        )}
        {lastAnswered && (
          <button className="btn btn-xs btn-ghost self-start" onClick={()=>sendControllerEvent(lastAnswered)}>
            Re-send last answer ({lastAnswered.command_id}) - duplicate ACK test
          </button>
        )}
        {status?.last_command_result && (
          <p className="text-xs opacity-70">Last result: {status.last_command_result.commandId} → {status.last_command_result.status}</p>
        )}

        <div className="divider my-0">Simulator</div>
        {!settings ? (
          <p className="text-xs opacity-60">Simulator settings unavailable</p>
        ) : (
          <div className="space-y-2">
            <label className="label cursor-pointer justify-start gap-3 py-0">
              <input type="checkbox" className="toggle toggle-sm toggle-success" checked={settings.autoAck} onChange={(e)=>updateSimulator({autoAck:e.target.checked})}/>
              <span className="label-text text-sm">Auto-ACK commands</span>
            </label>
            <div className="grid grid-cols-2 gap-2">
              <select className="select select-bordered select-sm" value={settings.behavior} onChange={(e)=>updateSimulator({behavior:e.target.value})}>
                {settings.behaviors.map((b)=><option key={b} value={b}>{b}</option>)}
              </select>
              <select className="select select-bordered select-sm" value={settings.ackDelayMs} onChange={(e)=>updateSimulator({ackDelayMs:Number(e.target.value)})}>
                {[100,400,1000,3000,6000].map((ms)=><option key={ms} value={ms}>ACK delay {ms}ms</option>)}
              </select>
            </div>
            <p className="text-[11px] opacity-60">NO_ACK = controller never answers (timeout → retry → FAILURE). NACK / MISMATCH simulate a faulty controller. Delay &gt; 4000ms shows a delayed ACK + retry.</p>
          </div>
        )}
      </div>
    </div>
  )
}

export default ControllerPanel
