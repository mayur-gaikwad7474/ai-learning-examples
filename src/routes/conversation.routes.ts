import { Router } from 'express';
import { requireIdentity } from '../middleware/requireIdentity.ts';
import * as conversationController from '../controllers/conversation.controller.ts';

const router = Router();

router.use(requireIdentity);

router.get('/', conversationController.listConversations);
router.get('/:id', conversationController.getConversation);
// A new message, or the user's Approve/Deny on the last answer. Both continue the conversation.
router.post('/:id/messages', conversationController.sendMessage);

export default router;
