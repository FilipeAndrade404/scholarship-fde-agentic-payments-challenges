import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { Payments, type PaymentContext } from './payments.js'

type ToolEvent = {
  ferramenta: string
  contexto: PaymentContext
  argumentos?: Record<string, unknown>
}

export function createHandler(payments: Payments) {
  // O agente recebe contexto autenticado da Lambda do chat. O modelo preenche somente argumentos.
  return async ({ ferramenta, contexto, argumentos = {} }: ToolEvent) => {
    const { usuario_id, sessao_id } = contexto ?? {}
    if (typeof usuario_id !== 'string' || !usuario_id.trim() ||
        typeof sessao_id !== 'string' || !sessao_id.trim()) {
      throw new Error('Contexto autenticado ausente.')
    }
    const identity = { usuario_id, sessao_id }

    let result
    switch (ferramenta) {
      case 'listar_catalogo':
        result = await payments.listarCatalogo(argumentos.categoria)
        break
      case 'registrar_intencao':
        result = await payments.registrarIntencao(identity, argumentos.produto_id, argumentos.quantidade)
        break
      case 'realizar_compra':
        result = await payments.realizarCompra(identity, argumentos.intencao_id, argumentos.metodo_pagamento)
        break
      default:
        throw new Error('Ferramenta desconhecida.')
    }

    console.info(JSON.stringify({
      evento: 'ferramenta_pagamento',
      ferramenta,
      ...identity,
      ...('status' in result ? { status: result.status } : { total: result.produtos.length }),
      ...('erro' in result ? { erro: result.erro } : {}),
    }))
    return result
  }
}

function table(variable: string) {
  const name = process.env[variable]
  if (!name) throw new Error(`Configuração ausente: ${variable}.`)
  return name
}

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}))

export async function handler(event: ToolEvent) {
  const payments = new Payments(db, {
    products: table('PRODUCTS_TABLE'),
    users: table('USERS_TABLE'),
    intents: table('INTENTS_TABLE'),
    transactions: table('TRANSACTIONS_TABLE'),
  })
  return createHandler(payments)(event)
}
