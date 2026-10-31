import mongoose from 'mongoose';

const MONGO_URI =
  process.env.MONGO_URI ?? 'mongodb://localhost:27017/ai-assistant';

export const connectToDatabase = async () => {
  await mongoose.connect(MONGO_URI, {
    // Fail fast at startup when MongoDB is not running, instead of on the first request.
    serverSelectionTimeoutMS: 5000,
    // Leave out undefined fields instead of saving them as null. The AI SDK rejects a saved model
    // message with, for example, `providerOptions: null`, so the next turn would fail.
    ignoreUndefined: true,
  });
  console.log(
    `Connected to MongoDB at ${mongoose.connection.host}/${mongoose.connection.name}`,
  );
};
