import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { createUserProvisioner } from '../dist/cognito.js'

test('gera o perfil uma vez e preserva o limite em logins e renovações', async () => {
  const client = new DynamoDBClient({
    endpoint: `http://127.0.0.1:${Number(process.env.DYNAMODB_LOCAL_PORT ?? 8000)}`,
    region: 'us-east-1',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  })
  const db = DynamoDBDocumentClient.from(client)
  const table = `user-init-test-${randomUUID()}`
  const key = { usuario_id: 'sub-cognito' }
  const initialize = createUserProvisioner(db, table, 50000)
  const event = {
    triggerSource: 'TokenGeneration_NewPasswordChallenge',
    request: { userAttributes: { sub: key.usuario_id } },
    response: {},
  }
  let created = false
  try {
    await client.send(new CreateTableCommand({
      TableName: table,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [{ AttributeName: 'usuario_id', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'usuario_id', KeyType: 'HASH' }],
    }))
    created = true
    const loadUser = async () => (await db.send(new GetCommand({
      TableName: table, Key: key, ConsistentRead: true,
    }))).Item

    assert.deepEqual(await Promise.all([initialize(event), initialize(event)]), [event, event])
    assert.deepEqual(await loadUser(), { ...key, limite_centavos: 50000 })
    await db.send(new UpdateCommand({
      TableName: table,
      Key: key,
      UpdateExpression: 'SET limite_centavos = :saldo',
      ExpressionAttributeValues: { ':saldo': 25010 },
    }))
    const refresh = { ...event, triggerSource: 'TokenGeneration_RefreshTokens' }
    assert.deepEqual(await initialize(refresh), refresh)
    assert.deepEqual(await loadUser(), { ...key, limite_centavos: 25010 })
    await assert.rejects(initialize({ request: { userAttributes: {} } }), /Identidade do usuário/)
  } finally {
    try {
      if (created) await client.send(new DeleteTableCommand({ TableName: table }))
    } finally {
      client.destroy()
    }
  }
})
