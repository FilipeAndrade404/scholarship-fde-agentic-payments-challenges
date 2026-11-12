import { createHash, randomUUID } from 'node:crypto'
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb'
import {
  type DynamoDBDocumentClient,
  type QueryCommandOutput,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'
import { chatTimeoutSeconds } from './chat-config.js'

const leaseDurationMs = (chatTimeoutSeconds + 30) * 1000

export type ConversationContext = { usuario_id: string; sessao_id: string }
export type AgentMessage = { role: 'user' | 'assistant'; content: Record<string, unknown>[] }
type Turn = { entrada: string; resposta: string; mensagens: AgentMessage[] }
export type ConversationLease = { conversation: string; token: string; order: number }

export function conversationId(context: ConversationContext) {
  return createHash('sha256').update(JSON.stringify([context.usuario_id, context.sessao_id])).digest('hex')
}

export class Conversations {
  constructor(private readonly db: DynamoDBDocumentClient, private readonly table: string) {}

  async history(conversation: string) {
    const turns: Turn[] = []
    let cursor: QueryCommandOutput['LastEvaluatedKey']
    do {
      const page = await this.db.send(new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: 'conversa_id = :conversation AND ordem > :zero',
        ExpressionAttributeValues: { ':conversation': conversation, ':zero': 0 },
        ConsistentRead: true,
        ExclusiveStartKey: cursor,
      }))
      turns.push(...(page.Items ?? []) as Turn[])
      cursor = page.LastEvaluatedKey
    } while (cursor)
    return turns
  }

  async reserve(conversation: string): Promise<ConversationLease | null> {
    const token = randomUUID()
    const now = Date.now()
    try {
      const result = await this.db.send(new UpdateCommand({
        TableName: this.table,
        Key: { conversa_id: conversation, ordem: 0 },
        UpdateExpression: 'SET bloqueio = :token, bloqueio_ate = :expiry',
        ConditionExpression: 'attribute_not_exists(bloqueio) OR bloqueio_ate <= :now',
        ExpressionAttributeValues: { ':token': token, ':expiry': now + leaseDurationMs, ':now': now },
        ReturnValues: 'ALL_NEW',
      }))
      return { conversation, token, order: (result.Attributes?.ultimo_turno ?? 0) + 1 }
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) return null
      throw error
    }
  }

  async save(lease: ConversationLease, turn: Turn) {
    // Reserva espaço para os atributos da chave e o custo estrutural do item DynamoDB.
    if (Buffer.byteLength(JSON.stringify(turn)) > 350 * 1024) {
      throw new Error('O turno excede o tamanho previsto para armazenamento.')
    }
    await this.db.send(new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: this.table,
            Item: { conversa_id: lease.conversation, ordem: lease.order, ...turn },
            ConditionExpression: 'attribute_not_exists(ordem)',
          },
        },
        {
          Update: {
            TableName: this.table,
            Key: { conversa_id: lease.conversation, ordem: 0 },
            UpdateExpression: 'SET ultimo_turno = :order REMOVE bloqueio, bloqueio_ate',
            ConditionExpression: 'bloqueio = :token',
            ExpressionAttributeValues: { ':order': lease.order, ':token': lease.token },
          },
        },
      ],
    }))
  }

  async release(lease: ConversationLease) {
    try {
      await this.db.send(new UpdateCommand({
        TableName: this.table,
        Key: { conversa_id: lease.conversation, ordem: 0 },
        UpdateExpression: 'REMOVE bloqueio, bloqueio_ate',
        ConditionExpression: 'bloqueio = :token',
        ExpressionAttributeValues: { ':token': lease.token },
      }))
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) throw error
    }
  }
}
