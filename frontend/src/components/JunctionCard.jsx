import { Link } from "react-router-dom"
import { Siren, AlertTriangle, Hand } from "lucide-react"
import Intersection from "./Intersection"
import { modeBadgeClass, statusBadgeClass } from "../lib/utils"

const JunctionCard = ({junction}) => {
  const queues=junction.queues || {}
  const total=Object.values(queues).reduce((a,b)=>a+(b||0),0)
  const critical=(junction.alerts || []).filter(a=>a.level==="CRITICAL")

  return (
    <div className={`card bg-base-100 shadow-md border-2 ${junction.mode==="EMERGENCY" ? "border-error" : junction.mode==="FAILURE" ? "border-warning" : "border-transparent"}`}>
      <div className="card-body p-5 gap-3">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="card-title">{junction.name}</h2>
            <p className="text-sm text-base-content/60">ID {junction.junction_id} · phase {junction.phase ?? "-"}</p>
          </div>
          <span className={`badge ${modeBadgeClass(junction.mode)}`}>{junction.mode}</span>
        </div>

        <Intersection status={junction} compact/>

        <div className="flex flex-wrap gap-2 text-sm">
          <span className={`badge ${statusBadgeClass(junction.controller_status)}`}>controller {junction.controller_status}</span>
          <span className="badge badge-outline">{total} vehicles waiting</span>
          {junction.emergency?.active && (
            <span className="badge badge-error gap-1"><Siren className="size-3"/> {junction.emergency.direction}</span>
          )}
          {junction.manual && <span className="badge badge-info gap-1"><Hand className="size-3"/> manual</span>}
          {critical.length>0 && junction.mode!=="EMERGENCY" && (
            <span className="badge badge-warning gap-1"><AlertTriangle className="size-3"/> {critical.length} alert(s)</span>
          )}
        </div>

        <div className="grid grid-cols-4 gap-1 text-center text-xs">
          {Object.entries(queues).map(([d,q])=>(
            <div key={d} className="bg-base-200 rounded p-1">
              <div className="opacity-60">{d}</div>
              <div className="font-bold">{q}</div>
            </div>
          ))}
        </div>

        <div className="card-actions justify-end">
          <Link to={`/junctions/${junction.junction_id}`} className="btn btn-primary btn-sm">Open junction</Link>
        </div>
      </div>
    </div>
  )
}

export default JunctionCard
