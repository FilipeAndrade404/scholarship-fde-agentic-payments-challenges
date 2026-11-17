import { CfnOutput, Duration, RemovalPolicy, type Stack } from 'aws-cdk-lib'
import {
  AuthorizationType,
  CfnAuthorizer,
  CognitoUserPoolsAuthorizer,
  EndpointType,
  LambdaIntegration,
  ResponseTransferMode,
  ResponseType,
  RestApi,
} from 'aws-cdk-lib/aws-apigateway'
import { AccountRecovery, FeaturePlan, UserPool } from 'aws-cdk-lib/aws-cognito'
import type { Function } from 'aws-cdk-lib/aws-lambda'
import { chatTimeoutSeconds } from '../api/src/chat-config.ts'

export function addChatAccess(stack: Stack, chat: Function, initializeUser: Function, frontendOrigin: string) {
  const userPool = new UserPool(stack, 'ChatUserPool', {
    userPoolName: `${stack.stackName}-usuarios`,
    selfSignUpEnabled: false,
    signInAliases: { email: true },
    signInCaseSensitive: false,
    autoVerify: { email: true },
    standardAttributes: { email: { required: true } },
    userInvitation: {
      emailSubject: 'Convite: Agente de Pagamentos na AWS - projeto de Filipe Andrade (Desafio 1, Sprint 2)',
      emailBody: [
        'Olá!',
        'Este convite dá acesso ao <b>Agente de Pagamentos na AWS</b>, projeto de <b>Filipe Andrade</b>'
          + ' no Desafio 1 da Sprint 2 (Pagamentos Agênticos). Ele vale somente para este projeto.',
        'Usuário: <b>{username}</b><br>Senha temporária: <b>{####}</b>',
        'O frontend roda localmente. As instruções estão na seção "Para o corretor" do README:<br>'
          + 'https://github.com/FilipeAndrade404/scholarship-fde-agentic-payments-challenges/tree/'
          + 'fellow/filipe-andrade-desafio-1/Desafio-1/filipe-andrade#para-o-corretor',
        'Depois de iniciar o frontend, acesse http://localhost:5173, entre com o usuário e a senha'
          + ' temporária acima e defina uma nova senha no primeiro acesso.',
      ].join('<br><br>'),
    },
    accountRecovery: AccountRecovery.EMAIL_ONLY,
    featurePlan: FeaturePlan.LITE,
    lambdaTriggers: { preTokenGeneration: initializeUser },
    removalPolicy: RemovalPolicy.DESTROY,
  })
  const client = userPool.addClient('WebClient', {
    userPoolClientName: `${stack.stackName}-web`,
    generateSecret: false,
    authFlows: { userSrp: true },
    preventUserExistenceErrors: true,
    enableTokenRevocation: true,
  })

  // A API REST suporta a integração Lambda com streaming de resposta.
  const api = new RestApi(stack, 'ChatApi', {
    restApiName: `${stack.stackName}-api`,
    endpointTypes: [EndpointType.REGIONAL],
    deployOptions: { stageName: 'prod' },
    cloudWatchRole: false,
  })
  const authorizer = new CognitoUserPoolsAuthorizer(stack, 'ChatAuthorizer', {
    cognitoUserPools: [userPool],
    identitySource: 'method.request.header.Authorization',
    resultsCacheTtl: Duration.seconds(0),
  })
  const authorizerResource = authorizer.node.defaultChild as CfnAuthorizer
  authorizerResource.identityValidationExpression = `^${client.userPoolClientId}$`

  const auth = { authorizationType: AuthorizationType.COGNITO, authorizer }
  const integration = new LambdaIntegration(chat, {
    proxy: true,
    allowTestInvoke: false,
    responseTransferMode: ResponseTransferMode.STREAM,
    timeout: Duration.seconds(chatTimeoutSeconds + 5),
  })
  const post = api.root.addResource('chat')
  const get = api.root.addResource('conversas').addResource('{sessao_id}')
  post.addMethod('POST', integration, auth)
  get.addMethod('GET', integration, auth)

  const cors = { allowOrigins: [frontendOrigin], allowHeaders: ['Authorization', 'Content-Type'] }
  post.addCorsPreflight({ ...cors, allowMethods: ['POST', 'OPTIONS'] })
  get.addCorsPreflight({ ...cors, allowMethods: ['GET', 'OPTIONS'] })
  chat.addEnvironment('FRONTEND_ORIGIN', frontendOrigin)
  const responseHeaders = { 'Access-Control-Allow-Origin': `'${frontendOrigin}'` }
  api.addGatewayResponse('Unauthorized', {
    type: ResponseType.UNAUTHORIZED,
    statusCode: '401',
    responseHeaders,
    templates: { 'application/json': '{"error":"Não autorizado."}' },
  })
  api.addGatewayResponse('ClientErrors', { type: ResponseType.DEFAULT_4XX, responseHeaders })
  api.addGatewayResponse('ServerErrors', { type: ResponseType.DEFAULT_5XX, responseHeaders })

  new CfnOutput(stack, 'ChatApiUrl', { value: api.url })
  new CfnOutput(stack, 'CognitoUserPoolId', { value: userPool.userPoolId })
  new CfnOutput(stack, 'CognitoUserPoolClientId', { value: client.userPoolClientId })
  return { apiUrl: api.url, userPoolId: userPool.userPoolId, userPoolClientId: client.userPoolClientId }
}
