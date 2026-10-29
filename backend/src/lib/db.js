import mongoose from "mongoose"

export const connectDB = async () => {
    try {
        const connection = await mongoose.connect(process.env.MONGODB_URI)
        console.log(`Connected to MongoDB:${connection.connection.host}`)
    } catch (error) {
        console.error("Error connecting to MongoDB:", error)
        //without the database we cannot recover state safely, so don't start half-working
        process.exit(1)
    }
}
