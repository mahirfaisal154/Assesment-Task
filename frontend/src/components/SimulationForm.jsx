import { useState } from "react"
import toast from "react-hot-toast"
import { Car, Copy, Siren, Zap, Loader2 } from "lucide-react"
import { DIRECTIONS, VEHICLE_TYPES } from "../../constants"
import { useJunctionStore } from "../store/useJunctionStore"
import { axiosInstance } from "../lib/axios"
import { newEventId, nextSequenceNo } from "../lib/utils"

const randomVehicleId = (type) => `${{EMERGENCY:"AMB",TRUCK:"TRK",FORKLIFT:"FL",EMPLOYEE_VEHICLE:"EMP"}[type] || "VH"}-${Math.floor(Math.random()*900+100)}`

// evaluator tool: fake the sensors. everything goes through the real POST /api/sensor-events
const SimulationForm = ({status}) => {
  const {sendSensorEvent, isSendingEvent} = useJunctionStore()
  const [formData, setFormData] = useState({
    direction:"NORTH",
    vehicle_type:"TRUCK",
    vehicle_id:randomVehicleId("TRUCK"),
    event_type:"VEHICLE_ARRIVED",
  })
  const [lastEvent, setLastEvent] = useState(null)
  const [isBurstRunning, setIsBurstRunning] = useState(false)
  const [isCustomClear, setIsCustomClear] = useState(false)
  const junctionId=status?.junction_id
  const isClear=formData.event_type==="VEHICLE_CLEARED"

  // vehicles currently waiting (from backend) - used to pick which one to clear
  const queuedVehicles=Object.entries(status?.queue_details || {})
    .flatMap(([dir, list])=>list.map(v=>({...v, direction:dir})))

  const changeEventType = (eventType) => {
    if(eventType==="VEHICLE_CLEARED"){
      //preselect the first waiting vehicle so we don't send a random id that was never queued
      const first=queuedVehicles[0]
      setIsCustomClear(!first)
      setFormData({...formData, event_type:eventType, vehicle_id:first ? first.vehicle_id : "", direction:first ? first.direction : formData.direction})
    } else {
      setIsCustomClear(false)
      setFormData({...formData, event_type:eventType, vehicle_id:randomVehicleId(formData.vehicle_type)})
    }
  }

  const pickQueuedVehicle = (value) => {
    if(value==="__custom__"){
      setIsCustomClear(true)
      setFormData({...formData, vehicle_id:""})
      return
    }
    const v=queuedVehicles.find(q=>q.vehicle_id===value)
    setFormData({...formData, vehicle_id:value, direction:v ? v.direction : formData.direction})
  }

  const buildEvent = (over={}) => ({
    event_id:newEventId(),
    junction_id:junctionId,
    direction:formData.direction,
    event_type:formData.event_type,
    vehicle_id:formData.vehicle_id.trim(),
    ...(formData.event_type==="VEHICLE_ARRIVED" ? {vehicle_type:formData.vehicle_type} : {}),
    sequence_no:nextSequenceNo(),
    timestamp:new Date().toISOString(),
    ...over,
  })

  const validateForm = () => {
    if(!formData.vehicle_id.trim()) return toast.error(isClear ? "Select a vehicle to clear" : "Vehicle id is required")
    return true
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    if(validateForm()!==true) return
    const event=buildEvent()
    const res=await sendSensorEvent(event)
    if(res) {
      setLastEvent(event)
      if(!isClear) setFormData({...formData, vehicle_id:randomVehicleId(formData.vehicle_type)})
      else if(!isCustomClear){
        //move selection to the next waiting vehicle (the cleared one is gone)
        const next=queuedVehicles.find(q=>q.vehicle_id!==event.vehicle_id)
        setFormData({...formData, vehicle_id:next ? next.vehicle_id : "", direction:next ? next.direction : formData.direction})
      }
    }
  }

  // exact same payload again (same event_id) -> backend must not change the queue
  const resendLast = () => lastEvent && sendSensorEvent(lastEvent)

  const emergencyFrom = async (direction) => {
    const event=buildEvent({direction, event_type:"VEHICLE_ARRIVED", vehicle_type:"EMERGENCY", vehicle_id:randomVehicleId("EMERGENCY")})
    const res=await sendSensorEvent(event)
    if(res) setLastEvent(event)
  }

  const randomTraffic = async () => {
    for(let i=0;i<6;i++){
      const type=VEHICLE_TYPES[1+Math.floor(Math.random()*3)]
      await sendSensorEvent(buildEvent({
        direction:DIRECTIONS[Math.floor(Math.random()*4)], event_type:"VEHICLE_ARRIVED", vehicle_type:type, vehicle_id:randomVehicleId(type),
      }), {silent:true})
    }
    toast.success("6 random vehicles sent")
  }

  // spec scenario 9: everything fired at (almost) the same time
  const concurrentBurst = async () => {
    setIsBurstRunning(true)
    const ts=new Date().toISOString()
    const emergency={event_id:newEventId("em"), junction_id:junctionId, direction:"EAST", event_type:"VEHICLE_ARRIVED", vehicle_id:randomVehicleId("EMERGENCY"), vehicle_type:"EMERGENCY", sequence_no:nextSequenceNo(), timestamp:ts}
    const wait=(ms)=>new Promise(r=>setTimeout(r,ms))
    const pendingId=status?.pending_command?.command_id
    const calls=[
      ["NORTH truck", axiosInstance.post("/sensor-events", {event_id:newEventId(), junction_id:junctionId, direction:"NORTH", event_type:"VEHICLE_ARRIVED", vehicle_id:randomVehicleId("TRUCK"), vehicle_type:"TRUCK", sequence_no:nextSequenceNo(), timestamp:ts})],
      ["EAST emergency", wait(4).then(()=>axiosInstance.post("/sensor-events", emergency))],
      ["WEST manual", wait(8).then(()=>axiosInstance.post(`/junctions/${junctionId}/commands`, {command:"MANUAL_GREEN_REQUEST", direction:"WEST", operator:"burst-test"}))],
      ["EAST emergency (dup)", wait(12).then(()=>axiosInstance.post("/sensor-events", emergency))],
      ["controller ACK", wait(17).then(()=>axiosInstance.post("/controller-events", {command_id:pendingId || "cmd-none", junction_id:junctionId, status:"ACK"}))],
    ]
    const results=await Promise.allSettled(calls.map(([,p])=>p))
    const summary=results.map((r,i)=>`${calls[i][0]}: ${r.status==="fulfilled" ? r.value.data.status : (r.reason.response?.status || "ERR")}`)
    toast(summary.join("\n"), {duration:8000, icon:"⚡"})
    setIsBurstRunning(false)
  }

  return (
    <div className="card bg-base-100 shadow">
      <div className="card-body p-4 gap-3">
        <h3 className="font-semibold flex items-center gap-2"><Car className="size-4"/> Traffic simulation (sensor events)</h3>
        <form onSubmit={handleSubmit} className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <select className="select select-bordered select-sm" value={formData.event_type} onChange={(e)=>changeEventType(e.target.value)}>
              <option value="VEHICLE_ARRIVED">Vehicle arrived</option>
              <option value="VEHICLE_CLEARED">Vehicle cleared</option>
            </select>
            <select className="select select-bordered select-sm" value={formData.direction} onChange={(e)=>setFormData({...formData, direction:e.target.value})}>
              {(status?.config?.directions || DIRECTIONS).map((d)=><option key={d} value={d}>{d}</option>)}
            </select>
            <select className="select select-bordered select-sm" value={formData.vehicle_type} disabled={formData.event_type==="VEHICLE_CLEARED"}
              onChange={(e)=>setFormData({...formData, vehicle_type:e.target.value, vehicle_id:randomVehicleId(e.target.value)})}>
              {VEHICLE_TYPES.map((t)=><option key={t} value={t}>{t}</option>)}
            </select>
            {isClear && !isCustomClear ? (
              <select className="select select-bordered select-sm" value={formData.vehicle_id} onChange={(e)=>pickQueuedVehicle(e.target.value)}>
                <option value="">{queuedVehicles.length ? "select waiting vehicle…" : "no vehicles waiting"}</option>
                {queuedVehicles.map((v)=>(
                  <option key={v.vehicle_id} value={v.vehicle_id}>{v.vehicle_id} ({v.vehicle_type}, {v.direction})</option>
                ))}
                <option value="__custom__">custom id (test ignored clear)…</option>
              </select>
            ) : (
              <input className="input input-bordered input-sm" placeholder="vehicle id" value={formData.vehicle_id}
                onChange={(e)=>setFormData({...formData, vehicle_id:e.target.value})}/>
            )}
          </div>
          {isClear && isCustomClear && queuedVehicles.length>0 && (
            <button type="button" className="btn btn-link btn-xs px-0" onClick={()=>changeEventType("VEHICLE_CLEARED")}>← pick from waiting vehicles</button>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="submit" className="btn btn-primary btn-sm" disabled={isSendingEvent || !junctionId}>
              {isSendingEvent ? <Loader2 className="size-4 animate-spin"/> : null} Send event
            </button>
            <button type="button" className="btn btn-outline btn-sm" disabled={!lastEvent} onClick={resendLast} title={lastEvent?.event_id}>
              <Copy className="size-4"/> Re-send last (duplicate)
            </button>
          </div>
        </form>

        <div className="divider my-0">Quick scenarios</div>
        <div className="flex flex-wrap gap-2">
          {(status?.config?.directions || DIRECTIONS).map((d)=>(
            <button key={d} className="btn btn-error btn-outline btn-xs" onClick={()=>emergencyFrom(d)}>
              <Siren className="size-3"/> Emergency {d}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-sm" onClick={randomTraffic}>6 random vehicles</button>
          <button className="btn btn-sm btn-accent" onClick={concurrentBurst} disabled={isBurstRunning}>
            {isBurstRunning ? <Loader2 className="size-4 animate-spin"/> : <Zap className="size-4"/>} Concurrent burst (scenario 9)
          </button>
        </div>
      </div>
    </div>
  )
}

export default SimulationForm
