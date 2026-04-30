require("dotenv").config();
const mongoose = require("mongoose");
const env = require("./src/config/env");
mongoose.connect(env.MONGO_URI, { dbName: "fasttv" }).then(() => {
    console.log("MongoDB connected for tests");
    process.exit(0);
}).catch((err) => {
    console.error("MongoDB error", err);
    process.exit(1);
});
