// Serialized per-junction processing.
// Every input for junction "A" (sensor event, command, ACK, timer tick) is chained on one promise,
// so two requests can never read the same state and write conflicting results.
// Different junctions still run in parallel.

export const createKeyedMutex = () => {
    const tails = new Map() // key -> last promise in the chain

    const runExclusive = (key, fn) => {
        const previous = tails.get(key) || Promise.resolve()
        const run = previous.then(() => fn())
        const tail = run.catch(() => { }) // an error must not block the next caller
        tails.set(key, tail)
        tail.then(() => {
            if (tails.get(key) === tail) tails.delete(key)
        })
        return run
    }

    const isBusy = (key) => tails.has(key)

    return { runExclusive, isBusy }
}
