import { fileURLToPath } from 'node:url'
import { ArnFormat, CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib'
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb'
import { Policy, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam'
import { Code, Function, Runtime } from 'aws-cdk-lib/aws-lambda'
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs'
import { AwsCustomResource, PhysicalResourceId } from 'aws-cdk-lib/custom-resources'
import type { Construct } from 'constructs'
import { initialCatalog } from '../tools/src/catalog.ts'
import { addAgentRuntime } from './agent-runtime.ts'

export class PaymentsStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props)

    const products = this.paymentTable('Products', 'produtos', 'id')
    const users = this.paymentTable('Users', 'usuarios', 'usuario_id')
    const intents = this.paymentTable('Intents', 'intencoes', 'intencao_id')
    const transactions = this.paymentTable('Transactions', 'transacoes', 'transacao_id')

    const toolName = `${this.stackName}-tools`
    const toolLogs = this.functionLogs('PaymentToolsLogs', toolName)
    const toolRole = this.functionRole('PaymentToolsRole', toolLogs)
    toolRole.addToPolicy(new PolicyStatement({
      actions: ['dynamodb:Scan'],
      resources: [products.tableArn],
    }))
    toolRole.addToPolicy(new PolicyStatement({
      actions: ['dynamodb:GetItem'],
      resources: [products.tableArn, users.tableArn, intents.tableArn],
    }))
    toolRole.addToPolicy(new PolicyStatement({
      actions: ['dynamodb:PutItem'],
      resources: [intents.tableArn],
    }))
    const purchaseOnly = { StringEquals: { 'dynamodb:EnclosingOperation': 'TransactWriteItems' } }
    toolRole.addToPolicy(new PolicyStatement({
      actions: ['dynamodb:UpdateItem'],
      resources: [products.tableArn, users.tableArn, intents.tableArn],
      conditions: purchaseOnly,
    }))
    toolRole.addToPolicy(new PolicyStatement({
      actions: ['dynamodb:PutItem'],
      resources: [transactions.tableArn],
      conditions: purchaseOnly,
    }))

    const tools = new Function(this, 'PaymentTools', {
      functionName: toolName,
      code: Code.fromAsset(fileURLToPath(new URL('./dist/payment-tools', import.meta.url))),
      runtime: Runtime.NODEJS_24_X,
      handler: 'index.handler',
      role: toolRole,
      logGroup: toolLogs,
      timeout: Duration.seconds(15),
      memorySize: 256,
      environment: {
        PRODUCTS_TABLE: products.tableName,
        USERS_TABLE: users.tableName,
        INTENTS_TABLE: intents.tableName,
        TRANSACTIONS_TABLE: transactions.tableName,
      },
    })

    this.seedCatalog(products)
    const agent = addAgentRuntime(this, tools)

    new CfnOutput(this, 'AgentRuntimeArn', { value: agent.attrAgentRuntimeArn })
    new CfnOutput(this, 'PaymentToolsArn', { value: tools.functionArn })
    new CfnOutput(this, 'UsersTableName', { value: users.tableName })
  }

  private paymentTable(id: string, suffix: string, key: string) {
    return new Table(this, id, {
      tableName: `${this.stackName}-${suffix}`,
      partitionKey: { name: key, type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    })
  }

  private functionLogs(id: string, functionName: string) {
    return new LogGroup(this, id, {
      logGroupName: `/aws/lambda/${functionName}`,
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    })
  }

  private functionRole(id: string, logGroup: LogGroup) {
    const role = new Role(this, id, { assumedBy: new ServicePrincipal('lambda.amazonaws.com') })
    role.addToPolicy(new PolicyStatement({
      actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [this.formatArn({
        service: 'logs',
        resource: 'log-group',
        arnFormat: ArnFormat.COLON_RESOURCE_NAME,
        resourceName: `${logGroup.logGroupName}:log-stream:*`,
      })],
    }))
    return role
  }

  private seedCatalog(products: Table) {
    const functionName = `${this.stackName}-catalogo-seed`
    const logGroup = this.functionLogs('CatalogSeedLogs', functionName)
    const role = this.functionRole('CatalogSeedRole', logGroup)
    const seedPolicy = new Policy(this, 'CatalogSeedWritePolicy', {
      roles: [role],
      statements: [new PolicyStatement({ actions: ['dynamodb:PutItem'], resources: [products.tableArn] })],
    })

    for (const product of initialCatalog) {
      const insert = {
        service: 'DynamoDB',
        action: 'putItem',
        physicalResourceId: PhysicalResourceId.of(product.id),
        ignoreErrorCodesMatching: '^ConditionalCheckFailedException$',
        parameters: {
          TableName: products.tableName,
          ConditionExpression: 'attribute_not_exists(#id)',
          ExpressionAttributeNames: { '#id': 'id' },
          Item: {
            id: { S: product.id },
            nome: { S: product.nome },
            moeda: { S: product.moeda },
            categoria: { S: product.categoria },
            preco_centavos: { N: String(product.preco_centavos) },
            estoque: { N: String(product.estoque) },
          },
        },
      }
      const seed = new AwsCustomResource(this, `Seed-${product.id}`, {
        functionName,
        logGroup,
        role,
        onCreate: insert,
        onUpdate: insert,
        installLatestAwsSdk: false,
      })
      seed.node.addDependency(seedPolicy)
    }
  }
}
