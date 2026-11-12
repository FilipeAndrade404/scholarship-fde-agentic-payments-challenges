import type { AgentEvent, AgentTurn } from './agent-client.js'
import { conversationId, type Conversations, type ConversationContext, type ConversationLease } from './conversations.js'

export type ChatEvent = {
  httpMethod?: string
  requestContext?: { authorizer?: { claims?: { sub?: unknown } } }
  body?: string | null
  isBase64Encoded?: boolean
  pathParameters?: { sessao_id?: string } | null
}

type ChatResponse = {
  statusCode: number
  contentType: string
  body: Iterable<string> | AsyncIterable<string>
}

type Agent = { invoke(session: string, turn: AgentTurn): AsyncIterable<AgentEvent> }

const json = (statusCode: number, value: object): ChatResponse => ({
  statusCode,
  contentType: 'application/json; charset=utf-8',
  body: [JSON.stringify(value)],
})
const line = (value: object) => JSON.stringify(value) + '\n'
const sessionPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function readMessage(event: ChatEvent) {
  if (typeof event.body !== 'string' || event.body.length > 32 * 1024) return null
  try {
    const body = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body
    const input = JSON.parse(body)
    if (typeof input?.sessao_id !== 'string' || !sessionPattern.test(input.sessao_id) ||
        typeof input.mensagem !== 'string' || input.mensagem.length > 4000 || !input.mensagem.trim()) {
      return null
    }
    return { sessao_id: input.sessao_id.toLowerCase(), mensagem: input.mensagem.trim() }
  } catch {
    return null
  }
}

export class Chat {
  constructor(private readonly conversations: Conversations, private readonly agent: Agent) {}

  async handle(event: ChatEvent): Promise<ChatResponse> {
    const usuario_id = event.requestContext?.authorizer?.claims?.sub
    if (typeof usuario_id !== 'string' || !usuario_id.trim()) {
      return json(401, { error: 'Não autorizado.' })
    }

    try {
      if (event.httpMethod === 'GET') {
        const session = event.pathParameters?.sessao_id
        if (typeof session !== 'string' || !sessionPattern.test(session)) {
          return json(400, { error: 'Informe uma sessão válida.' })
        }
        const turns = await this.conversations.history(conversationId({
          usuario_id, sessao_id: session.toLowerCase(),
        }))
        return json(200, { mensagens: turns.flatMap(turn => [
          { role: 'user', content: turn.entrada },
          { role: 'assistant', content: turn.resposta },
        ]) })
      }
      if (event.httpMethod !== 'POST') return json(405, { error: 'Método indisponível.' })

      const input = readMessage(event)
      if (!input) return json(400, { error: 'Informe uma sessão válida e uma mensagem de até 4000 caracteres.' })

      const context = { usuario_id, sessao_id: input.sessao_id }
      const lease = await this.conversations.reserve(conversationId(context))
      if (!lease) return json(409, { error: 'A conversa ainda está processando a mensagem anterior.' })
      return {
        statusCode: 200,
        contentType: 'application/x-ndjson; charset=utf-8',
        body: this.stream(lease, context, input.mensagem),
      }
    } catch (error) {
      console.warn('Falha ao acessar a conversa.', error instanceof Error ? error.name : 'Erro desconhecido')
      return json(503, { error: 'O chat está indisponível. Tente novamente mais tarde.' })
    }
  }

  private async *stream(
    lease: ConversationLease,
    context: ConversationContext,
    message: string,
  ) {
    let response = ''
    let saved = false
    try {
      const turns = await this.conversations.history(lease.conversation)
      const events = this.agent.invoke(lease.conversation, {
        contexto: context,
        mensagem: message,
        historico: turns.flatMap(turn => turn.mensagens),
      })
      for await (const event of events) {
        if (event.tipo === 'erro') throw new Error('O agente interrompeu o turno.')
        if (event.tipo === 'fim') {
          await this.conversations.save(lease, { entrada: message, resposta: response, mensagens: event.mensagens })
          saved = true
          yield line({ done: true })
          return
        }
        response += event.texto
        yield line({ message: { role: 'assistant', content: event.texto } })
      }
      throw new Error('O agente não concluiu o turno.')
    } catch (error) {
      console.warn('Falha no turno do chat.', error instanceof Error ? error.name : 'Erro desconhecido')
      yield line({ error: 'Não foi possível confirmar o resultado da mensagem.', done: true })
    } finally {
      if (!saved) {
        try {
          await this.conversations.release(lease)
        } catch (error) {
          console.warn('Falha ao liberar a conversa.', error instanceof Error ? error.name : 'Erro desconhecido')
        }
      }
    }
  }
}
