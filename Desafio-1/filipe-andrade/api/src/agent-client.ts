import { Readable } from 'node:stream'
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore'
import { chatTimeoutSeconds } from './chat-config.js'
import type { AgentMessage, ConversationContext } from './conversations.js'

export type AgentTurn = {
  contexto: ConversationContext
  mensagem: string
  historico: AgentMessage[]
}

export type AgentEvent =
  | { tipo: 'texto'; texto: string }
  | { tipo: 'fim'; mensagens: AgentMessage[] }
  | { tipo: 'erro' }

function isMessage(value: unknown): value is AgentMessage {
  return !!value && typeof value === 'object' &&
    'role' in value && (value.role === 'user' || value.role === 'assistant') &&
    'content' in value && Array.isArray(value.content)
}

function readEvent(data: string): AgentEvent {
  const event = JSON.parse(data)
  if (event?.tipo === 'texto' && typeof event.texto === 'string') {
    return { tipo: 'texto', texto: event.texto }
  }
  if (event?.tipo === 'fim' && Array.isArray(event.mensagens) && event.mensagens.length && event.mensagens.every(isMessage)) {
    return { tipo: 'fim', mensagens: event.mensagens }
  }
  if (event?.tipo === 'erro') return { tipo: 'erro' }
  throw new Error('Evento inesperado do AgentCore.')
}

export async function* parseAgentStream(body: AsyncIterable<Uint8Array>): AsyncGenerator<AgentEvent> {
  const decoder = new TextDecoder()
  let buffer = ''
  let data: string[] = []
  let dataLength = 0
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true })
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, '')
      buffer = buffer.slice(newline + 1)
      if (line === '' && data.length) {
        yield readEvent(data.join('\n'))
        data = []
        dataLength = 0
      } else if (line.startsWith('data:')) {
        const field = line.slice(5).replace(/^ /, '')
        dataLength += field.length + 1
        if (dataLength > 512 * 1024) throw new Error('Evento do agente excedeu o tamanho esperado.')
        data.push(field)
      }
    }
    if (buffer.length > 512 * 1024) throw new Error('Evento do agente excedeu o tamanho esperado.')
  }
  if (buffer.length || data.length) throw new Error('Resposta do agente interrompida.')
}

export class RuntimeAgent {
  constructor(private readonly client: BedrockAgentCoreClient, private readonly runtimeArn: string) {}

  async *invoke(session: string, turn: AgentTurn) {
    const signal = AbortSignal.timeout((chatTimeoutSeconds - 5) * 1000)
    const result = await this.client.send(new InvokeAgentRuntimeCommand({
      agentRuntimeArn: this.runtimeArn,
      runtimeSessionId: session,
      contentType: 'application/json',
      accept: 'text/event-stream',
      payload: Buffer.from(JSON.stringify(turn), 'utf8'),
    }), { abortSignal: signal })

    if (!(result.response instanceof Readable)) throw new Error('Resposta do AgentCore ausente.')
    const body = result.response
    try {
      if (result.statusCode !== 200 || !result.contentType?.startsWith('text/event-stream')) {
        throw new Error('O AgentCore retornou uma resposta inesperada.')
      }
      const abort = () => body.destroy(new Error('Tempo de resposta do agente excedido.'))
      if (signal.aborted) abort()
      signal.addEventListener('abort', abort, { once: true })
      try {
        yield* parseAgentStream(body)
      } finally {
        signal.removeEventListener('abort', abort)
      }
    } finally {
      body.destroy()
    }
  }
}
