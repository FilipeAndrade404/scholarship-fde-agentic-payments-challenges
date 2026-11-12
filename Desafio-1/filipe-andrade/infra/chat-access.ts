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
      emailSubject: 'Convite para o chat de pagamentos',
      emailBody: 'Seu usuário é {username}. Sua senha temporária é {####}. Altere a senha no primeiro acesso.',
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
