// The agent behind an HTTP API, so the app's chat (the AI SDK's useChat) can talk to it.
// Conversations are saved in MongoDB:
//
//   GET  /v1/conversations                 the signed-in person's past conversations, newest first
//   GET  /v1/conversations/:id             one conversation, as the UI messages useChat shows
//   POST /v1/conversations/:id/messages    body: { message }  →  the answer, streamed in the AI SDK's
//                                          UI message format. The first message creates the
//                                          conversation; an Approve or Deny is sent here too.
//
// The app sends only the newest message. The server keeps the conversation and adds each turn.
import express from 'express';
import { connectToDatabase } from './db.ts';
import conversationRoutes from './routes/conversation.routes.ts';
import { errorHandler } from './middleware/errorHandler.ts';

// 4000-4008 are other Creatosaurus services; 4009 was Muse's old realtime port and stays retired.
const PORT = Number(process.env.PORT ?? 4010);

const app = express();

app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'ai-learning-examples' });
});

app.use('/v1/conversations', conversationRoutes);

app.use(errorHandler);

await connectToDatabase();

app.listen(PORT, () => {
  console.log(`AI chat API running on http://localhost:${PORT}`);
});
