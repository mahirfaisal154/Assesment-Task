import { useState } from "react"
import { Activity } from "lucide-react"
import { DEVICE_TYPES, DEVICE_STATUSES } from "../../constants"
import { useJunctionStore } from "../store/useJunctionStore"
import { newEventId } from "../lib/utils"

// simulate device health events (POST /api/device-events)
const DeviceStatusForm = ({status}) => {
  const {sendDeviceEvent} = useJunctionStore()
  const [formData, setFormData] = useState({device_type:"CONTROLLER", direction:"", status:"OFFLINE"})
  const directions=status?.config?.directions || []

  const send = (data) => sendDeviceEvent({
    event_id:newEventId("status"),
    junction_id:status.junction_id,
    device_type:data.device_type,
    ...(data.direction ? {direction:data.direction} : {}),
    status:data.status,
    timestamp:new Date().toISOString(),
  })

  const handleSubmit = (e) => {
    e.preventDefault()
    send(formData)
  }

  const needsDirection = formData.device_type==="SENSOR"

  return (
    <div className="card bg-base-100 shadow">
      <div className="card-body p-4 gap-3">
        <h3 className="font-semibold flex items-center gap-2"><Activity className="size-4"/> Device status (failures)</h3>
        <form onSubmit={handleSubmit} className="grid grid-cols-3 gap-2">
          <select className="select select-bordered select-sm" value={formData.device_type} onChange={(e)=>setFormData({...formData, device_type:e.target.value})}>
            {DEVICE_TYPES.map((t)=><option key={t} value={t}>{t}</option>)}
          </select>
          <select className="select select-bordered select-sm" value={formData.direction} onChange={(e)=>setFormData({...formData, direction:e.target.value})}>
            <option value="">{needsDirection ? "direction…" : "whole junction"}</option>
            {directions.map((d)=><option key={d} value={d}>{d}</option>)}
          </select>
          <select className="select select-bordered select-sm" value={formData.status} onChange={(e)=>setFormData({...formData, status:e.target.value})}>
            {DEVICE_STATUSES.map((s)=><option key={s} value={s}>{s}</option>)}
          </select>
          <button type="submit" className="btn btn-sm btn-primary col-span-3" disabled={!status || (needsDirection && !formData.direction)}>Send status event</button>
        </form>
        <p className="text-[11px] opacity-60">
          CONTROLLER (or SIGNAL_CONTROLLER without direction) = whole junction controller. SIGNAL_CONTROLLER + direction = one signal head. SENSOR offline only degrades scheduling.
        </p>
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-xs btn-error btn-outline" onClick={()=>send({device_type:"CONTROLLER", status:"OFFLINE"})}>Controller OFFLINE</button>
          <button className="btn btn-xs btn-success btn-outline" onClick={()=>send({device_type:"CONTROLLER", status:"ONLINE"})}>Controller ONLINE</button>
          <button className="btn btn-xs btn-warning btn-outline" onClick={()=>send({device_type:"SENSOR", direction:"EAST", status:"OFFLINE"})}>EAST sensor OFFLINE</button>
          <button className="btn btn-xs btn-outline" onClick={()=>send({device_type:"SENSOR", direction:"EAST", status:"ONLINE"})}>EAST sensor ONLINE</button>
        </div>
      </div>
    </div>
  )
}

export default DeviceStatusForm
