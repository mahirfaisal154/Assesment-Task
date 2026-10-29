const JunctionSkeleton = () => {
  const cards=Array(6).fill(null)
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      {cards.map((_, idx)=>(
        <div key={idx} className="card bg-base-100 shadow p-4 space-y-3">
          <div className="skeleton h-5 w-32"></div>
          <div className="skeleton h-32 w-full"></div>
          <div className="skeleton h-4 w-48"></div>
        </div>
      ))}
    </div>
  )
}

export default JunctionSkeleton
