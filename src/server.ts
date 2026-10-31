// The agent behind an HTTP API, so the app can chat with it. Conversations are saved in MongoDB:
//
//   GET  /v1/conversations                 the signed-in person's past conversations, newest first
//   POST /v1/conversations                 start a new one
//   GET  /v1/conversations/:id             one conversation, as the messages to show
//   POST /v1/conversations/:id/messages    body: { text, attachments }  →  { title, message }
//
// The app sends only the new message. The server keeps the full model history and adds each turn.
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
