import {generateText} from 'ai'
import { model } from './model.ts'

const result = await generateText({
  model: model,
  instructions: 'You are a content writer who writes the clean and clear captions for the social media posts. also make sure to use the 2-3 hashtag and generate only the 1 caption don\'t give other options. also try to add emojis in the caption to make it more attractive and engaging only when needed and necessary. also make sure to keep the caption under 50 words.',
  prompt: 'I am planning to post the picture of the creatosaurus logo the compnay which is startup and which is going to help people to manage thier creative workflow with the sass. so user don\'t need to worry about taking the multiple subscriptions and in only one place they can manage thier whole createive workflow. also it helps you to build the worflows with AI so you can automate the things and you just have to take the dicisions and AI will take care of the rest. and dont add emojis in the caption.',
})

console.log(result.text)