import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { initialCatalog } from '../dist/catalog.js'
import { createHandler } from '../dist/handler.js'
import { Payments } from '../dist/payments.js'

const client = new DynamoDBClient({
  endpoint: `http://127.0.0.1:${Number(process.env.DYNAMODB_LOCAL_PORT ?? 8000)}`,
  region: 'us-east-1',
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
})
const db = DynamoDBDocumentClient.from(client)
const suffix = randomUUID()
const tables = {
  products: `products-${suffix}`,
  users: `users-${suffix}`,
  intents: `intents-${suffix}`,
  transactions: `transactions-${suffix}`,
}
const created = []
const context = { usuario_id: 'alice', sessao_id: 'chat-1' }
let clock = Date.parse('2026-01-01T00:00:00.000Z')
const handler = createHandler(new Payments(db, tables, () => clock))

const call = (ferramenta, argumentos, contexto = context) =>
  handler({ ferramenta, argumentos, contexto })
const register = (produto_id, quantidade = 1, contexto = context) =>
  call('registrar_intencao', { produto_id, quantidade }, contexto)
const buy = (intencao_id, metodo_pagamento, contexto = context) =>
  call('realizar_compra', { intencao_id, metodo_pagamento }, contexto)
const read = async (TableName, Key) =>
  (await db.send(new GetCommand({ TableName, Key, ConsistentRead: true }))).Item

before(async () => {
  for (const [TableName, key] of [
    [tables.products, 'id'],
    [tables.users, 'usuario_id'],
    [tables.intents, 'intencao_id'],
    [tables.transactions, 'transacao_id'],
  ]) {
    await client.send(new CreateTableCommand({
      TableName,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [{ AttributeName: key, AttributeType: 'S' }],
      KeySchema: [{ AttributeName: key, KeyType: 'HASH' }],
    }))
    created.push(TableName)
  }
  for (const Item of initialCatalog) {
    await db.send(new PutCommand({ TableName: tables.products, Item }))
  }
  for (const [usuario_id, limite_centavos] of [['alice', 50000], ['bob', 150000], ['carla', 20000]]) {
    await db.send(new PutCommand({ TableName: tables.users, Item: { usuario_id, limite_centavos } }))
  }
})

after(async () => {
  try {
    await Promise.all(created.map(TableName => client.send(new DeleteTableCommand({ TableName }))))
  } finally {
    client.destroy()
  }
})

test('lista catálogo e normaliza categoria', async () => {
  const all = await call('listar_catalogo')
  assert.equal(all.produtos.length, 7)
  assert.deepEqual((await call('listar_catalogo', { categoria: ' ÁUDIO ' })).produtos, [{
    id: 'prod_003', nome: 'Fone Bluetooth', preco: 249.9, moeda: 'BRL', estoque: 12,
  }])
  assert.deepEqual(await call('listar_catalogo', { categoria: 'inexistente' }), { produtos: [] })
})

test('recusa produto, quantidade e estoque inválidos', async () => {
  assert.equal((await register('prod_inexistente')).erro, 'PRODUTO_INVALIDO')
  assert.equal((await register('prod_003', 0)).erro, 'QUANTIDADE_INVALIDA')
  assert.equal((await register('prod_003', 13)).erro, 'ESTOQUE_INSUFICIENTE')
})

test('Pix usa a intenção original e debita limite e estoque uma vez sob concorrência', async () => {
  const intent = await register('prod_003')
  assert.equal(intent.status, 'pendente')
  assert.equal(intent.valor_total, 249.9)
  assert.equal(intent.expira_em, '2026-01-01T00:10:00.000Z')
  assert.equal((await read(tables.users, { usuario_id: 'alice' })).limite_centavos, 50000)
  assert.equal((await read(tables.products, { id: 'prod_003' })).estoque, 12)

  const results = await Promise.all(Array.from({ length: 2 }, () => call('realizar_compra', {
    intencao_id: intent.intencao_id,
    metodo_pagamento: 'pix',
    valor: 0,
    usuario_id: 'bob',
  })))
  const approved = results.find(result => result.status === 'aprovado')
  assert.equal(approved?.valor, 249.9)
  assert.equal(approved?.limite_restante, 250.1)
  assert.equal(results.filter(result => result.status === 'aprovado').length, 1)
  assert.equal(results.find(result => result.status === 'recusado')?.erro, 'INTENCAO_JA_PAGA')
  assert.equal((await read(tables.users, { usuario_id: 'alice' })).limite_centavos, 25010)
  assert.equal((await read(tables.users, { usuario_id: 'bob' })).limite_centavos, 150000)
  assert.equal((await read(tables.products, { id: 'prod_003' })).estoque, 11)
  assert.equal((await read(tables.intents, { intencao_id: intent.intencao_id })).status, 'paga')
  assert.equal((await db.send(new ScanCommand({ TableName: tables.transactions }))).Count, 1)
})

test('valida dono, sessão, método e limite antes de aprovar cartão', async () => {
  const bob = { ...context, usuario_id: 'bob' }
  const carla = { ...context, usuario_id: 'carla' }
  const intent = await register('prod_005', 1, bob)
  assert.equal((await buy('int_00000000', 'pix', bob)).erro, 'INTENCAO_INVALIDA')
  assert.equal((await buy(intent.intencao_id, 'pix')).erro, 'INTENCAO_INVALIDA')
  assert.equal((await buy(intent.intencao_id, 'pix', { ...bob, sessao_id: 'outra' })).erro, 'INTENCAO_INVALIDA')
  assert.equal((await buy(intent.intencao_id, 'dinheiro', bob)).erro, 'METODO_INVALIDO')

  const expensive = await register('prod_005', 1, carla)
  assert.equal((await buy(expensive.intencao_id, 'cartao', carla)).erro, 'LIMITE_EXCEDIDO')
  const card = await buy(intent.intencao_id, 'cartao', bob)
  assert.equal(card.status, 'aprovado')
  assert.equal(card.limite_restante, 201)
})

test('revalida estoque e rejeita intenção no instante da expiração', async () => {
  const intent = await register('prod_006')
  await db.send(new UpdateCommand({
    TableName: tables.products,
    Key: { id: 'prod_006' },
    UpdateExpression: 'SET estoque = :zero',
    ExpressionAttributeValues: { ':zero': 0 },
  }))
  assert.equal((await buy(intent.intencao_id, 'pix')).erro, 'INTENCAO_INVALIDA')
  clock += 10 * 60 * 1000
  assert.equal((await buy(intent.intencao_id, 'pix')).erro, 'INTENCAO_EXPIRADA')
  assert.equal((await read(tables.users, { usuario_id: 'alice' })).limite_centavos, 25010)
  assert.equal((await read(tables.intents, { intencao_id: intent.intencao_id })).status, 'pendente')
})
