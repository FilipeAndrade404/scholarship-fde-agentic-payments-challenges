import { Readable, type Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { RuntimeAgent } from './agent-client.js'
import { Chat, type ChatEvent } from './chat.js'
import { Conversations } from './conversations.js'

declare const awslambda: {
  streamifyResponse(handler: (event: ChatEvent, stream: Writable) => Promise<void>): unknown
  HttpResponseStream: {
    from(stream: Writable, metadata: { statusCode: number; headers: Record<string, string> }): Writable
  }
}

function configuration(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Configuração ausente: ${name}.`)
  return value
}

const chat = new Chat(
  new Conversations(DynamoDBDocumentClient.from(new DynamoDBClient({})), configuration('CONVERSATIONS_TABLE')),
  new RuntimeAgent(new BedrockAgentCoreClient({ maxAttempts: 1 }), configuration('AGENT_RUNTIME_ARN')),
)

export const handler = awslambda.streamifyResponse(async (event, stream) => {
  const response = await chat.handle(event)
  const headers: Record<string, string> = {
    'Content-Type': response.contentType,
    'Cache-Control': 'no-store',
  }
  if (process.env.FRONTEND_ORIGIN) {
    headers['Access-Control-Allow-Origin'] = process.env.FRONTEND_ORIGIN
  }
  const output = awslambda.HttpResponseStream.from(stream, { statusCode: response.statusCode, headers })
  await pipeline(Readable.from(response.body), output)
})
