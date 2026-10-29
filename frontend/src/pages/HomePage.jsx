import { useEffect, useState } from "react"
import { Plus, Siren, AlertOctagon, TrafficCone, WifiOff } from "lucide-react"
import { useJunctionStore } from "../store/useJunctionStore"
import JunctionCard from "../components/JunctionCard"
import JunctionSkeleton from "../components/skeletons/JunctionSkeleton"

const HomePage = () => {
  const {junctions, getJunctions, isJunctionsLoading, backendOnline, createJunction} = useJunctionStore()
  const [formData, setFormData] = useState({junction_id:"", name:""})
  const [showCreate, setShowCreate] = useState(false)

  useEffect(()=>{
    getJunctions()
    //polling fallback - socket pushes are the fast path
    const id=setInterval(getJunctions, 5000)
    return ()=>clearInterval(id)
  },[getJunctions])

  const handleCreate = async (e) => {
    e.preventDefault()
    const success=await createJunction({junction_id:formData.junction_id.trim(), name:formData.name.trim() || undefined})
    if(success===true){
      setFormData({junction_id:"", name:""})
      setShowCreate(false)
    }
  }

  const emergencies=junctions.filter(j=>j.emergency?.active).length
  const failures=junctions.filter(j=>j.mode==="FAILURE").length

  return (
    <div className="min-h-screen bg-base-200 pt-20 pb-10">
      <div className="max-w-7xl mx-auto px-4 space-y-4">
        {!backendOnline && (
          <div role="alert" className="alert alert-error">
            <WifiOff className="size-5"/>
            <span>Cannot reach the backend at the moment. Data below may be outdated - retrying every 5s.</span>
          </div>
        )}

        <div className="stats shadow w-full bg-base-100">
          <div className="stat">
            <div className="stat-figure text-primary"><TrafficCone className="size-8"/></div>
            <div className="stat-title">Junctions</div>
            <div className="stat-value">{junctions.length}</div>
          </div>
          <div className="stat">
            <div className="stat-figure text-error"><Siren className="size-8"/></div>
            <div className="stat-title">Active emergencies</div>
            <div className={`stat-value ${emergencies ? "text-error" : ""}`}>{emergencies}</div>
          </div>
          <div className="stat">
            <div className="stat-figure text-warning"><AlertOctagon className="size-8"/></div>
            <div className="stat-title">In failure mode</div>
            <div className={`stat-value ${failures ? "text-warning" : ""}`}>{failures}</div>
          </div>
        </div>

        <div className="flex items-center justify-between">
          <h2 className="text-xl font-bold">Junction overview</h2>
          <button className="btn btn-sm btn-outline" onClick={()=>setShowCreate(!showCreate)}>
            <Plus className="size-4"/> New junction
          </button>
        </div>

        {showCreate && (
          <form onSubmit={handleCreate} className="card bg-base-100 shadow p-4 flex flex-col sm:flex-row gap-2">
            <input className="input input-bordered input-sm" placeholder="Junction id (e.g. B)" value={formData.junction_id}
              onChange={(e)=>setFormData({...formData, junction_id:e.target.value})}/>
            <input className="input input-bordered input-sm flex-1" placeholder="Name (optional)" value={formData.name}
              onChange={(e)=>setFormData({...formData, name:e.target.value})}/>
            <button type="submit" className="btn btn-sm btn-primary" disabled={!formData.junction_id.trim()}>Create (default N/S + E/W phases)</button>
          </form>
        )}

        {isJunctionsLoading && junctions.length===0 ? (
          <JunctionSkeleton/>
        ) : junctions.length===0 ? (
          <p className="text-base-content/60">No junctions available.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {junctions.map((j)=><JunctionCard key={j.junction_id} junction={j}/>)}
          </div>
        )}
      </div>
    </div>
  )
}

export default HomePage
