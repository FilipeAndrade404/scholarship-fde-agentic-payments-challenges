import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Readable, Writable } from 'node:stream'
import { after, before, test } from 'node:test'
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { RuntimeAgent } from '../dist/agent-client.js'
import { Chat } from '../dist/chat.js'
import { Conversations } from '../dist/conversations.js'

const client = new DynamoDBClient({
  endpoint: `http://127.0.0.1:${Number(process.env.DYNAMODB_LOCAL_PORT ?? 8000)}`,
  region: 'us-east-1',
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
})
const table = `chat-test-${randomUUID()}`
const conversations = new Conversations(DynamoDBDocumentClient.from(client), table)
const runtimeArn = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test'

before(async () => {
  await client.send(new CreateTableCommand({
    TableName: table,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [
      { AttributeName: 'conversa_id', AttributeType: 'S' },
      { AttributeName: 'ordem', AttributeType: 'N' },
    ],
    KeySchema: [
      { AttributeName: 'conversa_id', KeyType: 'HASH' },
      { AttributeName: 'ordem', KeyType: 'RANGE' },
    ],
  }))
})

after(async () => {
  try {
    await client.send(new DeleteTableCommand({ TableName: table }))
  } finally {
    client.destroy()
  }
})

const message = (role, content) => ({ role, content: [{ text: content }] })
const claims = sub => ({ authorizer: { claims: { sub } } })
const post = (session, mensagem, user = 'alice') => ({
  httpMethod: 'POST',
  requestContext: claims(user),
  body: JSON.stringify({ sessao_id: session, mensagem, usuario_id: 'bob', historico: ['ignorar'] }),
})
const get = (session, user = 'alice') => ({
  httpMethod: 'GET',
  requestContext: claims(user),
  pathParameters: { sessao_id: session },
})
const textEvent = texto => ({ tipo: 'texto', texto })
const endEvent = mensagens => ({ tipo: 'fim', mensagens })

function chatWithReplies(replies) {
  const requests = []
  const runtime = new RuntimeAgent({
    async send(command) {
      requests.push(command.input)
      const events = replies.shift()
      const bytes = Buffer.from(events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''))
      const chunks = []
      for (let i = 0; i < bytes.length; i += 3) chunks.push(bytes.subarray(i, i + 3))
      return {
        statusCode: 200,
        contentType: 'text/event-stream; charset=utf-8',
        response: Readable.from(chunks),
      }
    },
  }, runtimeArn)
  return { chat: new Chat(conversations, runtime), requests }
}

async function read(response) {
  let body = ''
  for await (const chunk of response.body) body += chunk
  return body
}

test('usa apenas o sub autenticado e valida o corpo antes de invocar o agente', async () => {
  const { chat, requests } = chatWithReplies([])
  const event = post(randomUUID(), 'Olá')
  assert.equal((await chat.handle({ ...event, requestContext: undefined })).statusCode, 401)
  assert.equal((await chat.handle({ ...event, body: '{' })).statusCode, 400)
  assert.equal(requests.length, 0)
})

test('transmite texto, persiste histórico interno e isola usuários com a mesma sessão', async () => {
  const session = randomUUID()
  const internal = [
    message('user', 'Quero um fone'),
    { role: 'assistant', content: [{ toolUse: { toolUseId: 't1', name: 'registrar_intencao', input: {} } }] },
    { role: 'user', content: [{ toolResult: { toolUseId: 't1', content: [{ json: { intencao_id: 'int_123' } }] } }] },
    message('assistant', 'Prefere Pix ou cartão?'),
  ]
  const { chat, requests } = chatWithReplies([
    [textEvent('Prefere Pix ou cartão?'), endEvent(internal)],
    [textEvent('Compra concluída.'), endEvent([message('user', 'Pix'), message('assistant', 'Compra concluída.')])],
  ])
  const first = await chat.handle(post(session, 'Quero um fone'))
  assert.equal(first.statusCode, 200)
  assert.match(first.contentType, /^application\/x-ndjson/)
  assert.deepEqual((await read(first)).trim().split('\n').map(JSON.parse), [
    { message: { role: 'assistant', content: 'Prefere Pix ou cartão?' } },
    { done: true },
  ])
  assert.deepEqual(JSON.parse(Buffer.from(requests[0].payload).toString()), {
    contexto: { usuario_id: 'alice', sessao_id: session },
    mensagem: 'Quero um fone',
    historico: [],
  })
  assert.equal(requests[0].accept, 'text/event-stream')
  assert.equal(requests[0].agentRuntimeArn, runtimeArn)
  assert.match(requests[0].runtimeSessionId, /^[0-9a-f]{64}$/)

  await read(await chat.handle(post(session, 'Pix')))
  assert.deepEqual(JSON.parse(Buffer.from(requests[1].payload).toString()).historico, internal)
  assert.equal(requests[1].runtimeSessionId, requests[0].runtimeSessionId)
  assert.deepEqual(JSON.parse(await read(await chat.handle(get(session)))), {
    mensagens: [
      { role: 'user', content: 'Quero um fone' },
      { role: 'assistant', content: 'Prefere Pix ou cartão?' },
      { role: 'user', content: 'Pix' },
      { role: 'assistant', content: 'Compra concluída.' },
    ],
  })
  assert.deepEqual(JSON.parse(await read(await chat.handle(get(session, 'bob')))), { mensagens: [] })
})

test('rejeita turno simultâneo e grava somente depois da conclusão do agente', async () => {
  const session = randomUUID()
  const { chat, requests } = chatWithReplies([
    [textEvent('Olá'), endEvent([message('user', 'Oi'), message('assistant', 'Olá')])],
  ])
  const first = await chat.handle(post(session, 'Oi'))
  const iterator = first.body[Symbol.asyncIterator]()
  assert.match((await iterator.next()).value, /Olá/)
  assert.deepEqual(JSON.parse(await read(await chat.handle(get(session)))), { mensagens: [] })
  assert.equal((await chat.handle(post(session, 'Outra mensagem'))).statusCode, 409)
  assert.equal(requests.length, 1)
  assert.deepEqual(JSON.parse((await iterator.next()).value), { done: true })
  assert.equal((await iterator.next()).done, true)
  assert.equal(JSON.parse(await read(await chat.handle(get(session)))).mensagens.length, 2)
})

test('falha do agente retorna mensagem genérica e libera a sessão', async () => {
  const session = randomUUID()
  const { chat } = chatWithReplies([
    [{ tipo: 'erro', mensagem: 'detalhes internos' }],
    [textEvent('Olá'), endEvent([message('user', 'Oi'), message('assistant', 'Olá')])],
  ])
  const failure = JSON.parse(await read(await chat.handle(post(session, 'Oi'))))
  assert.equal(failure.error, 'Não foi possível confirmar o resultado da mensagem.')
  assert.equal(failure.done, true)
  assert.deepEqual(JSON.parse(await read(await chat.handle(get(session)))), { mensagens: [] })
  assert.match(await read(await chat.handle(post(session, 'Oi'))), /"done":true/)
})

test('adaptador da Lambda formata a resposta HTTP com streaming', async () => {
  process.env.CONVERSATIONS_TABLE = table
  process.env.AGENT_RUNTIME_ARN = runtimeArn
  let metadata
  globalThis.awslambda = {
    streamifyResponse: fn => fn,
    HttpResponseStream: { from: (output, headers) => { metadata = headers; return output } },
  }
  try {
    const { handler } = await import('../dist/handler.js')
    const chunks = []
    const stream = new Writable({ write(chunk, _encoding, next) { chunks.push(chunk); next() } })
    await handler({ httpMethod: 'POST' }, stream)
    assert.equal(metadata.statusCode, 401)
    assert.match(metadata.headers['Content-Type'], /^application\/json/)
    assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), { error: 'Não autorizado.' })
  } finally {
    delete globalThis.awslambda
    delete process.env.CONVERSATIONS_TABLE
    delete process.env.AGENT_RUNTIME_ARN
  }
})
