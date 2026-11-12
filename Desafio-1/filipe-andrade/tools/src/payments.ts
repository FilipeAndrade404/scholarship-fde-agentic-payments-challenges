import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb'
import {
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
  type ScanCommandOutput,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb'
import type { Product } from './catalog.js'

export type PaymentContext = { usuario_id: string; sessao_id: string }
export type PaymentTables = {
  products: string
  users: string
  intents: string
  transactions: string
}

type PurchaseIntent = PaymentContext & {
  intencao_id: string
  produto_id: string
  quantidade: number
  valor_centavos: number
  moeda: 'BRL'
  status: 'pendente' | 'paga'
  expira_em_ms: number
}

const errors = {
  PRODUTO_INVALIDO: 'Produto não encontrado no catálogo.',
  QUANTIDADE_INVALIDA: 'A quantidade deve ser um inteiro maior que zero.',
  ESTOQUE_INSUFICIENTE: 'Não há estoque suficiente para essa quantidade.',
  INTENCAO_INVALIDA: 'A intenção informada não é válida para esta sessão.',
  INTENCAO_EXPIRADA: 'Esta intenção de compra expirou.',
  INTENCAO_JA_PAGA: 'Esta intenção já foi utilizada em uma compra.',
  METODO_INVALIDO: 'Use cartao ou pix como método de pagamento.',
  LIMITE_EXCEDIDO: 'O valor da compra excede o limite disponível do usuário.',
}

function refused(erro: keyof typeof errors, mensagem = errors[erro]) {
  return { status: 'recusado' as const, erro, mensagem }
}

function normalize(category: string) {
  return category.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()
}

export class Payments {
  constructor(
    private readonly db: DynamoDBDocumentClient,
    private readonly tables: PaymentTables,
    private readonly now = Date.now,
  ) {}

  async listarCatalogo(categoria: unknown) {
    const category = typeof categoria === 'string' ? normalize(categoria) : ''
    const products: Product[] = []
    let cursor: ScanCommandOutput['LastEvaluatedKey']
    do {
      const page = await this.db.send(new ScanCommand({
        TableName: this.tables.products,
        ConsistentRead: true,
        ExclusiveStartKey: cursor,
      }))
      products.push(...(page.Items ?? []) as Product[])
      cursor = page.LastEvaluatedKey
    } while (cursor)

    return {
      produtos: products
        .filter(product => !category || normalize(product.categoria) === category)
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(({ id, nome, preco_centavos, moeda, estoque }) => ({
          id, nome, preco: preco_centavos / 100, moeda, estoque,
        })),
    }
  }

  private async getProduct(id: string) {
    const { Item } = await this.db.send(new GetCommand({
      TableName: this.tables.products,
      Key: { id },
      ConsistentRead: true,
    }))
    return Item as Product | undefined
  }

  async registrarIntencao(context: PaymentContext, produto_id: unknown, quantidade: unknown) {
    if (typeof produto_id !== 'string' || !produto_id || Buffer.byteLength(produto_id) > 2048) {
      return refused('PRODUTO_INVALIDO')
    }
    const product = await this.getProduct(produto_id)
    if (!product) return refused('PRODUTO_INVALIDO')
    if (typeof quantidade !== 'number' || !Number.isSafeInteger(quantidade) || quantidade <= 0) {
      return refused('QUANTIDADE_INVALIDA')
    }
    if (quantidade > product.estoque) return refused('ESTOQUE_INSUFICIENTE')

    const intent: PurchaseIntent = {
      ...context,
      intencao_id: `int_${randomUUID().replaceAll('-', '')}`,
      produto_id,
      quantidade,
      valor_centavos: product.preco_centavos * quantidade,
      moeda: product.moeda,
      status: 'pendente',
      expira_em_ms: this.now() + 10 * 60 * 1000,
    }
    await this.db.send(new PutCommand({
      TableName: this.tables.intents,
      Item: intent,
      ConditionExpression: 'attribute_not_exists(intencao_id)',
    }))
    return {
      intencao_id: intent.intencao_id,
      produto_id,
      quantidade,
      valor_total: intent.valor_centavos / 100,
      moeda: intent.moeda,
      status: intent.status,
      expira_em: new Date(intent.expira_em_ms).toISOString(),
    }
  }

  async realizarCompra(context: PaymentContext, intencao_id: unknown, metodo_pagamento: unknown) {
    if (typeof intencao_id !== 'string' || !/^int_[a-f0-9]+$/.test(intencao_id)) {
      return refused('INTENCAO_INVALIDA')
    }

    for (let attempt = 0; attempt < 4; attempt++) {
      const { Item } = await this.db.send(new GetCommand({
        TableName: this.tables.intents,
        Key: { intencao_id },
        ConsistentRead: true,
      }))
      const intent = Item as PurchaseIntent | undefined
      if (!intent || intent.usuario_id !== context.usuario_id || intent.sessao_id !== context.sessao_id) {
        return refused('INTENCAO_INVALIDA')
      }
      if (intent.status === 'paga') return refused('INTENCAO_JA_PAGA')
      if (this.now() >= intent.expira_em_ms) return refused('INTENCAO_EXPIRADA')
      if (metodo_pagamento !== 'cartao' && metodo_pagamento !== 'pix') {
        return refused('METODO_INVALIDO')
      }

      const { Item: user } = await this.db.send(new GetCommand({
        TableName: this.tables.users,
        Key: { usuario_id: context.usuario_id },
        ConsistentRead: true,
      }))
      const limit = user?.limite_centavos
      if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 0) {
        throw new Error('Limite do usuário ausente ou inválido.')
      }
      if (limit < intent.valor_centavos) return refused('LIMITE_EXCEDIDO')

      const product = await this.getProduct(intent.produto_id)
      if (!product || product.estoque < intent.quantidade) {
        return refused('INTENCAO_INVALIDA', 'O produto desta intenção não possui mais estoque suficiente.')
      }

      const time = this.now()
      if (time >= intent.expira_em_ms) return refused('INTENCAO_EXPIRADA')
      const remaining = limit - intent.valor_centavos
      const result = {
        status: 'aprovado' as const,
        transacao_id: `tx_${intencao_id.slice(4)}`,
        intencao_id,
        valor: intent.valor_centavos / 100,
        metodo_pagamento,
        limite_restante: remaining / 100,
        data: new Date(time).toISOString(),
      }

      try {
        await this.db.send(new TransactWriteCommand({
          ClientRequestToken: randomUUID(),
          TransactItems: [
            {
              Update: {
                TableName: this.tables.intents,
                Key: { intencao_id },
                UpdateExpression: 'SET #status = :paid',
                ConditionExpression: '#status = :pending AND usuario_id = :user AND sessao_id = :session AND expira_em_ms > :now',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: {
                  ':paid': 'paga', ':pending': 'pendente', ':user': context.usuario_id,
                  ':session': context.sessao_id, ':now': time,
                },
              },
            },
            {
              Update: {
                TableName: this.tables.users,
                Key: { usuario_id: context.usuario_id },
                UpdateExpression: 'SET limite_centavos = :remaining',
                ConditionExpression: 'limite_centavos = :previous',
                ExpressionAttributeValues: { ':remaining': remaining, ':previous': limit },
              },
            },
            {
              Update: {
                TableName: this.tables.products,
                Key: { id: intent.produto_id },
                UpdateExpression: 'SET estoque = estoque - :quantity',
                ConditionExpression: 'estoque >= :quantity',
                ExpressionAttributeValues: { ':quantity': intent.quantidade },
              },
            },
            {
              Put: {
                TableName: this.tables.transactions,
                Item: {
                  ...context,
                  transacao_id: result.transacao_id,
                  intencao_id,
                  produto_id: intent.produto_id,
                  quantidade: intent.quantidade,
                  valor_centavos: intent.valor_centavos,
                  moeda: intent.moeda,
                  metodo_pagamento,
                  data: result.data,
                },
                ConditionExpression: 'attribute_not_exists(transacao_id)',
              },
            },
          ],
        }))
        return result
      } catch (error) {
        const reasons = error instanceof TransactionCanceledException ? error.CancellationReasons : undefined
        const concurrentChange = reasons?.length && reasons.every(reason =>
          reason.Code === 'None' || reason.Code === 'ConditionalCheckFailed' || reason.Code === 'TransactionConflict',
        )
        if (!concurrentChange) throw error
        await delay(15 * (attempt + 1))
      }
    }
    throw new Error('Não foi possível concluir a compra devido a alterações concorrentes.')
  }
}
