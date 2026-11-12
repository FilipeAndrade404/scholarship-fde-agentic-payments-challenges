import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb'

type PreTokenEvent = { request?: { userAttributes?: { sub?: string } } }

export function createUserProvisioner(db: DynamoDBDocumentClient, table: string, initialLimit: number) {
  if (!table || !Number.isSafeInteger(initialLimit) || initialLimit < 0) {
    throw new Error('Configuração de usuários inválida.')
  }
  return async <T extends PreTokenEvent>(event: T): Promise<T> => {
    const usuario_id = event.request?.userAttributes?.sub
    if (typeof usuario_id !== 'string' || !usuario_id.trim()) {
      throw new Error('Identidade do usuário indisponível.')
    }
    try {
      await db.send(new PutCommand({
        TableName: table,
        Item: { usuario_id, limite_centavos: initialLimit },
        ConditionExpression: 'attribute_not_exists(usuario_id)',
      }))
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) {
        console.error('Falha ao preparar o perfil de pagamentos.', error instanceof Error ? error.name : 'Erro desconhecido')
        throw new Error('Não foi possível preparar seu perfil. Tente novamente.')
      }
    }
    return event
  }
}

const db = DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 1 }))

export async function handler(event: PreTokenEvent) {
  return createUserProvisioner(
    db,
    process.env.USERS_TABLE ?? '',
    Number(process.env.INITIAL_LIMIT_CENTS),
  )(event)
}
