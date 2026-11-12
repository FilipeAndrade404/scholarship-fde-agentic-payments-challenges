import { App, Tags } from 'aws-cdk-lib'
import { PaymentsStack } from './payments-stack.ts'

const app = new App()
const stack = new PaymentsStack(app, 'filipe-andrade-desafio-1', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' },
  description: 'Desafio 1 de Pagamentos Agênticos - Filipe Andrade',
})

Tags.of(stack).add('Project', stack.stackName)
