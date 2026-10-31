import { Router } from 'express';
import { requireIdentity } from '../middleware/requireIdentity.ts';
import * as conversationController from '../controllers/conversation.controller.ts';

const router = Router();

router.use(requireIdentity);

router.get('/', conversationController.listConversations);
router.post('/', conversationController.createConversation);
router.get('/:id', conversationController.getConversation);
router.post('/:id/messages', conversationController.sendMessage);

export default router;
